/**
 * WhatsApp Gateway — standalone transport service (Phase 1 skeleton).
 *
 * Responsibility: ONLY the whatsapp-web.js/Puppeteer transport — session
 * lifecycle, QR generation, send, and the raw inbound/ack event stream. It owns
 * NO CRM database: it posts normalized event DTOs back to the CRM backend, which
 * keeps all persistence, Socket.IO, RBAC, device governance, and lead capture.
 *
 * See docs/WHATSAPP_GATEWAY_EXTRACTION.md (§2 architecture, §5 API).
 *
 * STATUS: skeleton. The REST surface + auth + health + event-forwarder are wired
 * here. The transport implementation is moved in during Phase 1 by relocating the
 * transport half of backend/services/whatsappWebClient.js into ./transportCore.js and
 * replacing the `notImplemented` handlers below with calls into it. Until then
 * every transport endpoint returns 501 so the service is safe to deploy but inert.
 */

const express = require("express");
const transportCore = require("./transportCore");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = Number(process.env.WA_GATEWAY_PORT || 5100);
const INTERNAL_KEY = process.env.WA_GATEWAY_INTERNAL_KEY || null;
const BACKEND_EVENTS_URL = String(process.env.WA_BACKEND_EVENTS_URL || "").replace(/\/+$/, "") || null;

// ── Shared-secret auth (both directions use X-Internal-Key) ────────────
function requireInternalKey(req, res, next) {
  if (!INTERNAL_KEY) {
    return res.status(500).json({ error: "gateway not configured (WA_GATEWAY_INTERNAL_KEY unset)", code: "WA_GW_UNCONFIGURED" });
  }
  if (req.get("X-Internal-Key") !== INTERNAL_KEY) {
    return res.status(401).json({ error: "unauthorized", code: "WA_GW_UNAUTHORIZED" });
  }
  next();
}

/**
 * Forward a transport event to the CRM backend's events webhook. The backend
 * runs the existing persistence + Socket.IO + lead-capture logic. Best-effort:
 * a delivery failure is logged and dropped (mirrors the current fire-and-forget
 * emit semantics); the transport must never crash on a backend hiccup.
 *
 * type ∈ "qr" | "state" | "inbound" | "ack" | "imported"
 */
async function forwardEvent(type, tenantId, payload) {
  if (!BACKEND_EVENTS_URL || !INTERNAL_KEY) return;
  try {
    await fetch(`${BACKEND_EVENTS_URL}/internal/whatsapp/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": INTERNAL_KEY },
      body: JSON.stringify({ type, tenantId: Number(tenantId), ...payload }),
    });
  } catch (e) {
    console.error(`[wa-gateway] forwardEvent(${type}, ${tenantId}) failed (non-fatal): ${e.message}`);
  }
}

// ── Health (unauthenticated) ───────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "wa-gateway", version: "0.1.0" }));

// ── Transport REST surface (Phase 1 — wired) ──────────────────────────
app.get("/sessions/:tenantId/state", requireInternalKey, (_req, res) => {
  const state = transportCore.getState(_req.params.tenantId);
  res.json(state);
});

app.post("/sessions/:tenantId/connect", requireInternalKey, async (req, res) => {
  try {
    const state = await transportCore.connect(req.params.tenantId, req.body || {});
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message || "connect failed" });
  }
});

app.post("/sessions/:tenantId/disconnect", requireInternalKey, async (req, res) => {
  try {
    const state = await transportCore.disconnect(req.params.tenantId, req.body || {});
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message || "disconnect failed" });
  }
});

app.post("/sessions/:tenantId/send", requireInternalKey, async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  const result = await transportCore.sendMessage(req.params.tenantId, chatId, text);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/sessions/:tenantId/send-media", requireInternalKey, async (req, res) => {
  const { chatId, base64, mime, filename, caption } = req.body || {};
  if (!chatId || !base64) return res.status(400).json({ error: "chatId and base64 required" });
  try {
    const buffer = Buffer.from(base64, "base64");
    const result = await transportCore.sendFile(req.params.tenantId, chatId, buffer, filename, caption);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || "send-media failed" });
  }
});

app.get("/sessions/:tenantId/profile", requireInternalKey, async (req, res) => {
  const result = await transportCore.getProfile(req.params.tenantId);
  res.json(result);
});

app.put("/sessions/:tenantId/profile", requireInternalKey, async (req, res) => {
  const result = await transportCore.setProfile(req.params.tenantId, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/sessions/:tenantId/avatar", requireInternalKey, async (req, res) => {
  const { mediaUrl } = req.body || {};
  if (!mediaUrl) return res.status(400).json({ error: "mediaUrl required" });
  const result = await transportCore.setAvatar(req.params.tenantId, mediaUrl);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.delete("/sessions/:tenantId/avatar", requireInternalKey, async (req, res) => {
  const result = await transportCore.deleteAvatar(req.params.tenantId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/sessions/:tenantId/import", requireInternalKey, async (req, res) => {
  const result = await transportCore.importAllChats(req.params.tenantId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post("/sessions/:tenantId/threads/backfill", requireInternalKey, async (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const result = await transportCore.backfillThreadHistory(req.params.tenantId, chatId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Wire the event forwarder into the transport core
transportCore.setEventHandler(forwardEvent);

// Graceful shutdown on SIGTERM/SIGINT
process.on("SIGTERM", async () => {
  console.log("[wa-gateway] SIGTERM received — shutting down gracefully…");
  await transportCore.shutdownAll();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[wa-gateway] SIGINT received — shutting down gracefully…");
  await transportCore.shutdownAll();
  process.exit(0);
});

// Exported for tests; only listens when run directly.
module.exports = { app, forwardEvent };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[wa-gateway] listening on :${PORT}`);
    transportCore.restoreSessions().catch((e) => console.error("[wa-gateway] restoreSessions failed:", e.message));
  });
}
