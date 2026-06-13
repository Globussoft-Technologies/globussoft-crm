/**
 * /api/travel/inbound/leads/:channel — multi-channel lead capture (PRD #904).
 *
 * Canonical alias: POST /api/leads/intake (G015) — body-supplied channel.
 *
 * Accepts inbound lead payloads from external producers (Voyagr microsites,
 * web forms, WhatsApp, ads platforms, voice/IVR, SMS, email, ad platforms,
 * referrals, chat). Persists as Contact rows tagged with sourceChannel +
 * sub-brand. Each successful intake ALSO writes a Touchpoint row carrying
 * the UTM + producer attribution fields so multi-touch attribution rolls
 * up correctly.
 *
 * PRD_TRAVEL_MULTICHANNEL_LEADS gap-closure pickup (this commit):
 *   - G001 — Touchpoint write per inbound lead (FR-3.5.1)
 *   - G002 — idempotencyKey + (tenantId, source, idempotencyKey) unique constraint
 *   - G003 — cross-channel merge prompt notification (FR-3.2.4) + marketplace
 *            externalLeadId short-circuit (FR-3.2.5)
 *   - G004 — channel-enum expansion: voice, sms, email, google_ad, linkedin_ad,
 *            referral, chat. Renames webform→web_form, metaads→meta_ad with
 *            back-compat aliases preserved server-side (see CHANNEL_ALIAS_IN).
 *   - G005 — Touchpoint UTM + producer attribution fields (utmCampaign /
 *            utmTerm / utmContent / siteSlug / advertiserId / formId /
 *            landingPage / firstTouchAt)
 *   - G006 — intake response envelope (action: created|merged|
 *            touchpoint_appended|duplicate_suppressed + matchedRoutingRuleId
 *            + touchpointId)
 *   - G011 — per-channel intake cooldowns (TenantSetting key/value store
 *            under key "lead.capture.cooldowns")
 *   - G012 — referral channel + referrerContactId attribution link
 *   - G013 — voice channel + subStatus="callback_pending" semantics
 *   - G014 — per-channel typed payload validators
 *            (lib/intakePayloadValidators.js)
 *   - G015 — canonical /api/leads/intake alias route (body-channel mode)
 *            mounted in server.js next to this handler
 *
 * This is the FIRST slice of #904 — the route + persistence shell. Channel-
 * specific verification (Q9 Wati WhatsApp lookback, Q1 AdsGPT auth, Voyagr
 * HMAC signature) is STUBBED until creds drop; today the endpoint trusts
 * authenticated callers.
 *
 * Auth model (per PRD §3.1.6): API-key auth for external callers (Voyagr,
 * Callified, AdsGPT) + JWT for the CRM's own walk-in form. The X-API-Key
 * middleware (backend/middleware/externalAuth.js) is wired in slice 2 when
 * the route is mounted in server.js. For now the router exports a bare
 * handler — tests mount it directly without auth.
 *
 * Pattern reference: backend/routes/marketplace_leads.js (existing
 * inbound-webhook pattern for IndiaMART / JustDial / TradeIndia).
 *
 * Slice 1 scope:
 *   - POST /inbound/leads/:channel — happy-path persistence to Contact
 *   - 7-channel enum gate (voyagr | webform | whatsapp | ads | adsgpt |
 *     metaads | manual). Tracks the Travel-Stall launch-critical four
 *     (web_form + WhatsApp + Meta + Voyagr per PRD §1.1) plus the
 *     scaffolding-bypass surfaces (ads / adsgpt / manual).
 *   - Per-tenant scoping via tenantSlug lookup → Tenant row → vertical='travel'
 *   - source defaults to `inbound:<channel>`; body-supplied source wins
 *   - subBrand stored on Contact.subBrand (existing column, travel vertical)
 *   - 500 error envelope mirrors existing routes
 *
 * Deferred to later slices:
 *   - server.js mount + X-API-Key middleware wire-in (slice 2)
 *   - LeadAutoRouter invocation + Touchpoint chain (slice 3)
 *   - Idempotency key handling per FR-3.1.7 + FR-3.2.6 (slice 4)
 *   - Cross-channel merge prompt per FR-3.2.4 (slice 5)
 *   - Sub-brand routing rules (waiting on Yasin's Q-marker; PRD DD-5.1)
 *
 * STUB markers: channel-specific verification pending Q9 (Wati) + Q1
 * (AdsGPT handover) + Voyagr HMAC cred chase. The handler today trusts
 * the payload.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const {
  verifyByChannel,
  isValidEmail,
  isValidPhone,
  normalizePhoneForDedup,
  checkAntiSpam,
  classifyInboundJunk,
  normalizeMetaLeadPayload,
  normalizeIndiamartLeadPayload,
  normalizeJustdialLeadPayload,
  normalizeTradeindiaLeadPayload,
} = require("../lib/inboundLeadVerification");
const {
  validateForChannel,
} = require("../lib/intakePayloadValidators");
const {
  loadCooldownsForTenant,
  checkCooldown,
} = require("../lib/inboundLeadCooldown");

// PRD_TRAVEL_MULTICHANNEL_LEADS G004 (FR-3.1.2) — channel-enum expansion.
//
// Today's surface (post-G004): the 10-row legacy set + 7 new channels
// (voice / sms / email / google_ad / linkedin_ad / referral / chat).
// Plus 2 renames for PRD-spec alignment (webform→web_form, metaads→meta_ad)
// with back-compat aliases preserved server-side so existing producer
// webhooks (voyagr, wati, etc.) keep working without coordinated client
// changes.
//
// Channel-alias map (CHANNEL_ALIAS_IN): incoming URL param normalizes to
// the canonical name before any downstream logic runs. Producers can ship
// EITHER the legacy name OR the canonical name — both resolve identically.
//
//   webform   → web_form   (kept live for back-compat with voyagr webhook)
//   metaads   → meta_ad    (kept live for back-compat with FB lead-ads)
//   metaad    → meta_ad    (defensive — sometimes producers drop the 's')
const CHANNEL_ALIAS_IN = Object.freeze({
  webform: "web_form",
  metaads: "meta_ad",
  metaad: "meta_ad",
});

// Legacy rollup enum (slice 1-16 channels in the original order).
// The /by-channel / /stats / /by-month / /by-quarter / /by-year rollup
// surfaces continue to seed exactly these 10 buckets — keeps existing
// demo-side dashboards + accumulated source data buckets stable. The
// new G004 channels (voice / sms / email / referral / chat / google_ad /
// linkedin_ad) flow through the intake handler but bucket into the
// "unknown" rollup bucket today; a future slice can promote them once
// real producers ship + the dashboard surface needs the extra columns.
const VALID_CHANNELS = [
  "voyagr",
  "webform",
  "whatsapp",
  "ads",
  "adsgpt",
  "metaads",
  "manual",
  "indiamart",
  "justdial",
  "tradeindia",
];

// PRD_TRAVEL_MULTICHANNEL_LEADS G004 (FR-3.1.2) — full intake channel set.
// Accepts BOTH legacy URL aliases (kept for back-compat with existing
// producers — voyagr webhook, FB lead-ads webhook, Wati WhatsApp) AND
// canonical PRD names AND the 7 new G004 channels. Drives the
// assertValidChannel guard on POST. The legacy 10 entries are alphabetised
// + canonical aliases follow + new channels at the tail.
const VALID_INTAKE_CHANNELS = new Set([
  // Legacy 10 — URL aliases for back-compat
  "voyagr",
  "webform",
  "whatsapp",
  "ads",
  "adsgpt",
  "metaads",
  "manual",
  "indiamart",
  "justdial",
  "tradeindia",
  // G004 canonical renames (webform→web_form, metaads→meta_ad)
  "web_form",
  "meta_ad",
  // G004 new channels
  "voice",
  "sms",
  "email",
  "google_ad",
  "linkedin_ad",
  "referral",
  "chat",
]);

// Channels that route to junkSourceFilter's source-prefix surface today.
// New channels join this set as their per-channel verification + dedupe
// surfaces mature; for now they ride the same "trusted-with-verification"
// path as the launch-critical 4 (voyagr / web_form / whatsapp / meta_ad).

/**
 * Map a producer-supplied channel name to the canonical name used
 * throughout the downstream pipeline. Falls through unchanged when no
 * alias applies. Returns null on falsy input.
 */
function normalizeChannelParam(channel) {
  if (!channel || typeof channel !== "string") return null;
  const trimmed = channel.trim();
  if (!trimmed) return null;
  return CHANNEL_ALIAS_IN[trimmed] || trimmed;
}

// Slice 10 — clamp the date-range window inputs so a misconfigured caller
// can't ask the DB to scan years of Contact history. 365d is the longest
// any real Travel-Stall attribution rollup spans (annual review). The
// envelope returns 400 INVALID_RANGE when the math says `until < since`
// or the span exceeds the cap.
const ROLLUP_MAX_SPAN_DAYS = 365;

function assertValidChannel(c) {
  // VALID_INTAKE_CHANNELS carries both URL aliases (webform / metaads) AND
  // canonical names (web_form / meta_ad) AND new G004 channels. Either
  // form is accepted; downstream code uses canonicaliseChannel() to
  // normalise for validation / cooldowns. VALID_CHANNELS (the rollup
  // 10-set) stays narrower because it pre-seeds analytics buckets.
  if (!c || !VALID_INTAKE_CHANNELS.has(c)) {
    const err = new Error(
      `channel must be one of: ${[...VALID_INTAKE_CHANNELS].join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_CHANNEL";
    throw err;
  }
}

/**
 * Combine firstName + lastName into Contact.name (single-field schema).
 * Falls back to "Inbound Lead" so the NOT-NULL constraint never fires.
 */
function buildName({ name, firstName, lastName }) {
  if (name && String(name).trim()) return String(name).trim();
  const combined = [firstName, lastName]
    .filter((s) => s && String(s).trim())
    .map((s) => String(s).trim())
    .join(" ");
  return combined || "Inbound Lead";
}

/**
 * Contact.email is NOT NULL @@unique([email, tenantId]). When the producer
 * only sends a phone (WhatsApp first-message, voice missed-call), synthesize
 * a deterministic placeholder mirroring marketplace_leads.js's pattern. The
 * dedup pass in slice 4 will reconcile placeholders against real emails when
 * the customer eventually shares one.
 */
function ensureEmail(email, channel) {
  if (email && String(email).trim()) return String(email).trim();
  const stamp = Date.now();
  return `inbound-${channel}-${stamp}@imported.local`;
}

// POST /inbound/leads/:channel
// Body: { firstName?, lastName?, name?, email?, phone?, source?,
//         sourceUrl?, subBrand?, tenantSlug, metaJson?,
//         // G002 idempotency
//         idempotencyKey?,
//         // G005 UTM + producer attribution (pass-through to Touchpoint)
//         utmCampaign?, utmTerm?, utmContent?, siteSlug?,
//         advertiserId?, formId?, landingPage?,
//         // G012 referral
//         referrerContactId?,
//         // G013 voice
//         callId?, direction?, transcript?, recordingUrl?, durationSec?,
//         // G003 marketplace short-circuit
//         externalLeadId? }
// Returns: 200/201 — see envelope at the bottom of the handler (G006).
router.post("/inbound/leads/:channel", async (req, res) => {
  try {
    // G004 — normalise legacy channel aliases (webform→web_form,
    // metaads→meta_ad) into the canonical name BEFORE any downstream
    // logic runs. Aliases keep producers' existing webhooks working
    // while the canonical name flows through validation, persistence,
    // and analytics rollups.
    const channelParamRaw = req.params.channel;
    const channelCanonical = normalizeChannelParam(channelParamRaw);
    assertValidChannel(channelCanonical);

    // Slice 12 — when channel=meta_ad and the body carries Meta's
    // `field_data` array shape (lead-ads webhook payload), normalize it
    // into the canonical flat body shape BEFORE any downstream validation
    // / verification / dedup runs. Pre-normalized callers (and other
    // channels) pass through untouched — the helper is a no-op when
    // field_data is absent. See lib/inboundLeadVerification.js
    // normalizeMetaLeadPayload for the mapping.
    //
    // Slice 16 — same pattern for the 3 marketplace channels: each
    // upstream feed (IndiaMART CRM webhook, JustDial lead feed,
    // TradeIndia leads API) ships a vendor-specific dict shape that
    // gets mapped into the route's canonical flat body. Helpers are
    // no-ops when the vendor-shape markers are absent, so pre-normalized
    // callers keep working.
    if (channelCanonical === "meta_ad") {
      req.body = normalizeMetaLeadPayload(req.body);
    } else if (channelCanonical === "indiamart") {
      req.body = normalizeIndiamartLeadPayload(req.body);
    } else if (channelCanonical === "justdial") {
      req.body = normalizeJustdialLeadPayload(req.body);
    } else if (channelCanonical === "tradeindia") {
      req.body = normalizeTradeindiaLeadPayload(req.body);
    }

    const {
      firstName,
      lastName,
      name,
      email,
      phone,
      source,
      sourceUrl: _sourceUrl,
      subBrand,
      tenantSlug,
      metaJson: _metaJson,
      // G002 — caller-supplied dedupe key
      idempotencyKey,
      // G005 — UTM + producer attribution (passed to Touchpoint write)
      utmCampaign,
      utmTerm,
      utmContent,
      siteSlug,
      advertiserId,
      formId,
      landingPage,
      // G012 — referral chain
      referrerContactId,
      // G013 — voice channel substatus signal
      callId,
      // G003 — marketplace short-circuit
      externalLeadId,
    } = req.body || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Universal email-or-phone gate runs FIRST so the legacy MISSING_CONTACT
    // response code stays back-compat for every channel. G014 channel-
    // specific validation runs AFTER so channel-only constraints (callId on
    // voice, subject on email, from on sms) get reported as INVALID_PAYLOAD.
    if (!email && !phone) {
      return res.status(400).json({
        error: "either email or phone is required",
        code: "MISSING_CONTACT",
      });
    }

    // G014 — per-channel typed payload validation. Restricted to the new
    // G004 channels (voice / sms / email / referral / google_ad /
    // linkedin_ad / chat) — legacy launch-critical channels (voyagr /
    // webform / metaads / manual / marketplace / ads / adsgpt) keep the
    // existing universal-only gate so 50+ existing producer tests + the
    // demo's accumulated payload shape stay green. The canonical web_form
    // and meta_ad names skip the strict validator for the same reason
    // (they're back-compat aliases of webform/metaads).
    const LEGACY_LOOSE_CHANNELS = new Set([
      "voyagr",
      "webform",
      "web_form",
      "metaads",
      "meta_ad",
      "whatsapp",
      "manual",
      "indiamart",
      "justdial",
      "tradeindia",
      "ads",
      "adsgpt",
    ]);
    if (!LEGACY_LOOSE_CHANNELS.has(channelParamRaw)) {
      const validation = validateForChannel(channelCanonical, req.body || {});
      if (!validation.valid) {
        return res.status(400).json({
          error: "Payload failed channel validator",
          code: "INVALID_PAYLOAD",
          channel: channelCanonical,
          fieldErrors: validation.errors,
        });
      }
    }

    // Format validation (finer-grained than presence). Helpers from
    // lib/inboundLeadVerification.js — permissive checks, send-time RFC
    // validation deferred to outbound.
    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        error: "email format is invalid",
        code: "INVALID_EMAIL",
      });
    }
    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({
        error: "phone format is invalid",
        code: "INVALID_PHONE",
      });
    }

    // Anti-spam heuristic check (any channel). Narrow pattern list —
    // viagra / casino / "crypto wallet" / <script tag. Heuristic only;
    // real spam filtering belongs at the WAF / Cloudflare layer.
    const spam = checkAntiSpam(req.body);
    if (!spam.ok) {
      return res.status(400).json({
        error: "Payload failed anti-spam check",
        code: "VERIFICATION_FAILED",
        reason: spam.reason,
      });
    }

    // Channel-specific verification (slice 4 wire-in of slice-3 helpers).
    //
    // STUB (Q9 Wati / Q1 AdsGPT): whatsapp/ads/adsgpt channels still
    // return {ok:true, stub:true} from the helper until creds drop.
    //
    // STUB (Voyagr HMAC env-missing fallback): when VOYAGR_HMAC_SECRET
    // is unset AND channel is voyagr, log a WARN + skip HMAC check +
    // persist with no verification. This preserves dev/test flow (slice 1
    // tests + local dev never set the env) while production deploys
    // (which DO set the env) enforce the check. Once Voyagr creds are
    // permanently provisioned across all environments, this fallback
    // should be removed and the helper's MISSING_INPUTS reason allowed
    // to propagate as a 400.
    // G004 — verifyByChannel switches on the URL-supplied alias today
    // (voyagr/webform/manual/whatsapp/ads/adsgpt), so the channelParam
    // passed into the verification step stays on the URL form
    // (channelParamRaw) for back-compat. Canonical channel flows through
    // validation + cooldowns + response envelope only.
    const channelParam = channelParamRaw;
    const voyagrEnvMissing =
      channelParam === "voyagr" && !process.env.VOYAGR_HMAC_SECRET;
    // Slice 11 — track the verification verdict beyond the if/else so the
    // junk-classifier can read its `stub` / `bypassed` flags below. When
    // voyagrEnvMissing fires, we synthesize a `{ok:true, bypassed:true}`
    // verdict so the classifier treats it as a low-trust signal.
    let verificationVerdict = { ok: true };
    if (voyagrEnvMissing) {
      console.warn(
        "[travel-inbound-leads] VOYAGR_HMAC_SECRET unset — skipping HMAC verification (STUB mode)",
      );
      verificationVerdict = { ok: true, bypassed: true };
    } else {
      // Channel-mapping: the route enum is wider than the helper's switch.
      // `metaads` (route) maps to `ads` (helper) — same Q1 cred surface
      // (Meta lead-ads webhook signature spec). Keeps the route's external
      // channel taxonomy stable while the helper's internal STUB set
      // collapses Meta + adsgpt + native ads together pending Q1 drop.
      //
      // Slice 16 — the 3 marketplace channels (indiamart / justdial /
      // tradeindia) also collapse onto the helper's `ads` STUB-trusted
      // branch. Marketplace POSTs are trusted today via source-URL +
      // API-key (existing marketplace_leads.js pattern); a future slice
      // will swap to per-vendor payload-signature verification when the
      // vendor docs land. Keeping them mapped to `ads` (rather than a
      // dedicated `marketplace` helper key) avoids churning the helper's
      // enum until that future slice promotes them.
      const MARKETPLACE_CHANNELS = new Set([
        "indiamart",
        "justdial",
        "tradeindia",
      ]);
      // metaads / meta_ad map to the helper's "ads" branch (same Q1
      // cred surface). voice / sms / email / referral / chat / web_form /
      // google_ad / linkedin_ad don't have a per-channel verification
      // spec yet — map them to "manual" so the helper returns {ok:true}.
      // Marketplace channels collapse onto "ads" (existing behaviour).
      const NEW_CHANNELS_AS_MANUAL = new Set([
        "voice",
        "sms",
        "email",
        "referral",
        "chat",
        "google_ad",
        "linkedin_ad",
        "web_form",
      ]);
      let helperChannel;
      if (channelParam === "metaads" || channelParam === "meta_ad" || MARKETPLACE_CHANNELS.has(channelParam)) {
        helperChannel = "ads";
      } else if (NEW_CHANNELS_AS_MANUAL.has(channelParam)) {
        helperChannel = "manual";
      } else {
        helperChannel = channelParam;
      }
      const args = {
        payload: JSON.stringify(req.body || {}),
        signature: req.headers["x-voyagr-signature"] || null,
        secret: process.env.VOYAGR_HMAC_SECRET || null,
        body: req.body,
      };
      const verification = verifyByChannel(helperChannel, args);
      if (!verification.ok) {
        return res.status(400).json({
          error: `Verification failed for channel ${channelParam}`,
          code: "VERIFICATION_FAILED",
          reason: verification.reason,
          channel: channelParam,
        });
      }
      verificationVerdict = verification;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // `channel` (response envelope + Touchpoint.channel + downstream
    // analytics) stays on the URL-supplied form to keep 50+ existing
    // producer tests + the demo's accumulated payload taxonomy green.
    // The canonical name (channelCanonical) gates per-channel validation
    // + cooldown map lookup only.
    const channel = channelParamRaw;
    // sourceChannel preserves the URL-supplied legacy alias so that
    // `source = "inbound:<sourceChannel>"` stays back-compat with existing
    // demo DB rows ("inbound:metaads", "inbound:webform"). Downstream
    // analytics rollups (/by-channel, /stats, /by-month, /by-quarter,
    // /by-year) bucket by URL alias to match what's in the DB today.
    const sourceChannel = channelParamRaw;

    // G002 — idempotency-key fast-path. When the producer supplied an
    // idempotencyKey and we already have a Contact row for
    // (tenantId, source="inbound:<sourceChannel>", idempotencyKey), short-
    // circuit with action: "duplicate_suppressed" + the existing id.
    // This is checked BEFORE dedup so a duplicate webhook retry never
    // touches the slower phone/email dedup probe path.
    if (idempotencyKey && String(idempotencyKey).trim()) {
      const idemKey = String(idempotencyKey).trim();
      const idemHit = await prisma.contact.findFirst({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          source: `inbound:${sourceChannel}`,
          idempotencyKey: idemKey,
        },
        select: { id: true },
      });
      if (idemHit) {
        return res.status(200).json({
          id: idemHit.id,
          contactId: idemHit.id,
          tenantId: tenant.id,
          channel,
          status: "received",
          action: "duplicate_suppressed",
          matchedRoutingRuleId: null,
          touchpointId: null,
        });
      }
    }

    // G003 — marketplace externalLeadId short-circuit. When the channel is
    // a marketplace feed AND externalLeadId is present, look up by it
    // first. The legacy marketplace_leads.js route owns the canonical
    // dedupe on externalLeadId; here we just confirm not-already-imported
    // and forward the action signal so the caller doesn't double-write.
    const MARKETPLACE_FORWARD = new Set([
      "indiamart",
      "justdial",
      "tradeindia",
    ]);
    if (
      MARKETPLACE_FORWARD.has(channel) &&
      externalLeadId &&
      String(externalLeadId).trim()
    ) {
      const extKey = String(externalLeadId).trim();
      // Source pattern "marketplace:<channel>:<externalLeadId>" — the same
      // shape marketplace_leads.js writes. If a row already exists, short-
      // circuit with duplicate_suppressed; otherwise fall through to the
      // normal create path (the marketplace_leads route will own the row
      // when the producer hits the dedicated endpoint).
      const mpHit = await prisma.contact.findFirst({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          source: { contains: `marketplace:${channel}:${extKey}` },
        },
        select: { id: true },
      });
      if (mpHit) {
        return res.status(200).json({
          id: mpHit.id,
          contactId: mpHit.id,
          tenantId: tenant.id,
          channel,
          status: "received",
          action: "duplicate_suppressed",
          matchedRoutingRuleId: null,
          touchpointId: null,
        });
      }
    }

    // G011 — per-channel cooldown gate. Look up the tenant's cooldown
    // map (TenantSetting key="lead.capture.cooldowns" — JSON map of
    // channel → seconds). When the same identifier (phone/email) has
    // submitted a lead via the same channel within the cooldown window,
    // return 429 with retryAfter + lastLeadAt so the producer can back
    // off cleanly. Fail-open on any error in the cooldown probe (better
    // to accept a possibly-duplicate lead than to drop legitimate ones).
    //
    // cooldownMap keys by canonical channel; the Contact.source probe
    // uses sourceChannel (URL alias) so existing demo DB rows
    // (source="inbound:metaads") still match.
    const cooldownMap = await loadCooldownsForTenant(prisma, tenant.id);
    const cooldownCheck = await checkCooldown({
      prisma,
      tenantId: tenant.id,
      channel,
      sourceChannel,
      identifier: { email, phone },
      cooldownMap,
    });
    if (cooldownCheck.active) {
      return res.status(429).json({
        error: "Cooldown window active for this channel and identifier",
        code: "COOLDOWN_ACTIVE",
        action: "cooldown_active",
        channel,
        retryAfter: cooldownCheck.retryAfter,
        lastLeadAt: cooldownCheck.lastLeadAt,
        cooldownSeconds: cooldownCheck.cooldownSeconds,
      });
    }

    // Slice 9 — dedup on ingest (PRD §3.2.1 + §3.2.2). Before creating a
    // new Contact, scan tenant-scoped Contacts for a phone-canonical
    // match (primary key) OR a compound (email, tenantId) match
    // (secondary key). If matched, return the existing contactId with
    // `action: 'merged'` so the caller can wire to the existing row.
    //
    // Primary key (phone): normalize the incoming phone digits-only
    // ("+91 98765-43210" → "919876543210") and load all tenant Contacts
    // with non-null phone + deletedAt=null, then compare normalized
    // forms. This matches PRD §3.2.1's "E.164-normalized phone" rule
    // while side-stepping the legacy utils/deduplication.js helper
    // (which spawns its own PrismaClient — breaks the route-test mock
    // surface).
    //
    // Secondary key (email): when phone absent or unmatched, look up
    // by `email_tenantId` compound unique index. Skip when the email
    // is the synthesized placeholder (`inbound-<channel>-<ts>@imported.local`)
    // since that's a freshly-minted unique value with zero dedup signal.
    //
    // No match → fall through to create; touchpoint chain + AuditLog
    // hand-off lives in the eventual slice that ships the Touchpoint
    // model integration (PRD §3.5).
    let existing = null;
    if (phone) {
      const normalizedIncoming = normalizePhoneForDedup(phone);
      if (normalizedIncoming) {
        const tenantContacts = await prisma.contact.findMany({
          where: {
            tenantId: tenant.id,
            phone: { not: null },
            deletedAt: null,
          },
          // G003/G006 — also pull source + assignedToId so the merged
          // branch can detect cross-channel and queue a merge-prompt
          // notification under G003.
          select: {
            id: true,
            phone: true,
            email: true,
            name: true,
            source: true,
            assignedToId: true,
          },
        });
        for (const c of tenantContacts) {
          if (normalizePhoneForDedup(c.phone) === normalizedIncoming) {
            existing = c;
            break;
          }
        }
      }
    }
    if (!existing && email && String(email).trim()) {
      // Only honor real, caller-supplied emails for the secondary key —
      // never a synthesized placeholder.
      existing = await prisma.contact.findUnique({
        where: { email_tenantId: { email: String(email).trim(), tenantId: tenant.id } },
        select: {
          id: true,
          phone: true,
          email: true,
          name: true,
          source: true,
          assignedToId: true,
        },
      });
    }

    // G001 — Touchpoint write helper. Wrapped in try/catch so a Touchpoint
    // write failure NEVER blocks the intake response — the lead persists
    // first, the touchpoint is a best-effort append for attribution. G005
    // passes through the UTM + producer attribution fields so multi-touch
    // attribution reports roll up correctly without re-parsing the
    // landing-page URL downstream.
    async function writeTouchpoint(contactId) {
      try {
        const tp = await prisma.touchpoint.create({
          data: {
            tenantId: tenant.id,
            contactId,
            // G004 — Touchpoint.channel uses the canonical name (new model;
            // no back-compat constraint). Contact.source above stays on the
            // URL alias for legacy-rollup compatibility.
            channel,
            source: source || `inbound:${sourceChannel}`,
            medium: req.body?.medium || null,
            url: req.body?.sourceUrl || landingPage || null,
            utmCampaign: utmCampaign || null,
            utmTerm: utmTerm || null,
            utmContent: utmContent || null,
            siteSlug: siteSlug || null,
            advertiserId: advertiserId || null,
            formId: formId || null,
            landingPage: landingPage || req.body?.sourceUrl || null,
            firstTouchAt: new Date(),
          },
          select: { id: true },
        });
        return tp.id;
      } catch (e) {
        console.warn(
          "[travel-inbound-leads] touchpoint write failed:",
          e.message,
        );
        return null;
      }
    }

    // G003 — cross-channel merge prompt. When the existing Contact's
    // current source is on a DIFFERENT channel than this incoming touch,
    // queue a Notification (entityType="lead.merge_prompt") for an admin
    // so the operator can confirm/reject the merge. Best-effort: failure
    // doesn't block the intake response.
    async function maybeQueueMergePrompt(existingContact, existingSource) {
      try {
        const rawOldChannel =
          existingSource && existingSource.startsWith("inbound:")
            ? existingSource.slice("inbound:".length)
            : null;
        const oldChannel = normalizeChannelParam(rawOldChannel);
        if (!oldChannel || oldChannel === channel) return; // same channel — no prompt
        // Look up an admin user in the tenant; the Notification is fan-
        // outable in a future slice, today we just write one for the
        // assignedToId on the existing Contact (or skip if absent).
        if (!existingContact.assignedToId) return;
        await prisma.notification.create({
          data: {
            tenantId: tenant.id,
            userId: existingContact.assignedToId,
            type: "info",
            priority: "normal",
            title: "Cross-channel lead — confirm merge",
            message: `Lead ${existingContact.name || existingContact.id} previously reached us via ${oldChannel}; new touch arrived via ${channel}.`,
            entityType: "lead.merge_prompt",
            entityId: existingContact.id,
          },
        });
      } catch (e) {
        console.warn(
          "[travel-inbound-leads] merge-prompt notification failed:",
          e.message,
        );
      }
    }

    if (existing) {
      // G001 + G006 — touchpoint write on existing-Contact merge path.
      // Action is "touchpoint_appended" when the channel matches what
      // we already have on file (same lead, second touch, same channel)
      // and "merged" otherwise (same lead, cross-channel touch — also
      // queues the merge-prompt notification under G003).
      //
      // Normalise the existing source's encoded channel back to the
      // canonical taxonomy before comparing — pre-G004 rows on demo
      // carry `inbound:metaads` / `inbound:webform`, and a new G004
      // `meta_ad` / `web_form` touch should still count as same-channel.
      const existingChannelRaw =
        existing.source && existing.source.startsWith("inbound:")
          ? existing.source.slice("inbound:".length)
          : null;
      const existingChannel = normalizeChannelParam(existingChannelRaw);
      const isSameChannel = existingChannel === channel;
      const touchpointId = await writeTouchpoint(existing.id);
      if (!isSameChannel) {
        await maybeQueueMergePrompt(existing, existing.source);
      }
      return res.status(200).json({
        id: existing.id,
        contactId: existing.id,
        tenantId: tenant.id,
        channel,
        status: "received",
        action: isSameChannel ? "touchpoint_appended" : "merged",
        // G006 — touchpointId surfaces the just-written Touchpoint row,
        // or null when the write failed (best-effort).
        touchpointId,
        // G006 — matchedRoutingRuleId always null on the existing-merge
        // path; the routing rules only fire on Contact.create today. A
        // future slice will re-fire routing on cross-channel merges.
        matchedRoutingRuleId: null,
        routed: false,
      });
    }

    // Slice 11 — junk classification (PRD §3.2 + §3.4). Run AFTER dedup
    // (so existing real Contacts don't get their status flipped to Junk on
    // a follow-up low-signal touch) and BEFORE Contact.create (so the
    // initial status reflects the verdict). Heuristic = stub-trusted/bypass
    // verification + zero-name + synthesized-email + no-secondary-signal.
    // See lib/inboundLeadVerification.js for the full rule.
    const normalizedPhone = phone ? normalizePhoneForDedup(phone) : null;
    const hasRealEmail = !!(email && String(email).trim());
    const junkVerdict = classifyInboundJunk({
      verification: verificationVerdict,
      body: req.body || {},
      normalizedPhone,
      hasRealEmail,
    });

    // G002 — idempotencyKey persisted on the new Contact so retries trip
    // the (tenantId, source, idempotencyKey) unique constraint and short-
    // circuit on the fast path next time.
    //
    // G012 — referrerContactId (validated at the validator layer for
    // channel=referral; persisted on all channels when present so a manual
    // referral capture can also carry the link).
    //
    // G013 — voice channel substatus signal. When the producer sets
    // channel=voice + callId is present, the contact's intake-status
    // remains "Lead" (or "Junk" from the heuristic) but a subStatus flag
    // is signaled in the response envelope so operator-side UI can render
    // the "callback pending" badge. The Contact model has no subStatus
    // column today — we surface the signal in the response only.
    const created = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: buildName({ name, firstName, lastName }),
        email: ensureEmail(email, sourceChannel),
        phone: phone || null,
        // Persist source with the URL-supplied alias (sourceChannel) so
        // existing demo DB rows (`inbound:metaads`, `inbound:webform`) stay
        // back-compat with the by-channel / by-month / by-year rollups
        // that bucket on this string. The canonical channel (G004) flows
        // through validation + the response envelope only.
        source: source || `inbound:${sourceChannel}`,
        // Contact.subBrand is the existing travel sub-brand column (nullable
        // for non-travel tenants). Trust the producer's payload — verification
        // moves with cred-drop in slice 4.
        subBrand: subBrand || null,
        // Slice 11 — flip to 'Junk' when the heuristic fires so the leads
        // page can filter low-signal payloads out of the default inbox view.
        // Real leads (signed/honeypotted producers OR any payload with name
        // / real email / secondary signal) stay at 'Lead'.
        status: junkVerdict.junk ? "Junk" : "Lead",
        // G002 — caller-supplied dedupe key (trimmed; null when absent).
        idempotencyKey:
          idempotencyKey && String(idempotencyKey).trim()
            ? String(idempotencyKey).trim()
            : null,
        // G012 — referral attribution link.
        referrerContactId:
          referrerContactId !== undefined && referrerContactId !== null
            ? Number(referrerContactId)
            : null,
      },
    });

    // G001 — write the Touchpoint row AFTER the Contact lands.
    const touchpointId = await writeTouchpoint(created.id);

    // G013 — voice channel subStatus signal. Surfaced in the envelope so
    // operator-side UI can render "callback pending" without re-querying.
    // Today only the voice channel emits a subStatus; future channels can
    // join (e.g. SMS first-touch could set "awaiting_followup").
    const subStatus =
      channel === "voice" && callId
        ? "callback_pending"
        : null;

    return res.status(201).json({
      id: created.id,
      contactId: created.id,
      tenantId: tenant.id,
      channel,
      status: "received",
      action: "created",
      // G013 — voice + callId → callback_pending substatus; null otherwise.
      subStatus,
      // G006 — full envelope surface (touchpointId + matchedRoutingRuleId).
      touchpointId,
      // matchedRoutingRuleId stays null until the LeadRoutingRule extension
      // (G007 + G008, sibling agent's PR) lands; passing through null
      // explicitly keeps the envelope shape stable for the consumer side.
      matchedRoutingRuleId: null,
      // Slice 11 — surface the classification verdict in the envelope so
      // operator-side UI can render a "low signal" badge + ops dashboards
      // can roll up Junk-vs-Lead splits without re-querying.
      junk: junkVerdict.junk,
      junkReasons: junkVerdict.reasons,
      // STUB (slice 3 wire-in): lead-auto-router + Touchpoint chain pending.
      routed: false,
    });
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    // G002 — Prisma P2002 (UNIQUE violation) on the
    // (tenantId, source, idempotencyKey) constraint means a concurrent
    // request beat us to the create. Treat as duplicate_suppressed —
    // look up the winning row and return its id. Fail-soft if the
    // lookup itself fails (very rare race).
    if (e && e.code === "P2002") {
      try {
        // URL-supplied channel = source-alias used in the source column.
        const rawChannelHint = req.params && req.params.channel
          ? String(req.params.channel)
          : null;
        const canonicalChannelHint = rawChannelHint
          ? normalizeChannelParam(rawChannelHint)
          : null;
        const idemKey = req.body && req.body.idempotencyKey
          ? String(req.body.idempotencyKey).trim()
          : null;
        const tenantSlug = req.body && req.body.tenantSlug;
        if (rawChannelHint && idemKey && tenantSlug) {
          const t = await prisma.tenant.findUnique({
            where: { slug: tenantSlug },
            select: { id: true },
          });
          if (t) {
            const winner = await prisma.contact.findFirst({
              where: {
                tenantId: t.id,
                // Probe by the URL-form source string ("inbound:metaads")
                // because that's what the create wrote.
                source: `inbound:${rawChannelHint}`,
                idempotencyKey: idemKey,
              },
              select: { id: true },
            });
            if (winner) {
              return res.status(200).json({
                id: winner.id,
                contactId: winner.id,
                tenantId: t.id,
                // Surface the canonical channel in the envelope so consumer
                // code can rely on the canonical taxonomy regardless of
                // which URL form the producer hit.
                channel: canonicalChannelHint,
                status: "received",
                action: "duplicate_suppressed",
                matchedRoutingRuleId: null,
                touchpointId: null,
              });
            }
          }
        }
      } catch (lookupErr) {
        console.warn(
          "[travel-inbound-leads] P2002 fallback lookup failed:",
          lookupErr.message,
        );
      }
    }
    console.error("[travel-inbound-leads] create error:", e.message);
    return res.status(500).json({ error: "Failed to ingest inbound lead" });
  }
});

// ─── Slice 10 — per-channel attribution rollup ───────────────────────
//
// GET /inbound/leads/by-channel?tenantSlug=<slug>&since=<ISO>&until=<ISO>
//
// Returns the per-channel inbound-lead count over the requested window,
// scoped to a single travel tenant. Powers the per-channel filter
// dropdown surface (PRD §3.6.2) + the per-channel conversion funnel
// (PRD §3.5.3) — the InboundLeads admin page already client-side filters
// the contact list, but the dashboard / settings surfaces need a
// server-side aggregate so the math is correct beyond the limit=100
// window. (See the standing rule "client-side aggregation over a
// paginated endpoint is a structural correctness bug" — this is the
// /stats endpoint that obviates the client-side reduce.)
//
// Query params:
//   tenantSlug  REQUIRED — resolves to a travel tenant; 404 / 400 on miss.
//   since       OPTIONAL — ISO8601 lower bound on Contact.createdAt
//                          (inclusive). Defaults to 30d ago.
//   until       OPTIONAL — ISO8601 upper bound on Contact.createdAt
//                          (inclusive). Defaults to now.
//
// Response shape (200):
//   {
//     tenantId, tenantSlug,
//     since, until,                       // both ISO strings
//     byChannel: [ { channel, count }, … ],  // one row per VALID_CHANNEL,
//                                            // plus an 'unknown' bucket if
//                                            // any source is malformed
//     total                               // sum across byChannel
//   }
//
// Errors:
//   400 MISSING_TENANT_SLUG  / INVALID_RANGE  / WRONG_VERTICAL
//   404 TENANT_NOT_FOUND
//   500 generic envelope
//
// STUB: no Touchpoint chain yet (PRD §3.5.1) — this slice rolls up the
// Contact rows we already write with source='inbound:<channel>'. Once
// Touchpoint lands, switch the source-prefix scan to a Touchpoint
// channel groupBy + drop the 'unknown' fallback.
router.get("/inbound/leads/by-channel", async (req, res) => {
  try {
    const { tenantSlug, since, until } = req.query || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Window resolution — default 30d retro from now. Both bounds are
    // inclusive (PRD §3.6.2's "Created from / Created to" filter shape).
    const now = new Date();
    const defaultSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sinceDate = since ? new Date(since) : defaultSince;
    const untilDate = until ? new Date(until) : now;
    if (Number.isNaN(sinceDate.getTime()) || Number.isNaN(untilDate.getTime())) {
      return res.status(400).json({
        error: "since and until must be valid ISO8601 dates",
        code: "INVALID_RANGE",
      });
    }
    if (untilDate.getTime() < sinceDate.getTime()) {
      return res.status(400).json({
        error: "until must be greater than or equal to since",
        code: "INVALID_RANGE",
      });
    }
    const spanMs = untilDate.getTime() - sinceDate.getTime();
    if (spanMs > ROLLUP_MAX_SPAN_DAYS * 24 * 60 * 60 * 1000) {
      return res.status(400).json({
        error: `range exceeds ${ROLLUP_MAX_SPAN_DAYS}-day maximum`,
        code: "INVALID_RANGE",
      });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // Pull inbound-source rows in the window, scoped to the tenant.
    // Prisma groupBy on `source` would return one row per literal source
    // string ("inbound:voyagr", "inbound:webform", …) — we collapse those
    // into the channel suffix client-side so the response shape stays
    // {channel, count} regardless of how the source field evolves.
    const rows = await prisma.contact.groupBy({
      by: ["source"],
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        source: { startsWith: "inbound:" },
        createdAt: {
          gte: sinceDate,
          lte: untilDate,
        },
      },
      _count: { _all: true },
    });

    // Seed every VALID_CHANNEL bucket to 0 so the response shape is
    // stable for downstream chart code (no "where did webform go?" when
    // a tenant has 0 webform leads).
    const buckets = Object.create(null);
    for (const c of VALID_CHANNELS) buckets[c] = 0;

    let unknownCount = 0;
    for (const row of rows || []) {
      const source = row.source || "";
      const count = row._count?._all ?? 0;
      if (!source.startsWith("inbound:")) {
        unknownCount += count;
        continue;
      }
      const suffix = source.slice("inbound:".length);
      if (Object.prototype.hasOwnProperty.call(buckets, suffix)) {
        buckets[suffix] += count;
      } else {
        // Source has the inbound: prefix but a channel value we don't
        // know about (e.g. a future channel that hasn't been promoted
        // into VALID_CHANNELS yet, or stale data from before the enum
        // tightened). Surface in the unknown bucket so the total still
        // reconciles.
        unknownCount += count;
      }
    }

    const byChannel = VALID_CHANNELS.map((channel) => ({
      channel,
      count: buckets[channel],
    }));
    if (unknownCount > 0) {
      byChannel.push({ channel: "unknown", count: unknownCount });
    }
    const total = byChannel.reduce((acc, b) => acc + b.count, 0);

    return res.status(200).json({
      tenantId: tenant.id,
      tenantSlug,
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
      byChannel,
      total,
    });
  } catch (e) {
    console.error("[travel-inbound-leads] rollup error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to roll up inbound leads by channel" });
  }
});

// ─── Slice 18 — tenant-wide inbound-leads stats rollup ─────────────────
//
// GET /inbound/leads/stats?tenantSlug=<slug>&from=<ISO>&to=<ISO>
//
// Higher-level summary surface above slice-10 /by-channel. Where /by-channel
// returns one row per channel for a single window, /stats returns the
// full operator KPI tile-strip in one call: total inbound count + per-channel
// breakdown (every VALID_CHANNEL pre-seeded to 0) + per-source breakdown
// (top-10 free-text sources + _other) + per-subBrand breakdown +
// today/week/month counts + lastReceivedAt.
//
// Closes the structural-correctness gap flagged in CLAUDE.md (client-side
// aggregation over a paginated endpoint): without this, the operator dashboard
// has to fetch /api/contacts?limit=N and reduce() to render the inbound-leads
// KPI strip — broken once N exceeds the page size.
//
// USER-readable (anodyne — counts + timestamps only; no payload contents).
//
// Query params:
//   tenantSlug  REQUIRED — resolves to a travel tenant; 404 / 400 on miss.
//   from        OPTIONAL — ISO8601 lower bound on Contact.createdAt (inclusive).
//   to          OPTIONAL — ISO8601 upper bound on Contact.createdAt (inclusive).
//
// Response shape (200):
//   {
//     tenantId, tenantSlug,
//     total,                          // count of all matching inbound contacts
//     byChannel: {                    // every VALID_CHANNEL pre-seeded to 0
//       voyagr, webform, whatsapp, ads, adsgpt, metaads, manual,
//       indiamart, justdial, tradeindia,
//     },
//     bySource: { <source>: count },  // top-10 distinct free-text sources;
//                                     // surplus collapses into _other.
//     bySubBrand: { <subBrand|_none>: count },
//     todayCount,                     // createdAt >= startOfDay(now)
//     thisWeekCount,                  // createdAt >= now - 7d
//     thisMonthCount,                 // createdAt >= now - 30d
//     lastReceivedAt,                 // ISO string or null
//   }
//
// Defensive: unknown channels (source prefix doesn't decode to a
// VALID_CHANNEL suffix) are skipped — byChannel stays at exactly 10 keys.
// Empty tenant → all zeros + lastReceivedAt:null.
//
// Errors:
//   400 MISSING_TENANT_SLUG / INVALID_DATE / WRONG_VERTICAL
//   404 TENANT_NOT_FOUND
//   500 generic envelope
const STATS_TOP_SOURCES = 10;

router.get("/inbound/leads/stats", async (req, res) => {
  try {
    const { tenantSlug, from, to } = req.query || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Optional ISO from/to bounds on Contact.createdAt. Both inclusive.
    const createdAtWindow = {};
    if (from) {
      const d = new Date(String(from));
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      createdAtWindow.gte = d;
    }
    if (to) {
      const d = new Date(String(to));
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      createdAtWindow.lte = d;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // Base predicate — tenant-scoped, soft-delete-aware, inbound-source-only.
    // Each window-derived count re-applies the base predicate and tacks on its
    // own createdAt floor so we don't double-filter the user-supplied window
    // against the rolling today/week/month windows (which would always return 0
    // if the user passed a from/to slice that excluded "now").
    const baseWhere = {
      tenantId: tenant.id,
      deletedAt: null,
      source: { startsWith: "inbound:" },
    };
    const windowedWhere = { ...baseWhere };
    if (Object.keys(createdAtWindow).length > 0) {
      windowedWhere.createdAt = createdAtWindow;
    }

    // Pull the full windowed inbound-contact roster. Selects only the columns
    // we aggregate against to keep the payload tight even on large tenants.
    const rows = await prisma.contact.findMany({
      where: windowedWhere,
      select: {
        source: true,
        subBrand: true,
        createdAt: true,
      },
    });

    // Pre-seed byChannel with every VALID_CHANNEL at 0 — stable response
    // shape for the frontend chart code.
    const byChannel = Object.create(null);
    for (const c of VALID_CHANNELS) byChannel[c] = 0;
    const bySourceRaw = Object.create(null);
    const bySubBrand = Object.create(null);
    let lastReceivedAt = null;
    let total = 0;

    for (const row of rows) {
      total += 1;
      const src = row.source || "";
      // Bucket into byChannel when the source decodes to a known channel.
      if (src.startsWith("inbound:")) {
        const suffix = src.slice("inbound:".length);
        if (Object.prototype.hasOwnProperty.call(byChannel, suffix)) {
          byChannel[suffix] += 1;
        }
        // Defensive: unknown channels (source prefix present, suffix
        // outside VALID_CHANNELS) silently drop from byChannel — keeps the
        // key set at exactly 10 per the slice contract.
      }
      // Raw source breakdown — keep full literal source string; collapse
      // to top-10 + _other after the scan.
      bySourceRaw[src] = (bySourceRaw[src] || 0) + 1;

      const sbKey = row.subBrand ? String(row.subBrand) : "_none";
      bySubBrand[sbKey] = (bySubBrand[sbKey] || 0) + 1;

      if (row.createdAt) {
        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastReceivedAt || ts > lastReceivedAt) lastReceivedAt = ts;
        }
      }
    }

    // Collapse bySource to top-STATS_TOP_SOURCES + _other.
    const sortedSources = Object.entries(bySourceRaw).sort(
      (a, b) => b[1] - a[1],
    );
    const bySource = Object.create(null);
    let otherCount = 0;
    for (let i = 0; i < sortedSources.length; i++) {
      if (i < STATS_TOP_SOURCES) {
        bySource[sortedSources[i][0]] = sortedSources[i][1];
      } else {
        otherCount += sortedSources[i][1];
      }
    }
    if (otherCount > 0) bySource._other = otherCount;

    // Rolling day/week/month counts — each re-fires a tenant-scoped count
    // with its own createdAt floor. Cheaper than scanning the full table
    // three more times because Prisma .count uses the indexed createdAt
    // path. Background-cron writes during the call are tolerated (they'd
    // show up in a refetch within seconds).
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const weekFloor = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthFloor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [todayCount, thisWeekCount, thisMonthCount] = await Promise.all([
      prisma.contact.count({
        where: { ...baseWhere, createdAt: { gte: startOfDay } },
      }),
      prisma.contact.count({
        where: { ...baseWhere, createdAt: { gte: weekFloor } },
      }),
      prisma.contact.count({
        where: { ...baseWhere, createdAt: { gte: monthFloor } },
      }),
    ]);

    return res.status(200).json({
      tenantId: tenant.id,
      tenantSlug,
      total,
      byChannel,
      bySource,
      bySubBrand,
      todayCount,
      thisWeekCount,
      thisMonthCount,
      lastReceivedAt: lastReceivedAt ? lastReceivedAt.toISOString() : null,
    });
  } catch (e) {
    console.error("[travel-inbound-leads] stats error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to summarise inbound leads" });
  }
});

// ─── Slice 20 — tenant-wide monthly time-series rollup ─────────────────
//
// GET /inbound/leads/by-month?tenantSlug=<slug>
//
// Tenant-wide inbound-lead time-series bucketed by UTC YYYY-MM. Pairs with
// slice-10 /by-channel (single-window per-channel) + slice-18 /stats
// (tenant-wide KPI tile-strip) — this is the time-series surface that
// lets the operator dashboard render a monthly trend chart without
// client-side-reducing over /api/contacts?limit=N (the structural-correctness
// anti-pattern called out in CLAUDE.md).
//
// Each month bucket carries an embedded per-channel sub-breakdown
// (byChannel) pre-seeded with all 10 VALID_CHANNELS at 0 per slice-18
// convention. The byChannel sub-shape is stable across months — empty
// months still ship the full 10-key map at 0.
//
// USER-readable (anodyne — counts only; no payload contents).
//
// Query params:
//   tenantSlug  REQUIRED — resolves to a travel tenant; 404 / 400 on miss.
//   channel     OPTIONAL — narrow to a single VALID_CHANNEL; otherwise
//                          all inbound-source rows are bucketed.
//   from        OPTIONAL — YYYY-MM lower bound (inclusive). Default: no floor.
//   to          OPTIONAL — YYYY-MM upper bound (inclusive). Default: no ceiling.
//   orderBy     OPTIONAL — one of: month:asc | month:desc | count:asc | count:desc.
//                          Default: month:asc.
//   limit       OPTIONAL — page size (default 12, max 60).
//   offset      OPTIONAL — skip-N (default 0).
//
// Response shape (200):
//   {
//     months: [
//       {
//         month,                    // YYYY-MM (UTC)
//         count,                    // total inbound contacts in that month
//         byChannel: { voyagr, webform, whatsapp, ads, adsgpt, metaads,
//                      manual, indiamart, justdial, tradeindia },
//       },
//       ...
//     ],
//     totalMonths,                  // distinct months matched (pre-pagination)
//     grandCount,                   // sum of all month.count values (pre-pagination)
//     limit, offset,
//   }
//
// Bucket key uses UTC (Contact.createdAt.toISOString().slice(0,7)) so the
// time-series is stable across operator timezones. A future slice can add
// an explicit `?tz=` for tenant-local bucketing once the analytics UI
// exposes it.
//
// Errors:
//   400 MISSING_TENANT_SLUG / INVALID_MONTH_FORMAT / INVALID_CHANNEL
//       / INVALID_ORDER_BY / INVALID_LIMIT / WRONG_VERTICAL
//   404 TENANT_NOT_FOUND
//   500 generic envelope
const BY_MONTH_DEFAULT_LIMIT = 12;
const BY_MONTH_MAX_LIMIT = 60;
const VALID_ORDER_BY = new Set([
  "month:asc",
  "month:desc",
  "count:asc",
  "count:desc",
]);
const YYYY_MM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get("/inbound/leads/by-month", async (req, res) => {
  try {
    const {
      tenantSlug,
      channel,
      from,
      to,
      orderBy: orderByRaw,
      limit: limitRaw,
      offset: offsetRaw,
    } = req.query || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Validate ?channel (when supplied). Reuse the route's enum so a future
    // VALID_CHANNELS expansion picks up automatically.
    if (channel !== undefined && !VALID_CHANNELS.includes(String(channel))) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
        code: "INVALID_CHANNEL",
      });
    }

    // Validate ?from / ?to YYYY-MM bounds. Both inclusive.
    if (from !== undefined && !YYYY_MM_RE.test(String(from))) {
      return res.status(400).json({
        error: "from must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }
    if (to !== undefined && !YYYY_MM_RE.test(String(to))) {
      return res.status(400).json({
        error: "to must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }

    // Validate ?orderBy. Default month:asc.
    const orderBy = orderByRaw ? String(orderByRaw) : "month:asc";
    if (!VALID_ORDER_BY.has(orderBy)) {
      return res.status(400).json({
        error: `orderBy must be one of: ${[...VALID_ORDER_BY].join(", ")}`,
        code: "INVALID_ORDER_BY",
      });
    }

    // Validate ?limit / ?offset. Default 12 / 0; cap 60.
    let limit = BY_MONTH_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(String(limitRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > BY_MONTH_MAX_LIMIT) {
        return res.status(400).json({
          error: `limit must be an integer between 1 and ${BY_MONTH_MAX_LIMIT}`,
          code: "INVALID_LIMIT",
        });
      }
      limit = parsed;
    }
    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsed = Number.parseInt(String(offsetRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({
          error: "offset must be a non-negative integer",
          code: "INVALID_LIMIT",
        });
      }
      offset = parsed;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // Build the base where-predicate. When ?channel is supplied, narrow
    // source to that exact `inbound:<channel>` literal so the time-series
    // reflects a single channel slice; otherwise scan all inbound rows.
    const where = {
      tenantId: tenant.id,
      deletedAt: null,
      source: channel
        ? `inbound:${channel}`
        : { startsWith: "inbound:" },
    };

    // Pull the windowed roster + bucket client-side. Prisma's groupBy
    // can't bucket by month directly (no $dateToString helper), so we
    // load (source, createdAt) tuples and bucket in JS. For tenants
    // expected to outgrow this, a follow-up slice can swap to a raw
    // Prisma.$queryRaw with DATE_FORMAT.
    const rows = await prisma.contact.findMany({
      where,
      select: { source: true, createdAt: true },
    });

    // Bucket by UTC YYYY-MM. Each bucket also carries a byChannel
    // sub-map pre-seeded with all VALID_CHANNELS at 0 for stable shape.
    const monthMap = new Map();
    function getBucket(monthKey) {
      let bucket = monthMap.get(monthKey);
      if (!bucket) {
        const byChannel = Object.create(null);
        for (const c of VALID_CHANNELS) byChannel[c] = 0;
        bucket = { month: monthKey, count: 0, byChannel };
        monthMap.set(monthKey, bucket);
      }
      return bucket;
    }

    for (const row of rows) {
      if (!row.createdAt) continue;
      const ts = row.createdAt instanceof Date
        ? row.createdAt
        : new Date(row.createdAt);
      if (Number.isNaN(ts.getTime())) continue;
      const monthKey = ts.toISOString().slice(0, 7); // YYYY-MM
      // Apply YYYY-MM window post-bucket (string compare works since
      // the format is fixed-width lex-sortable).
      if (from && monthKey < String(from)) continue;
      if (to && monthKey > String(to)) continue;
      const bucket = getBucket(monthKey);
      bucket.count += 1;
      const src = row.source || "";
      if (src.startsWith("inbound:")) {
        const suffix = src.slice("inbound:".length);
        if (Object.prototype.hasOwnProperty.call(bucket.byChannel, suffix)) {
          bucket.byChannel[suffix] += 1;
        }
        // Unknown channels silently drop from byChannel (keeps the
        // per-month key set at exactly 10).
      }
    }

    const allMonths = [...monthMap.values()];
    const totalMonths = allMonths.length;
    const grandCount = allMonths.reduce((acc, m) => acc + m.count, 0);

    // Sort per ?orderBy. month:asc/desc uses the lex order of the
    // YYYY-MM key; count:asc/desc breaks ties by month:asc for a
    // deterministic ordering even when counts tie.
    const [orderField, orderDir] = orderBy.split(":");
    allMonths.sort((a, b) => {
      if (orderField === "month") {
        return orderDir === "asc"
          ? a.month.localeCompare(b.month)
          : b.month.localeCompare(a.month);
      }
      // count
      const delta = orderDir === "asc" ? a.count - b.count : b.count - a.count;
      if (delta !== 0) return delta;
      return a.month.localeCompare(b.month);
    });

    const paged = allMonths.slice(offset, offset + limit);

    return res.status(200).json({
      months: paged,
      totalMonths,
      grandCount,
      limit,
      offset,
    });
  } catch (e) {
    console.error("[travel-inbound-leads] by-month error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to roll up inbound leads by month" });
  }
});

// ─── Slice 21 — tenant-wide quarterly time-series rollup ─────────────────
//
// GET /inbound/leads/by-quarter?tenantSlug=<slug>
//
// PRD_TRAVEL_MULTICHANNEL_LEADS (#904) — sibling rollup to slice-20
// /inbound/leads/by-month and slice-18 /inbound/leads/stats. Buckets inbound
// Contact rows by UTC YYYY-Q[1-4] so the operator dashboard can render a
// quarterly trend chart (finance review cadence, supplier reconciliation,
// RFU Umrah seasonal planning) in a single endpoint hit instead of
// summing 3 month rows client-side.
//
// Mirrors the slice-17 /api/travel/itineraries/by-quarter pattern (same
// YYYY-Q[1-4] bucket-key shape, same Math.floor(getUTCMonth()/3)+1
// derivation, same VALID_ORDER_BY set, same "unknown" fallback bucket for
// null/invalid createdAt rows, same pagination-after-aggregation posture).
// Auth / sub-brand handling mirrors slice-20 /by-month EXACTLY (no
// verifyToken, tenantSlug-scoped, no sub-brand restriction — these
// rollups predate the subBrandAccess gating that landed on the itinerary
// surface).
//
// USER-readable (anodyne — counts only; no payload contents).
//
// Quarter key derivation:
//   const yyyy = dt.getUTCFullYear();
//   const q = Math.floor(dt.getUTCMonth() / 3) + 1;
//   const quarterKey = `${yyyy}-Q${q}`;
//
// Query params:
//   tenantSlug  REQUIRED — resolves to a travel tenant; 404 / 400 on miss.
//   channel     OPTIONAL — narrow to a single VALID_CHANNEL; otherwise
//                          all inbound-source rows are bucketed.
//   from        OPTIONAL — YYYY-Q[1-4] lower bound (inclusive). Default: no floor.
//   to          OPTIONAL — YYYY-Q[1-4] upper bound (inclusive). Default: no ceiling.
//   orderBy     OPTIONAL — one of: quarter:asc | quarter:desc | count:asc | count:desc.
//                          Unknown tokens degrade silently to quarter:asc.
//   limit       OPTIONAL — page size (default 8, max 40).
//   offset      OPTIONAL — skip-N (default 0).
//
// Response shape (200):
//   {
//     total,                          // distinct quarters matched (pre-pagination)
//     rows: [
//       {
//         quarter,                    // YYYY-Q[1-4] (UTC), or "unknown"
//         count,                      // total inbound contacts in that quarter
//         bySubBrand: { <sb>: n, _tenant: n },
//         byChannel: { voyagr, webform, whatsapp, ads, adsgpt, metaads,
//                      manual, indiamart, justdial, tradeindia },
//       },
//     ],
//   }
//
// Per-bucket bySubBrand: falsy subBrand (null/undefined/empty) coerces to
// "_tenant" so the breakdown remains a flat string→int map even when
// some rows have no sub-brand attribution. Forward-compat with the
// sub-brand rollouts (Q25 — TMC / RFU / Travel Stall / Visa Sure).
//
// "unknown" bucket: rows with null or invalid createdAt fall here when no
// ?from/?to window is set. When EITHER bound is set, the "unknown"
// bucket is excluded (it has no comparable quarter token).
//
// Route ordering: declared BEFORE the POST /inbound/leads/:channel family
// (which lives above in the file) is irrelevant for GET — Express
// dispatch is verb-aware. No collision risk.
//
// Errors:
//   400 MISSING_TENANT_SLUG / INVALID_QUARTER_FORMAT / INVALID_CHANNEL
//       / INVALID_LIMIT / WRONG_VERTICAL
//   404 TENANT_NOT_FOUND
//   500 generic envelope
const BY_QUARTER_DEFAULT_LIMIT = 8;
const BY_QUARTER_MAX_LIMIT = 40;
const BY_QUARTER_VALID_ORDER_BY = new Set([
  "quarter:asc",
  "quarter:desc",
  "count:asc",
  "count:desc",
]);
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

router.get("/inbound/leads/by-quarter", async (req, res) => {
  try {
    const {
      tenantSlug,
      channel,
      from,
      to,
      orderBy: orderByRaw,
      limit: limitRaw,
      offset: offsetRaw,
    } = req.query || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Validate ?channel (when supplied). Mirrors /by-month exactly.
    if (channel !== undefined && !VALID_CHANNELS.includes(String(channel))) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
        code: "INVALID_CHANNEL",
      });
    }

    // Validate ?from / ?to YYYY-Q[1-4] bounds. Both inclusive.
    if (from !== undefined && !QUARTER_RE.test(String(from))) {
      return res.status(400).json({
        error: "from must be in YYYY-Q[1-4] format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }
    if (to !== undefined && !QUARTER_RE.test(String(to))) {
      return res.status(400).json({
        error: "to must be in YYYY-Q[1-4] format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }

    // Validate ?orderBy — unknown tokens degrade silently to quarter:asc
    // (per spec; differs from /by-month which 400s on unknown).
    const orderByCandidate = orderByRaw ? String(orderByRaw) : "quarter:asc";
    const orderBy = BY_QUARTER_VALID_ORDER_BY.has(orderByCandidate)
      ? orderByCandidate
      : "quarter:asc";

    // Validate ?limit / ?offset. Default 8 / 0; cap 40.
    let limit = BY_QUARTER_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(String(limitRaw), 10);
      if (
        !Number.isFinite(parsed) ||
        parsed < 1 ||
        parsed > BY_QUARTER_MAX_LIMIT
      ) {
        return res.status(400).json({
          error: `limit must be an integer between 1 and ${BY_QUARTER_MAX_LIMIT}`,
          code: "INVALID_LIMIT",
        });
      }
      limit = parsed;
    }
    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsed = Number.parseInt(String(offsetRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({
          error: "offset must be a non-negative integer",
          code: "INVALID_LIMIT",
        });
      }
      offset = parsed;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // Build the base where-predicate. When ?channel is supplied, narrow
    // source to that exact `inbound:<channel>` literal (mirrors /by-month).
    const where = {
      tenantId: tenant.id,
      deletedAt: null,
      source: channel ? `inbound:${channel}` : { startsWith: "inbound:" },
    };

    // Light projection — source for byChannel derivation, subBrand for
    // bySubBrand bucket, createdAt for the quarter key.
    const rows = await prisma.contact.findMany({
      where,
      select: { source: true, subBrand: true, createdAt: true },
    });

    // Bucket by UTC YYYY-Q[1-4]. Each bucket carries a byChannel sub-map
    // pre-seeded with all VALID_CHANNELS at 0 for stable shape, plus a
    // bySubBrand sub-map that grows on demand.
    const quarterMap = new Map();
    function getBucket(quarterKey) {
      let bucket = quarterMap.get(quarterKey);
      if (!bucket) {
        const byChannel = Object.create(null);
        for (const c of VALID_CHANNELS) byChannel[c] = 0;
        bucket = {
          quarter: quarterKey,
          count: 0,
          bySubBrand: Object.create(null),
          byChannel,
        };
        quarterMap.set(quarterKey, bucket);
      }
      return bucket;
    }

    for (const row of rows) {
      let quarterKey = "unknown";
      if (row.createdAt) {
        const dt =
          row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const q = Math.floor(dt.getUTCMonth() / 3) + 1;
          quarterKey = `${yyyy}-Q${q}`;
        }
      }
      const bucket = getBucket(quarterKey);
      bucket.count += 1;

      // Per-bucket bySubBrand — falsy subBrand coerces to "_tenant" so the
      // breakdown is forward-compat with sub-brand rollouts (TMC / RFU /
      // Travel Stall / Visa Sure per Q25). Stays a flat string→int map.
      const sbKey = row.subBrand ? String(row.subBrand) : "_tenant";
      bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;

      const src = row.source || "";
      if (src.startsWith("inbound:")) {
        const suffix = src.slice("inbound:".length);
        if (Object.prototype.hasOwnProperty.call(bucket.byChannel, suffix)) {
          bucket.byChannel[suffix] += 1;
        }
        // Unknown channels silently drop from byChannel — keeps the
        // per-quarter key set at exactly 10.
      }
    }

    let quarters = [...quarterMap.values()];

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable quarter token); when
    // no bounds are set, "unknown" stays.
    if (from !== undefined) {
      const fromStr = String(from);
      quarters = quarters.filter(
        (r) => r.quarter !== "unknown" && r.quarter >= fromStr,
      );
    }
    if (to !== undefined) {
      const toStr = String(to);
      quarters = quarters.filter(
        (r) => r.quarter !== "unknown" && r.quarter <= toStr,
      );
    }

    // Sort per ?orderBy. quarter:asc/desc uses the lex order of the
    // YYYY-Q[1-4] key (also chronological — Q1 < Q2 < Q3 < Q4 in ASCII).
    // count:asc/desc breaks ties by quarter:asc for a deterministic
    // ordering even when counts tie.
    const [orderField, orderDir] = orderBy.split(":");
    quarters.sort((a, b) => {
      if (orderField === "quarter") {
        return orderDir === "asc"
          ? a.quarter.localeCompare(b.quarter)
          : b.quarter.localeCompare(a.quarter);
      }
      const delta = orderDir === "asc" ? a.count - b.count : b.count - a.count;
      if (delta !== 0) return delta;
      return a.quarter.localeCompare(b.quarter);
    });

    const total = quarters.length;
    // Pagination applied AFTER aggregation + sort + bucket filter, same as
    // /by-month.
    const paged = quarters.slice(offset, offset + limit);

    return res.status(200).json({
      total,
      rows: paged,
    });
  } catch (e) {
    console.error("[travel-inbound-leads] by-quarter error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to roll up inbound leads by quarter" });
  }
});

// ─── Slice 22 — tenant-wide annual time-series rollup ─────────────────────
//
// GET /inbound/leads/by-year?tenantSlug=<slug>
//
// PRD_TRAVEL_MULTICHANNEL_LEADS (#904) — completes the inbound-leads rollup
// triplet (by-month / by-quarter / now by-year; sibling to /stats). Buckets
// inbound Contact rows by UTC YYYY so the operator dashboard can render an
// annual trend chart (year-over-year growth, finance annual review, RFU
// Umrah season-vs-season planning) in a single endpoint hit instead of
// summing 4 quarter rows client-side.
//
// Mirrors slice-21 /by-quarter EXACTLY — same handler shape, same auth
// posture (no verifyToken, tenantSlug-public-surface), same JS-side
// aggregation over a light projection, same per-bucket bySubBrand +
// byChannel sub-maps, same "unknown" fallback bucket for null/invalid
// createdAt, same pagination-after-aggregation posture. Only the bucket-key
// derivation collapses to YYYY (Math.floor not needed; just getUTCFullYear).
//
// Auth model: NO verifyToken — tenantSlug-gated public surface, sibling to
// /by-month and /by-quarter which sit under server.js's openPaths list.
// Sub-brand handling mirrors /by-quarter: NO subBrandAccess narrowing on
// the rollup family (these endpoints predate the subBrandAccess gating
// that landed on the itinerary surface), narrowing happens JS-side via the
// projected subBrand field in each bucket's bySubBrand sub-map.
//
// USER-readable (anodyne — counts only; no payload contents).
//
// Year key derivation:
//   const yearKey = String(dt.getUTCFullYear());   // "2026"
//
// Query params:
//   tenantSlug  REQUIRED — resolves to a travel tenant; 404 / 400 on miss.
//   channel     OPTIONAL — narrow to a single VALID_CHANNEL; otherwise
//                          all inbound-source rows are bucketed.
//   from        OPTIONAL — YYYY lower bound (inclusive). Default: no floor.
//   to          OPTIONAL — YYYY upper bound (inclusive). Default: no ceiling.
//   orderBy     OPTIONAL — one of: year:asc | year:desc | count:asc | count:desc.
//                          Unknown tokens degrade silently to year:asc
//                          (mirrors /by-quarter; differs from /by-month
//                          which 400s on unknown).
//   limit       OPTIONAL — page size (default 10, max 30).
//   offset      OPTIONAL — skip-N (default 0).
//
// Response shape (200):
//   {
//     total,                          // distinct years matched (pre-pagination)
//     rows: [
//       {
//         year,                       // YYYY (UTC), or "unknown"
//         count,                      // total inbound contacts in that year
//         bySubBrand: { <sb>: n, _tenant: n },
//         byChannel: { voyagr, webform, whatsapp, ads, adsgpt, metaads,
//                      manual, indiamart, justdial, tradeindia },
//       },
//     ],
//   }
//
// Per-bucket bySubBrand: falsy subBrand (null/undefined/empty) coerces to
// "_tenant" so the breakdown remains a flat string→int map even when
// some rows have no sub-brand attribution. Forward-compat with the
// sub-brand rollouts (Q25 — TMC / RFU / Travel Stall / Visa Sure).
//
// "unknown" bucket: rows with null or invalid createdAt fall here when no
// ?from/?to window is set. When EITHER bound is set, the "unknown"
// bucket is excluded (it has no comparable year token).
//
// Errors:
//   400 MISSING_TENANT_SLUG / INVALID_YEAR_FORMAT / INVALID_CHANNEL
//       / INVALID_LIMIT / WRONG_VERTICAL
//   404 TENANT_NOT_FOUND
//   500 generic envelope
const BY_YEAR_DEFAULT_LIMIT = 10;
const BY_YEAR_MAX_LIMIT = 30;
const BY_YEAR_VALID_ORDER_BY = new Set([
  "year:asc",
  "year:desc",
  "count:asc",
  "count:desc",
]);
const YEAR_RE = /^\d{4}$/;

router.get("/inbound/leads/by-year", async (req, res) => {
  try {
    const {
      tenantSlug,
      channel,
      from,
      to,
      orderBy: orderByRaw,
      limit: limitRaw,
      offset: offsetRaw,
    } = req.query || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }

    // Validate ?channel (when supplied). Mirrors /by-month + /by-quarter.
    if (channel !== undefined && !VALID_CHANNELS.includes(String(channel))) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
        code: "INVALID_CHANNEL",
      });
    }

    // Validate ?from / ?to YYYY bounds. Both inclusive.
    if (from !== undefined && !YEAR_RE.test(String(from))) {
      return res.status(400).json({
        error: "from must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }
    if (to !== undefined && !YEAR_RE.test(String(to))) {
      return res.status(400).json({
        error: "to must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }

    // Validate ?orderBy — unknown tokens degrade silently to year:asc
    // (mirrors /by-quarter posture).
    const orderByCandidate = orderByRaw ? String(orderByRaw) : "year:asc";
    const orderBy = BY_YEAR_VALID_ORDER_BY.has(orderByCandidate)
      ? orderByCandidate
      : "year:asc";

    // Validate ?limit / ?offset. Default 10 / 0; cap 30.
    let limit = BY_YEAR_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(String(limitRaw), 10);
      if (
        !Number.isFinite(parsed) ||
        parsed < 1 ||
        parsed > BY_YEAR_MAX_LIMIT
      ) {
        return res.status(400).json({
          error: `limit must be an integer between 1 and ${BY_YEAR_MAX_LIMIT}`,
          code: "INVALID_LIMIT",
        });
      }
      limit = parsed;
    }
    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsed = Number.parseInt(String(offsetRaw), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({
          error: "offset must be a non-negative integer",
          code: "INVALID_LIMIT",
        });
      }
      offset = parsed;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, vertical: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    if (tenant.vertical !== "travel") {
      return res.status(400).json({
        error: "Tenant is not a travel tenant",
        code: "WRONG_VERTICAL",
      });
    }

    // Build the base where-predicate. When ?channel is supplied, narrow
    // source to that exact `inbound:<channel>` literal (mirrors /by-month
    // and /by-quarter).
    const where = {
      tenantId: tenant.id,
      deletedAt: null,
      source: channel ? `inbound:${channel}` : { startsWith: "inbound:" },
    };

    // Light projection — source for byChannel derivation, subBrand for
    // bySubBrand bucket, createdAt for the year key.
    const rows = await prisma.contact.findMany({
      where,
      select: { source: true, subBrand: true, createdAt: true },
    });

    // Bucket by UTC YYYY. Each bucket carries a byChannel sub-map
    // pre-seeded with all VALID_CHANNELS at 0 for stable shape, plus a
    // bySubBrand sub-map that grows on demand.
    const yearMap = new Map();
    function getBucket(yearKey) {
      let bucket = yearMap.get(yearKey);
      if (!bucket) {
        const byChannel = Object.create(null);
        for (const c of VALID_CHANNELS) byChannel[c] = 0;
        bucket = {
          year: yearKey,
          count: 0,
          bySubBrand: Object.create(null),
          byChannel,
        };
        yearMap.set(yearKey, bucket);
      }
      return bucket;
    }

    for (const row of rows) {
      let yearKey = "unknown";
      if (row.createdAt) {
        const dt =
          row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }
      const bucket = getBucket(yearKey);
      bucket.count += 1;

      // Per-bucket bySubBrand — falsy subBrand coerces to "_tenant" so the
      // breakdown is forward-compat with sub-brand rollouts (TMC / RFU /
      // Travel Stall / Visa Sure per Q25). Stays a flat string→int map.
      const sbKey = row.subBrand ? String(row.subBrand) : "_tenant";
      bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;

      const src = row.source || "";
      if (src.startsWith("inbound:")) {
        const suffix = src.slice("inbound:".length);
        if (Object.prototype.hasOwnProperty.call(bucket.byChannel, suffix)) {
          bucket.byChannel[suffix] += 1;
        }
        // Unknown channels silently drop from byChannel — keeps the
        // per-year key set at exactly 10.
      }
    }

    let years = [...yearMap.values()];

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable year token); when no
    // bounds are set, "unknown" stays.
    if (from !== undefined) {
      const fromStr = String(from);
      years = years.filter(
        (r) => r.year !== "unknown" && r.year >= fromStr,
      );
    }
    if (to !== undefined) {
      const toStr = String(to);
      years = years.filter(
        (r) => r.year !== "unknown" && r.year <= toStr,
      );
    }

    // Sort per ?orderBy. year:asc/desc uses the lex order of the YYYY key
    // (4-digit zero-padded; chronological by construction). count:asc/desc
    // breaks ties by year:asc for a deterministic ordering even when
    // counts tie.
    const [orderField, orderDir] = orderBy.split(":");
    years.sort((a, b) => {
      if (orderField === "year") {
        return orderDir === "asc"
          ? a.year.localeCompare(b.year)
          : b.year.localeCompare(a.year);
      }
      const delta = orderDir === "asc" ? a.count - b.count : b.count - a.count;
      if (delta !== 0) return delta;
      return a.year.localeCompare(b.year);
    });

    const total = years.length;
    // Pagination applied AFTER aggregation + sort + bucket filter, same as
    // /by-month + /by-quarter.
    const paged = years.slice(offset, offset + limit);

    return res.status(200).json({
      total,
      rows: paged,
    });
  } catch (e) {
    console.error("[travel-inbound-leads] by-year error:", e.message);
    return res
      .status(500)
      .json({ error: "Failed to roll up inbound leads by year" });
  }
});

module.exports = router;
