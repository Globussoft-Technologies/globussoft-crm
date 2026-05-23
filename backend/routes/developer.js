const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// ── Agent activity log ───────────────────────────────────────────────
//
// Background agents (and the orchestrator parent) append JSONL lines to
// .scripts-state/agent-activity.jsonl as they progress through tasks.
// Each line: { ts, agent, action, file?, commit?, status, message? }.
//
// This endpoint reads the tail of that log so a small dashboard widget
// (frontend/src/pages/Developer.jsx) can show live agent progress
// without the user having to tail a file. ADMIN-only because the log
// can carry route paths and commit hashes that aren't customer-relevant.
//
// File-based, not DB-based, on purpose: agents may run before backend
// is up, the file survives backend restarts, and it's gitignored
// (.scripts-state/) so no risk of leaking activity into the repo.
const AGENT_ACTIVITY_LOG = path.resolve(
  __dirname,
  "..",
  "..",
  ".scripts-state",
  "agent-activity.jsonl"
);

router.get("/agent-activity", verifyToken, verifyRole(["ADMIN"]), (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
  try {
    if (!fs.existsSync(AGENT_ACTIVITY_LOG)) {
      return res.json({ activity: [], count: 0, message: "No agent activity yet" });
    }
    const raw = fs.readFileSync(AGENT_ACTIVITY_LOG, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const activity = tail.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        return { ts: null, agent: "unparseable", action: "log-error", message: line.slice(0, 200), _line: i };
      }
    }).reverse(); // newest first
    res.json({ activity, count: activity.length, totalLines: lines.length });
  } catch (err) {
    console.error("[developer/agent-activity]", err);
    res.status(500).json({ error: "Failed to read agent activity log" });
  }
});

// POST agent activity entry — called by agents as they progress. Auth
// is admin-only so a leaked monitor token can't spam the log; in
// practice the orchestrator parent has a long-lived admin token.
router.post("/agent-activity", verifyToken, verifyRole(["ADMIN"]), (req, res) => {
  const { agent, action, file, commit, status, message } = req.body || {};
  if (!agent || !action) {
    return res.status(400).json({ error: "agent and action required" });
  }
  const entry = {
    ts: new Date().toISOString(),
    agent: String(agent).slice(0, 80),
    action: String(action).slice(0, 80),
    file: file ? String(file).slice(0, 200) : undefined,
    commit: commit ? String(commit).slice(0, 40) : undefined,
    status: status ? String(status).slice(0, 40) : undefined,
    message: message ? String(message).slice(0, 500) : undefined,
    by: req.user.email || req.user.userId,
  };
  try {
    fs.mkdirSync(path.dirname(AGENT_ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(AGENT_ACTIVITY_LOG, JSON.stringify(entry) + "\n", "utf8");
    res.status(201).json({ success: true, entry });
  } catch (err) {
    console.error("[developer/agent-activity POST]", err);
    res.status(500).json({ error: "Failed to write agent activity entry" });
  }
});

// #899 Part A: per-sub-brand API key scoping. Optional `subBrand` body field
// MUST be one of these 4 values when present; absent / null = tenant-wide
// (legacy behaviour, backward compatible). Kept in sync with VALID_SUB_BRANDS
// in routes/voyagr.js — refactor to a shared constant if a 3rd caller appears.
const VALID_API_KEY_SUB_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];

// Generate a new secure API Key for the user
//
// #720: `name` is REQUIRED — pre-fix the route silently fell back to
// "Default Ext-Integration Key" when the client posted an empty / missing
// label, which let users accidentally accumulate multiple unnamed keys
// from the Developer UI's Generate Key button. Reject blank / whitespace-
// only names with 400 + KEY_NAME_REQUIRED so the UI can show an inline
// validation error and so external API callers can't pollute the
// credentials list either.
//
// #899 Part A: optional `subBrand` body field — when set, scopes the key
// to ONE Travel sub-brand (tmc / rfu / travelstall / visasure). The
// /api/v1/voyagr route's middleware (voyagrAuth) enforces this on every
// inbound request, rejecting cross-sub-brand misuse with 403. Absent /
// null = tenant-wide key (legacy / generic — every existing key today).
router.post("/apikeys", verifyToken, async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({
        error: "Key name is required",
        code: "KEY_NAME_REQUIRED",
      });
    }

    // #899 Part A: validate optional subBrand against the whitelist.
    let subBrand = null;
    if (req.body.subBrand !== undefined && req.body.subBrand !== null && req.body.subBrand !== "") {
      if (typeof req.body.subBrand !== "string" ||
          !VALID_API_KEY_SUB_BRANDS.includes(req.body.subBrand)) {
        return res.status(400).json({
          error: `subBrand must be one of: ${VALID_API_KEY_SUB_BRANDS.join(", ")}`,
          code: "INVALID_SUB_BRAND",
        });
      }
      subBrand = req.body.subBrand;
    }

    const rawKey = `glbs_${crypto.randomBytes(24).toString('hex')}`;

    // In production, we would hash the key secret before storing it.
    // However, for this dashboard demo context, we'll store it raw.
    const key = await prisma.apiKey.create({
      data: {
        name,
        keySecret: rawKey,
        subBrand, // #899 Part A: null = tenant-wide; 'tmc'|'rfu'|'travelstall'|'visasure' = scoped
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      }
    });

    res.status(201).json({ key, rawKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to cryptographically construct API Key." });
  }
});

// Fetch user's active API keys
router.get("/apikeys", verifyToken, async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(keys);
  } catch(_err) {
    res.status(500).json({ error: "Failed to locate key registers." });
  }
});

// Revoke API Key
router.delete("/apikeys/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.apiKey.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "API key not found" });
    await prisma.apiKey.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch(_err) {
    res.status(500).json({ error: "Failed to revoke key." });
  }
});

// #713: scheme + private-host allowlist for outbound webhook targets.
//
// Pre-fix the route accepted any string in `targetUrl` and stored it raw
// — `javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`, plus
// `http://127.0.0.1/…` / `http://10.0.0.1/…` (SSRF surface). Two concerns:
//
//   1. Stored-XSS: any admin UI that ever renders the target as a clickable
//      link (or a recipient-side log viewer) executes the `javascript:`.
//   2. SSRF: the webhook dispatcher (lib/webhookDelivery.js) will POST to
//      whatever is stored, so a private-host target lets a malicious admin
//      probe the demo box's internal network from the server's perspective.
//
// Pattern mirrors landingPageRenderer.safeUrl's scheme allowlist but
// rejects (400 + INVALID_WEBHOOK_SCHEME / INVALID_WEBHOOK_HOST) instead of
// silently falling back to a placeholder — for a stored config field the
// caller has to know the value was bad. Loopback / RFC1918 / link-local /
// 0.0.0.0 are blocked unconditionally; on the demo box we don't have any
// legitimate intranet webhook targets, so a blanket block is safer than
// an opt-in allowlist.
function validateWebhookUrl(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, status: 400, error: "Webhook URL is required", code: "WEBHOOK_URL_REQUIRED" };
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch (_e) {
    return { ok: false, status: 400, error: "Webhook URL is not a valid URL", code: "INVALID_WEBHOOK_URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      error: "Webhook URL must use http: or https:",
      code: "INVALID_WEBHOOK_SCHEME",
    };
  }
  const host = u.hostname.toLowerCase();
  // Block loopback / private / link-local / 0.0.0.0.
  // Anti-SSRF: same class as #545's pattern (URL → parse → host-check).
  // IPv4 literals matched explicitly; common IPv6 loopback (::1) and link-
  // local (fe80::/10) covered. DNS rebinding is not in scope here — the
  // dispatcher (lib/webhookDelivery.js) re-resolves at send time, so a
  // future hardening pass could add DNS-resolution-time host check there.
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    // 172.16.0.0/12 → 172.16.* through 172.31.*
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^fe80:/i.test(host) ||
    /^fc[0-9a-f]{2}:/i.test(host) ||
    /^fd[0-9a-f]{2}:/i.test(host)
  ) {
    return {
      ok: false,
      status: 400,
      error: "Webhook URL host is not allowed (loopback / private network)",
      code: "INVALID_WEBHOOK_HOST",
    };
  }
  return { ok: true };
}

// Register Webhook Trigger
router.post("/webhooks", verifyToken, async (req, res) => {
  try {
    const check = validateWebhookUrl(req.body.targetUrl);
    if (!check.ok) {
      return res.status(check.status).json({ error: check.error, code: check.code });
    }
    if (typeof req.body.event !== "string" || req.body.event.trim().length === 0) {
      return res.status(400).json({ error: "Webhook event is required", code: "WEBHOOK_EVENT_REQUIRED" });
    }
    const webhook = await prisma.webhook.create({
      data: {
        event: req.body.event.trim(),
        targetUrl: req.body.targetUrl.trim(),
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      }
    });
    res.status(201).json(webhook);
  } catch (_err) {
    res.status(500).json({ error: "Failed to register webhook trigger link." });
  }
});

// Fetch user's registered webhooks
router.get("/webhooks", verifyToken, async (req, res) => {
  try {
    const hooks = await prisma.webhook.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(hooks);
  } catch(_err) {
    res.status(500).json({ error: "Failed to retrieve webhook nodes." });
  }
});

// Delete Webhook Trigger
router.delete("/webhooks/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.webhook.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Webhook not found" });
    await prisma.webhook.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch(_err) {
    res.status(500).json({ error: "Failed to deregister webhook target." });
  }
});

module.exports = router;
