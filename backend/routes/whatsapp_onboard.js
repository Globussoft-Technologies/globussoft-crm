//
// WhatsApp embedded-signup onboarding routes (P2).
//
// All routes are mounted under /api/whatsapp/onboard.
//
//   POST   /exchange          tenant ADMIN — exchange ES code + validate token
//   POST   /finalize          tenant ADMIN — wire webhook, register phone, persist
//   POST   /disconnect        tenant ADMIN — soft-disconnect (preserves history)
//   GET    /status            tenant member — computed integration health
//   GET    /numbers           tenant ADMIN — list this tenant's phone-number-ids
//
// Two-step shape (/exchange THEN /finalize) keeps the destructive write
// (DB persist + Meta webhook subscribe) behind an extra round-trip — the
// frontend can show progress UX between the two and the user can review
// before committing. Both calls go through tenant ADMIN RBAC.
//
// Feature flag: WHATSAPP_EMBEDDED_SIGNUP_ENABLED must be `true` or routes
// 503 with EMBEDDED_SIGNUP_NOT_APPROVED. Keep false until Meta App Review
// approves your app for the required permissions.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const onboarding = require("../lib/whatsappOnboardingService");
const health = require("../lib/whatsappHealth");
const provider = require("../services/whatsappProvider");
const { decryptCredential, maskConfigRow } = require("../lib/credentialMasking");

// Verbose terminal logging for the WhatsApp connection callback. Mirrors
// the WA_DEBUG flag in services/whatsappProvider.js so a single env var
// controls everything (default OFF; set WHATSAPP_DEBUG_LOG=true to re-enable).
const WA_DEBUG = String(process.env.WHATSAPP_DEBUG_LOG || "false").toLowerCase() === "true";
function redactConnectionBody(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  if (typeof out.code === "string" && out.code.length > 0) {
    out.code = `***REDACTED(${out.code.length})***`;
  }
  if (typeof out.registerPin === "string" && out.registerPin.length > 0) {
    out.registerPin = "***REDACTED***";
  }
  return out;
}
function connLog(tag, payload) {
  if (!WA_DEBUG) return;
  try {
    const pretty = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    console.log(`[whatsapp-connect] ${tag} ${pretty}`);
  } catch (e) {
    console.log(`[whatsapp-connect] ${tag} <log-serialize-failed: ${e.message}>`);
  }
}

// In-memory handoff store for the two-step flow. Keyed by handoffId (random
// 32-char hex). Entries auto-expire after 10 minutes. NOT durable — if the
// backend restarts mid-onboard the user re-runs the embedded-signup popup.
// That's acceptable because the popup is fast (<30s) and Meta's `code` is
// valid for 10 minutes anyway.
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const handoffStore = new Map();
function cleanupHandoffs() {
  const now = Date.now();
  for (const [k, v] of handoffStore) {
    if (v.expiresAt < now) handoffStore.delete(k);
  }
}
setInterval(cleanupHandoffs, 60 * 1000).unref?.();

function newHandoffId() {
  return require("crypto").randomBytes(16).toString("hex");
}

const WA_SECRET_FIELDS = ["accessToken", "webhookVerifyToken"];

// Feature-flag gate. Mounted on every route in this file.
function requireEnabled(req, res, next) {
  if (!onboarding.isEnabled()) {
    return res.status(503).json({
      error: "Embedded signup not enabled. Set WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true after Meta App Review approval.",
      code: "EMBEDDED_SIGNUP_NOT_APPROVED",
    });
  }
  next();
}

// ────────────────────────────────────────────────────────────────────────
// POST /exchange — step 1
// Body: { code, wabaId, phoneNumberId, redirectUri? }
// ────────────────────────────────────────────────────────────────────────
router.post("/exchange", verifyToken, verifyRole(["ADMIN"]), requireEnabled, async (req, res) => {
  try {
    connLog(`→ POST /api/whatsapp/onboard/exchange tenantId=${req.user.tenantId} userId=${req.user.userId}`, {
      body: redactConnectionBody(req.body || {}),
    });
    const { code, wabaId, phoneNumberId, redirectUri } = req.body || {};
    if (!code || !wabaId || !phoneNumberId) {
      const resp = { error: "code, wabaId, phoneNumberId are required" };
      connLog("← 400 /exchange", resp);
      return res.status(400).json(resp);
    }
    const result = await onboarding.exchangeAndDebug({ code, redirectUri });
    if (!result.ok) {
      const resp = { error: result.error, code: result.code };
      connLog("← 422 /exchange", resp);
      return res.status(422).json(resp);
    }
    const handoffId = newHandoffId();
    handoffStore.set(handoffId, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      token: result.token,
      expiresAt: Date.now() + HANDOFF_TTL_MS,
      tokenExpiresAt: result.expiresAt,
      appUserId: result.appUserId,
      wabaId,
      phoneNumberId,
    });
    const resp = {
      handoffId,
      tokenExpiresAt: result.expiresAt,
      scopes: result.scopes,
      neverExpires: result.expiresAt === null,
    };
    connLog("← 202 /exchange", resp);
    res.status(202).json(resp);
  } catch (err) {
    console.error("[onboard /exchange] error:", err);
    connLog("← 500 /exchange", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "exchange failed", detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /finalize — step 2
// Body: { handoffId, registerPin? }
// ────────────────────────────────────────────────────────────────────────
router.post("/finalize", verifyToken, verifyRole(["ADMIN"]), requireEnabled, async (req, res) => {
  try {
    connLog(`→ POST /api/whatsapp/onboard/finalize tenantId=${req.user.tenantId} userId=${req.user.userId}`, {
      body: redactConnectionBody(req.body || {}),
    });
    const { handoffId, registerPin } = req.body || {};
    if (!handoffId) {
      const resp = { error: "handoffId is required" };
      connLog("← 400 /finalize", resp);
      return res.status(400).json(resp);
    }
    const h = handoffStore.get(handoffId);
    if (!h) {
      const resp = { error: "handoff expired or not found", code: "HANDOFF_EXPIRED" };
      connLog("← 404 /finalize", resp);
      return res.status(404).json(resp);
    }
    if (h.tenantId !== req.user.tenantId) {
      // Same handoffId, different tenant — never legitimate.
      const resp = { error: "handoff does not belong to this tenant" };
      connLog("← 403 /finalize (tenant mismatch)", resp);
      return res.status(403).json(resp);
    }
    if (h.expiresAt < Date.now()) {
      handoffStore.delete(handoffId);
      const resp = { error: "handoff expired", code: "HANDOFF_EXPIRED" };
      connLog("← 404 /finalize (expired)", resp);
      return res.status(404).json(resp);
    }

    const result = await onboarding.finalize({
      tenantId: h.tenantId,
      userId: h.userId,
      token: h.token,
      expiresAt: h.tokenExpiresAt,
      appUserId: h.appUserId,
      wabaId: h.wabaId,
      phoneNumberId: h.phoneNumberId,
      registerPin: registerPin || null,
    });
    // Drop the handoff regardless of outcome — the token+code combo has
    // been used.
    handoffStore.delete(handoffId);

    if (!result.ok) {
      const resp = { error: result.error, code: result.code };
      connLog("← 422 /finalize", resp);
      return res.status(422).json(resp);
    }
    const resp = {
      success: true,
      configId: result.configId,
      phoneNumberId: result.phoneNumberId,
      wabaId: result.wabaId,
      tokenExpiresAt: result.tokenExpiresAt,
    };
    connLog("← 201 /finalize", resp);
    res.status(201).json(resp);
  } catch (err) {
    console.error("[onboard /finalize] error:", err);
    connLog("← 500 /finalize", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "finalize failed", detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /disconnect
// Body: { alsoUnsubscribeFromMeta?: boolean }
// ────────────────────────────────────────────────────────────────────────
router.post("/disconnect", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const alsoUnsubscribe = !!req.body?.alsoUnsubscribeFromMeta;
    const result = await onboarding.disconnect({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      alsoUnsubscribeFromMeta: alsoUnsubscribe,
    });
    if (!result.ok) {
      const status = result.code === "NOT_CONNECTED" ? 404 : 500;
      return res.status(status).json({ error: result.code || "disconnect failed", code: result.code });
    }
    res.json({ success: true, configId: result.configId });
  } catch (err) {
    console.error("[onboard /disconnect] error:", err);
    res.status(500).json({ error: "disconnect failed", detail: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /status — integration health for the current tenant
// Open to any logged-in tenant member so the Channels.jsx badge renders.
// ────────────────────────────────────────────────────────────────────────
router.get("/status", verifyToken, async (req, res) => {
  try {
    const cfg = await prisma.whatsAppConfig.findFirst({
      where: { tenantId: req.user.tenantId, provider: "meta_cloud" },
    });
    const s = health.computeStatus(cfg);
    // Do NOT leak credentials. We surface non-secret fields only.
    res.json({
      ...s,
      configured: !!cfg,
      phoneNumberId: cfg?.phoneNumberId || null,
      businessAccountId: cfg?.businessAccountId || null,
      qualityRating: cfg?.qualityRating || null,
      messagingLimitTier: cfg?.messagingLimitTier || null,
      onboardedAt: cfg?.onboardedAt || null,
      disconnectedAt: cfg?.disconnectedAt || null,
      lastHealthCheckAt: cfg?.lastHealthCheckAt || null,
    });
  } catch (err) {
    console.error("[onboard /status] error:", err);
    res.status(500).json({ error: "failed to compute status" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /numbers — list phone numbers attached to the tenant's WABA
// Calls Graph live, so changes Meta-side appear without a sync.
// ────────────────────────────────────────────────────────────────────────
router.get("/numbers", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const cfg = await prisma.whatsAppConfig.findFirst({
      where: { tenantId: req.user.tenantId, provider: "meta_cloud" },
    });
    if (!cfg || !cfg.businessAccountId || !cfg.accessToken) {
      return res.status(404).json({ error: "not connected", code: "NOT_CONNECTED" });
    }
    const token = decryptCredential(cfg.accessToken);
    const r = await provider.listPhoneNumbers({ wabaId: cfg.businessAccountId, accessToken: token });
    if (!r.ok) {
      return res.status(502).json({ error: r.error || "graph call failed", code: "GRAPH_ERROR" });
    }
    res.json({ phoneNumbers: r.data?.data || [] });
  } catch (err) {
    console.error("[onboard /numbers] error:", err);
    res.status(500).json({ error: "failed to list numbers" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /config — masked WhatsAppConfig (admin only). Mirrors the legacy
// GET /api/whatsapp/config but lives under /onboard for the new flow.
// ────────────────────────────────────────────────────────────────────────
router.get("/config", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const cfg = await prisma.whatsAppConfig.findFirst({
      where: { tenantId: req.user.tenantId, provider: "meta_cloud" },
    });
    if (!cfg) return res.json(null);
    res.json(maskConfigRow(cfg, WA_SECRET_FIELDS));
  } catch (err) {
    res.status(500).json({ error: "failed to fetch config" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /debug — frontend → VS Code terminal log bridge
// The Embedded Signup React component forwards every Meta popup
// postMessage + the FB.login callback to this endpoint so operators can
// see exactly what Meta returned without keeping Chrome DevTools open.
// No body validation — the data is opaque diagnostic info, and the
// frontend already redacts the OAuth code before sending.
// ────────────────────────────────────────────────────────────────────────
router.post("/debug", verifyToken, (req, res) => {
  if (!WA_DEBUG) return res.json({ logged: false, reason: "WHATSAPP_DEBUG_LOG=false" });
  const tag = req.body?.tag || "frontend";
  const payload = req.body?.payload;
  try {
    const pretty = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    console.log(`[whatsapp-connect:browser] ${tag} (tenantId=${req.user.tenantId} userId=${req.user.userId}) ${pretty}`);
  } catch (e) {
    console.log(`[whatsapp-connect:browser] ${tag} <log-serialize-failed: ${e.message}>`);
  }
  res.json({ logged: true });
});

module.exports = router;
