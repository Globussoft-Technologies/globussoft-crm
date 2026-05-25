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

/**
 * Normalize an arbitrary phone string to its digits-only canonical form,
 * used as the dedup key for tenant-scoped Contact lookups (PRD §3.2.1).
 *
 * Mirrors `utils/deduplication.js#normalizePhone` but is a pure local
 * copy so this lib stays IO-free — the route layer's prisma singleton
 * mock would otherwise leak through utils/deduplication's own
 * PrismaClient instantiation.
 *
 * Rules (Indian-default — clinics + travel are India-first):
 *   - empty / null / non-string → null
 *   - all non-digit chars stripped
 *   - 10-digit result → prepend "91" (Indian mobile assumption)
 *   - otherwise return digits-only as-is (so already-E.164 12-digit
 *     `919876543210` and 11-digit US `15551234567` both round-trip
 *     intact)
 *   - empty-after-strip → null
 *
 * Returns the digits-only canonical key — NOT the user-facing `+91…`
 * display form. Two inputs that should dedup MUST produce the same
 * output here:
 *   "9876543210" → "919876543210"
 *   "+91 98765-43210" → "919876543210"
 *   "+919876543210" → "919876543210"
 *
 * @param {string} phone
 * @returns {string|null}
 */
function normalizePhoneForDedup(phone) {
  if (!phone || typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return "91" + digits;
  return digits;
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
 * Slice 11 — Inbound-lead junk classification heuristic (PRD §3.2 + §3.4).
 *
 * Flags a payload as `junk` when the trust signal is weak AND the payload
 * carries no identifying data beyond a single contact-method digit. The
 * route applies the verdict by writing `status: 'Junk'` (free-string field
 * on Contact) instead of the default `'Lead'`, so the operator UI's leads
 * page can filter junk out of the inbox by default.
 *
 * Heuristic — junk = true when ALL of these hold:
 *   1. The verification was STUB-trusted (channel returned {stub:true}, e.g.
 *      whatsapp/ads/adsgpt pre-Q9/Q1 cred drop) OR was bypassed entirely
 *      (verification.bypassed:true — passed in by the route when
 *      VOYAGR_HMAC_SECRET is unset). A signed/honeypotted payload from a
 *      real producer is NEVER junk by this rule.
 *   2. No name signal — neither `body.name` nor the firstName+lastName pair
 *      carries a non-empty string. (Bots routinely skip name fields.)
 *   3. No real email — the route synthesized the placeholder
 *      `inbound-<channel>-<ts>@imported.local` because the producer didn't
 *      send one (`hasRealEmail` is the inbound flag).
 *   4. No `company`, `subBrand`, or `metaJson` extras in the body — these
 *      are the secondary-signal fields that real leads tend to carry.
 *   5. Normalized phone (if present) is the ONLY contact field. A
 *      no-phone-AND-no-real-email payload is rejected upstream by the
 *      MISSING_CONTACT 400, so this branch is really "phone-only,
 *      minimal-payload."
 *
 * Why "STUB-trusted" not "HMAC-failed": HMAC failure already 400s in the
 * route (VERIFICATION_FAILED). Junk-classification is for payloads that
 * PASSED verification but carry minimal-signal data — the weak-signal
 * class that real-spam-filtering would handle at the WAF layer but we
 * still want app-tier visibility into. Per PRD §3.2 "soft dedup" + the
 * cron-learning standing rule "client-side aggregation over a paginated
 * endpoint is a structural correctness bug," we want the dashboard to
 * see a Junk vs Lead split that mirrors the actual data quality.
 *
 * NOT a hard block — junk leads still persist (operator can promote them
 * later if a real conversion happens). This differs from the
 * VERIFICATION_FAILED / SPAM_PATTERN paths which 400 + drop the payload.
 *
 * Pure helper — IO-free, no Prisma, no fetch. Returns the verdict +
 * reason list for observability + AuditLog hand-off.
 *
 * @param {object} args
 * @param {{ok: boolean, stub?: boolean, bypassed?: boolean}} args.verification
 * @param {object} args.body                 the raw request body
 * @param {string|null} args.normalizedPhone the digits-only canonical phone
 * @param {boolean} args.hasRealEmail        true when caller-supplied email is a real one
 * @returns {{junk: boolean, reasons: string[]}}
 */
function classifyInboundJunk({
  verification,
  body,
  normalizedPhone,
  hasRealEmail,
} = {}) {
  const reasons = [];
  const v = verification || {};
  if (!v.stub && !v.bypassed) {
    return { junk: false, reasons: [] };
  }
  // Channel was either STUB-trusted or HMAC-bypassed — proceed to check the
  // payload signal.
  reasons.push(v.bypassed ? "VERIFICATION_BYPASSED" : "VERIFICATION_STUB");

  const b = body || {};
  const nameRaw = b.name && String(b.name).trim();
  const firstRaw = b.firstName && String(b.firstName).trim();
  const lastRaw = b.lastName && String(b.lastName).trim();
  if (nameRaw || firstRaw || lastRaw) {
    // Name present — not junk.
    return { junk: false, reasons: [] };
  }
  reasons.push("NO_NAME");

  if (hasRealEmail) {
    // Real email present — not junk.
    return { junk: false, reasons: [] };
  }
  reasons.push("NO_REAL_EMAIL");

  const companyRaw = b.company && String(b.company).trim();
  const subBrandRaw = b.subBrand && String(b.subBrand).trim();
  const metaRaw = b.metaJson;
  if (companyRaw || subBrandRaw || metaRaw) {
    // Secondary signal present — not junk.
    return { junk: false, reasons: [] };
  }
  reasons.push("NO_SECONDARY_SIGNAL");

  // Reached only when verification is stub/bypassed AND no name AND no real
  // email AND no secondary signal. Phone may or may not be present (the
  // MISSING_CONTACT 400 upstream guarantees ≥1 contact field).
  if (!normalizedPhone) {
    reasons.push("NO_PHONE");
  }
  return { junk: true, reasons };
}

/**
 * Slice 12 — Normalize a Meta lead-ads webhook payload into the route's
 * canonical body shape (PRD §3.4.3 + §1.1's launch-critical Meta channel).
 *
 * Meta delivers lead-ad submissions as a `field_data` array of
 * `{ name, values: [...] }` pairs:
 *
 *   {
 *     "leadgen_id": "1234567890",
 *     "form_id": "987654321",
 *     "ad_id": "111",
 *     "campaign_id": "222",
 *     "created_time": "2026-05-25T10:00:00+0000",
 *     "field_data": [
 *       { "name": "full_name", "values": ["Asha Verma"] },
 *       { "name": "email", "values": ["asha@example.com"] },
 *       { "name": "phone_number", "values": ["+919876543210"] }
 *     ]
 *   }
 *
 * The route expects flat `{ firstName?, lastName?, name?, email?, phone?,
 * subBrand?, metaJson? }` (see slice 1 docstring). This helper bridges the
 * two without forcing the route handler to grow channel-shape branches.
 *
 * Behavior:
 *   - If `body.field_data` is absent or not an array, returns the body
 *     untouched (pre-normalized callers and non-Meta payloads pass through).
 *   - Maps known Meta field-names to canonical fields:
 *       full_name | name             → name
 *       first_name | given_name      → firstName
 *       last_name | family_name      → lastName
 *       email                        → email
 *       phone_number | phone         → phone
 *       company_name | company       → company
 *       sub_brand | subBrand         → subBrand
 *   - Caller-supplied flat fields WIN over field_data extraction (so a
 *     pre-normalized payload that also carries field_data — defensive
 *     producer — keeps the explicit values).
 *   - Preserves leadgen_id / form_id / ad_id / campaign_id / created_time
 *     under `metaJson` so downstream attribution rollups can read them
 *     without re-querying Meta.
 *   - Each `values` array is collapsed to its first entry (Meta convention:
 *     single-value fields ship a 1-element array; multi-select fields not
 *     supported in this slice — out-of-scope per PRD §7).
 *   - Unknown field names are preserved under `metaJson.extraFields`
 *     (object keyed by Meta field name) so ops can debug "why is this
 *     field not flowing through" without losing data.
 *
 * Pure helper — IO-free, no Prisma. Returns a NEW object; does not mutate
 * the input body.
 *
 * @param {object} body  raw request body (Meta webhook payload OR
 *                       pre-normalized flat shape)
 * @returns {object}     canonical flat body the route handler expects
 */
function normalizeMetaLeadPayload(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.field_data)) return body;

  // Map Meta field-names → canonical route fields. Multiple Meta tokens
  // can land on the same canonical field (e.g. `full_name` / `name` both
  // → name) because Meta's form-builder lets producers name fields
  // freely; we keep the alias list narrow to the documented standard
  // fields.
  const FIELD_MAP = {
    full_name: "name",
    name: "name",
    first_name: "firstName",
    given_name: "firstName",
    last_name: "lastName",
    family_name: "lastName",
    email: "email",
    phone_number: "phone",
    phone: "phone",
    company_name: "company",
    company: "company",
    sub_brand: "subBrand",
    subBrand: "subBrand",
  };

  const extracted = {};
  const extraFields = {};

  for (const entry of body.field_data) {
    if (!entry || typeof entry !== "object") continue;
    const rawName = entry.name;
    if (!rawName || typeof rawName !== "string") continue;
    // Meta convention: single-value fields ship a 1-element array. Defend
    // against producers shipping a bare string (older lead-ads format).
    let value;
    if (Array.isArray(entry.values) && entry.values.length > 0) {
      value = entry.values[0];
    } else if (typeof entry.values === "string") {
      value = entry.values;
    } else {
      continue;
    }
    if (value === null || value === undefined) continue;
    const canonical = FIELD_MAP[rawName];
    if (canonical) {
      // Caller-supplied flat field wins over field_data extraction.
      if (extracted[canonical] === undefined) {
        extracted[canonical] = value;
      }
    } else {
      extraFields[rawName] = value;
    }
  }

  // Preserve Meta-specific attribution tokens under metaJson so the
  // route's downstream code can read them without re-querying Meta.
  const metaTokens = {};
  for (const k of [
    "leadgen_id",
    "form_id",
    "ad_id",
    "campaign_id",
    "created_time",
    "page_id",
  ]) {
    if (body[k] !== undefined && body[k] !== null) {
      metaTokens[k] = body[k];
    }
  }
  const hasExtras = Object.keys(extraFields).length > 0;
  const hasMetaTokens = Object.keys(metaTokens).length > 0;

  // Shallow-clone the body, then layer extracted-canonical fields BEHIND
  // caller-supplied flat fields (caller wins), then merge metaJson.
  const out = { ...body };
  // Strip field_data from the output so the route doesn't ingest it as
  // a Contact-shaped payload field.
  delete out.field_data;

  for (const [k, v] of Object.entries(extracted)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") {
      out[k] = v;
    }
  }

  if (hasMetaTokens || hasExtras) {
    const existingMeta =
      out.metaJson && typeof out.metaJson === "object" ? out.metaJson : {};
    const mergedMeta = { ...existingMeta };
    for (const [k, v] of Object.entries(metaTokens)) {
      if (mergedMeta[k] === undefined) mergedMeta[k] = v;
    }
    if (hasExtras) {
      mergedMeta.extraFields = {
        ...(existingMeta.extraFields || {}),
        ...extraFields,
      };
    }
    out.metaJson = mergedMeta;
  }

  return out;
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
  normalizePhoneForDedup,
  checkAntiSpam,
  verifyByChannel,
  classifyInboundJunk,
  normalizeMetaLeadPayload,
  SPAM_PATTERNS,
};
