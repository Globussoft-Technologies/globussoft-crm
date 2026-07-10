/**
 * whatsappGatewayClient.js — the HTTP SHIM. Exposes the SAME method surface as
 * services/whatsappWebClient.js (the watiClient-compatible contract) but routes
 * the TRANSPORT leg to the standalone WhatsApp Gateway over REST, while REUSING
 * whatsappWebClient's existing backend persistence helpers so the persisted
 * rows, thread upserts, and envelopes stay behaviorally identical.
 *
 * Enabled per-tenant by the selector (Phase 2) when config/waGateway says so.
 * When the gateway is unreachable / a tenant isn't connected, every send
 * degrades to the SAME stub semantics as today (QUEUED row + {stub:true}), so a
 * gateway outage never crashes callers or loses data.
 *
 * STATUS: Phase 1 additive — NOT wired into server.js yet. The selector +
 * /internal/whatsapp/events handler that drive it land in Phase 2.
 *
 * See docs/WHATSAPP_GATEWAY_EXTRACTION.md (§2 architecture, §5 API).
 */

const cfg = require("../config/waGateway");
// Reuse the backend persistence + helpers (single source of truth). This shim
// only swaps the actual `client.sendMessage` transport leg for an HTTP call.
const wa = require("./whatsappWebClient");
const { toStateDTO } = require("./waTransportDTO");

// ── State cache — fed by the gateway's `state` events (Phase 2 webhook) and
// warmed by GET /state on boot. Keeps isConnected/getState SYNCHRONOUS (the
// whatsappSessionGuard + sendSessionMessage contract) with no round-trip. ──────
const stateCache = new Map(); // tenantId -> StateDTO

function applyGatewayState(tenantId, state) {
  stateCache.set(Number(tenantId), toStateDTO(state));
  return getState(tenantId);
}

function getState(tenantId) {
  return stateCache.get(Number(tenantId)) || toStateDTO({ state: "DISCONNECTED" });
}
function isConnected(tenantId) {
  const s = stateCache.get(Number(tenantId));
  return Boolean(s && s.connected);
}
function isEnabled(tenantId) {
  if (process.env.NODE_ENV === "test") return false;
  if (tenantId == null) return false;
  return module.exports.isConnected(tenantId);
}
function getConfig() {
  return { endpoint: cfg.gatewayUrl(), token: null, channelNumber: null };
}

// ── Low-level gateway REST call. Never throws — returns {ok:false} on any
// failure so callers fall back to stub semantics. ─────────────────────────────
async function call(method, tenantId, path, body) {
  const base = cfg.gatewayUrl();
  const key = cfg.internalKey();
  if (!base || !key) return { ok: false, status: 0, error: "gateway-not-configured" };
  try {
    const res = await fetch(`${base}/sessions/${Number(tenantId)}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Internal-Key": key },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...json };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// ── Lifecycle (transport → gateway; state cache updated from the response) ────
async function connect(tenantId, { reset = false } = {}) {
  const r = await call("POST", tenantId, "/connect", { reset });
  if (r.ok) applyGatewayState(tenantId, r);
  return getState(tenantId);
}
async function disconnect(tenantId, { logout = false } = {}) {
  const r = await call("POST", tenantId, "/disconnect", { logout });
  applyGatewayState(tenantId, { state: "DISCONNECTED" });
  return r.ok ? getState(tenantId) : { state: "DISCONNECTED", connected: false, phone: null, qr: null };
}
async function importAllChats(tenantId, opts = {}) {
  const r = await call("POST", tenantId, "/import", opts);
  return r.ok ? r : { imported: false, reason: r.error || "gateway-unreachable" };
}
async function backfillThreadHistory(tenantId, threadId) {
  const prisma = require("../lib/prisma");
  const thread = await prisma.whatsAppThread.findFirst({ where: { id: Number(threadId), tenantId: Number(tenantId) }, select: { contactPhone: true } }).catch(() => null);
  if (!thread) return { backfilled: false, reason: "thread-not-found" };
  const r = await call("POST", tenantId, "/threads/backfill", { chatId: wa.toChatId(thread.contactPhone) });
  return r.ok ? r : { backfilled: false, reason: r.error || "gateway-unreachable" };
}

// ── Profile passthroughs ──────────────────────────────────────────────────────
async function getOwnProfile(tenantId) {
  const r = await call("GET", tenantId, "/profile");
  return r.ok ? r : { connected: false, phone: null, name: null, about: null, avatar: null };
}
async function setOwnProfile(tenantId, patch) {
  const r = await call("PUT", tenantId, "/profile", patch);
  if (!r.ok) throw new Error(r.error === "WhatsApp not connected" || !module.exports.isConnected(tenantId) ? "WhatsApp not connected" : (r.error || "profile update failed"));
  return r;
}

// ── Send surface — persistence via whatsappWebClient helpers, transport via the
// gateway. resolveSendChatId + ensureOutboundThread + persistMessageRow are the
// SAME code paths as in-process, so rows/threads are behaviorally identical. ────
async function sendSessionMessage({ tenantId, subBrand, toPhone, text, contactId, threadId, userId, persistTo, templateName }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!text) throw new Error("text required");
  const to = String(toPhone).includes("@") ? String(toPhone) : wa.normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const rowTo = persistTo || to;
  const from = getState(tenantId).phone || null;
  const tpl = templateName || null;

  let resolvedThreadId = threadId;
  if (!resolvedThreadId && !String(to).includes("@")) {
    resolvedThreadId = await wa.ensureOutboundThread(tenantId, to, contactId);
  }

  if (!module.exports.isEnabled(tenantId)) {
    // Mirror the in-process stub log (subBrand is metadata-only — logged, never routed).
    console.log(`[whatsappGateway STUB] sendText tenant=${tenantId} subBrand=${subBrand || "(none)"} to=${to} textLen=${String(text).length} — not connected via gateway`);
    const row = await wa.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "QUEUED", threadId: resolvedThreadId, userId, from });
    return { stub: true, sent: false, status: "QUEUED", to, channel: from, messageRowId: row ? row.id : null };
  }

  const chatId = String(to).includes("@") ? to : await wa.resolveSendChatId(tenantId, to, contactId);
  const r = await call("POST", tenantId, "/send", { chatId, text });
  if (r.ok && r.providerMsgId) {
    const row = await wa.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "SENT", providerMsgId: r.providerMsgId, threadId: resolvedThreadId, userId, from });
    return { stub: false, sent: true, status: "SENT", to, channel: from, providerMsgId: r.providerMsgId, messageRowId: row ? row.id : null };
  }
  const row = await wa.persistMessageRow({ tenantId, contactId, to: rowTo, body: text, templateName: tpl, status: "FAILED", errorMessage: r.error || "gateway send failed", threadId: resolvedThreadId, userId, from });
  return { stub: false, sent: false, status: "FAILED", to, channel: from, error: r.error || "gateway send failed", messageRowId: row ? row.id : null };
}

async function sendTemplateMessage({ tenantId, subBrand, toPhone, templateName, parameters, contactId, bodyPreview, threadId, userId, persistTo }) {
  if (!toPhone) throw new Error("toPhone required");
  const values = Array.isArray(parameters) ? parameters.map((p) => (p && typeof p === "object" ? p.value : p)).filter((v) => v != null && v !== "") : [];
  const text = (bodyPreview && String(bodyPreview).trim()) || (templateName ? `${templateName}${values.length ? `: ${values.join(" · ")}` : ""}` : "") || "";
  if (!text) throw new Error("no renderable body for template send");
  const out = await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text, contactId, threadId, userId, persistTo, templateName: templateName || null });
  return { ...out, templateName: templateName || null };
}

async function sendSessionFile({ tenantId, toPhone, buffer, filename, mimeType, caption, contactId, threadId, userId, persistTo, mediaUrl }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!buffer || !buffer.length) throw new Error("file buffer required");
  const to = String(toPhone).includes("@") ? String(toPhone) : wa.normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const rowTo = persistTo || to;
  const from = getState(tenantId).phone || null;
  const kind = String(mimeType || "").split("/")[0] || "document";
  const persistCommon = { tenantId, contactId, to: rowTo, body: caption || null, threadId, userId, from, mediaUrl: mediaUrl || null, mediaType: mimeType || null, metaType: kind === "application" ? "document" : kind };

  if (!module.exports.isEnabled(tenantId)) {
    const row = await wa.persistMessageRow({ ...persistCommon, status: "QUEUED" });
    return { stub: true, sent: false, status: "QUEUED", to, channel: from, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }
  const chatId = wa.toChatId(to);
  const r = await call("POST", tenantId, "/send-media", { chatId, base64: buffer.toString("base64"), mime: mimeType || "application/octet-stream", filename: filename || "file", caption: caption || undefined });
  if (r.ok && r.providerMsgId) {
    const row = await wa.persistMessageRow({ ...persistCommon, status: "SENT", providerMsgId: r.providerMsgId });
    return { stub: false, sent: true, status: "SENT", to, channel: from, providerMsgId: r.providerMsgId, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }
  const row = await wa.persistMessageRow({ ...persistCommon, status: "FAILED", errorMessage: r.error || "gateway media send failed" });
  return { stub: false, sent: false, status: "FAILED", to, channel: from, error: r.error || "gateway media send failed", messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
}

// The one call every travel cron uses. subBrand is threaded through unchanged
// (metadata only — never selects the number/session).
async function sendBestEffort({ tenantId, subBrand, toPhone, templateName, parameters, fallbackText, contactId }) {
  try {
    if (fallbackText) return await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text: fallbackText, contactId });
    if (templateName) return await module.exports.sendTemplateMessage({ tenantId, subBrand, toPhone, templateName, parameters, contactId });
    return { stub: !module.exports.isEnabled(tenantId), sent: false, status: "SKIPPED", error: "neither fallbackText nor templateName supplied" };
  } catch (e) {
    console.error(`[whatsappGateway] sendBestEffort error (non-fatal): ${e.message}`);
    return { stub: !module.exports.isEnabled(tenantId), sent: false, status: "FAILED", error: e.message };
  }
}

// Read-surface parity with whatsappWebClient (unchanged contract).
async function getMessageTemplates() { return { stub: true, templates: [] }; }
async function getContacts() { return { stub: true, contacts: [] }; }
async function getMessages() { return { stub: true, items: [] }; }
async function getMediaResponse() { return null; }
async function purgeChats(tenantId) { return wa.purgeChats(tenantId); }

module.exports = {
  // cache / events
  applyGatewayState,
  stateCache,
  // state
  getState,
  isConnected,
  isEnabled,
  getConfig,
  // lifecycle
  connect,
  disconnect,
  importAllChats,
  backfillThreadHistory,
  purgeChats,
  // profile
  getOwnProfile,
  setOwnProfile,
  // send
  sendSessionMessage,
  sendTemplateMessage,
  sendSessionFile,
  sendBestEffort,
  // read stubs
  getMessageTemplates,
  getContacts,
  getMessages,
  getMediaResponse,
  // helper passthroughs (kept identical to whatsappWebClient's surface)
  normalizePhone: wa.normalizePhone,
  toChatId: wa.toChatId,
  fromChatId: wa.fromChatId,
};
