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

// Generate a new secure API Key for the user
router.post("/apikeys", verifyToken, async (req, res) => {
  try {
    const rawKey = `glbs_${crypto.randomBytes(24).toString('hex')}`;

    // In production, we would hash the key secret before storing it.
    // However, for this dashboard demo context, we'll store it raw.
    const key = await prisma.apiKey.create({
      data: {
        name: req.body.name || "Default Ext-Integration Key",
        keySecret: rawKey,
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

// Register Webhook Trigger
router.post("/webhooks", verifyToken, async (req, res) => {
  try {
    const webhook = await prisma.webhook.create({
      data: {
        event: req.body.event,
        targetUrl: req.body.targetUrl,
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
