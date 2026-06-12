/**
 * Wati WhatsApp client — TRAVEL vertical transport (Q9).
 *
 * IMPORTANT — two SEPARATE WhatsApp tracks coexist in this codebase:
 *   - Wellness / generic CRM → direct Meta Cloud API via
 *     backend/services/whatsappProvider.js (+ WhatsAppConfig rows). That
 *     track is NOT touched by this module in any way.
 *   - Travel vertical        → Wati's own REST platform (this module).
 *     The 7 travel crons + 3 travel endpoints dispatch through here.
 *
 * Credentials (provided by Travel Stall via the Wati dashboard → API Docs):
 *   WATI_API_ENDPOINT   — e.g. https://live-mt-server.wati.io/<accountId>
 *   WATI_ACCESS_TOKEN   — the long-lived Bearer token Wati issues
 *   WATI_CHANNEL_NUMBER — the WhatsApp business number on the account
 *                         (digits, e.g. 9198xxxxxx00). Used as the
 *                         channel selector on multi-number accounts and
 *                         for observability; optional on single-number
 *                         accounts.
 *
 * Mode switch (mirrors lib/llmRouter.js discipline):
 *   - Both WATI_API_ENDPOINT + WATI_ACCESS_TOKEN present AND
 *     NODE_ENV !== 'test'  → REAL sends via Wati REST API.
 *   - Anything missing / under test → STUB: logs the would-send line and
 *     persists a QUEUED WhatsAppMessage row. CI + dev-without-creds stay
 *     offline and deterministic.
 *
 * Wati API surface used (api-docs.wati.io):
 *   POST {base}/api/v1/sendTemplateMessage?whatsappNumber={to}
 *        body { template_name, broadcast_name, parameters: [{name,value}] }
 *   POST {base}/api/v1/sendSessionMessage/{to}?messageText={text}
 *        (free-form; only delivers inside the 24h customer-initiated window)
 *   GET  {base}/api/v1/getMessageTemplates
 *
 * Persistence: every dispatch (stub or real) best-effort writes ONE
 * WhatsAppMessage row (direction OUTBOUND; status QUEUED → SENT/FAILED)
 * so the /channels log + ops dashboards see travel traffic. Persistence
 * failure NEVER fails the send — wrapped in try/catch.
 *
 * Sub-brand routing: resolveForSubBrand (lib/subBrandConfig.js) supplies a
 * per-sub-brand channel number when the tenant's subBrandConfigJson carries
 * one (TMC / RFU / ops-shared); falls back to WATI_CHANNEL_NUMBER. Until
 * the 3-number split lands on the Wati account this is observability-only.
 *
 * CJS self-mocking seam (CLAUDE.md standing pattern): inter-function calls
 * go through module.exports.fn(...) so vitest vi.spyOn interception works.
 */

const { resolveForSubBrand } = require("../lib/subBrandConfig");

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Config + mode
// ---------------------------------------------------------------------------

// Values containing "REPLACE" are the .env dummy placeholders shipped ahead
// of the cred drop — treat them as unset so a half-edited .env can never
// trigger live HTTP calls against a bogus endpoint.
function isPlaceholder(v) {
  return /REPLACE/i.test(v);
}

function getConfig() {
  let endpoint = (process.env.WATI_API_ENDPOINT || "").trim().replace(/\/+$/, "");
  let token = (process.env.WATI_ACCESS_TOKEN || "").trim();
  let channelNumber = (process.env.WATI_CHANNEL_NUMBER || "").trim();
  if (isPlaceholder(endpoint)) endpoint = "";
  if (isPlaceholder(token)) token = "";
  if (isPlaceholder(channelNumber)) channelNumber = "";
  return { endpoint: endpoint || null, token: token || null, channelNumber: channelNumber || null };
}

function isEnabled() {
  if (process.env.NODE_ENV === "test") return false;
  const { endpoint, token } = module.exports.getConfig();
  return Boolean(endpoint && token);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Wati wants the recipient as bare digits with country code (no '+').
// Conservative normalisation: strip non-digits; a bare 10-digit Indian
// mobile gets the 91 prefix (matches utils/deduplication.js conventions).
function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

// Resolve the per-sub-brand channel number from Tenant.subBrandConfigJson
// (phoneNumberId slot), falling back to the env channel. Best-effort: any
// DB error degrades to the env fallback — routing must never block a send.
async function resolveChannelNumber(tenantId, subBrand) {
  const { channelNumber } = module.exports.getConfig();
  if (!tenantId || !subBrand) return channelNumber;
  try {
    const prisma = require("../lib/prisma");
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { subBrandConfigJson: true },
    });
    const cfg = resolveForSubBrand(tenant, subBrand);
    return (cfg && cfg.phoneNumberId) || channelNumber;
  } catch (e) {
    console.error(`[watiClient] channel resolve failed (falling back to env): ${e.message}`);
    return channelNumber;
  }
}

// Best-effort WhatsAppMessage persistence. Status values follow the model's
// documented enum (QUEUED, SENT, FAILED). NEVER throws.
//
// threadId / userId / from are optional pass-throughs so the travel chat
// surface (routes/travel_whatsapp.js) gets thread-linked rows from the SAME
// persist (no double-row); cron/endpoint callers omit them → null.
async function persistMessageRow({ tenantId, contactId, to, body, templateName, status, providerMsgId, errorMessage, threadId, userId, from, mediaUrl, mediaType, metaType }) {
  try {
    const prisma = require("../lib/prisma");
    if (!prisma.whatsAppMessage || typeof prisma.whatsAppMessage.create !== "function") return null;
    return await prisma.whatsAppMessage.create({
      data: {
        to: String(to),
        from: from || null,
        direction: "OUTBOUND",
        status,
        body: body || null,
        templateName: templateName || null,
        providerMsgId: providerMsgId || null,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
        tenantId: tenantId || 1,
        contactId: contactId || null,
        threadId: threadId || null,
        userId: userId || null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        metaType: metaType || null,
      },
    });
  } catch (e) {
    console.error(`[watiClient] WhatsAppMessage persist failed (non-fatal): ${e.message}`);
    return null;
  }
}

async function watiFetch(path, { method = "POST", query = {}, body } = {}) {
  const { endpoint, token } = module.exports.getConfig();
  const url = new URL(`${endpoint}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json-patch+json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Wati HTTP ${res.status}: ${out.message || out.error || res.statusText || "request failed"}`);
    }
    // Wati signals logical failure with result:false / "error" even on 200.
    if (out.result === false || out.result === "error") {
      throw new Error(`Wati rejected: ${out.message || out.info || JSON.stringify(out).slice(0, 300)}`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Send primitives
// ---------------------------------------------------------------------------

/**
 * Send an approved Wati template message (HSM). Works outside the 24h
 * session window — the production path for OTPs / reminders / nudges.
 *
 * @param {object} p
 * @param {number}  p.tenantId       — travel tenant id (scoping + persistence)
 * @param {string}  [p.subBrand]     — tmc | rfu | travelstall | visasure
 * @param {string}  p.toPhone        — recipient (any format; normalised)
 * @param {string}  p.templateName   — Wati template name (Meta-approved)
 * @param {Array}   [p.parameters]   — [{ name, value }] template variables
 * @param {string}  [p.broadcastName]— Wati broadcast label (analytics bucket)
 * @param {number}  [p.contactId]    — CRM contact for the persisted row
 * @param {string}  [p.bodyPreview]  — human-readable text for the message log
 */
async function sendTemplateMessage({ tenantId, subBrand, toPhone, templateName, parameters, broadcastName, contactId, bodyPreview, threadId, userId, persistTo }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!templateName) throw new Error("templateName required");
  const to = normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const channel = await module.exports.resolveChannelNumber(tenantId, subBrand);
  // `persistTo` lets the chat surface store the thread-keyed E.164 form
  // while the Wati API itself receives bare digits. Defaults to the
  // normalised digits (cron callers' historical behaviour).
  const rowTo = persistTo || to;

  if (!module.exports.isEnabled()) {
    console.log(
      `[watiClient STUB] sendTemplateMessage tenant=${tenantId} subBrand=${subBrand || "(none)"} ` +
      `to=${to} template=${templateName} channel=${channel || "(no-config)"} — ` +
      `set WATI_API_ENDPOINT + WATI_ACCESS_TOKEN to go live`,
    );
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: bodyPreview, templateName, status: "QUEUED", threadId, userId, from: channel,
    });
    return { stub: true, sent: false, status: "QUEUED", to, templateName, channel, messageRowId: row ? row.id : null };
  }

  try {
    const out = await module.exports.watiFetch("/api/v1/sendTemplateMessage", {
      method: "POST",
      query: { whatsappNumber: to, ...(channel ? { channel_number: channel } : {}) },
      body: {
        template_name: templateName,
        broadcast_name: broadcastName || `travel-crm-${templateName}`,
        parameters: Array.isArray(parameters) ? parameters : [],
      },
    });
    const providerMsgId = (out && (out.id || out.messageId || (out.message && out.message.id))) || null;
    console.log(`[watiClient] template sent tenant=${tenantId} to=${to} template=${templateName}`);
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: bodyPreview, templateName, status: "SENT", providerMsgId, threadId, userId, from: channel,
    });
    return { stub: false, sent: true, status: "SENT", to, templateName, channel, providerMsgId, messageRowId: row ? row.id : null };
  } catch (e) {
    console.error(`[watiClient] template send FAILED tenant=${tenantId} to=${to} template=${templateName}: ${e.message}`);
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: bodyPreview, templateName, status: "FAILED", errorMessage: e.message, threadId, userId, from: channel,
    });
    return { stub: false, sent: false, status: "FAILED", to, templateName, channel, error: e.message, messageRowId: row ? row.id : null };
  }
}

/**
 * Send a free-form session message. Only delivers inside the 24h window
 * after the customer last messaged the business number — fine for dev
 * testing (message the number first) and conversational replies; NOT a
 * substitute for templates on cold outbound.
 */
async function sendSessionMessage({ tenantId, subBrand, toPhone, text, contactId, threadId, userId, persistTo }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!text) throw new Error("text required");
  const to = normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const channel = await module.exports.resolveChannelNumber(tenantId, subBrand);
  const rowTo = persistTo || to;

  if (!module.exports.isEnabled()) {
    console.log(
      `[watiClient STUB] sendSessionMessage tenant=${tenantId} subBrand=${subBrand || "(none)"} ` +
      `to=${to} channel=${channel || "(no-config)"} textLen=${String(text).length} — ` +
      `set WATI_API_ENDPOINT + WATI_ACCESS_TOKEN to go live`,
    );
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: text, status: "QUEUED", threadId, userId, from: channel,
    });
    return { stub: true, sent: false, status: "QUEUED", to, channel, messageRowId: row ? row.id : null };
  }

  try {
    const out = await module.exports.watiFetch(`/api/v1/sendSessionMessage/${encodeURIComponent(to)}`, {
      method: "POST",
      query: { messageText: text, ...(channel ? { channel_number: channel } : {}) },
    });
    const providerMsgId = (out && (out.id || out.messageId || (out.message && out.message.id))) || null;
    console.log(`[watiClient] session message sent tenant=${tenantId} to=${to}`);
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: text, status: "SENT", providerMsgId, threadId, userId, from: channel,
    });
    return { stub: false, sent: true, status: "SENT", to, channel, providerMsgId, messageRowId: row ? row.id : null };
  } catch (e) {
    console.error(`[watiClient] session send FAILED tenant=${tenantId} to=${to}: ${e.message}`);
    const row = await module.exports.persistMessageRow({
      tenantId, contactId, to: rowTo, body: text, status: "FAILED", errorMessage: e.message, threadId, userId, from: channel,
    });
    return { stub: false, sent: false, status: "FAILED", to, channel, error: e.message, messageRowId: row ? row.id : null };
  }
}

/**
 * Send a media file in the open session window (Wati sendSessionFile —
 * multipart upload; image/video/audio/document/sticker). Mirrors the
 * session-message contract: stub mode persists a QUEUED row; real mode
 * uploads and persists SENT/FAILED.
 */
async function sendSessionFile({ tenantId, subBrand, toPhone, buffer, filename, mimeType, caption, contactId, threadId, userId, persistTo, mediaUrl }) {
  if (!toPhone) throw new Error("toPhone required");
  if (!buffer || !buffer.length) throw new Error("file buffer required");
  const to = normalizePhone(toPhone);
  if (!to) throw new Error("toPhone could not be normalised");
  const channel = await module.exports.resolveChannelNumber(tenantId, subBrand);
  const rowTo = persistTo || to;
  const kind = String(mimeType || "").split("/")[0] || "document";
  const persistCommon = {
    tenantId, contactId, to: rowTo, body: caption || null, threadId, userId, from: channel,
    mediaUrl: mediaUrl || null,
    mediaType: mimeType || null,
    metaType: kind === "application" ? "document" : kind,
  };

  if (!module.exports.isEnabled()) {
    console.log(
      `[watiClient STUB] sendSessionFile tenant=${tenantId} to=${to} file=${filename} ` +
      `(${mimeType}, ${buffer.length}b) — set WATI creds to go live`,
    );
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "QUEUED" });
    return { stub: true, sent: false, status: "QUEUED", to, channel, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }

  try {
    const { endpoint, token } = module.exports.getConfig();
    const url = new URL(`${endpoint}/api/v1/sendSessionFile/${encodeURIComponent(to)}`);
    if (caption) url.searchParams.set("caption", caption);
    if (channel) url.searchParams.set("channel_number", channel);
    const fd = new FormData();
    fd.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), filename || "file");
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }, // boundary set by FormData
      body: fd,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.result === false || out.result === "error") {
      throw new Error(`Wati HTTP ${res.status}: ${out.message || out.info || res.statusText || "file send failed"}`);
    }
    const providerMsgId = (out && (out.id || out.messageId || (out.message && out.message.id))) || null;
    console.log(`[watiClient] session file sent tenant=${tenantId} to=${to} file=${filename}`);
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "SENT", providerMsgId });
    return { stub: false, sent: true, status: "SENT", to, channel, providerMsgId, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  } catch (e) {
    console.error(`[watiClient] session file send FAILED tenant=${tenantId} to=${to}: ${e.message}`);
    const row = await module.exports.persistMessageRow({ ...persistCommon, status: "FAILED", errorMessage: e.message });
    return { stub: false, sent: false, status: "FAILED", to, channel, error: e.message, messageRowId: row ? row.id : null, mediaUrl: mediaUrl || null };
  }
}

/**
 * Best-effort dispatch — the ONE call every travel cron / endpoint uses.
 *
 * Strategy: template first when templateName is supplied (the only path
 * that works on cold outbound); if the template send fails (e.g. not yet
 * approved in the Wati account) AND fallbackText is supplied, retry as a
 * session message (delivers when the recipient messaged the business
 * number inside 24h — the typical dev-testing flow). Never throws: every
 * outcome resolves to a status envelope so cron loops stay resilient.
 */
async function sendBestEffort({ tenantId, subBrand, toPhone, templateName, parameters, broadcastName, fallbackText, contactId }) {
  try {
    if (templateName) {
      const t = await module.exports.sendTemplateMessage({
        tenantId, subBrand, toPhone, templateName, parameters, broadcastName, contactId, bodyPreview: fallbackText,
      });
      if (t.sent || t.stub || !fallbackText) return t;
      const s = await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text: fallbackText, contactId });
      return { ...s, templateError: t.error, fellBackToSession: true };
    }
    if (fallbackText) {
      return await module.exports.sendSessionMessage({ tenantId, subBrand, toPhone, text: fallbackText, contactId });
    }
    return { stub: !module.exports.isEnabled(), sent: false, status: "SKIPPED", error: "neither templateName nor fallbackText supplied" };
  } catch (e) {
    console.error(`[watiClient] sendBestEffort error (non-fatal): ${e.message}`);
    return { stub: !module.exports.isEnabled(), sent: false, status: "FAILED", error: e.message };
  }
}

/** List the account's templates (real mode only) — handy for ops debugging. */
async function getMessageTemplates() {
  if (!module.exports.isEnabled()) {
    return { stub: true, templates: [] };
  }
  const out = await module.exports.watiFetch("/api/v1/getMessageTemplates", { method: "GET" });
  return { stub: false, templates: out.messageTemplates || out.templates || [] };
}

/**
 * List recent Wati contacts (people who messaged the business number).
 * Used by the travel chat's pull-sync so inbound messages reach the CRM
 * even when the Wati webhook can't reach this backend (e.g. localhost
 * dev without a tunnel). Real mode only.
 */
async function getContacts({ pageSize = 20 } = {}) {
  if (!module.exports.isEnabled()) {
    return { stub: true, contacts: [] };
  }
  const out = await module.exports.watiFetch("/api/v1/getContacts", {
    method: "GET",
    query: { pageSize },
  });
  const contacts = out.contact_list || out.contacts || out.contactList || [];
  return { stub: false, contacts: Array.isArray(contacts) ? contacts : [] };
}

/**
 * Fetch the recent messages of one conversation (by recipient number).
 * Wati item shape (defensively parsed by the sync consumer):
 *   { id, eventType: 'message', text, owner (true = sent by us), created,
 *     conversationId, statusString, type }
 */
async function getMessages({ whatsappNumber, pageSize = 30 }) {
  if (!whatsappNumber) throw new Error("whatsappNumber required");
  if (!module.exports.isEnabled()) {
    return { stub: true, items: [] };
  }
  const to = normalizePhone(whatsappNumber);
  const out = await module.exports.watiFetch(`/api/v1/getMessages/${encodeURIComponent(to)}`, {
    method: "GET",
    query: { pageSize },
  });
  const items = (out.messages && (out.messages.items || out.messages)) || out.items || [];
  return { stub: false, items: Array.isArray(items) ? items : [] };
}

module.exports = {
  isEnabled,
  getConfig,
  normalizePhone,
  resolveChannelNumber,
  persistMessageRow,
  watiFetch,
  sendTemplateMessage,
  sendSessionMessage,
  sendSessionFile,
  sendBestEffort,
  getMessageTemplates,
  getContacts,
  getMessages,
  getMediaResponse,
  REQUEST_TIMEOUT_MS,
};

/**
 * Fetch a media file from Wati (raw Response, NOT json) so the travel
 * media proxy can stream it to the browser. Tries the v1 getMedia path
 * first, falls back to the showFile variant older accounts use.
 * Returns the fetch Response (caller checks .ok / streams .body) or null
 * in stub mode.
 */
async function getMediaResponse(fileName) {
  if (!module.exports.isEnabled()) return null;
  const { endpoint, token } = module.exports.getConfig();
  const headers = { Authorization: `Bearer ${token}` };
  const paths = [
    `${endpoint}/api/v1/getMedia?fileName=${encodeURIComponent(fileName)}`,
    `${endpoint}/api/file/showFile?fileName=${encodeURIComponent(fileName)}`,
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res;
    } catch { /* try next variant */ }
  }
  return null;
}
