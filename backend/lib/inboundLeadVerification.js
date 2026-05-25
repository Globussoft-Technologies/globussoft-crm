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
 * Slice 13 — Normalize an IndiaMART CRM Listing API payload into the route's
 * canonical body shape (PRD §3.4.2 marketplace backpressure + §1.1's
 * launch-critical marketplace channel cluster).
 *
 * IndiaMART delivers each lead row as a `SENDER_*` / `QUERY_*` SCREAMING_SNAKE
 * dict from `https://mapi.indiamart.com/wservce/crm/crmListing/v2/`:
 *
 *   {
 *     "UNIQUE_QUERY_ID": "1234567890",
 *     "QUERY_ID": "Q-1",
 *     "SENDER_NAME": "Asha Verma",
 *     "SENDER_EMAIL": "asha@example.com",
 *     "SENDER_MOBILE": "+919876543210",   // or SENDER_PHONE
 *     "SENDER_COMPANY": "Acme Travels",
 *     "SENDER_CITY": "Mumbai",
 *     "SENDER_STATE": "MH",
 *     "SENDER_COUNTRY_ISO": "IN",
 *     "QUERY_PRODUCT_NAME": "Umrah Package",
 *     "QUERY_MESSAGE": "Need a quote",
 *     "QUERY_TYPE": "B",
 *     "QUERY_TIME": "2026-05-25 10:00:00"
 *   }
 *
 * The route expects flat `{ firstName?, lastName?, name?, email?, phone?,
 * subBrand?, metaJson? }` (see slice 1 docstring + slice 12 Meta normalizer
 * for the same shape contract). This helper bridges the two so the route's
 * channel taxonomy can grow without forcing the handler to sprout per-vendor
 * branches.
 *
 * Behavior (mirrors normalizeMetaLeadPayload's discipline):
 *   - Detection: the helper looks for the IndiaMART signature key set
 *     (`UNIQUE_QUERY_ID` OR `QUERY_ID` OR `SENDER_NAME` / `SENDER_MOBILE` /
 *     `SENDER_EMAIL`). When NONE of these are present, the helper returns
 *     the body untouched (no-op for pre-normalized callers + non-IndiaMART
 *     payloads).
 *   - Maps the known IndiaMART field names to canonical fields:
 *       SENDER_NAME                    → name
 *       SENDER_EMAIL                   → email
 *       SENDER_MOBILE | SENDER_PHONE   → phone
 *       SENDER_COMPANY                 → company
 *   - Caller-supplied flat fields WIN (so a pre-normalized payload that also
 *     carries `SENDER_*` keys — defensive producer — keeps the explicit
 *     values).
 *   - Preserves IndiaMART attribution + lead-context tokens under metaJson:
 *       UNIQUE_QUERY_ID / QUERY_ID                  (lead identity)
 *       QUERY_PRODUCT_NAME / QUERY_MESSAGE          (lead intent)
 *       QUERY_TYPE / QUERY_TIME                     (lead metadata)
 *       SENDER_CITY / SENDER_STATE / SENDER_COUNTRY_ISO  (geo)
 *   - Unknown SCREAMING_SNAKE keys (any field starting with SENDER_ or
 *     QUERY_ that didn't map to a canonical field or known meta token) are
 *     preserved under `metaJson.extraFields` so ops can debug missing
 *     mappings without losing data.
 *   - The original SCREAMING_SNAKE keys are stripped from the output so the
 *     route handler doesn't accidentally ingest them as Contact-shaped
 *     fields (mirrors the slice-12 `delete field_data` step).
 *
 * Pure helper — IO-free, no Prisma. Returns a NEW object; does not mutate
 * the input body.
 *
 * @param {object} body  raw request body (IndiaMART webhook row OR
 *                       pre-normalized flat shape)
 * @returns {object}     canonical flat body the route handler expects
 */
function normalizeIndiamartLeadPayload(body) {
  if (!body || typeof body !== "object") return body;

  // Detection — IndiaMART rows always carry at least one of these. Without
  // them, the helper is a no-op so pre-normalized callers + non-IndiaMART
  // payloads pass through untouched.
  const SIGNATURE_KEYS = [
    "UNIQUE_QUERY_ID",
    "QUERY_ID",
    "SENDER_NAME",
    "SENDER_MOBILE",
    "SENDER_PHONE",
    "SENDER_EMAIL",
  ];
  const isIndiamartShape = SIGNATURE_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(body, k),
  );
  if (!isIndiamartShape) return body;

  // Map IndiaMART field names → canonical route fields. Multiple IndiaMART
  // tokens can land on the same canonical field (SENDER_MOBILE +
  // SENDER_PHONE both → phone) because the vendor's payload schema has
  // historically shipped phone under either key depending on the form-type.
  const FIELD_MAP = {
    SENDER_NAME: "name",
    SENDER_EMAIL: "email",
    SENDER_MOBILE: "phone",
    SENDER_PHONE: "phone",
    SENDER_COMPANY: "company",
  };

  // IndiaMART attribution + lead-context tokens that downstream attribution
  // rollups need to read without re-querying IndiaMART. Mirrors the Meta
  // normalizer's metaTokens block.
  const META_TOKENS = [
    "UNIQUE_QUERY_ID",
    "QUERY_ID",
    "QUERY_PRODUCT_NAME",
    "QUERY_MESSAGE",
    "QUERY_TYPE",
    "QUERY_TIME",
    "SENDER_CITY",
    "SENDER_STATE",
    "SENDER_COUNTRY_ISO",
  ];

  const extracted = {};
  const extraFields = {};
  const metaTokens = {};

  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;

    const canonical = FIELD_MAP[k];
    if (canonical) {
      if (extracted[canonical] === undefined) {
        extracted[canonical] = v;
      }
      continue;
    }
    if (META_TOKENS.includes(k)) {
      metaTokens[k] = v;
      continue;
    }
    // Unmapped SCREAMING_SNAKE key starting with SENDER_ or QUERY_ — preserve
    // under extraFields so ops can debug. Plain camelCase / snake_case keys
    // that aren't IndiaMART tokens (e.g. caller-supplied `subBrand`,
    // `tenantSlug`) are NOT shoveled into extraFields — they survive
    // untouched on the output body.
    if (/^(SENDER_|QUERY_)/.test(k)) {
      extraFields[k] = v;
    }
  }

  const hasMetaTokens = Object.keys(metaTokens).length > 0;
  const hasExtras = Object.keys(extraFields).length > 0;

  // Shallow-clone the body, strip the IndiaMART-shaped keys we've consumed
  // (so the route handler doesn't ingest SENDER_NAME etc. as a
  // Contact-shaped field), then layer extracted-canonical fields BEHIND
  // caller-supplied flat fields (caller wins).
  const out = { ...body };
  for (const k of Object.keys(FIELD_MAP)) delete out[k];
  for (const k of META_TOKENS) delete out[k];
  for (const k of Object.keys(extraFields)) delete out[k];

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

/**
 * Slice 14 — Normalize a JustDial lead-feed payload into the route's canonical
 * body shape (PRD §3.4.2 marketplace backpressure + §1.1 launch-critical
 * marketplace channel cluster). Sister to the slice-12 Meta normalizer and the
 * slice-13 IndiaMART normalizer.
 *
 * JustDial delivers each lead row as a lowercase-key dict from their lead
 * feed API (`https://api.justdial.com/...`):
 *
 *   {
 *     "leadid": "JD-9876543",
 *     "enquiry_id": "EQ-12345",
 *     "name": "Asha Verma",
 *     "email": "asha@example.com",
 *     "mobile": "+919876543210",
 *     "prefixedmobileno": "+919876543210",
 *     "company": "Acme Travels",
 *     "city": "Mumbai",
 *     "area": "Andheri",
 *     "branchpin": "400053",
 *     "category": "Travel Agents",
 *     "subcategory": "Umrah Package",
 *     "query": "Looking for Umrah Q4",
 *     "enquirydate": "2026-05-25 10:00:00",
 *     "source": "justdial-web"
 *   }
 *
 * The route expects flat `{ firstName?, lastName?, name?, email?, phone?,
 * subBrand?, metaJson? }` (see slice 1 docstring; the slice-12 Meta + slice-13
 * IndiaMART normalizers established the bridge pattern). This helper plugs
 * JustDial into the same contract.
 *
 * Behavior (mirrors normalizeIndiamartLeadPayload's discipline):
 *   - Detection: looks for the JustDial signature key set (`leadid` OR
 *     `enquiry_id` OR `prefixedmobileno` OR `enquirydate` OR `branchpin`).
 *     When NONE of these are present the helper returns the body untouched
 *     (pre-normalized callers + non-JustDial payloads pass through). Note
 *     that bare `mobile` / `name` / `email` are NOT signature keys because
 *     they collide with the route's own canonical flat shape — we require
 *     at least one JustDial-specific key to switch into normalization mode.
 *   - Maps JustDial field names → canonical route fields:
 *       name                            → name
 *       email                           → email
 *       prefixedmobileno | mobile       → phone
 *       company                         → company
 *   - Caller-supplied flat fields WIN over JustDial extraction (defensive
 *     producer that ships both shapes keeps the explicit values).
 *   - Preserves JustDial attribution + lead-context tokens under metaJson:
 *       leadid / enquiry_id              (lead identity)
 *       category / subcategory           (lead intent)
 *       query                            (lead message)
 *       enquirydate                      (lead timestamp)
 *       city / area / branchpin          (geo)
 *   - Unknown JustDial-shaped keys (lowercase tokens not in the field/meta
 *     map) are LEFT untouched on the body — JustDial's payload uses generic
 *     lowercase keys (no SENDER_/QUERY_-style prefix), so we can't safely
 *     shovel "unknown lowercase keys" into extraFields without sweeping up
 *     legitimate route-canonical fields. The conservative move is to leave
 *     unknowns where they are and let downstream code ignore them.
 *   - The original JustDial keys we DID consume (name/email/mobile/etc.) are
 *     stripped from the output so the route handler doesn't ingest stale
 *     duplicates of the canonical flat fields.
 *
 * Pure helper — IO-free, no Prisma. Returns a NEW object; does not mutate
 * the input body.
 *
 * @param {object} body  raw request body (JustDial lead-feed row OR
 *                       pre-normalized flat shape)
 * @returns {object}     canonical flat body the route handler expects
 */
function normalizeJustdialLeadPayload(body) {
  if (!body || typeof body !== "object") return body;

  // Detection — JustDial rows always carry at least one of these. Bare
  // `mobile` / `name` / `email` are NOT signature keys because they overlap
  // with the route's own canonical flat shape; we'd misclassify pre-
  // normalized callers as JustDial payloads and strip their fields.
  const SIGNATURE_KEYS = [
    "leadid",
    "enquiry_id",
    "prefixedmobileno",
    "enquirydate",
    "branchpin",
  ];
  const isJustdialShape = SIGNATURE_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(body, k),
  );
  if (!isJustdialShape) return body;

  // Map JustDial field names → canonical route fields. `prefixedmobileno`
  // is JustDial's newer E.164-formatted phone column; `mobile` is the
  // legacy local-format column. Producers may ship either or both; we
  // prefer prefixedmobileno when present because it's already E.164.
  const FIELD_MAP = {
    name: "name",
    email: "email",
    prefixedmobileno: "phone",
    mobile: "phone",
    company: "company",
  };

  // JustDial attribution + lead-context tokens that downstream attribution
  // rollups need to read without re-querying JustDial.
  const META_TOKENS = [
    "leadid",
    "enquiry_id",
    "category",
    "subcategory",
    "query",
    "enquirydate",
    "city",
    "area",
    "branchpin",
  ];

  const extracted = {};
  const metaTokens = {};

  // Preference order for phone: prefixedmobileno wins over mobile (newer
  // E.164 convention beats legacy local format). We process in map order
  // but explicitly check prefixedmobileno first to lock the precedence.
  if (
    body.prefixedmobileno !== undefined &&
    body.prefixedmobileno !== null &&
    !(typeof body.prefixedmobileno === "string" &&
      body.prefixedmobileno.trim() === "")
  ) {
    extracted.phone = body.prefixedmobileno;
  } else if (
    body.mobile !== undefined &&
    body.mobile !== null &&
    !(typeof body.mobile === "string" && body.mobile.trim() === "")
  ) {
    extracted.phone = body.mobile;
  }

  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;

    const canonical = FIELD_MAP[k];
    if (canonical) {
      // Phone is already resolved above by precedence; skip re-extraction.
      if (canonical === "phone") continue;
      if (extracted[canonical] === undefined) {
        extracted[canonical] = v;
      }
      continue;
    }
    if (META_TOKENS.includes(k)) {
      metaTokens[k] = v;
    }
    // Unknown lowercase keys are LEFT on the body — see header comment for
    // why we don't sweep them into extraFields (collision risk with the
    // route's own canonical shape).
  }

  const hasMetaTokens = Object.keys(metaTokens).length > 0;

  // Shallow-clone the body, strip the JustDial-shaped keys we consumed (so
  // the route handler doesn't ingest `mobile` / `prefixedmobileno` etc. as
  // Contact-shaped fields), then layer extracted-canonical fields BEHIND
  // caller-supplied flat fields (caller wins).
  const out = { ...body };
  for (const k of Object.keys(FIELD_MAP)) delete out[k];
  for (const k of META_TOKENS) delete out[k];

  for (const [k, v] of Object.entries(extracted)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") {
      out[k] = v;
    }
  }

  if (hasMetaTokens) {
    const existingMeta =
      out.metaJson && typeof out.metaJson === "object" ? out.metaJson : {};
    const mergedMeta = { ...existingMeta };
    for (const [k, v] of Object.entries(metaTokens)) {
      if (mergedMeta[k] === undefined) mergedMeta[k] = v;
    }
    out.metaJson = mergedMeta;
  }

  return out;
}

/**
 * Slice 15 — Normalize a TradeIndia lead-feed payload into the route's canonical
 * body shape (PRD §3.4.2 marketplace backpressure + §1.1 launch-critical
 * marketplace channel cluster). Sister to the slice-12 Meta, slice-13 IndiaMART,
 * and slice-14 JustDial normalizers — completes the four-marketplace cluster.
 *
 * TradeIndia (tradeindia.com) is a B2B marketplace similar to IndiaMART; their
 * lead-feed API ships each enquiry row as a lowercase + snake_case dict:
 *
 *   {
 *     "query_id": "TI-9988776",
 *     "sender_name": "Asha Verma",
 *     "sender_company": "Acme Travels",
 *     "email_id": "asha@example.com",
 *     "mobile": "+919876543210",
 *     "subject": "Umrah package enquiry",
 *     "query_details": "Looking for Umrah Q4 family of 4",
 *     "product_name": "Umrah Package",
 *     "query_time": "2026-05-25 10:00:00",
 *     "sender_city": "Mumbai",
 *     "sender_state": "Maharashtra",
 *     "sender_country": "India"
 *   }
 *
 * Note on field-name uncertainty: TradeIndia has shipped multiple lead-feed API
 * versions over the years (the older buyer-leads API used `mob_no` / `phone`;
 * the newer enquiry API uses `mobile`). This normalizer accepts the union —
 * `mobile`, `mob_no`, and `phone` all map to canonical `phone`; `email_id` and
 * `email` both map to canonical `email`; `sender_name` and `name` both map to
 * canonical `name`. Producers may ship either older or newer shape.
 *
 * The route expects flat `{ firstName?, lastName?, name?, email?, phone?,
 * subBrand?, metaJson? }` (see slice 1 docstring; the slice-12/13/14 normalizers
 * established the bridge pattern). This helper plugs TradeIndia into the same
 * contract.
 *
 * Behavior (mirrors normalizeIndiamartLeadPayload's discipline — TradeIndia's
 * snake_case shape is closer to IndiaMART than to JustDial):
 *   - Detection: looks for TradeIndia signature keys (`sender_company` OR
 *     `query_details` OR `query_id`). These three are distinctive — IndiaMART
 *     uses SCREAMING_SNAKE for the same concepts and JustDial uses bare
 *     `company` / `query` / `leadid`, so the lowercase snake_case form is
 *     TradeIndia-specific. When NONE of these are present the helper returns
 *     the body untouched (pre-normalized callers + non-TradeIndia payloads
 *     pass through). Bare `mobile` / `email_id` are NOT signature keys because
 *     they overlap with the route's own canonical shape.
 *   - Maps TradeIndia field names → canonical route fields:
 *       sender_name | name               → name
 *       email_id | email                 → email
 *       mobile | mob_no | phone          → phone
 *       sender_company | company         → company
 *   - Caller-supplied flat fields WIN over TradeIndia extraction (defensive
 *     producer that ships both shapes keeps the explicit values).
 *   - Preserves TradeIndia attribution + lead-context tokens under metaJson:
 *       query_id                          (lead identity)
 *       subject / query_details           (lead intent + message)
 *       product_name                      (lead product)
 *       query_time                        (lead timestamp)
 *       sender_city / sender_state /
 *         sender_country                  (geo)
 *   - Unknown snake_case keys starting with `sender_` or `query_` that didn't
 *     map to a canonical field or known meta token are preserved under
 *     `metaJson.extraFields` so ops can debug missing mappings without losing
 *     data (mirrors the IndiaMART normalizer's extraFields discipline).
 *   - The original TradeIndia keys we DID consume are stripped from the
 *     output so the route handler doesn't ingest stale duplicates of the
 *     canonical flat fields.
 *
 * subBrand stays `null` here — TradeIndia doesn't surface a sub-brand hint in
 * its lead-feed payload; the route resolves subBrand from tenant context later
 * in the pipeline. Phone normalization is downstream (the normalizer ships the
 * raw vendor value verbatim).
 *
 * Pure helper — IO-free, no Prisma. Returns a NEW object; does not mutate the
 * input body.
 *
 * @param {object} body  raw request body (TradeIndia lead-feed row OR
 *                       pre-normalized flat shape)
 * @returns {object}     canonical flat body the route handler expects
 */
function normalizeTradeindiaLeadPayload(body) {
  if (!body || typeof body !== "object") return body;

  // Detection — TradeIndia-distinctive snake_case keys. We intentionally do
  // NOT include bare `mobile` / `email_id` because they overlap with the
  // route's own canonical shape; signature must be TradeIndia-specific.
  const SIGNATURE_KEYS = ["sender_company", "query_details", "query_id"];
  const isTradeindiaShape = SIGNATURE_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(body, k),
  );
  if (!isTradeindiaShape) return body;

  // Map TradeIndia field names → canonical route fields. Multiple TradeIndia
  // tokens may land on the same canonical field across API-version drift
  // (mob_no = older buyer-leads API; mobile = newer enquiry API; phone is
  // occasionally seen on legacy producers).
  const FIELD_MAP = {
    sender_name: "name",
    name: "name",
    email_id: "email",
    email: "email",
    mobile: "phone",
    mob_no: "phone",
    phone: "phone",
    sender_company: "company",
    company: "company",
  };

  // TradeIndia attribution + lead-context tokens that downstream attribution
  // rollups need to read without re-querying TradeIndia.
  const META_TOKENS = [
    "query_id",
    "subject",
    "query_details",
    "product_name",
    "query_time",
    "sender_city",
    "sender_state",
    "sender_country",
  ];

  const extracted = {};
  const extraFields = {};
  const metaTokens = {};

  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;

    const canonical = FIELD_MAP[k];
    if (canonical) {
      if (extracted[canonical] === undefined) {
        extracted[canonical] = v;
      }
      continue;
    }
    if (META_TOKENS.includes(k)) {
      metaTokens[k] = v;
      continue;
    }
    // Unmapped snake_case key starting with `sender_` or `query_` → preserve
    // under extraFields. Plain camelCase / unrelated snake_case keys (e.g.
    // caller-supplied `tenantSlug`, `subBrand`) are NOT swept — they survive
    // untouched on the output body. Mirrors the IndiaMART normalizer's
    // extraFields semantics.
    if (/^(sender_|query_)/.test(k)) {
      extraFields[k] = v;
    }
  }

  const hasMetaTokens = Object.keys(metaTokens).length > 0;
  const hasExtras = Object.keys(extraFields).length > 0;

  // Shallow-clone the body, strip the TradeIndia-shaped keys we've consumed,
  // then layer extracted-canonical fields BEHIND caller-supplied flat fields
  // (caller wins).
  const out = { ...body };
  for (const k of Object.keys(FIELD_MAP)) delete out[k];
  for (const k of META_TOKENS) delete out[k];
  for (const k of Object.keys(extraFields)) delete out[k];

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
  normalizeIndiamartLeadPayload,
  normalizeJustdialLeadPayload,
  normalizeTradeindiaLeadPayload,
  SPAM_PATTERNS,
};
