/**
 * waTransportDTO.js — the normalized, transport-agnostic DTO boundary between
 * the WhatsApp TRANSPORT (whatsapp-web.js/Puppeteer — in-process today, the
 * standalone WhatsApp Gateway after extraction) and the CRM BACKEND persistence
 * layer (Prisma + Socket.IO + lead capture).
 *
 * WHY THIS EXISTS — services/whatsappWebClient.js historically consumed raw
 * whatsapp-web.js `msg` objects directly inside ingestInbound/applyAck/import.
 * Those objects only exist inside the live Puppeteer session, so they can't
 * cross a process boundary. These helpers extract the plain-data fields the
 * backend actually needs into flat JSON DTOs that serialize cleanly over the
 * gateway's events webhook — and behave identically in-process.
 *
 * SCOPE — PURE field extraction/normalization ONLY. No Prisma, no Socket.IO, no
 * live client, no media download. Classification (chatAddressKind /
 * isContentMessage / resolveIndividual) stays in whatsappWebClient so there is a
 * single source of truth for it; this module only shapes data.
 *
 * See docs/WHATSAPP_GATEWAY_EXTRACTION.md §2 (DTO boundary) for the full shapes.
 *
 * @typedef {Object} AckDTO
 * @property {string|null} providerMsgId
 * @property {number} ack   whatsapp-web.js ack int (-1..4)
 *
 * @typedef {Object} InboundMessageDTO
 * @property {string|null} providerMsgId
 * @property {string} from            raw wweb address ("<id>@c.us" | "@lid" | "@g.us")
 * @property {boolean} fromMe
 * @property {boolean} isGroup
 * @property {string} type            wweb message type ("chat"/"image"/…)
 * @property {string|null} body
 * @property {string|null} notifyName WhatsApp push name (pre-clean)
 * @property {boolean} hasMedia
 * @property {number|null} timestamp  unix seconds
 *
 * @typedef {Object} HistoryMessageDTO  (a single message during import/backfill)
 * @property {string|null} providerMsgId
 * @property {boolean} outbound
 * @property {string} type
 * @property {string|null} body
 * @property {boolean} hasMedia
 * @property {number|null} timestamp
 * @property {number|null} ack
 * @property {string|null} notifyName
 */

// Serialized message id, or null. Mirrors `msg.id._serialized` access used
// everywhere in whatsappWebClient so callers don't re-implement the guard.
function messageIdOf(msg) {
  return msg && msg.id ? msg.id._serialized || null : null;
}

// whatsapp-web.js ack event → AckDTO. Pure. Kept here (and re-exported from
// whatsappWebClient as toAckDTO) so both the in-process path and the gateway
// build the same shape.
function toAckDTO(msg, ack) {
  return { providerMsgId: messageIdOf(msg), ack: Number(ack) };
}

// Extract the plain-data content fields of an inbound wweb message. Does NOT
// download media (that needs the live session) and does NOT classify/resolve
// the sender — the caller (which has the session) fills media + resolved phone.
function toInboundContentDTO(msg) {
  if (!msg) return null;
  return {
    providerMsgId: messageIdOf(msg),
    from: msg.from || "",
    fromMe: Boolean(msg.fromMe),
    type: String(msg.type || "chat").toLowerCase(),
    body: typeof msg.body === "string" && msg.body !== "" ? msg.body : null,
    notifyName: (msg._data && msg._data.notifyName) || null,
    hasMedia: Boolean(msg.hasMedia),
    timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : null,
  };
}

// Extract a single history message (import/backfill) into a HistoryMessageDTO.
// Same purity contract as toInboundContentDTO; `ack` is carried so an imported
// outbound row lands at the right status.
function toHistoryMessageDTO(msg) {
  if (!msg) return null;
  return {
    providerMsgId: messageIdOf(msg),
    outbound: Boolean(msg.fromMe),
    type: String(msg.type || "chat").toLowerCase(),
    body: typeof msg.body === "string" && msg.body.trim() !== "" ? msg.body : null,
    hasMedia: Boolean(msg.hasMedia),
    timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : null,
    ack: Number.isFinite(msg.ack) ? msg.ack : null,
    notifyName: (msg._data && msg._data.notifyName) || null,
  };
}

// Public connection state → StateDTO (the JSON-safe shape getState already
// returns). Defined here so the gateway's /state endpoint and the backend
// state cache agree on the field set.
function toStateDTO({ state, connected, phone, qr, lastError } = {}) {
  return {
    state: state || "DISCONNECTED",
    connected: Boolean(connected),
    phone: phone || null,
    qr: qr || null,
    lastError: lastError || null,
  };
}

module.exports = {
  messageIdOf,
  toAckDTO,
  toInboundContentDTO,
  toHistoryMessageDTO,
  toStateDTO,
};
