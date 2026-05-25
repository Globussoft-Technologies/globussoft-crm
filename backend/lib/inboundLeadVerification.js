// Travel CRM — pure verification helpers for inbound lead payloads (#904).
//
// Slice 3 of the #904 Multi-channel lead capture module (PRD:
// docs/PRD_TRAVEL_MULTICHANNEL_LEADS.md). Pure helpers — no Prisma,
// no fetch, no IO. Returns { ok, reason } envelopes the route can
// destructure in its 401/403/422 branches.
//
// === Why this slice ===
//
// Slice 1 (commit 8b562b0b) shipped POST /api/travel/inbound/leads/:channel
// in STUB mode: it accepts every payload and trusts the channel. That
// scaffold is correct for cred-blocked channels (whatsapp/ads/adsgpt
// pending Q9 Wati creds + Q1 AdsGPT/Meta creds), but the route needs a
// pluggable verification surface so slice 4 can wire real signature
// checks without re-shaping the handler.
//
// This file ships that surface as a pure library; route consumption is
// deferred to slice 4. Pattern follows lib/tcsCalculation.js +
// lib/gstCalculation.js + lib/hsnSacMapper.js — pure helpers land
// before the route call sites.
//
// === Channel verification matrix ===
//
//   voyagr   → HMAC-SHA256 over raw body, header X-Voyagr-Signature (hex)
//              Shared secret env-injected at runtime (VOYAGR_INBOUND_SECRET).
//   webform  → Honeypot-field check (default field name: website_url).
//              A non-empty honeypot value means the form was filled by a
//              bot — humans never see the field (display:none).
//   manual   → No verification — operator-side CRM entry, already
//              authenticated by the surrounding JWT middleware.
//   whatsapp → STUB pending Q9 Wati creds.
//   ads      → STUB pending Q1 AdsGPT/Meta lead-ads webhook signature spec.
//   adsgpt   → STUB pending Q1 (same as ads).
//
// When a STUB channel returns ok:true, it also sets stub:true so the
// route handler can log the bypass + emit a metric for "trusted-payload
// count" — useful telemetry before real verification lands.
//
// === Anti-spam pattern list ===
//
// Intentionally narrow + obvious: viagra / casino / "crypto wallet" /
// `<script` tag. These are heuristic only — we are NOT trying to be a
// spam filter, just rejecting the most obvious bot drive-bys. Real
// spam-filtering belongs at the WAF / Cloudflare layer, not in route
// code. Expanding this list silently is a maintenance hazard; if more
// patterns are needed, add them with a comment explaining the
// observation that motivated each one.

const crypto = require("crypto");

/**
 * Verify Voyagr HMAC-SHA256 signature using timing-safe compare.
 *
 * @param {object} args
 * @param {string} args.payload   raw request body as a string
 * @param {string} args.signature X-Voyagr-Signature header value (hex)
 * @param {string} args.secret    shared secret (env-injected)
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyVoyagrHmac({ payload, signature, secret } = {}) {
  if (!payload || !signature || !secret) {
    return { ok: false, reason: "MISSING_INPUTS" };
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  // timingSafeEqual requires equal-length buffers; pre-check guards
  // against allocation + throws on mismatched lengths.
  if (expected.length !== signature.length) {
    return { ok: false, reason: "SIGNATURE_LENGTH_MISMATCH" };
  }
  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");
  if (!crypto.timingSafeEqual(expectedBuf, signatureBuf)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  return { ok: true };
}

/**
 * Verify web-form payload — honeypot field check.
 *
 * A honeypot field is rendered display:none in the public form so
 * real users never see it. Bots auto-fill every input they see; any
 * non-empty value here is a strong bot signal.
 *
 * @param {object} args
 * @param {object} args.body                 request body (parsed object)
 * @param {string} [args.honeypotFieldName]  default "website_url"
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyWebForm({ body, honeypotFieldName = "website_url" } = {}) {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "EMPTY_BODY" };
  }
  const honeypotValue = body[honeypotFieldName];
  if (honeypotValue !== undefined && honeypotValue !== null) {
    if (String(honeypotValue).trim() !== "") {
      return { ok: false, reason: "HONEYPOT_TRIPPED" };
    }
  }
  return { ok: true };
}

/**
 * Permissive email validation. Defers strict RFC-5322 to send-time;
 * here we just want "looks plausible".
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Permissive phone validation. Strips non-digit chars and requires
 * 7-15 digit length — covers Indian (10) + international (E.164 up
 * to 15).
 *
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  if (!phone || typeof phone !== "string") return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Anti-spam heuristics — see header for rationale. Each entry should
// have a justifying observation when added.
const SPAM_PATTERNS = [
  /viagra/i, // drive-by pharma spam
  /casino/i, // gambling spam
  /\bcrypto\s+wallet\b/i, // crypto-recovery scam form-fill
  /<script\b/i, // attempted XSS in lead text
];

/**
 * @param {object} body
 * @returns {{ok: boolean, reason?: string}}
 */
function checkAntiSpam(body) {
  if (!body) return { ok: true };
  let allText;
  try {
    allText = JSON.stringify(body);
  } catch {
    // Circular reference or similar — treat as suspicious.
    return { ok: false, reason: "BODY_NOT_SERIALIZABLE" };
  }
  for (const pat of SPAM_PATTERNS) {
    if (pat.test(allText)) {
      const reasonToken = pat.source
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
      return { ok: false, reason: `SPAM_PATTERN_${reasonToken}` };
    }
  }
  return { ok: true };
}

/**
 * Dispatch verification based on channel.
 *
 * @param {string} channel  voyagr|webform|whatsapp|ads|adsgpt|manual
 * @param {object} args     channel-specific args (forwarded as-is)
 * @returns {{ok: boolean, reason?: string, channel: string, stub?: boolean}}
 */
function verifyByChannel(channel, args = {}) {
  let result;
  switch (channel) {
    case "voyagr":
      result = verifyVoyagrHmac(args);
      break;
    case "webform":
      result = verifyWebForm(args);
      break;
    case "manual":
      result = { ok: true };
      break;
    case "whatsapp":
    case "ads":
    case "adsgpt":
      // STUB pending Q9 (Wati) + Q1 (AdsGPT/Meta). Slice 4 will swap
      // these branches to real signature verification once creds land.
      result = { ok: true, stub: true };
      break;
    default:
      result = { ok: false, reason: "UNKNOWN_CHANNEL" };
  }
  return { ...result, channel };
}

module.exports = {
  verifyVoyagrHmac,
  verifyWebForm,
  isValidEmail,
  isValidPhone,
  checkAntiSpam,
  verifyByChannel,
  SPAM_PATTERNS,
};
