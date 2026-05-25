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

// Slice-1 channel enum — narrower than the full PRD §3.1.2 16-value enum
// because slice 1 only ships the four launch-critical Travel-Stall channels
// (web_form + WhatsApp + Meta + Voyagr) + the scaffolding-bypass surfaces
// (ads / adsgpt / manual). Marketplace channels (indiamart / justdial /
// tradeindia) stay on their existing route until the cron refactor in slice 3.
const VALID_CHANNELS = [
  "voyagr",
  "webform",
  "whatsapp",
  "ads",
  "adsgpt",
  "metaads",
  "manual",
];

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

    // STUB (Q9 / Q1 / Voyagr HMAC): channel-specific verification pending
    // creds. Today the handler trusts the payload — the X-API-Key middleware
    // (slice 2 wire-in) is the perimeter for now.

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
        status: "Lead",
      },
    });

    return res.status(201).json({
      id: created.id,
      contactId: created.id,
      tenantId: tenant.id,
      channel,
      status: "received",
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

module.exports = router;
