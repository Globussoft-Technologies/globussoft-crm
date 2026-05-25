/**
 * /api/travel/inbound/leads/:channel — multi-channel lead capture (PRD #904).
 *
 * Accepts inbound lead payloads from external producers (Voyagr microsites,
 * web forms, WhatsApp, ads platforms). Persists as Contact rows tagged with
 * sourceChannel + sub-brand, ready for the downstream LeadAutoRouter and
 * Touchpoint chain that lands in subsequent slices.
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

// Slice-1 channel enum — narrower than the full PRD §3.1.2 16-value enum
// because slice 1 only shipped the four launch-critical Travel-Stall channels
// (web_form + WhatsApp + Meta + Voyagr) + the scaffolding-bypass surfaces
// (ads / adsgpt / manual). Marketplace channels (indiamart / justdial /
// tradeindia) joined in slice 16 with their slice 13/14/15 normalizers.
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

// Slice 10 — clamp the date-range window inputs so a misconfigured caller
// can't ask the DB to scan years of Contact history. 365d is the longest
// any real Travel-Stall attribution rollup spans (annual review). The
// envelope returns 400 INVALID_RANGE when the math says `until < since`
// or the span exceeds the cap.
const ROLLUP_MAX_SPAN_DAYS = 365;

function assertValidChannel(c) {
  if (!c || !VALID_CHANNELS.includes(c)) {
    const err = new Error(
      `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
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
//         sourceUrl?, subBrand?, tenantSlug, metaJson? }
// Returns: 201 { id, channel, status: 'received', routed: false,
//                contactId, tenantId }
router.post("/inbound/leads/:channel", async (req, res) => {
  try {
    assertValidChannel(req.params.channel);

    // Slice 12 — when channel=metaads and the body carries Meta's
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
    if (req.params.channel === "metaads") {
      req.body = normalizeMetaLeadPayload(req.body);
    } else if (req.params.channel === "indiamart") {
      req.body = normalizeIndiamartLeadPayload(req.body);
    } else if (req.params.channel === "justdial") {
      req.body = normalizeJustdialLeadPayload(req.body);
    } else if (req.params.channel === "tradeindia") {
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
    } = req.body || {};

    if (!tenantSlug) {
      return res.status(400).json({
        error: "tenantSlug is required",
        code: "MISSING_TENANT_SLUG",
      });
    }
    if (!email && !phone) {
      return res.status(400).json({
        error: "either email or phone is required",
        code: "MISSING_CONTACT",
      });
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
    const channelParam = req.params.channel;
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
      const helperChannel =
        channelParam === "metaads" || MARKETPLACE_CHANNELS.has(channelParam)
          ? "ads"
          : channelParam;
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

    const channel = req.params.channel;

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
          select: { id: true, phone: true, email: true, name: true },
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
        select: { id: true, phone: true, email: true, name: true },
      });
    }

    if (existing) {
      return res.status(200).json({
        id: existing.id,
        contactId: existing.id,
        tenantId: tenant.id,
        channel,
        status: "received",
        action: "merged",
        // STUB (touchpoint slice): once Touchpoint chain lands, append a
        // row here + return touchpointId. For now we signal the merge so
        // operator-side UI can render "duplicate detected" badge.
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

    const created = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: buildName({ name, firstName, lastName }),
        email: ensureEmail(email, channel),
        phone: phone || null,
        source: source || `inbound:${channel}`,
        // Contact.subBrand is the existing travel sub-brand column (nullable
        // for non-travel tenants). Trust the producer's payload — verification
        // moves with cred-drop in slice 4.
        subBrand: subBrand || null,
        // Slice 11 — flip to 'Junk' when the heuristic fires so the leads
        // page can filter low-signal payloads out of the default inbox view.
        // Real leads (signed/honeypotted producers OR any payload with name
        // / real email / secondary signal) stay at 'Lead'.
        status: junkVerdict.junk ? "Junk" : "Lead",
      },
    });

    return res.status(201).json({
      id: created.id,
      contactId: created.id,
      tenantId: tenant.id,
      channel,
      status: "received",
      action: "created",
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

module.exports = router;
