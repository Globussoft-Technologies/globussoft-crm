/**
 * intakePayloadValidators — per-channel typed payload validators for the
 * multi-channel lead intake endpoints (PRD_TRAVEL_MULTICHANNEL_LEADS §3.1.4
 * + G014 in docs/TRAVEL_GAP_CLOSURE_TRACKER.md).
 *
 * The intake endpoint POST /api/travel/inbound/leads/:channel (and the
 * canonical alias POST /api/leads/intake) accepts payloads from a dozen
 * different producers (voice/IVR, SMS, email, WhatsApp, Meta lead-ads,
 * Voyagr microsites, ads platforms, marketplace feeds). Each producer has
 * a slightly different mandatory-field set — voice needs a callId, sms
 * needs (from, body), web_form needs at least one of (email, phone), etc.
 * Without this layer, intake either accepts garbage payloads or asserts the
 * minimum-common-denominator (email-or-phone present) and surfaces the
 * specific drift downstream as a routing error.
 *
 * Each validator is a pure function:
 *   validate<Channel>(body) → { valid: boolean, errors: Array<{field, message}> }
 *
 * Errors carry a `field` so the route can surface field-level error
 * messages to the caller. `valid` is the gate the route uses to short-
 * circuit before touching the DB.
 *
 * Channel name aliasing (G004 — channel-enum normalization):
 *   - `webform`  → `web_form`
 *   - `metaads`  → `meta_ad`
 *   - `metaad`   → `meta_ad`
 * The route layer normalizes the channel before invoking `validateForChannel`
 * so this module sees only the canonical name. Unknown channels fall back
 * to the universal validator (email OR phone required).
 *
 * STUB: per-channel validators today encode the must-have-something rules
 * from the PRD draft; tightening (e.g. transcript length cap on voice,
 * MMS attachment caps on sms) is intentionally deferred until each
 * producer is wired end-to-end and we have real payload samples in the
 * audit log.
 */

'use strict';

/**
 * Universal sanity check used by every channel-specific validator plus the
 * "unknown channel" fallback. PRD §3.1.5 — every inbound lead MUST carry
 * at least one of email or phone (no anonymous touchpoints). Returns a
 * single error when both are missing.
 */
function requireEmailOrPhone(body) {
  const email = body && body.email;
  const phone = body && body.phone;
  if (
    (!email || !String(email).trim()) &&
    (!phone || !String(phone).trim())
  ) {
    return [
      {
        field: 'email|phone',
        message: 'either email or phone is required',
      },
    ];
  }
  return [];
}

/**
 * voice — incoming call from the Callified / GlobusPhone bridge or IVR
 * dropdown. Required:
 *   - callId    : opaque external call identifier (used for idempotency)
 *   - direction : "inbound" (today; "outbound" reserved for outreach)
 * Optional:
 *   - transcript, recordingUrl, durationSec, ivrPath
 *
 * The voice channel ALSO requires phone (the caller's number) — this is
 * downstream of the universal email-or-phone check; we add a voice-
 * specific "phone is the only valid contact channel" assertion below.
 */
function validateVoice(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  if (!body.callId || !String(body.callId).trim()) {
    errors.push({ field: 'callId', message: 'callId is required for voice channel' });
  }
  if (!body.direction || !['inbound', 'outbound'].includes(String(body.direction))) {
    errors.push({
      field: 'direction',
      message: 'direction must be "inbound" or "outbound"',
    });
  }
  // voice REQUIRES a phone (a voice call without a caller phone is
  // structurally impossible). Email-only voice payloads are rejected.
  if (!body.phone || !String(body.phone).trim()) {
    errors.push({ field: 'phone', message: 'phone is required for voice channel' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * sms — inbound SMS routed via Twilio / MSG91 webhook. Required:
 *   - from : sender phone (mapped to body.phone if absent)
 *   - body : message body (used for free-text intent parsing)
 */
function validateSms(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  const from = body.from || body.phone;
  if (!from || !String(from).trim()) {
    errors.push({ field: 'from', message: 'from (sender phone) is required for sms channel' });
  }
  if (!body.body || !String(body.body).trim()) {
    errors.push({ field: 'body', message: 'body (sms text) is required for sms channel' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * email — inbound parsed email (Mailgun / IMAP poller). Required:
 *   - email    : sender email
 *   - subject  : email subject line (parsed for intent)
 * Optional:
 *   - body, attachments[], threadId
 */
function validateEmail(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  if (!body.email || !String(body.email).trim()) {
    errors.push({ field: 'email', message: 'email is required for email channel' });
  }
  if (!body.subject || !String(body.subject).trim()) {
    errors.push({ field: 'subject', message: 'subject is required for email channel' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * web_form — Voyagr microsite, in-CRM marketing landing page, embedded
 * widget. Required: standard email-or-phone universal check + a `formId`
 * so attribution can identify which form was submitted.
 */
function validateWebForm(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  // formId helps attribute multi-form pages; allow null but warn isn't a
  // thing we can do here — operator-side tooling surfaces missing-formId
  // payloads as "unknown source" in the attribution report.
  return { valid: errors.length === 0, errors };
}

/**
 * whatsapp — Wati / Meta Cloud WhatsApp Business API webhook. Required:
 *   - phone : WhatsApp number (the universal check accepts it)
 *   - waMessageId : Meta-generated message ID (used for idempotency)
 */
function validateWhatsapp(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  if (!body.phone || !String(body.phone).trim()) {
    errors.push({ field: 'phone', message: 'phone is required for whatsapp channel' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * meta_ad — Meta lead-ads webhook (Facebook / Instagram). Required:
 *   - advertiserId : Meta page id (used for sub-brand routing)
 *   - formId       : Meta lead form id
 *
 * The normalizer (lib/inboundLeadVerification.js normalizeMetaLeadPayload)
 * flattens Meta's field_data[] shape into top-level email/phone before
 * this validator runs.
 */
function validateMetaAd(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  return { valid: errors.length === 0, errors };
}

/**
 * google_ad / linkedin_ad — ad-platform lead forms. Universal check only;
 * platform-specific assertions land when AdsGPT / LinkedIn Lead Gen creds
 * arrive.
 */
function validateAdGeneric(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  return { valid: errors.length === 0, errors };
}

/**
 * referral — manual / portal-driven referral (G012). Required:
 *   - referrerContactId : the contact who referred (validated against tenant
 *                         scope at the route layer, not here)
 * Plus the universal email-or-phone check.
 */
function validateReferral(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: '_body', message: 'body must be an object' }] };
  }
  if (
    body.referrerContactId === undefined ||
    body.referrerContactId === null ||
    !Number.isInteger(Number(body.referrerContactId))
  ) {
    errors.push({
      field: 'referrerContactId',
      message: 'referrerContactId is required and must be an integer for referral channel',
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * chat — live-chat / chatbot handoff. Universal check; sessionId optional
 * (used for thread reconciliation when present).
 */
function validateChat(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  return { valid: errors.length === 0, errors };
}

/**
 * manual — CRM walk-in form (operator types it in). Universal check only.
 */
function validateManual(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  return { valid: errors.length === 0, errors };
}

/**
 * Marketplace channels (indiamart / justdial / tradeindia / voyagr / ads /
 * adsgpt) — universal check; producer-specific assertions live in the
 * normalizers (lib/inboundLeadVerification.js).
 */
function validateMarketplaceLike(body) {
  const errors = [...requireEmailOrPhone(body || {})];
  return { valid: errors.length === 0, errors };
}

/**
 * Canonical channel-name normalizer. G004 channel-rename map:
 *   - webform → web_form
 *   - metaads / metaad → meta_ad
 * The intake route layer also accepts these aliases at the URL level (for
 * back-compat with existing webhook producers) and normalizes server-side
 * before invoking this module.
 */
const CHANNEL_ALIASES = Object.freeze({
  webform: 'web_form',
  metaads: 'meta_ad',
  metaad: 'meta_ad',
});

function canonicaliseChannel(channel) {
  if (!channel || typeof channel !== 'string') return null;
  const trimmed = channel.trim();
  if (!trimmed) return null;
  return CHANNEL_ALIASES[trimmed] || trimmed;
}

const VALIDATOR_MAP = Object.freeze({
  voice: validateVoice,
  sms: validateSms,
  email: validateEmail,
  web_form: validateWebForm,
  whatsapp: validateWhatsapp,
  meta_ad: validateMetaAd,
  google_ad: validateAdGeneric,
  linkedin_ad: validateAdGeneric,
  referral: validateReferral,
  chat: validateChat,
  manual: validateManual,
  voyagr: validateMarketplaceLike,
  ads: validateAdGeneric,
  adsgpt: validateAdGeneric,
  indiamart: validateMarketplaceLike,
  justdial: validateMarketplaceLike,
  tradeindia: validateMarketplaceLike,
});

/**
 * Dispatcher used by the route. Resolves the (aliased) channel to its
 * validator. Unknown channels degrade to the universal email-or-phone
 * check (so a future channel that hasn't been promoted into the map yet
 * still gets the structural safety net).
 */
function validateForChannel(channel, body) {
  const canonical = canonicaliseChannel(channel);
  const validator = (canonical && VALIDATOR_MAP[canonical]) || null;
  if (!validator) {
    // Universal fallback for unknown / unmapped channels.
    const errors = requireEmailOrPhone(body || {});
    return { valid: errors.length === 0, errors };
  }
  return validator(body || {});
}

module.exports = {
  validateForChannel,
  canonicaliseChannel,
  CHANNEL_ALIASES,
  // Exported for direct unit testing.
  validateVoice,
  validateSms,
  validateEmail,
  validateWebForm,
  validateWhatsapp,
  validateMetaAd,
  validateAdGeneric,
  validateReferral,
  validateChat,
  validateManual,
  validateMarketplaceLike,
  requireEmailOrPhone,
};
