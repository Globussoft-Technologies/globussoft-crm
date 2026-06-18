// Travel CRM — Itinerary CRUD routes (Phase 1).
//
// Endpoints:
//   GET    /api/travel/itineraries                          — list (paginated, filterable)
//   POST   /api/travel/itineraries                          — create itinerary (+ optional items)
//   GET    /api/travel/itineraries/by-month                  — tenant-wide monthly rollup (#907 slice 16)
//   GET    /api/travel/itineraries/by-quarter                — tenant-wide quarterly rollup (#907 slice 17)
//   GET    /api/travel/itineraries/by-year                   — tenant-wide annual rollup (#907 slice 18)
//   GET    /api/travel/itineraries/stats                     — tenant-wide aggregate envelope (#907 rollup family completion)
//   GET    /api/travel/itineraries/:id                      — fetch one with items
//   PATCH  /api/travel/itineraries/:id                      — amend top-level fields (not items)
//   POST   /api/travel/itineraries/:id/items                — append a polymorphic item
//   POST   /api/travel/itineraries/:id/items/bulk-reorder   — atomic bulk reposition (#907 slice 8)
//   POST   /api/travel/itineraries/:id/items/bulk-delete    — atomic bulk delete (#907 slice 11)
//   GET    /api/travel/itineraries/:id/items/search         — item notes search/filter (#907 slice 10)
//   GET    /api/travel/itineraries/:id/totals               — itinerary aggregation rollup (#907 slice 14)
//   PATCH  /api/travel/itineraries/:id/items/:itemId        — amend an item
//   DELETE /api/travel/itineraries/:id/items/:itemId        — remove an item
//   POST   /api/travel/itineraries/:id/items/:itemId/duplicate — clone one item in place (#907 slice 12)
//   POST   /api/travel/itineraries/:id/duplicate            — clone parent + all items (#907 slice 15)
//   POST   /api/travel/itineraries/:id/draft/regen          — regen LLM-drafted summary (PRD §4.3 + §9.1)
//
// Mounted at /api/travel by server.js. Shares the requireTravelTenant
// guard + sub-brand access check with travel_diagnostics.js (extracted
// to a shared helper in Day 11).
//
// Item polymorphism: ItineraryItem.itemType ∈ {flight, hotel, transfer,
// activity, visa, insurance}. detailsJson carries the type-specific
// payload (e.g. for flight: { from, to, depart, return, cabin, pnr }).
// The route validates itemType against the enum + parses detailsJson as
// JSON; per-type field validation is intentionally deferred (Phase 1.5)
// because each type's required fields are still being finalised with
// Yasin's supplier docs.
//
// Money fields use Decimal(15,2) per Q24.
//
// See docs/TRAVEL_CRM_PRD.md §4.3 + §5.1 for the spec.
//
// G047/G049/G051 — itinerary lineage + template metrics + AI provenance
// (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.1.e / FR-3.1.h / FR-3.4.h):
//   - POST /itineraries accepts `clonedFromTemplateId` and persists it on
//     the new Itinerary row. On clone, the parent template's `usageCount`
//     is incremented + `lastUsedAt` is bumped to `now()`.
//   - POST /itineraries/:id/accept reads back `clonedFromTemplateId` +
//     `totalAmount`, increments the parent template's `acceptedCount` and
//     recomputes `avgFinalPrice` as a rolling average across all accepted
//     clones. Both metric writes are wrapped in non-fatal try/catch so a
//     write failure never rolls back the operator's primary action.
//   - POST /itineraries/from-suggestion sets `ItineraryItem.draftedByAi=
//     true` on every materialised item; manual POST /:id/items + the
//     legacy POST /itineraries inline items leave it at the schema default
//     (false). Editor surfaces an "AI-drafted" badge on draftedByAi rows.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { renderTravelItineraryPdf } = require("../services/pdfRenderer");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  assertCompletedDiagnostic,
} = require("../middleware/travelGuards");
const { findLatestDiagnostic } = require("../lib/travelLatestDiagnostic");
const { getTravelAdvanceRatio } = require("../lib/tenantSettings");
const { computeWindowOpenAt } = require("../lib/webCheckinWindow");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
const watiClient = require("../services/watiClient");
const llmRouter = require("../lib/llmRouter");
const { computeDayCosts } = require("../lib/itineraryDayCostCalculator");
const listProjection = require("../lib/listProjection");
const { writeAudit } = require("../lib/audit");
// G124 (Master PRD A3 residual) — per-document view/download/share audit
// helper. Drops a discrete DOCUMENT_VIEW / DOCUMENT_DOWNLOAD / DOCUMENT_SHARE
// row alongside the entity-shaped writeAudit rows so the audit-viewer can
// show a "Document Access" sub-tab without re-classifying every per-route
// verb. Unit-tested at backend/test/lib/documentAccessAudit.test.js.
const { recordDocumentAccess } = require("../lib/documentAccessAudit");
// PRD §4.7 (gap A3) — share-link expiry/revocation policy. Pure helpers
// (clamp 1..30 days, default 7; revoked > expired > active precedence)
// unit-tested in test/lib/shareLinkPolicy.test.js.
const { computeShareExpiresAt, shareLinkState } = require("../lib/shareLinkPolicy");
// BYOK: customer payments settle into the TENANT's own Razorpay account (our
// platform RAZORPAY_KEY_* env vars are ONLY for tenant→Globussoft subscription
// billing). Mirrors the wellness customer-payment flow. See lib/tenantPaymentGateway.js.
const { getTenantRazorpayClient, getTenantRazorpayCreds, NOT_CONFIGURED_MESSAGE } = require("../lib/tenantPaymentGateway");
// Customer-portal in-app notifications (2026-06-17) — advisor sends/revises an
// itinerary or a payment lands → notify the customer (Contact) in their portal.
const { safeNotifyTravelCustomer } = require("../lib/travelPortalNotificationService");

// Build + emit the right customer-portal notification for a trip event.
// Best-effort (the service swallows errors) — never blocks the request.
// `itin` needs { contactId, tenantId, destination }.
function notifyCustomerTrip(itin, kind) {
  if (!itin || !itin.contactId) return;
  const dest = itin.destination || "your trip";
  const M = {
    sent: { type: "itinerary", title: "Your trip plan is ready ✈️", message: `Your advisor has prepared a trip to ${dest} for you. Open it in your portal to review and confirm.` },
    revised: { type: "itinerary", title: "Your trip plan was updated", message: `Your advisor revised your ${dest} trip plan. Please review the updated offer in your portal.` },
    advance_paid: { type: "payment", title: "Payment received — booking confirmed 🎉", message: `Thanks for your payment! Your ${dest} booking is confirmed. We'll be in touch with the next steps.` },
    fully_paid: { type: "payment", title: "Fully paid — you're all set! 🎉", message: `Thanks! We've received full payment for your ${dest} trip. Your booking is confirmed.` },
  };
  const m = M[kind];
  if (!m) return;
  // link "booking:<id>" → the portal opens THIS specific trip's detail (not the
  // list). Fire-and-forget; safeNotifyTravelCustomer never throws.
  safeNotifyTravelCustomer({ contactId: itin.contactId, tenantId: itin.tenantId, title: m.title, message: m.message, type: m.type, link: `booking:${itin.id}` });
}

// Covers fly + non-fly (domestic) transport and general trip expenses. Keep
// in sync with ITEM_TYPES in frontend/src/pages/travel/ItineraryDetail.jsx.
const VALID_ITEM_TYPES = [
  "flight", "train", "bus", "cab", "transfer", "hotel",
  "sightseeing", "activity", "meals", "visa", "insurance", "other",
];
// Phase 2 (PRD §4.7) extends the enum with advance_paid / fully_paid for
// the 50%-advance booking flow. Existing draft/sent/etc. semantics
// unchanged — the two new values are only set by the public payment
// endpoints. Routes that PATCH status accept all values.
//
// `expired` (2026-06-16): advisor-set terminal status for a booking
// auto-flagged by cron/paymentDeadlineEngine.js as deposit-overdue. Kept
// distinct from `rejected` (customer declined) so non-payment cancellations
// are reportable separately. The engine never sets it — an advisor PATCHes
// to "expired" after reviewing the overdue flag (no auto-cancel by design).
const VALID_STATUSES = ["draft", "sent", "revised", "accepted", "rejected", "advance_paid", "fully_paid", "expired"];
// Advance-deposit ratio is now per-tenant + per-sub-brand tunable via
// the TenantSetting table — see lib/tenantSettings.js. The Phase 2
// baseline (Travel Stall 50/50) is the helper's hard-coded fallback
// when no setting row exists; RFU pilgrim packages can override to
// 0.3 (30/70), TMC school trips will use their TripPaymentPlan
// instead. Keep the public GET + record-advance shapes unchanged.

function assertValidItemType(itemType) {
  if (!VALID_ITEM_TYPES.includes(itemType)) {
    const err = new Error(`itemType must be one of: ${VALID_ITEM_TYPES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_ITEM_TYPE";
    throw err;
  }
}

// ─── List + create ────────────────────────────────────────────────────

// GET /api/travel/itineraries
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction).
// Default shape unchanged (full Itinerary row + `items` include with the
// polymorphic item details). The full row includes shareToken (an
// auth-bearing public-share token), pricingJson (a heavy @db.Text
// breakdown of cost + GST + tcs lines), pdfUrl, and micrositeUrl —
// every one of these is a sensitive value that picker / dropdown
// callers don't need. Pass `?fields=summary` to opt into the slim
// projection (id + subBrand + contactId + destination + status + dates
// + totalAmount + currency + createdAt; the share token + pricing JSON
// + PDF URL are SQL-dropped at the Prisma layer). The slim path also
// SKIPS the `items` include (picker callers don't need per-item bodies).
router.get("/itineraries", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(String(req.query.status))) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      where.status = String(req.query.status);
    }
    if (req.query.contactId) {
      const cid = parseInt(req.query.contactId, 10);
      if (Number.isFinite(cid)) where.contactId = cid;
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
    };
    if (isSummary) {
      findManyArgs.select = listProjection("Itinerary", false);
    } else {
      findManyArgs.include = { items: { orderBy: { position: "asc" } } };
    }
    const [itineraries, total] = await Promise.all([
      prisma.itinerary.findMany(findManyArgs),
      prisma.itinerary.count({ where }),
    ]);
    res.json({ itineraries, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] list error:", e.message);
    res.status(500).json({ error: "Failed to list itineraries" });
  }
});

// POST /api/travel/itineraries
// Required: subBrand, contactId, destination. Optional: leadId, status,
// startDate, endDate, pricingJson, totalAmount, currency, items[].
router.post("/itineraries", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { subBrand, contactId, destination } = req.body || {};
    if (!subBrand || !contactId || !destination) {
      return res.status(400).json({
        error: "subBrand, contactId, destination required",
        code: "MISSING_FIELDS",
      });
    }
    assertValidSubBrand(subBrand);
    const cid = parseInt(contactId, 10);
    if (!Number.isFinite(cid)) {
      return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    // PRD §4.1 diagnostic-first guard. The Itinerary is the customer-facing
    // quote artifact (PDF + share link); the PRD forbids creating one
    // before the contact has completed a diagnostic for this sub-brand.
    // /pricing/quote stays unguarded — it's pure internal pricing math.
    await assertCompletedDiagnostic(prisma, req.travelTenant.id, cid, subBrand);

    const {
      leadId, status, startDate, endDate,
      pricingJson, totalAmount, currency, shareToken, pax,
      items, productTier: bodyProductTier,
      // G047 — Itinerary lineage (PRD FR-3.1.e). Operator clones from an
      // ItineraryTemplate; we persist the parent FK so the editor can
      // render a "Cloned from <template name>" chip in the header. Optional
      // — manually-built itineraries leave it null. Validated below.
      clonedFromTemplateId: bodyClonedFromTemplateId,
    } = req.body;

    // G047 — resolve + validate clonedFromTemplateId. Cross-tenant template
    // refs are rejected so an attacker can't lineage their itinerary to an
    // unrelated tenant's template id. We tolerate "" / 0 / non-numeric →
    // null (lineage is opt-in; bad inputs degrade silently to "no lineage").
    let clonedFromTemplateId = null;
    if (bodyClonedFromTemplateId != null && bodyClonedFromTemplateId !== "") {
      const tid = parseInt(bodyClonedFromTemplateId, 10);
      if (Number.isFinite(tid) && tid > 0) {
        const tpl = await prisma.itineraryTemplate.findFirst({
          where: { id: tid, tenantId: req.travelTenant.id },
          select: { id: true },
        });
        if (!tpl) {
          return res.status(404).json({
            error: "Cloned template not found",
            code: "TEMPLATE_NOT_FOUND",
          });
        }
        clonedFromTemplateId = tid;
      }
    }

    // PRD §6.4 — capture the recommended tier from the contact's latest
    // diagnostic so tier-vs-actual analytics stay stable. Body can override;
    // otherwise default from the diagnostic's recommendedTier (may itself
    // be null if the diagnostic didn't classify, e.g. unanswered Qs).
    let productTier = bodyProductTier || null;
    if (!productTier) {
      const latest = await findLatestDiagnostic(prisma, req.travelTenant.id, cid, subBrand);
      productTier = (latest && latest.recommendedTier) || null;
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // Validate items[] up-front so a bad item type rejects before the
    // create transaction starts.
    const itemRows = [];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || typeof it !== "object") continue;
        if (!it.itemType || !it.description) {
          return res.status(400).json({
            error: `items[${i}]: itemType + description required`,
            code: "ITEM_MISSING_FIELDS",
          });
        }
        assertValidItemType(it.itemType);
        const itQty = it.quantity != null && it.quantity !== "" ? Number(it.quantity) : 1;
        itemRows.push({
          itemType: it.itemType,
          position: typeof it.position === "number" ? it.position : i,
          description: String(it.description),
          detailsJson: it.detailsJson ? String(it.detailsJson) : null,
          supplierId: it.supplierId ? parseInt(it.supplierId, 10) : null,
          unitCost: it.unitCost != null && it.unitCost !== "" ? Number(it.unitCost) : null,
          markup: it.markup != null && it.markup !== "" ? Number(it.markup) : null,
          gstAmount: it.gstAmount != null && it.gstAmount !== "" ? Number(it.gstAmount) : null,
          unit: it.unit ? String(it.unit) : "per_person",
          quantity: Number.isFinite(itQty) && itQty >= 0 ? itQty : 1,
          direction: it.direction ? String(it.direction) : null,
          totalPrice: computeItemLineTotal(it),
        });
      }
    }

    const itinerary = await prisma.itinerary.create({
      data: {
        tenantId: req.travelTenant.id,
        subBrand,
        contactId: cid,
        leadId: leadId ? parseInt(leadId, 10) : null,
        status: status || "draft",
        productTier,
        destination: String(destination),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        pricingJson: pricingJson ? String(pricingJson) : null,
        totalAmount: totalAmount != null ? Number(totalAmount) : null,
        currency: currency || "INR",
        pax: (() => { const p = parseInt(pax, 10); return Number.isFinite(p) && p >= 1 ? p : 1; })(),
        shareToken: shareToken || null,
        // G047 lineage persisted; null when not cloned (manual create).
        clonedFromTemplateId,
        items: itemRows.length > 0 ? { create: itemRows } : undefined,
      },
      include: { items: { orderBy: { position: "asc" } } },
    });

    // G049 — bump template usage metrics on clone-from-template event.
    // Non-fatal: a metric-bump failure must NOT roll back the itinerary
    // create (the operator's primary action wins). The lastUsedAt bump
    // lets the library grid surface "Stale templates" and the usageCount
    // increment was already engine-bumped here historically; the new bit
    // is `lastUsedAt`.
    if (clonedFromTemplateId) {
      try {
        await prisma.itineraryTemplate.update({
          where: { id: clonedFromTemplateId },
          data: {
            usageCount: { increment: 1 },
            lastUsedAt: new Date(),
          },
        });
      } catch (metricErr) {
        console.error(
          "[travel-itin] template metrics bump (clone) failed:",
          metricErr.message,
        );
      }
    }

    // Notify the customer that their advisor prepared a trip. In this portal
    // drafts are customer-visible + decidable, so "creating an itinerary for
    // the user" IS the notify moment — fire for any offer state (draft/sent/
    // revised), not just sent. (The →sent PATCH transition deliberately does
    // NOT re-notify, so a later draft→sent edit can't double-send.)
    if (["draft", "sent", "revised"].includes(itinerary.status)) notifyCustomerTrip(itinerary, "sent");

    res.status(201).json(itinerary);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      return res.status(409).json({ error: "shareToken collision", code: "DUPLICATE_SHARE_TOKEN" });
    }
    console.error("[travel-itin] create error:", e.message);
    res.status(500).json({ error: "Failed to create itinerary" });
  }
});

// ─── Tenant-wide monthly rollup (slice 16) ────────────────────────────

// GET /api/travel/itineraries/by-month — any verified token (tenant + sub-brand scoped).
//
// Slice 16 of #907 (PRD_TRAVEL_ITINERARY_UPGRADES.md §3 — tenant-wide
// itinerary analytics rolled up by calendar month). Mirrors #900 slice
// 16 (/quotes/by-month) + #901 slice 29 (/invoices/by-month) + #908
// slice 21 (/flyer-templates/by-month) — same UTC YYYY-MM bucketing
// template, same defensive math (null/invalid totalAmount → 0 contrib;
// null/invalid createdAt → "unknown" bucket, excluded when ?from/?to is
// set), same orderBy semantics, same half-up 2dp rounding via
// Number.EPSILON. One row per UTC-month present in the scoped itinerary
// set, summarising count + 7-status splits + value sums for that month.
// Read-only; consumed by the operator-facing "itineraries trend" chart
// on the Travel dashboard and the per-month drill-down picker into the
// underlying /itineraries list.
//
// 7-status envelope (PRD §4.7 Phase 2 50%-advance booking):
//   draft / sent / revised / accepted / rejected / advance_paid / fully_paid
// The acceptedValue rollup sums totalAmount across the THREE
// "agreement-secured" statuses {accepted, advance_paid, fully_paid} —
// once the customer accepts the itinerary, the booking is locked in even
// if payment is still pending or only the 50% advance has cleared. This
// matches Phase 2's deposit-mechanics: an itinerary with status=
// accepted-but-zero-paid still represents committed revenue for the
// trend chart's "closed deals" line. totalValue, by contrast, sums
// totalAmount across ALL statuses (the pipeline view).
//
// Why a separate endpoint instead of extending /global-stats:
//   - Different aggregation granularity (per-month time-series, not
//     single-rollup).
//   - Different natural sort (chronological, not single row).
//   - Pre-fills a different UI surface (line/bar chart vs KPI tile).
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// Itinerary.createdAt's UTC year + month. UTC chosen deliberately so
// bucket labels stay stable across operator timezones — finance
// reconciliation works in calendar-month UTC for cross-border volume.
//
// Scope rules:
//   - Tenant-scoped on Itinerary.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access). Itinerary
//     .subBrand is required + non-nullable, so the narrowing uses
//     `{ in: [...allowed] }` (no NULL OR-clause — mirrors the /itineraries
//     list endpoint, NOT the flyer-templates endpoint which allows tenant-wide
//     NULL rows).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status   optional Itinerary.status filter (one of VALID_STATUSES);
//            invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY-MM); rows
//            with month < from are excluded.
//   to       optional inclusive upper bound on bucket (YYYY-MM); rows
//            with month > to are excluded.
//   orderBy  default "month:asc" (chronological); also accepts
//            "month:desc", "count:asc|desc", "acceptedCount:asc|desc",
//            "totalValue:asc|desc". Unknown tokens degrade silently to
//            the default (same posture as slice 16 / slice 29 / slice 21).
//   limit    default 12 (one year of months), max 60 (5 years).
//   offset   default 0
//
// Response shape:
//   {
//     months: [ {
//       month: "2026-05",
//       count, totalValue,
//       draftCount, sentCount, revisedCount, acceptedCount, rejectedCount,
//       advancePaidCount, fullyPaidCount,
//       acceptedValue
//     } ],
//     totalMonths,
//     grandCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-month" as a numeric :id (which would 400 INVALID_ID).
router.get("/itineraries/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // YYYY-MM validation — same regex slice 16 / 29 / 21 use. Bucket
    // labels we emit follow this exact shape so callers passing
    // month-tokens to from/to should already be using it.
    const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }
    if (toRaw !== null && !MONTH_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "month:asc",
      "month:desc",
      "count:asc",
      "count:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
      "totalValue:asc",
      "totalValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /itineraries list handler — empty access set → all-zeros rollup
    // (not 403) so the dashboard tile renders cleanly for
    // not-yet-onboarded operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        months: [],
        totalMonths: 0,
        grandCount: 0,
        grandTotalValue: 0,
        grandAcceptedValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-MM. Input size bound is the same as the list
    // endpoint (low thousands at platinum scale).
    const itineraries = await prisma.itinerary.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Statuses whose totalAmount counts toward acceptedValue — the
    // "agreement-secured" set. Phase 2 50%-advance booking treats
    // advance_paid + fully_paid as continuations of accepted, NOT as
    // separate post-acceptance states (PRD §4.7).
    const ACCEPTED_VALUE_STATUSES = new Set(["accepted", "advance_paid", "fully_paid"]);

    // Aggregate per-UTC-month. Map "YYYY-MM" → { ...row counts/sums }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid totalAmount contributes 0.
    const byMonth = new Map();
    for (const it of itineraries) {
      let monthKey = "unknown";
      if (it.createdAt) {
        const dt = it.createdAt instanceof Date
          ? it.createdAt
          : new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
          monthKey = `${yyyy}-${mm}`;
        }
      }

      let row = byMonth.get(monthKey);
      if (!row) {
        row = {
          month: monthKey,
          count: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          revisedCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          advancePaidCount: 0,
          fullyPaidCount: 0,
          acceptedValue: 0,
        };
        byMonth.set(monthKey, row);
      }

      row.count += 1;
      const amt = Number(it.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (it.status) {
        case "draft": row.draftCount += 1; break;
        case "sent": row.sentCount += 1; break;
        case "revised": row.revisedCount += 1; break;
        case "accepted": row.acceptedCount += 1; break;
        case "rejected": row.rejectedCount += 1; break;
        case "advance_paid": row.advancePaidCount += 1; break;
        case "fully_paid": row.fullyPaidCount += 1; break;
        default: break;
      }
      if (ACCEPTED_VALUE_STATUSES.has(it.status)) {
        row.acceptedValue += safeAmt;
      }
    }

    // Finalise rounding on per-row sums.
    let months = [...byMonth.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable month token); when no
    // bounds are set, "unknown" stays so the count surface remains
    // complete. Mirrors slice 16 / 29 / 21 posture.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM which is also
    // chronological. "unknown" sorts last in asc / first in desc by
    // virtue of being lexicographically > "9999-12" — acceptable for a
    // defensive fallback bucket that should rarely appear.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    months.sort((a, b) => {
      if (field === "month") {
        if (a.month < b.month) return -1 * mult;
        if (a.month > b.month) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalMonths = months.length;
    const grandCount = months.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      months.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      months.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slice 16 / 29 / 21.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// ─── Tenant-wide quarterly rollup (slice 17) ──────────────────────────

// GET /api/travel/itineraries/by-quarter — any verified token (tenant + sub-brand scoped).
//
// Slice 17 of #907 (PRD_TRAVEL_ITINERARY_UPGRADES.md §3 — tenant-wide
// itinerary analytics rolled up by calendar quarter). Mirrors slice 16
// /by-month exactly — same 7-status envelope, same defensive math,
// same orderBy semantics, same half-up 2dp rounding — at quarter
// resolution instead of month. One row per UTC YYYY-Qn present in the
// scoped itinerary set, summarising count + 7-status splits + value
// sums for that quarter.
//
// 7-status envelope (PRD §4.7 Phase 2 50%-advance booking):
//   draft / sent / revised / accepted / rejected / advance_paid / fully_paid
// The acceptedValue rollup sums totalAmount across the THREE
// "agreement-secured" statuses {accepted, advance_paid, fully_paid} —
// mirrors slice 16 by-month exactly.
//
// Why quarter granularity in addition to month: finance review cadence
// (board reporting, supplier reconciliation, RFU Umrah seasonal
// planning) is quarterly. The dashboard's quarterly trend chart needs
// a single endpoint hit instead of summing 3 month rows client-side.
//
// Bucket key shape: "YYYY-Qn" where n ∈ {1,2,3,4}. Calendar quarter via
// `Math.floor(month/3) + 1` where month is the 0-indexed UTC month:
//   Q1: Jan–Mar (months 0..2)
//   Q2: Apr–Jun (months 3..5)
//   Q3: Jul–Sep (months 6..8)
//   Q4: Oct–Dec (months 9..11)
// UTC chosen deliberately so bucket labels stay stable across operator
// timezones (matches slice 16 by-month posture).
//
// Scope rules: identical to slice 16 by-month — tenant-scoped on
// Itinerary.tenantId, sub-brand-restricted via subBrandAccess
// (Itinerary.subBrand is non-nullable → narrowing uses { in: [...] }
// with NO NULL OR-clause), any verified token, no RBAC narrowing.
//
// Query string:
//   status   optional Itinerary.status filter; invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY-Qn); rows
//            with quarter < from are excluded.
//   to       optional inclusive upper bound on bucket (YYYY-Qn); rows
//            with quarter > to are excluded.
//   orderBy  default "quarter:asc" (chronological); also accepts
//            "quarter:desc", "count:asc|desc", "acceptedCount:asc|desc",
//            "totalValue:asc|desc". Unknown tokens degrade silently to
//            the default.
//   limit    default 12 (3 years of quarters), max 40 (10 years).
//   offset   default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       count, totalValue,
//       draftCount, sentCount, revisedCount, acceptedCount, rejectedCount,
//       advancePaidCount, fullyPaidCount,
//       acceptedValue
//     } ],
//     totalQuarters,
//     grandCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-quarter" as a numeric :id (which would 400 INVALID_ID).
router.get("/itineraries/by-quarter", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // YYYY-Qn validation — quarter ∈ {1,2,3,4}, year is 4 digits.
    // Bucket labels we emit follow this exact shape so callers passing
    // quarter-tokens to from/to should already be using it.
    const QUARTER_RE = /^\d{4}-Q[1-4]$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }
    if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "quarter:asc",
      "quarter:desc",
      "count:asc",
      "count:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
      "totalValue:asc",
      "totalValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /itineraries list handler — empty access set → all-zeros rollup
    // (not 403) so the dashboard tile renders cleanly for
    // not-yet-onboarded operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        quarters: [],
        totalQuarters: 0,
        grandCount: 0,
        grandTotalValue: 0,
        grandAcceptedValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-Qn. Input size bound is the same as the list
    // endpoint (low thousands at platinum scale).
    const itineraries = await prisma.itinerary.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Statuses whose totalAmount counts toward acceptedValue — the
    // "agreement-secured" set. Mirrors slice 16 by-month exactly.
    const ACCEPTED_VALUE_STATUSES = new Set(["accepted", "advance_paid", "fully_paid"]);

    // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { ...row counts/sums }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid totalAmount contributes 0.
    const byQuarter = new Map();
    for (const it of itineraries) {
      let quarterKey = "unknown";
      if (it.createdAt) {
        const dt = it.createdAt instanceof Date
          ? it.createdAt
          : new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const q = Math.floor(dt.getUTCMonth() / 3) + 1;
          quarterKey = `${yyyy}-Q${q}`;
        }
      }

      let row = byQuarter.get(quarterKey);
      if (!row) {
        row = {
          quarter: quarterKey,
          count: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          revisedCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          advancePaidCount: 0,
          fullyPaidCount: 0,
          acceptedValue: 0,
        };
        byQuarter.set(quarterKey, row);
      }

      row.count += 1;
      const amt = Number(it.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (it.status) {
        case "draft": row.draftCount += 1; break;
        case "sent": row.sentCount += 1; break;
        case "revised": row.revisedCount += 1; break;
        case "accepted": row.acceptedCount += 1; break;
        case "rejected": row.rejectedCount += 1; break;
        case "advance_paid": row.advancePaidCount += 1; break;
        case "fully_paid": row.fullyPaidCount += 1; break;
        default: break;
      }
      if (ACCEPTED_VALUE_STATUSES.has(it.status)) {
        row.acceptedValue += safeAmt;
      }
    }

    // Finalise rounding on per-row sums.
    let quarters = [...byQuarter.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable quarter token); when
    // no bounds are set, "unknown" stays so the count surface remains
    // complete. Mirrors slice 16 by-month posture.
    if (fromRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
    }
    if (toRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
    // chronological (Q1 < Q2 < Q3 < Q4 in ASCII, years naturally
    // ordered). "unknown" sorts last in asc / first in desc by virtue
    // of being lexicographically > "9999-Q4" — acceptable for a
    // defensive fallback bucket that should rarely appear.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    quarters.sort((a, b) => {
      if (field === "quarter") {
        if (a.quarter < b.quarter) return -1 * mult;
        if (a.quarter > b.quarter) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalQuarters = quarters.length;
    const grandCount = quarters.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slice 16 by-month.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] by-quarter error:", e.message);
    res.status(500).json({ error: "Failed to compute quarterly rollup" });
  }
});

// ─── Tenant-wide annual rollup (slice 18) ─────────────────────────────

// GET /api/travel/itineraries/by-year — any verified token (tenant + sub-brand scoped).
//
// Slice 18 of #907 (PRD_TRAVEL_ITINERARY_UPGRADES.md §3 — tenant-wide
// itinerary analytics rolled up by calendar year). Completes the
// by-month/by-quarter/by-year triplet (slices 16/17/18). Mirrors slice
// 17 by-quarter exactly — same 7-status envelope, same defensive math,
// same orderBy semantics, same half-up 2dp rounding — at year
// resolution instead of quarter. One row per UTC YYYY present in the
// scoped itinerary set, summarising count + 7-status splits + value
// sums for that calendar year.
//
// 7-status envelope (PRD §4.7 Phase 2 50%-advance booking):
//   draft / sent / revised / accepted / rejected / advance_paid / fully_paid
// The acceptedValue rollup sums totalAmount across the THREE
// "agreement-secured" statuses {accepted, advance_paid, fully_paid} —
// mirrors slices 16/17 exactly.
//
// Why year granularity in addition to month + quarter: annual reviews
// (year-end CFO close, year-over-year trend lines, fiscal-year
// reporting, RFU Umrah season-on-season comparisons) need a single
// endpoint hit instead of summing 12 month rows or 4 quarter rows
// client-side. Also feeds multi-year trend charts directly.
//
// Bucket key shape: "YYYY" — 4-digit UTC calendar year via
// `dt.getUTCFullYear()`. UTC chosen deliberately so bucket labels stay
// stable across operator timezones (matches slices 16/17 posture).
//
// Scope rules: identical to slices 16/17 — tenant-scoped on
// Itinerary.tenantId, sub-brand-restricted via subBrandAccess
// (Itinerary.subBrand is non-nullable → narrowing uses { in: [...] }
// with NO NULL OR-clause), any verified token, no RBAC narrowing.
//
// Query string:
//   status   optional Itinerary.status filter; invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY); rows with
//            year < from are excluded. Invalid → 400 INVALID_YEAR_FORMAT.
//   to       optional inclusive upper bound on bucket (YYYY); rows with
//            year > to are excluded. Invalid → 400 INVALID_YEAR_FORMAT.
//   orderBy  default "year:asc" (chronological); also accepts
//            "year:desc", "count:asc|desc", "acceptedCount:asc|desc",
//            "totalValue:asc|desc". Unknown tokens degrade silently to
//            the default.
//   limit    default 10 years, max 30 years.
//   offset   default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       count, totalValue,
//       draftCount, sentCount, revisedCount, acceptedCount, rejectedCount,
//       advancePaidCount, fullyPaidCount,
//       acceptedValue
//     } ],
//     totalYears,
//     grandCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-year" as a numeric :id (which would 400 INVALID_ID).
router.get("/itineraries/by-year", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

    if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // YYYY validation — exactly 4 digits. Bucket labels we emit follow
    // this shape so callers passing year-tokens to from/to should
    // already be using it.
    const YEAR_RE = /^\d{4}$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }
    if (toRaw !== null && !YEAR_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "year:asc",
      "year:desc",
      "count:asc",
      "count:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
      "totalValue:asc",
      "totalValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /itineraries list handler — empty access set → all-zeros rollup
    // (not 403) so the dashboard tile renders cleanly for
    // not-yet-onboarded operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        years: [],
        totalYears: 0,
        grandCount: 0,
        grandTotalValue: 0,
        grandAcceptedValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY. Input size bound is the same as the list
    // endpoint (low thousands at platinum scale).
    const itineraries = await prisma.itinerary.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Statuses whose totalAmount counts toward acceptedValue — the
    // "agreement-secured" set. Mirrors slices 16/17 exactly.
    const ACCEPTED_VALUE_STATUSES = new Set(["accepted", "advance_paid", "fully_paid"]);

    // Aggregate per-UTC-year. Map "YYYY" → { ...row counts/sums }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid totalAmount contributes 0.
    const byYear = new Map();
    for (const it of itineraries) {
      let yearKey = "unknown";
      if (it.createdAt) {
        const dt = it.createdAt instanceof Date
          ? it.createdAt
          : new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }

      let row = byYear.get(yearKey);
      if (!row) {
        row = {
          year: yearKey,
          count: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          revisedCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          advancePaidCount: 0,
          fullyPaidCount: 0,
          acceptedValue: 0,
        };
        byYear.set(yearKey, row);
      }

      row.count += 1;
      const amt = Number(it.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (it.status) {
        case "draft": row.draftCount += 1; break;
        case "sent": row.sentCount += 1; break;
        case "revised": row.revisedCount += 1; break;
        case "accepted": row.acceptedCount += 1; break;
        case "rejected": row.rejectedCount += 1; break;
        case "advance_paid": row.advancePaidCount += 1; break;
        case "fully_paid": row.fullyPaidCount += 1; break;
        default: break;
      }
      if (ACCEPTED_VALUE_STATUSES.has(it.status)) {
        row.acceptedValue += safeAmt;
      }
    }

    // Finalise rounding on per-row sums.
    let years = [...byYear.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable year token); when no
    // bounds are set, "unknown" stays so the count surface remains
    // complete. Mirrors slices 16/17 posture.
    if (fromRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
    }
    if (toRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
    }

    // Sort. "year" sorts lexicographically on YYYY which is also
    // chronological (4-digit zero-padded years naturally ordered).
    // "unknown" sorts last in asc / first in desc by virtue of being
    // lexicographically > "9999" — acceptable for a defensive fallback
    // bucket that should rarely appear.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    years.sort((a, b) => {
      if (field === "year") {
        if (a.year < b.year) return -1 * mult;
        if (a.year > b.year) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalYears = years.length;
    const grandCount = years.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      years.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      years.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slices 16/17.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] by-year error:", e.message);
    res.status(500).json({ error: "Failed to compute annual rollup" });
  }
});

// GET /api/travel/itineraries/stats — tenant-wide aggregate (#907 rollup
// family completion). Mirrors the travel_quotes /stats envelope shape so
// dashboard tiles share a stable contract across the rollup endpoints.
//
// Envelope:
//   {
//     total: <number>,
//     byStatus: { draft|sent|revised|accepted|rejected|advance_paid|fully_paid:
//                 { count, totalValue } },
//     bySubBrand: { tmc|rfu|travelstall|visasure|_tenant: { count } },
//     grandTotalValue: <number>,
//     grandAcceptedValue: <number>,
//     acceptanceRate: <0-1 or null>,
//     lastUpdatedAt: <ISO or null>
//   }
//
// Status enum is the canonical 7-value set from schema.prisma's Itinerary
// model. accepted/advance_paid/fully_paid all roll up into
// grandAcceptedValue (the agreement-secured set — Phase 2 50%-advance
// booking flow treats advance_paid + fully_paid as continuations of
// accepted, NOT separate categories). acceptanceRate uses
// terminal-decision denominator (accepted + advance_paid + fully_paid +
// rejected) — null when denom=0.
//
// Half-up 2dp on all money values. Defensive: null/non-numeric
// totalAmount → 0. bySubBrand coalesces missing subBrand → "_tenant"
// matching the /quotes/stats convention.
//
// Optional query:
//   ?from=ISO — lower bound on createdAt (inclusive)
//   ?to=ISO   — upper bound on createdAt (inclusive)
//
// Route-ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "stats" as a numeric :id (which would 400 INVALID_ID).
router.get("/itineraries/stats", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    // Optional ISO date bounds on createdAt.
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    // Canonical zeroed envelope — returned when the caller has no
    // sub-brand access OR when zero rows match. Single source of truth
    // so the empty-set + empty-result paths can't drift.
    const zeroed = {
      total: 0,
      byStatus: {
        draft: { count: 0, totalValue: 0 },
        sent: { count: 0, totalValue: 0 },
        revised: { count: 0, totalValue: 0 },
        accepted: { count: 0, totalValue: 0 },
        rejected: { count: 0, totalValue: 0 },
        advance_paid: { count: 0, totalValue: 0 },
        fully_paid: { count: 0, totalValue: 0 },
      },
      bySubBrand: {},
      grandTotalValue: 0,
      grandAcceptedValue: 0,
      acceptanceRate: null,
      lastUpdatedAt: null,
    };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403 — so not-yet-onboarded operators render an empty tile
    // cleanly instead of a permission error.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const itineraries = await prisma.itinerary.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        status: true,
        totalAmount: true,
        updatedAt: true,
      },
    });

    if (itineraries.length === 0) {
      return res.json(zeroed);
    }

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const byStatus = {
      draft: { count: 0, totalValue: 0 },
      sent: { count: 0, totalValue: 0 },
      revised: { count: 0, totalValue: 0 },
      accepted: { count: 0, totalValue: 0 },
      rejected: { count: 0, totalValue: 0 },
      advance_paid: { count: 0, totalValue: 0 },
      fully_paid: { count: 0, totalValue: 0 },
    };
    const bySubBrand = {};
    let grandTotalValue = 0;
    let grandAcceptedValue = 0;
    let lastUpdatedAt = null;

    // accepted | advance_paid | fully_paid all count as
    // agreement-secured (see PRD §4.7 Phase 2 50%-advance booking).
    const ACCEPTED_LIKE = new Set(["accepted", "advance_paid", "fully_paid"]);
    // Terminal-decision set for acceptanceRate denominator: every status
    // whose outcome is decided. rejected is the lone "decided no";
    // accepted/advance_paid/fully_paid are the "decided yes" trio.
    const TERMINAL = new Set(["accepted", "advance_paid", "fully_paid", "rejected"]);

    for (const it of itineraries) {
      const amt = Number(it.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      grandTotalValue += safeAmt;

      if (byStatus[it.status]) {
        byStatus[it.status].count += 1;
        byStatus[it.status].totalValue += safeAmt;
      }

      if (ACCEPTED_LIKE.has(it.status)) {
        grandAcceptedValue += safeAmt;
      }

      // bySubBrand: defensively coalesce null → "_tenant" matching
      // /quotes/stats convention.
      const sbKey = it.subBrand ? String(it.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
      bySubBrand[sbKey].count += 1;

      const ts = it.updatedAt instanceof Date ? it.updatedAt : new Date(it.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
    }

    // Round per-status sums.
    for (const s of Object.keys(byStatus)) {
      byStatus[s].totalValue = round2(byStatus[s].totalValue);
    }

    // acceptanceRate: (accepted-like count) / (terminal count); null if
    // denom=0. accepted+advance_paid+fully_paid all count toward the
    // numerator (agreement-secured); rejected counts toward denominator
    // only.
    let acceptedLikeCount = 0;
    let terminalCount = 0;
    for (const it of itineraries) {
      if (ACCEPTED_LIKE.has(it.status)) acceptedLikeCount += 1;
      if (TERMINAL.has(it.status)) terminalCount += 1;
    }
    const acceptanceRate = terminalCount > 0
      ? round2(acceptedLikeCount / terminalCount)
      : null;

    res.json({
      total: itineraries.length,
      byStatus,
      bySubBrand,
      grandTotalValue: round2(grandTotalValue),
      grandAcceptedValue: round2(grandAcceptedValue),
      acceptanceRate,
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] stats error:", e.message);
    res.status(500).json({
      error: "Failed to fetch itinerary stats",
      code: "ITINERARY_STATS_FAILED",
    });
  }
});

// ─── Get + amend ──────────────────────────────────────────────────────

// GET /api/travel/itineraries/:id
router.get("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const itin = await prisma.itinerary.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      include: { items: { orderBy: { position: "asc" } } },
    });
    if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, itin.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(itin);
  } catch (e) {
    console.error("[travel-itin] get error:", e.message);
    res.status(500).json({ error: "Failed to get itinerary" });
  }
});

// PATCH /api/travel/itineraries/:id
// Amend top-level fields only (not items — those have their own endpoints).
router.patch("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.itinerary.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      select: { id: true, subBrand: true, status: true },
    });
    if (!existing) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, existing.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const data = {};
    const {
      status, destination, startDate, endDate,
      pricingJson, totalAmount, currency, pdfUrl, shareToken, pax,
      shareExpiresAt,
    } = req.body || {};

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      data.status = status;
    }
    if (pax !== undefined) {
      const p = parseInt(pax, 10);
      data.pax = Number.isFinite(p) && p >= 1 ? p : 1;
    }
    if (destination !== undefined) data.destination = String(destination);
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (pricingJson !== undefined) data.pricingJson = pricingJson ? String(pricingJson) : null;
    if (totalAmount !== undefined) data.totalAmount = totalAmount != null ? Number(totalAmount) : null;
    if (currency !== undefined) data.currency = currency || "INR";
    if (pdfUrl !== undefined) data.pdfUrl = pdfUrl || null;
    if (shareToken !== undefined) data.shareToken = shareToken || null;
    // PRD §4.7 (gap A3) — advisor-facing shorten/extend control for the
    // share-link expiry. ISO date string (or null/"" to clear → legacy
    // non-expiring link). Garbage is REJECTED (unlike expiryDays at mint
    // time, which clamps): a typo here would silently re-arm/kill a live
    // customer link, so the advisor must see the error.
    if (shareExpiresAt !== undefined) {
      if (shareExpiresAt === null || shareExpiresAt === "") {
        data.shareExpiresAt = null;
      } else {
        const parsed = new Date(shareExpiresAt);
        if (typeof shareExpiresAt !== "string" || Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "shareExpiresAt must be an ISO-8601 date string",
            code: "INVALID_SHARE_EXPIRES_AT",
          });
        }
        data.shareExpiresAt = parsed;
      }
    }

    // Reviving a declined offer: when the advisor edits a REJECTED itinerary
    // without explicitly setting a status, flip it back to "revised" so it
    // reappears as a fresh, decidable offer in the customer's portal (PRD
    // §6.1 — "advisor updated the offer per your feedback"). Clear the old
    // decline reason so the next round starts clean.
    if (existing.status === "rejected" && status === undefined) {
      data.status = "revised";
      data.declineReason = null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    const updated = await prisma.itinerary.update({
      where: { id },
      data,
      include: { items: { orderBy: { position: "asc" } } },
    });

    // Notify the customer on a real status transition: REVISED (re-decidable
    // offer) or an advisor manually recording payment (advance_paid /
    // fully_paid). NOT on →sent: a new trip is already announced on create
    // (drafts are customer-visible here), so a later draft→sent flip mustn't
    // re-notify. Compared against the prior status so an idempotent re-PATCH of
    // the same status doesn't re-notify. (Public payment endpoints emit from
    // their own handlers — no double-send via PATCH.)
    if (data.status && data.status !== existing.status &&
        ["revised", "advance_paid", "fully_paid"].includes(data.status)) {
      notifyCustomerTrip(updated, data.status);
    }

    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      return res.status(409).json({ error: "shareToken collision", code: "DUPLICATE_SHARE_TOKEN" });
    }
    console.error("[travel-itin] patch error:", e.message);
    res.status(500).json({ error: "Failed to update itinerary" });
  }
});

// DELETE /api/travel/itineraries/:id — ADMIN only (full delete cascades items).
router.delete(
  "/itineraries/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("itineraries", "delete"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.itinerary.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
      await prisma.itinerary.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-itin] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete itinerary" });
    }
  },
);

// ─── Item endpoints ───────────────────────────────────────────────────

async function loadItineraryWithGuard(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const itin = await prisma.itinerary.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    select: { id: true, subBrand: true },
  });
  if (!itin) {
    const err = new Error("Itinerary not found");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, itin.subBrand)) {
    const err = new Error("Sub-brand access denied");
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
  return itin;
}

// POST /api/travel/itineraries/:id/items/bulk-reorder
//
// #907 slice 8 — atomic bulk reposition of multiple ItineraryItem rows
// in a single call. Visual editor (PRD §3.3) drags items across days; a
// single drag operation can touch up to N items (renumber positions
// within a day, optionally move across day-offsets). Without this
// primitive, the editor would have to issue N PATCH calls — non-atomic
// (partial-failure leaves items in inconsistent order) and chatty.
//
// Body shape:
//   { updates: [ { itemId, position, dayOffset? }, ... ] }
//
// Semantics:
//   - `position`     required per update (integer ≥ 0). Final position
//                    after the bulk write — collisions are the operator's
//                    responsibility; route does not auto-densify.
//   - `dayOffset`    optional per update (non-negative integer). When
//                    present, merges into the item's detailsJson under
//                    key `dayOffset` (slice-2 convention). All other
//                    detailsJson keys preserved; stale `dayNumber` key
//                    removed to avoid dual-source confusion (mirrors the
//                    clone-day endpoint's normalisation).
//   - Atomic via prisma.$transaction — all updates land together or none
//     do.
//   - Hard cap of 200 updates per call (runaway-payload guard).
//   - All itemIds must belong to the target itinerary; cross-itinerary
//     ids → 400 ITEM_NOT_IN_ITINERARY with the offending id list.
//   - Duplicate itemIds in the updates list → 400 DUPLICATE_ITEM_ID.
//
// Response: { updatedCount, items: [...] } where items reflect post-
// update state sorted by position asc — convenient for the editor to
// re-render without a follow-up GET.
//
// Sub-paths BEFORE /:id per Express ordering convention.
router.post(
  "/itineraries/:id/items/bulk-reorder",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const { updates } = req.body || {};

      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({
          error: "updates must be a non-empty array",
          code: "EMPTY_UPDATES",
        });
      }
      if (updates.length > 200) {
        return res.status(400).json({
          error: "updates capped at 200 per call",
          code: "TOO_MANY_UPDATES",
        });
      }

      // Validate each update + detect dupes.
      const itemIds = [];
      const seenIds = new Set();
      for (const upd of updates) {
        const itemId = parseInt(upd?.itemId, 10);
        if (!Number.isFinite(itemId)) {
          return res.status(400).json({
            error: "each update needs a numeric itemId",
            code: "INVALID_ITEM_ID",
          });
        }
        if (seenIds.has(itemId)) {
          return res.status(400).json({
            error: `itemId ${itemId} appears more than once in updates`,
            code: "DUPLICATE_ITEM_ID",
            itemId,
          });
        }
        seenIds.add(itemId);
        const pos = Number(upd.position);
        if (!Number.isInteger(pos) || pos < 0) {
          return res.status(400).json({
            error: "each update needs an integer position ≥ 0",
            code: "INVALID_POSITION",
            itemId,
          });
        }
        if (upd.dayOffset !== undefined) {
          const d = Number(upd.dayOffset);
          if (!Number.isInteger(d) || d < 0) {
            return res.status(400).json({
              error: "dayOffset must be a non-negative integer when supplied",
              code: "INVALID_DAY_OFFSET",
              itemId,
            });
          }
        }
        itemIds.push(itemId);
      }

      // Fetch current rows; verify all belong to target itinerary.
      const existing = await prisma.itineraryItem.findMany({
        where: { id: { in: itemIds }, itineraryId: itin.id },
        select: { id: true, detailsJson: true },
      });
      if (existing.length !== itemIds.length) {
        const foundIds = new Set(existing.map((r) => r.id));
        const missing = itemIds.filter((id) => !foundIds.has(id));
        return res.status(400).json({
          error: "one or more itemIds do not belong to this itinerary",
          code: "ITEM_NOT_IN_ITINERARY",
          missing,
        });
      }

      // Map current detailsJson by itemId for the dayOffset merge.
      const existingById = new Map(existing.map((r) => [r.id, r]));

      // Build prisma update ops; run as a single transaction.
      const ops = updates.map((upd) => {
        const itemId = parseInt(upd.itemId, 10);
        const data = { position: Number(upd.position) };
        if (upd.dayOffset !== undefined) {
          // Merge into detailsJson; preserve other keys; drop stale dayNumber.
          let details = {};
          try {
            const raw = existingById.get(itemId)?.detailsJson;
            details = raw ? JSON.parse(raw) : {};
          } catch {
            details = {};
          }
          details.dayOffset = Number(upd.dayOffset);
          delete details.dayNumber;
          data.detailsJson = JSON.stringify(details);
        }
        return prisma.itineraryItem.update({ where: { id: itemId }, data });
      });

      await prisma.$transaction(ops);

      // Re-fetch post-update so callers get the canonical row ordering.
      const refreshed = await prisma.itineraryItem.findMany({
        where: { id: { in: itemIds }, itineraryId: itin.id },
        orderBy: { position: "asc" },
      });

      res.json({ updatedCount: refreshed.length, items: refreshed });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] bulk-reorder error:", e.message);
      res.status(500).json({ error: "Failed to bulk-reorder items" });
    }
  },
);

// POST /api/travel/itineraries/:id/items/bulk-delete
//
// #907 slice 11 — atomic bulk delete of multiple ItineraryItem rows in a
// single call. Visual editor (PRD §3.3) operator workflow includes "delete
// all items on day N" (collapse-day) and "remove selected items"
// (multi-select bulk-delete) primitives; without a bulk-delete endpoint
// the editor must issue N DELETE calls — non-atomic (partial failure
// leaves the itinerary in a torn state where the operator can't tell
// which items survived) and chatty.
//
// Body shape:
//   { itemIds: [1, 2, 3, ...] }
//
// Semantics:
//   - itemIds required (non-empty integer array, each ≥ 0).
//   - All itemIds must belong to the target itinerary; cross-itinerary
//     ids → 400 ITEM_NOT_IN_ITINERARY with the offending id list.
//   - Atomic via prisma.itineraryItem.deleteMany — backed by a single
//     SQL DELETE; all rows removed together or none.
//   - Hard cap of 200 ids per call (runaway-payload guard — matches
//     bulk-reorder's cap so the operator's bulk-select UX has a single
//     consistent ceiling).
//   - Duplicate itemIds in the input list → 400 DUPLICATE_ITEM_ID. The
//     operator's editor should de-dupe before submitting; surfacing the
//     dupe explicitly catches client-side bugs early rather than
//     silently accepting a noisy payload.
//
// Response: { deletedCount, deletedIds } — deletedIds reflects the
// canonical id set that was just removed (sorted asc for stable
// caller-side assertions). No `items` echo because the rows no longer
// exist; the caller is expected to refetch the itinerary list if it
// needs the post-delete state.
//
// Sub-paths BEFORE /:id per Express ordering convention.
router.post(
  "/itineraries/:id/items/bulk-delete",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const { itemIds } = req.body || {};

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return res.status(400).json({
          error: "itemIds must be a non-empty array",
          code: "EMPTY_ITEM_IDS",
        });
      }
      if (itemIds.length > 200) {
        return res.status(400).json({
          error: "itemIds capped at 200 per call",
          code: "TOO_MANY_ITEM_IDS",
        });
      }

      // Validate each id is a non-negative integer + detect dupes.
      const parsedIds = [];
      const seenIds = new Set();
      for (const raw of itemIds) {
        const itemId = parseInt(raw, 10);
        if (!Number.isInteger(itemId) || itemId < 0) {
          return res.status(400).json({
            error: "each itemId must be a non-negative integer",
            code: "INVALID_ITEM_ID",
          });
        }
        if (seenIds.has(itemId)) {
          return res.status(400).json({
            error: `itemId ${itemId} appears more than once in itemIds`,
            code: "DUPLICATE_ITEM_ID",
            itemId,
          });
        }
        seenIds.add(itemId);
        parsedIds.push(itemId);
      }

      // Verify every id belongs to the target itinerary BEFORE deleting.
      // A blind deleteMany scoped on itineraryId would silently swallow
      // unknown / cross-itinerary ids (returns count 0 for missing rows),
      // hiding caller-side bugs. Explicit pre-flight makes the contract
      // strict: partial set → 400, all-present → atomic delete.
      const existing = await prisma.itineraryItem.findMany({
        where: { id: { in: parsedIds }, itineraryId: itin.id },
        select: { id: true },
      });
      if (existing.length !== parsedIds.length) {
        const foundIds = new Set(existing.map((r) => r.id));
        const missing = parsedIds.filter((id) => !foundIds.has(id));
        return res.status(400).json({
          error: "one or more itemIds do not belong to this itinerary",
          code: "ITEM_NOT_IN_ITINERARY",
          missing,
        });
      }

      const result = await prisma.itineraryItem.deleteMany({
        where: { id: { in: parsedIds }, itineraryId: itin.id },
      });

      // deletedIds sorted asc for stable caller-side assertion shape.
      const deletedIds = [...parsedIds].sort((a, b) => a - b);
      res.json({ deletedCount: result.count, deletedIds });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] bulk-delete error:", e.message);
      res.status(500).json({ error: "Failed to bulk-delete items" });
    }
  },
);

// ─── Items search / filter (#907 slice 10) ───────────────────────────
//
// GET /api/travel/itineraries/:id/items/search?q=<term>&itemType=<t>&dayOffset=<n>
//
// Operator-facing search across an itinerary's items. RFU 14N Umrah and
// TMC 12N Europe packages routinely carry 50-100 items spread across many
// days; locating a specific note ("vegetarian only", "Madinah 3-min walk")
// by scrolling is painful. This endpoint searches case-insensitively
// across description + notes-friendly keys inside detailsJson (notes,
// specialRequests, dietaryNotes, mobility) and returns matches with a
// short snippet + the matched-field list.
//
// Query params:
//   q          required, ≥2 chars after trim; substring case-insensitive.
//   itemType   optional; must be one of VALID_ITEM_TYPES if provided.
//   dayOffset  optional; non-negative integer; filters via
//              detailsJson.dayOffset (preferred) or (detailsJson.dayNumber - 1)
//              fallback (slice-2 convention).
//
// Response:
//   {
//     itineraryId, query, itemType, dayOffset,  // echoed inputs
//     matchCount,
//     items: [{
//       id, itemType, position, description, dayOffset,
//       matchedFields: ["description"|"notes"|"specialRequests"|"dietaryNotes"|"mobility", ...],
//       snippet,   // first ~80 chars surrounding the first match
//     }, ...]
//   }
//
// Express ordering: this sub-path sits BEFORE the PATCH/DELETE
// /:id/items/:itemId verbs (different methods + the /:itemId param could
// otherwise match "search" — but verb mismatch makes the collision moot).
//
// Tenant + sub-brand guard via loadItineraryWithGuard (mirrors slices
// 2/5/6/7/8/9). Read-only — no audit log, no eventBus emit.
//
// PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 (item search/filter
// candidate).
router.get(
  "/itineraries/:id/items/search",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);

      const qRaw = typeof req.query.q === "string" ? req.query.q : "";
      const q = qRaw.trim();
      if (q.length < 2) {
        return res.status(400).json({
          error: "q is required and must be at least 2 chars after trim",
          code: "INVALID_QUERY",
        });
      }

      let itemTypeFilter = null;
      if (req.query.itemType != null && req.query.itemType !== "") {
        if (!VALID_ITEM_TYPES.includes(req.query.itemType)) {
          return res.status(400).json({
            error: `itemType must be one of: ${VALID_ITEM_TYPES.join(", ")}`,
            code: "INVALID_ITEM_TYPE",
          });
        }
        itemTypeFilter = req.query.itemType;
      }

      let dayOffsetFilter = null;
      if (req.query.dayOffset != null && req.query.dayOffset !== "") {
        const n = parseInt(req.query.dayOffset, 10);
        if (!Number.isFinite(n) || n < 0 || String(n) !== String(req.query.dayOffset)) {
          return res.status(400).json({
            error: "dayOffset must be a non-negative integer",
            code: "INVALID_DAY_OFFSET",
          });
        }
        dayOffsetFilter = n;
      }

      const where = { itineraryId: itin.id };
      if (itemTypeFilter) where.itemType = itemTypeFilter;
      const rows = await prisma.itineraryItem.findMany({
        where,
        orderBy: { position: "asc" },
      });

      const NOTE_KEYS = ["notes", "specialRequests", "dietaryNotes", "mobility"];
      const needle = q.toLowerCase();

      function resolveDayOffset(details) {
        if (!details || typeof details !== "object") return null;
        if (typeof details.dayOffset === "number") return details.dayOffset;
        if (typeof details.dayNumber === "number") return details.dayNumber - 1;
        return null;
      }

      function makeSnippet(text) {
        const lower = String(text).toLowerCase();
        const idx = lower.indexOf(needle);
        if (idx < 0) return String(text).slice(0, 80);
        const start = Math.max(0, idx - 30);
        const end = Math.min(String(text).length, idx + needle.length + 30);
        const prefix = start > 0 ? "…" : "";
        const suffix = end < String(text).length ? "…" : "";
        return prefix + String(text).slice(start, end) + suffix;
      }

      const matches = [];
      for (const row of rows) {
        let details = null;
        if (row.detailsJson) {
          try { details = JSON.parse(row.detailsJson); } catch { details = null; }
        }

        const rowDayOffset = resolveDayOffset(details);
        if (dayOffsetFilter !== null && rowDayOffset !== dayOffsetFilter) continue;

        const matchedFields = [];
        let firstHitText = null;

        if (row.description && row.description.toLowerCase().includes(needle)) {
          matchedFields.push("description");
          firstHitText = row.description;
        }
        if (details && typeof details === "object") {
          for (const key of NOTE_KEYS) {
            const val = details[key];
            if (typeof val === "string" && val.toLowerCase().includes(needle)) {
              matchedFields.push(key);
              if (firstHitText === null) firstHitText = val;
            }
          }
        }

        if (matchedFields.length === 0) continue;

        matches.push({
          id: row.id,
          itemType: row.itemType,
          position: row.position,
          description: row.description,
          dayOffset: rowDayOffset,
          matchedFields,
          snippet: firstHitText !== null ? makeSnippet(firstHitText) : null,
        });
      }

      res.json({
        itineraryId: itin.id,
        query: q,
        itemType: itemTypeFilter,
        dayOffset: dayOffsetFilter,
        matchCount: matches.length,
        items: matches,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] items search error:", e.message);
      res.status(500).json({ error: "Failed to search items" });
    }
  },
);

// POST /api/travel/itineraries/:id/items
// Valid pricing bases for a line item — documents what "rate" means.
const VALID_ITEM_UNITS = ["per_person", "per_night", "per_room_night", "per_day", "per_group"];
const VALID_ITEM_DIRECTIONS = ["one_way", "round_trip"];

// Line total is ALWAYS computed server-side so the math is consistent and
// unambiguous: total = rate × quantity + markup + GST.
function computeItemLineTotal({ unitCost, quantity, markup, gstAmount }) {
  const rate = unitCost != null && unitCost !== "" ? Number(unitCost) : 0;
  let qty = quantity != null && quantity !== "" ? Number(quantity) : 1;
  if (!Number.isFinite(qty) || qty < 0) qty = 1;
  const mk = markup != null && markup !== "" ? Number(markup) : 0;
  const gst = gstAmount != null && gstAmount !== "" ? Number(gstAmount) : 0;
  return Math.round((rate * qty + mk + gst) * 100) / 100;
}

// After any item add/edit/delete: recompute the itinerary total from its line
// items (GROUP total = sum of item line totals; per-person is derived as
// total / pax in the UI), and — if the customer had previously DECLINED —
// revive it to "revised" so the updated plan reappears as a fresh, decidable
// offer in their portal. Returns the new total.
async function syncItineraryAfterItemChange(itineraryId) {
  const items = await prisma.itineraryItem.findMany({
    where: { itineraryId },
    select: { totalPrice: true },
  });
  const total = items.reduce(
    (s, it) => s + (it.totalPrice != null ? Number(it.totalPrice) : 0),
    0,
  );
  const itin = await prisma.itinerary.findUnique({
    where: { id: itineraryId },
    select: { status: true },
  });
  const data = { totalAmount: Math.round(total * 100) / 100 };
  if (itin && itin.status === "rejected") {
    data.status = "revised";
    data.declineReason = null;
  }
  await prisma.itinerary.update({ where: { id: itineraryId }, data });
  return data.totalAmount;
}

router.post("/itineraries/:id/items", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    // S118 — accept latitude + longitude + dayNumber (mirrors PATCH handler at
    // ~line 1985 + bulk-import path at ~line 4575). Pre-S118 the destructure
    // dropped lat/lng silently, so S82's frontend geocode-on-create flow
    // (Nominatim → lat/lng in POST body) was a no-op until a follow-up PATCH.
    // All three are additive nullable columns from S8; "" / null clears them.
    const { itemType, description, position, detailsJson, supplierId, unitCost, markup, gstAmount, unit, quantity, direction, dayNumber, latitude, longitude } = req.body || {};
    if (!itemType || !description) {
      return res.status(400).json({ error: "itemType + description required", code: "ITEM_MISSING_FIELDS" });
    }
    assertValidItemType(itemType);
    if (unit != null && unit !== "" && !VALID_ITEM_UNITS.includes(String(unit))) {
      return res.status(400).json({ error: `unit must be one of: ${VALID_ITEM_UNITS.join(", ")}`, code: "INVALID_UNIT" });
    }
    if (direction != null && direction !== "" && !VALID_ITEM_DIRECTIONS.includes(String(direction))) {
      return res.status(400).json({ error: `direction must be one of: ${VALID_ITEM_DIRECTIONS.join(", ")}`, code: "INVALID_DIRECTION" });
    }

    // S118 — dayNumber / latitude / longitude validation mirrors the PATCH
    // handler exactly. `undefined` / `null` / "" → persist as null.
    let dayNumberValue = null;
    if (dayNumber !== undefined && dayNumber !== null && dayNumber !== "") {
      const dn = parseInt(dayNumber, 10);
      if (!Number.isInteger(dn) || dn < 1 || dn > 365) {
        return res.status(400).json({ error: "dayNumber must be an integer between 1 and 365", code: "INVALID_DAY_NUMBER" });
      }
      dayNumberValue = dn;
    }
    let latitudeValue = null;
    if (latitude !== undefined && latitude !== null && latitude !== "") {
      const lat = Number(latitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: "latitude must be between -90 and 90", code: "INVALID_LATITUDE" });
      }
      latitudeValue = lat;
    }
    let longitudeValue = null;
    if (longitude !== undefined && longitude !== null && longitude !== "") {
      const lng = Number(longitude);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "longitude must be between -180 and 180", code: "INVALID_LONGITUDE" });
      }
      longitudeValue = lng;
    }

    // Auto-position if not provided — append to the end.
    let pos = typeof position === "number" ? position : null;
    if (pos === null) {
      const maxRow = await prisma.itineraryItem.findFirst({
        where: { itineraryId: itin.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      pos = (maxRow?.position ?? -1) + 1;
    }

    const qty = quantity != null && quantity !== "" ? Number(quantity) : 1;
    const created = await prisma.itineraryItem.create({
      data: {
        itineraryId: itin.id,
        itemType,
        position: pos,
        description: String(description),
        detailsJson: detailsJson ? String(detailsJson) : null,
        supplierId: supplierId ? parseInt(supplierId, 10) : null,
        unitCost: unitCost != null && unitCost !== "" ? Number(unitCost) : null,
        markup: markup != null && markup !== "" ? Number(markup) : null,
        gstAmount: gstAmount != null && gstAmount !== "" ? Number(gstAmount) : null,
        unit: unit ? String(unit) : "per_person",
        quantity: Number.isFinite(qty) && qty >= 0 ? qty : 1,
        direction: direction ? String(direction) : null,
        // S118 — persist S8 columns (additive nullable; null preserves legacy
        // POST shape so pre-S118 clients keep working).
        dayNumber: dayNumberValue,
        latitude: latitudeValue,
        longitude: longitudeValue,
        // Total is computed, never trusted from the client.
        totalPrice: computeItemLineTotal({ unitCost, quantity, markup, gstAmount }),
      },
    });
    await syncItineraryAfterItemChange(itin.id);
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item create error:", e.message);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// PATCH /api/travel/itineraries/:id/items/:itemId
router.patch("/itineraries/:id/items/:itemId", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ITEM_ID" });
    }
    const existing = await prisma.itineraryItem.findFirst({
      where: { id: itemId, itineraryId: itin.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });

    const data = {};
    const { itemType, position, description, detailsJson, supplierId, unitCost, markup, gstAmount, unit, quantity, direction, dayNumber, latitude, longitude, totalPrice } = req.body || {};
    if (itemType !== undefined) {
      assertValidItemType(itemType);
      data.itemType = itemType;
    }
    if (position !== undefined) data.position = Number(position);
    if (description !== undefined) data.description = String(description);
    if (detailsJson !== undefined) data.detailsJson = detailsJson ? String(detailsJson) : null;
    if (supplierId !== undefined) data.supplierId = supplierId ? parseInt(supplierId, 10) : null;
    if (unitCost !== undefined) data.unitCost = unitCost != null && unitCost !== "" ? Number(unitCost) : null;
    if (markup !== undefined) data.markup = markup != null && markup !== "" ? Number(markup) : null;
    if (gstAmount !== undefined) data.gstAmount = gstAmount != null && gstAmount !== "" ? Number(gstAmount) : null;
    if (unit !== undefined) {
      if (unit && !VALID_ITEM_UNITS.includes(String(unit))) {
        return res.status(400).json({ error: `unit must be one of: ${VALID_ITEM_UNITS.join(", ")}`, code: "INVALID_UNIT" });
      }
      data.unit = unit ? String(unit) : "per_person";
    }
    if (quantity !== undefined) {
      const q = quantity != null && quantity !== "" ? Number(quantity) : 1;
      data.quantity = Number.isFinite(q) && q >= 0 ? q : 1;
    }
    if (direction !== undefined) {
      if (direction && !VALID_ITEM_DIRECTIONS.includes(String(direction))) {
        return res.status(400).json({ error: `direction must be one of: ${VALID_ITEM_DIRECTIONS.join(", ")}`, code: "INVALID_DIRECTION" });
      }
      data.direction = direction ? String(direction) : null;
    }

    // FR-3.3 day-by-day editor + FR-3.4 map preview
    // (PRD_TRAVEL_ITINERARY_UPGRADES). The visual editor moves items across
    // day cards (dayNumber) and plots them on the map (latitude/longitude).
    // All three are additive nullable columns (S8); "" / null clears them.
    if (dayNumber !== undefined) {
      if (dayNumber === null || dayNumber === "") {
        data.dayNumber = null;
      } else {
        const dn = parseInt(dayNumber, 10);
        if (!Number.isInteger(dn) || dn < 1 || dn > 365) {
          return res.status(400).json({ error: "dayNumber must be an integer between 1 and 365", code: "INVALID_DAY_NUMBER" });
        }
        data.dayNumber = dn;
      }
    }
    if (latitude !== undefined) {
      if (latitude === null || latitude === "") {
        data.latitude = null;
      } else {
        const lat = Number(latitude);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
          return res.status(400).json({ error: "latitude must be between -90 and 90", code: "INVALID_LATITUDE" });
        }
        data.latitude = lat;
      }
    }
    if (longitude !== undefined) {
      if (longitude === null || longitude === "") {
        data.longitude = null;
      } else {
        const lng = Number(longitude);
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
          return res.status(400).json({ error: "longitude must be between -180 and 180", code: "INVALID_LONGITUDE" });
        }
        data.longitude = lng;
      }
    }

    // Recompute the line total whenever a price-affecting field changes,
    // merging the patch with the item's existing values. A client-supplied
    // `totalPrice` is only honoured when NONE of the cost components are
    // being patched — that's the "override the total directly" path (used
    // by ad-hoc line items where unitCost/markup don't apply). If both
    // arrive in the same body, server-recomputed wins.
    const costFieldsPatched = [unitCost, markup, gstAmount, quantity].some((v) => v !== undefined);
    if (costFieldsPatched) {
      data.totalPrice = computeItemLineTotal({
        unitCost: unitCost !== undefined ? unitCost : existing.unitCost,
        quantity: quantity !== undefined ? quantity : existing.quantity,
        markup: markup !== undefined ? markup : existing.markup,
        gstAmount: gstAmount !== undefined ? gstAmount : existing.gstAmount,
      });
    } else if (totalPrice !== undefined) {
      data.totalPrice = totalPrice != null && totalPrice !== "" ? Number(totalPrice) : 0;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    const updated = await prisma.itineraryItem.update({ where: { id: itemId }, data });
    await syncItineraryAfterItemChange(itin.id);
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item patch error:", e.message);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// DELETE /api/travel/itineraries/:id/items/:itemId
router.delete("/itineraries/:id/items/:itemId", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ITEM_ID" });
    }
    const existing = await prisma.itineraryItem.findFirst({
      where: { id: itemId, itineraryId: itin.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });
    await prisma.itineraryItem.delete({ where: { id: itemId } });
    await syncItineraryAfterItemChange(itin.id);
    res.json({ deleted: true, id: itemId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item delete error:", e.message);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// POST /api/travel/itineraries/:id/items/:itemId/duplicate
//
// #907 slice 12 — per-item clone-in-place. The closest existing surface,
// /clone-day (slice 6), bulk-clones every item on a given day; the
// SAME_DAY_CLONE branch at line 1761 explicitly directs the operator to
// "POST /items to duplicate" a single line. That suggested DIY pattern
// asks operators to re-supply every field from the source row — at best
// awkward, at worst lossy (forgets supplierId / detailsJson / GST). This
// endpoint closes that gap with a one-call dup.
//
// Semantics:
//   - Source resolved via (:id, :itemId) — tenant + sub-brand scoping
//     inherited from loadItineraryWithGuard on the parent.
//   - Cloned row is appended to the SAME itinerary (no cross-itinerary
//     dup — that's clone-day's job for whole-day moves, or future
//     copy-itinerary for the full duplicate).
//   - Position: appended at max(position)+1 of the same itinerary
//     (mirrors POST /items + clone-day pattern).
//   - All copyable fields preserved verbatim: itemType, description,
//     detailsJson (raw passthrough — already-stringified JSON), supplierId,
//     unitCost, markup, gstAmount, totalPrice. id / createdAt /
//     updatedAt are NOT preserved (Prisma auto-fills).
//   - Body { description?: string } optional override — operator can
//     rename the clone in one call ("Hotel Day 5 — backup option").
//     Empty / whitespace-only override falls back to source description
//     (defensive: operator hitting Submit on a blank form shouldn't blow
//     away the description).
//
// Response: 201 + the freshly created row (matches POST /items shape).
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 (FR-3.6 operator UX
// — "Cloning a template is one click + an optional rename"; same shape
// applies at the item level).
router.post(
  "/itineraries/:id/items/:itemId/duplicate",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const itemId = parseInt(req.params.itemId, 10);
      if (!Number.isFinite(itemId)) {
        return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ITEM_ID" });
      }
      const source = await prisma.itineraryItem.findFirst({
        where: { id: itemId, itineraryId: itin.id },
      });
      if (!source) {
        return res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });
      }

      // Optional rename — fall back to the source description when the
      // override is missing / empty / whitespace-only.
      let description = source.description;
      if (req.body && typeof req.body.description === "string") {
        const trimmed = req.body.description.trim();
        if (trimmed.length > 0) description = trimmed;
      }

      // Append after the current max position of THIS itinerary.
      const maxRow = await prisma.itineraryItem.findFirst({
        where: { itineraryId: itin.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const nextPos = (maxRow?.position ?? -1) + 1;

      const created = await prisma.itineraryItem.create({
        data: {
          itineraryId: itin.id,
          itemType: source.itemType,
          position: nextPos,
          description,
          detailsJson: source.detailsJson, // raw passthrough — already JSON-stringified
          supplierId: source.supplierId,
          unitCost: source.unitCost != null ? Number(source.unitCost) : null,
          markup: source.markup != null ? Number(source.markup) : null,
          gstAmount: source.gstAmount != null ? Number(source.gstAmount) : null,
          totalPrice: source.totalPrice != null ? Number(source.totalPrice) : null,
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] item duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate item" });
    }
  },
);

// POST /api/travel/itineraries/:id/duplicate
//
// #907 slice 15 — full-itinerary clone. The slice-12 handler above dups a
// single ItineraryItem in place; this dups the parent Itinerary row plus
// every child ItineraryItem in one atomic call. Mirrors the #900 slice 1
// /quotes/:id/duplicate parent-level pattern (clone parent + clone all
// line items in a single tenant-scoped transaction).
//
// Schema reality (Itinerary model — see prisma/schema.prisma:4348-4400):
// the model has NO customerName/customerEmail/acceptedAt/rejectedAt/
// advance_paid_at/fully_paid_at fields (the dispatch spec's field-name
// list pre-dated the latest schema sweep and was generic). The actual
// copyable fields are: subBrand, contactId, leadId, destination,
// startDate, endDate, pricingJson, totalAmount, currency, productTier,
// draftSummary. The defensive-rename body override targets `destination`
// (slice 12's `description` analog at the parent level — semantically
// "rename the clone"). pdfUrl is NOT copied (the clone has no PDF yet),
// shareToken is reset to null (a clone shouldn't accidentally inherit
// the source's public-share URL), advancePaidAmount/advancePaidAt/
// paymentReference are nulled (the clone is a fresh draft, no money
// recorded yet), parentItineraryId is NOT set (the dup is a separate
// document, not a version revision — version-chain is the PUT /:id
// path's job per the §4.3 + §6.1 comment block below).
//
// Status always resets to 'draft' so the clone enters the operator
// queue cleanly (same convention as #900 slice 1 quotes/duplicate).
//
// Atomicity: parent create + items createMany are wrapped in
// prisma.$transaction so a partial failure (e.g. the children
// createMany throwing) doesn't leave an orphan parent row. Empty-items
// source clones cleanly (no createMany call when there are zero items
// — avoids the empty-array no-op).
//
// Response: 201 + the freshly-created itinerary row WITH its items
// included (mirrors POST /itineraries response shape).
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 (FR-3.6 operator UX
// — "clone a template in one click + optional rename"). The slice-12
// JSDoc at line 919 anticipated this endpoint as "future copy-itinerary
// for the full duplicate"; this closes that forward reference.
router.post(
  "/itineraries/:id/duplicate",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.itinerary.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Itinerary not found",
          code: "ITINERARY_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, source.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Optional rename of `destination` — slice 12's `description`
      // analog at the parent level. Empty/whitespace falls back to the
      // source value (defensive: operator hitting Submit on a blank form
      // shouldn't blow away the destination string).
      let destination = source.destination;
      if (req.body && typeof req.body.destination === "string") {
        const trimmed = req.body.destination.trim();
        if (trimmed.length > 0) destination = trimmed;
      }

      const sourceItems = await prisma.itineraryItem.findMany({
        where: { itineraryId: source.id },
        orderBy: { position: "asc" },
      });

      // Atomic: parent create + (optional) items createMany in one tx so
      // a partial failure rolls back the parent. Empty-items source =>
      // skip createMany entirely (no-op + no payload-shape ambiguity).
      const created = await prisma.$transaction(async (tx) => {
        const newItin = await tx.itinerary.create({
          data: {
            tenantId: req.travelTenant.id,
            subBrand: source.subBrand,
            contactId: source.contactId,
            leadId: source.leadId,
            status: "draft",
            productTier: source.productTier,
            destination,
            startDate: source.startDate,
            endDate: source.endDate,
            pricingJson: source.pricingJson,
            totalAmount: source.totalAmount,
            currency: source.currency,
            draftSummary: source.draftSummary,
            // Reset clone-only fields — see header comment above.
            shareToken: null,
            pdfUrl: null,
            advancePaidAmount: null,
            advancePaidAt: null,
            paymentReference: null,
          },
        });
        if (sourceItems.length > 0) {
          await tx.itineraryItem.createMany({
            data: sourceItems.map((it) => ({
              itineraryId: newItin.id,
              itemType: it.itemType,
              position: it.position,
              description: it.description,
              detailsJson: it.detailsJson, // raw passthrough — already JSON-stringified
              supplierId: it.supplierId,
              unitCost: it.unitCost,
              markup: it.markup,
              gstAmount: it.gstAmount,
              totalPrice: it.totalPrice,
            })),
          });
        }
        return newItin;
      });

      // Re-fetch with items included so the 201 envelope matches the
      // POST /itineraries shape (createMany doesn't return rows).
      const withItems = await prisma.itinerary.findUnique({
        where: { id: created.id },
        include: { items: { orderBy: { position: "asc" } } },
      });
      res.status(201).json(withItems);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] itinerary duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate itinerary" });
    }
  },
);

// ─── Status transitions + version chain (PRD §4.3 / §6.1) ───────────
//
// `status` flows: draft → sent → revised → accepted | rejected. The
// accept/reject endpoints are explicit terminal transitions; PUT (full
// replacement with version bump) is the canonical "revised" path —
// creates a NEW Itinerary row chained to the original via
// parentItineraryId so the full revision history is queryable.
//
// Customer-facing share creates a shareToken (random URL slug) the
// itinerary's PDF link uses. The actual PDF rendering hooks into the
// existing pdfRenderer pattern in a follow-up — for now the endpoint
// returns the share URL + token (back-compat with frontend's existing
// /api/travel/itineraries/:id/share contract from PRD §6.1).

// PRD §4.6 — auto-create WebCheckin rows for every flight item on an
// accepted itinerary. Best-effort: failures log + don't block the
// accept (the operator's primary action — confirming the booking —
// must always succeed). Cron sweeps the created rows at T-window
// per airline.
//
// detailsJson on a flight item needs { pnr, flightNumber, departureAt };
// items missing those fields skip silently. The operator can still
// manually POST /api/travel/webcheckins to fill the gap.
//
// Exported for unit-test reach; not used by anything outside this file
// in production.
async function autoCreateWebCheckinsForItinerary(itineraryId, tenantId) {
  const flightItems = await prisma.itineraryItem.findMany({
    where: { itineraryId, itemType: "flight" },
  });
  if (flightItems.length === 0) return { created: 0, skipped: 0 };

  const itinFull = await prisma.itinerary.findUnique({
    where: { id: itineraryId },
    select: { contactId: true, tenantId: true },
  });
  if (!itinFull || itinFull.tenantId !== tenantId) {
    // Defensive — should never trip since the caller already guarded.
    return { created: 0, skipped: flightItems.length };
  }
  // Itinerary has contactId (Int FK) but no `contact` relation pointing
  // back to Contact, so we resolve the passenger-name fallback via a
  // second findUnique on Contact. The first commit (9898e87) tried to
  // join via `select: { contact: { … } }` which Prisma rejected with
  // "Unknown field `contact`" — fix in 01bb911's follow-up.
  const fallbackContact = await prisma.contact.findUnique({
    where: { id: itinFull.contactId },
    select: { name: true },
  });

  let created = 0;
  let skipped = 0;
  for (const item of flightItems) {
    let details = {};
    try { details = JSON.parse(item.detailsJson || "{}"); } catch { /* malformed → skip */ }
    if (!details.pnr || !details.flightNumber || !details.departureAt) {
      skipped++;
      continue;
    }
    const airlineCode = String(
      details.airlineCode
      || (typeof details.flightNumber === "string"
        && details.flightNumber.match(/^[A-Z0-9]{2}/)?.[0])
      || "",
    ).toUpperCase();
    const dep = new Date(details.departureAt);
    if (!Number.isFinite(dep.getTime())) {
      skipped++;
      continue;
    }
    const windowOpenAt = computeWindowOpenAt(dep, airlineCode);
    try {
      await prisma.webCheckin.create({
        data: {
          tenantId: itinFull.tenantId,
          contactId: itinFull.contactId,
          itineraryId,
          pnr: String(details.pnr),
          airlineCode,
          flightNumber: String(details.flightNumber),
          departureAt: dep,
          windowOpenAt: windowOpenAt || dep,
          passengerName: details.passengerName || fallbackContact?.name || "Passenger",
          seatPref: details.seatPref || null,
          mealPref: details.mealPref || null,
          status: "pending",
        },
      });
      created++;
    } catch (e) {
      console.error(
        `[travel-itin] webcheckin auto-create for itinerary ${itineraryId} ` +
        `(PNR ${details.pnr}) failed (non-fatal):`,
        e.message,
      );
      skipped++;
    }
  }
  return { created, skipped };
}

// POST /api/travel/itineraries/:id/accept
//
// Marks the itinerary as customer-accepted (terminal status). Refuses
// if already accepted or rejected — explicit re-statuses require a new
// version via PUT.
//
// Side-effect: fans out one WebCheckin row per flight ItineraryItem
// (PRD §4.6). Fan-out runs AFTER the response is sent so the
// operator's HTTP turnaround stays fast and any auto-create failure
// can't block the primary accept action. Errors log only.
router.post("/itineraries/:id/accept", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      // G049 — pull clonedFromTemplateId + totalAmount so we can bump the
      // template's acceptedCount + recompute avgFinalPrice after the accept
      // lands. The legacy select kept only id+status; the two extra columns
      // are cheap to pull and avoid a second findFirst on the metrics path.
      select: { id: true, status: true, clonedFromTemplateId: true, totalAmount: true },
    });
    if (full.status === "accepted") {
      return res.status(409).json({ error: "Itinerary already accepted", code: "ALREADY_ACCEPTED" });
    }
    if (full.status === "rejected") {
      return res.status(409).json({
        error: "Itinerary was rejected — create a new version via PUT to accept",
        code: "ALREADY_REJECTED",
      });
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "accepted" },
    });

    // G049 — bump template acceptedCount + recompute avgFinalPrice on the
    // accept hook (PRD FR-3.1.h). Rolling average formula:
    //   newAvg = ((oldAvg * (oldCount - 1)) + newPrice) / oldCount    [oldCount > 0]
    //   newAvg = newPrice                                              [oldCount == 0]
    // We read the template's current acceptedCount + avgFinalPrice in one
    // findUnique, increment acceptedCount, then write the recomputed
    // avgFinalPrice. Race-safe at low contention (single-operator-per-
    // template steady state); the +/- 1 jitter at high contention is
    // acceptable for a library-grid display metric. A SQL-side
    // recompute would need a one-step UPDATE that re-reads the previous
    // value, which Prisma's update API can't express atomically.
    //
    // Non-fatal: the accept-fan-out (web-check-in + webhook) MUST still fire
    // even if this metric write fails; we log + move on.
    if (full.clonedFromTemplateId && full.totalAmount != null) {
      try {
        const tpl = await prisma.itineraryTemplate.findUnique({
          where: { id: full.clonedFromTemplateId },
          select: { acceptedCount: true, avgFinalPrice: true },
        });
        if (tpl) {
          const oldCount = Number(tpl.acceptedCount || 0);
          const newCount = oldCount + 1;
          const newPrice = Number(full.totalAmount);
          let newAvg;
          if (oldCount === 0 || tpl.avgFinalPrice == null) {
            newAvg = newPrice;
          } else {
            const oldAvg = Number(tpl.avgFinalPrice);
            newAvg = ((oldAvg * oldCount) + newPrice) / newCount;
          }
          // Round to 2dp to match Decimal(15,2). Number.EPSILON guard
          // dodges (0.1+0.2)-style binary-floating drift on the last cent.
          const rounded = Math.round((newAvg + Number.EPSILON) * 100) / 100;
          await prisma.itineraryTemplate.update({
            where: { id: full.clonedFromTemplateId },
            data: {
              acceptedCount: { increment: 1 },
              avgFinalPrice: rounded,
            },
          });
        }
      } catch (metricErr) {
        console.error(
          "[travel-itin] template metrics bump (accept) failed:",
          metricErr.message,
        );
      }
    }

    // PRD §4.6 WebCheckin fan-out. Originally fire-and-forget (commit
    // 9898e87) — switched to AWAIT after the deploy gate caught a CI race:
    // shared-infra latency stretched the post-response create past the
    // spec's 5s polling window, making the contract impossible to pin.
    // Awaiting adds ~50-100ms to the operator's /accept turnaround (one
    // findMany + 1-N create calls scoped to flight items only) — a
    // worthwhile trade for the deterministic post-accept invariant
    // "all flight items have a corresponding WebCheckin row".
    //
    // Wrapping in a separate try/catch so a fan-out failure DOES NOT
    // roll back the accept itself (operator's primary action wins).
    // We log the failure + return the accepted itinerary; the cron can
    // sweep + the operator can manually create the missing row later.
    try {
      await autoCreateWebCheckinsForItinerary(itin.id, req.travelTenant.id);
    } catch (e) {
      console.error("[travel-itin] webcheckin auto-create error (non-fatal):", e.message);
    }

    // #929 Part B — fire-and-forget webhook emission on customer accept.
    // Subscribers (Callified.ai, partner SaaSes) can trigger downstream
    // booking workflows (supplier PO creation, payment-request issuance,
    // arrival pre-checks) without polling. Uses shared safeEmitEvent
    // helper (extracted to lib/eventBus.js tick #47).
    const { safeEmitEvent } = require("../lib/eventBus");
    safeEmitEvent(
      "itinerary.accepted",
      {
        id: updated.id,
        contactId: updated.contactId || null,
        tripId: updated.tripId || null,
        subBrand: updated.subBrand || null,
        totalAmount: updated.totalAmount || null,
        currency: updated.currency || null,
        tenantId: req.travelTenant.id,
        acceptedAt: new Date().toISOString(),
      },
      req.travelTenant.id,
      "travel-itin/accept",
    );

    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] accept error:", e.message);
    res.status(500).json({ error: "Failed to accept itinerary" });
  }
});

// Per-PERSON INR cost averages by budget tier. These are EDITABLE placeholder
// estimates so the operator gets a priced draft they can adjust per item
// before sending to the client — NOT authoritative rates. Tune freely.
const SUGGEST_TIER_COSTS = {
  economy: { hotel: 2500, transfer: 400, sightseeing: 600, activity: 800, meals: 500 },
  mid: { hotel: 5000, transfer: 800, sightseeing: 1200, activity: 1500, meals: 1000 },
  luxury: { hotel: 12000, transfer: 2000, sightseeing: 3000, activity: 4000, meals: 2500 },
};
function tierCost(kind, budgetTier) {
  const t = SUGGEST_TIER_COSTS[budgetTier];
  return t && t[kind] != null ? t[kind] : null;
}

// Parse + normalise the structured JSON the LLM returns for itinerary-suggest
// (real mode). Gemini is prompted to emit { summary, days:[{ dayNumber,
// items:[{ itemType, description, estimatedCost }] }] } with realistic
// per-person INR costs. We defensively strip markdown fences / stray prose,
// validate the shape, clamp itemType to VALID_ITEM_TYPES, and coerce costs.
// Returns a clean suggestion or null so the caller can fall back to the
// deterministic skeleton (stub mode / transient failure / unparseable output).
function parseLlmSuggestion(rawText, { destination }) {
  if (typeof rawText !== "string" || rawText.trim() === "") return null;
  let text = rawText.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (text[0] !== "{") {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    text = text.slice(first, last + 1);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const srcDays = Array.isArray(parsed.days) ? parsed.days : null;
  if (!srcDays || srcDays.length === 0) return null;

  const cleanDays = [];
  for (let i = 0; i < srcDays.length; i += 1) {
    const day = srcDays[i];
    if (!day || typeof day !== "object") continue;
    const dayNumber = Number.isInteger(day.dayNumber) && day.dayNumber > 0
      ? day.dayNumber
      : cleanDays.length + 1;
    const srcItems = Array.isArray(day.items) ? day.items : [];
    const items = [];
    for (const it of srcItems) {
      if (!it || typeof it !== "object") continue;
      const desc = typeof it.description === "string" && it.description.trim() !== ""
        ? it.description.trim().slice(0, 500)
        : (typeof it.name === "string" ? it.name.trim().slice(0, 500) : "");
      if (!desc) continue;
      let itemType = typeof it.itemType === "string" ? it.itemType.trim().toLowerCase() : "activity";
      if (!VALID_ITEM_TYPES.includes(itemType)) itemType = "activity";
      let estimatedCost = null;
      const c = Number(it.estimatedCost != null ? it.estimatedCost : it.unitCost);
      if (Number.isFinite(c) && c >= 0) estimatedCost = Math.round(c * 100) / 100;
      items.push({
        itemType,
        description: desc,
        suggestedSupplierName: null,
        estimatedCost,
        latitude: null,
        longitude: null,
      });
    }
    if (items.length === 0) continue;
    cleanDays.push({ dayNumber, items });
  }
  if (cleanDays.length === 0) return null;

  const summary = typeof parsed.summary === "string" && parsed.summary.trim() !== ""
    ? parsed.summary.trim()
    : `Suggested ${cleanDays.length}-day outline for ${destination}.`;
  return { summary, days: cleanDays };
}

// FR-3.4(d) response shape: { summary, days: [{ dayNumber, items: [...] }] }.
// Deterministic (no Date.now / Math.random) so the stub is test-pinnable
// and demo screenshots stay stable. Each item uses a valid ItineraryItem
// itemType (flight|transfer|hotel|sightseeing|activity|meals) so the operator
// can materialise an accepted day straight through /from-suggestion unchanged.
//
// Costs: when an explicit numeric `budgetPerPax` is supplied the per-night
// hotel cost is derived from it (budgetPerPax / days), preserving the FR-3.4
// budget-split contract pinned by the spec. Otherwise the per-item estimate
// comes from the budget-tier table above (null when no tier is supplied).
function buildSuggestionSkeleton({ destination, days, budgetPerPax, budgetTier, summary }) {
  const perNightHotel =
    budgetPerPax != null && days > 0
      ? Math.round((budgetPerPax / days) * 100) / 100
      : tierCost("hotel", budgetTier);
  const transferCost = tierCost("transfer", budgetTier);
  const sightseeingCost = tierCost("sightseeing", budgetTier);
  const activityCost = tierCost("activity", budgetTier);
  const mealsCost = tierCost("meals", budgetTier);

  const dayList = [];
  for (let d = 1; d <= days; d++) {
    const items = [];
    if (d === 1) {
      items.push({ itemType: "flight", description: `Arrival in ${destination}`, suggestedSupplierName: null, estimatedCost: null, latitude: null, longitude: null });
      items.push({ itemType: "transfer", description: `Airport transfer to hotel in ${destination}`, suggestedSupplierName: null, estimatedCost: transferCost, latitude: null, longitude: null });
    }
    items.push({ itemType: "hotel", description: `Night ${d} — stay in ${destination}`, suggestedSupplierName: null, estimatedCost: perNightHotel, latitude: null, longitude: null });
    items.push({ itemType: "sightseeing", description: `Day ${d} — morning sightseeing in ${destination}`, suggestedSupplierName: null, estimatedCost: sightseeingCost, latitude: null, longitude: null });
    items.push({ itemType: "activity", description: `Day ${d} — afternoon activity in ${destination}`, suggestedSupplierName: null, estimatedCost: activityCost, latitude: null, longitude: null });
    items.push({ itemType: "meals", description: `Day ${d} — dinner in ${destination}`, suggestedSupplierName: null, estimatedCost: mealsCost, latitude: null, longitude: null });
    if (d === days) {
      items.push({ itemType: "flight", description: `Departure from ${destination}`, suggestedSupplierName: null, estimatedCost: null, latitude: null, longitude: null });
    }
    dayList.push({ dayNumber: d, items });
  }
  return { summary, days: dayList };
}

// FR-3.6: the "Suggest itinerary" modal collects interests + pace as plain
// text so operators never hand-author JSON. We assemble the structured theme
// object here. `interests` accepts an array OR a comma/newline-separated
// string; `pace` is a short label/free-text. Returns { interests?, pace? }
// or null when nothing usable was supplied.
function buildThemeFromInputs(rawInterests, rawPace) {
  const theme = {};
  let list = [];
  if (Array.isArray(rawInterests)) list = rawInterests;
  else if (typeof rawInterests === "string") list = rawInterests.split(/[,\n]/);

  const seen = new Set();
  const interests = [];
  for (const entry of list) {
    const s = typeof entry === "string" ? entry.trim().slice(0, 60) : "";
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    interests.push(s);
    if (interests.length >= 20) break;
  }
  if (interests.length > 0) theme.interests = interests;
  if (typeof rawPace === "string" && rawPace.trim() !== "") {
    theme.pace = rawPace.trim().slice(0, 40);
  }
  return Object.keys(theme).length > 0 ? theme : null;
}

// Fold the structured theme + any explicit free-text profile into one
// human-readable traveller-profile string for the LLM prompt / stub. Keeps
// the existing `travellerProfile` payload contract intact while letting the
// new interests/pace inputs steer the suggestion.
function composeTravellerProfile(explicitProfile, theme) {
  const parts = [];
  if (typeof explicitProfile === "string" && explicitProfile.trim() !== "") {
    parts.push(explicitProfile.trim());
  }
  if (theme) {
    if (Array.isArray(theme.interests) && theme.interests.length > 0) {
      parts.push(`Interests: ${theme.interests.join(", ")}.`);
    }
    if (theme.pace) parts.push(`Pace: ${theme.pace}.`);
  }
  const text = parts.join(" ").trim();
  return text ? text.slice(0, 2000) : null;
}

// POST /api/travel/itineraries/suggest
//
// PRD_TRAVEL_ITINERARY_UPGRADES FR-3.4 — LLM "Suggest itinerary".
// Operator supplies destination + days + (optional) budget-per-pax +
// traveller profile + sub-brand; returns a STRUCTURED day-by-day draft
// for review. Per FR-3.4(e) this is SUGGESTED only — NOTHING is written
// to the DB. The operator materialises accepted days via the existing
// POST /itineraries + /:id/items endpoints.
//
// itinerary-suggest task class → gemini-flash provider slot (PRD §9.1;
// PRD names gemini-2.5-flash). Until Q11 keys land, llmRouter returns a
// [STUB-ITINERARY-SUGGEST] summary and we assemble a deterministic
// day-by-day skeleton here (FR-3.4(g) — mirrors /draft/regen's stub).
//
// No diagnostic-first guard: this is an internal operator drafting tool,
// not a customer-facing quote artifact (that guard lives on itinerary
// CREATE). Sub-brand, when supplied, is validated + access-checked.
// Travel-tenant only (requireTravelTenant → 403 WRONG_VERTICAL for
// generic/wellness).
router.post(
  "/itineraries/suggest",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const { destination, days, budgetPerPax, travellerProfile, subBrand, interests, pace, budgetTier } = req.body || {};
      // Budget tier drives per-item cost estimates in the skeleton; ignore
      // unknown values (an explicit numeric budgetPerPax still wins for hotel).
      const tier = typeof budgetTier === "string" && SUGGEST_TIER_COSTS[budgetTier] ? budgetTier : null;

      const dest = typeof destination === "string" ? destination.trim() : "";
      if (!dest) {
        return res.status(400).json({ error: "destination is required", code: "MISSING_DESTINATION" });
      }
      const numDays = parseInt(days, 10);
      if (!Number.isInteger(numDays) || numDays < 1 || numDays > 30) {
        return res.status(400).json({ error: "days must be an integer between 1 and 30", code: "INVALID_DAYS" });
      }

      let resolvedSubBrand = null;
      if (subBrand != null && String(subBrand).trim() !== "") {
        assertValidSubBrand(String(subBrand).trim()); // throws 400 INVALID_SUB_BRAND (caught below)
        resolvedSubBrand = String(subBrand).trim();
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, resolvedSubBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
      }

      let budgetNum = null;
      if (budgetPerPax != null && budgetPerPax !== "") {
        budgetNum = Number(budgetPerPax);
        if (!Number.isFinite(budgetNum) || budgetNum < 0) {
          return res.status(400).json({ error: "budgetPerPax must be a non-negative number", code: "INVALID_BUDGET" });
        }
      }
      // FR-3.6: assemble the theme JSON server-side from the operator's
      // plain-text interests + pace (the client no longer hand-authors JSON),
      // then fold it into the traveller-profile text the LLM / stub consumes.
      const theme = buildThemeFromInputs(interests, pace);
      const profile = composeTravellerProfile(travellerProfile, theme);

      let result;
      try {
        result = await llmRouter.routeRequest({
          task: "itinerary-suggest",
          payload: {
            destination: dest,
            days: numDays,
            budgetPerPax: budgetNum,
            budgetTier: tier,
            travellerProfile: profile,
            theme,
            subBrand: resolvedSubBrand,
            __userId: req.user.userId,
            __surface: "itinerary-suggest",
          },
          tenantId: req.travelTenant.id,
        });
      } catch (e) {
        if (e.code === "LLM_BUDGET_EXCEEDED") {
          return res.status(429).json({
            error: "Monthly AI budget reached for this tenant.",
            code: "LLM_BUDGET_EXCEEDED",
            spentCents: e.spentCents,
            capCents: e.capCents,
          });
        }
        // FR-3.4(g): the day-by-day skeleton is deterministic and does NOT
        // depend on the LLM — only the prose summary does. When the provider
        // is transiently unavailable (e.g. Gemini 503 "high demand"), still
        // return a usable outline instead of failing the whole request. The
        // operator gets the full structured days; only the summary is the
        // generic stub line. (In CI the router is already in stub mode, so
        // this branch never runs there and the spec's model/stub pins hold.)
        console.error("[travel-itin] suggest LLM fallback:", e.message);
        result = {
          text: `Suggested ${numDays}-day outline for ${dest}.`,
          model: "stub-fallback",
          stub: true,
        };
      }

      // Prefer the LLM's structured, destination-specific items + per-person
      // costs when the real provider answered. Fall back to the deterministic
      // tier-priced skeleton in stub mode (CI), on a transient LLM failure
      // (503), or if the model returned unparseable JSON — so the operator
      // always gets a usable, priced draft.
      let suggestion = null;
      let costSource = "stub";
      if (result && !result.stub) {
        suggestion = parseLlmSuggestion(result.text, { destination: dest });
        if (suggestion) costSource = "llm";
      }
      if (!suggestion) {
        const stubSummary = (result && result.stub && typeof result.text === "string")
          ? result.text
          : `Suggested ${numDays}-day outline for ${dest}.`;
        suggestion = buildSuggestionSkeleton({
          destination: dest,
          days: numDays,
          budgetPerPax: budgetNum,
          budgetTier: tier,
          summary: stubSummary,
        });
      }

      return res.status(200).json({
        suggestion,
        theme,
        subBrand: resolvedSubBrand,
        model: result.model,
        stub: Boolean(result.stub),
        // "llm" = costs/items came from Gemini; "stub" = deterministic
        // tier-priced fallback (CI / transient failure / unparseable output).
        costSource,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] suggest error:", e.message);
      res.status(500).json({ error: "Failed to generate itinerary suggestion" });
    }
  },
);

// POST /api/travel/itineraries/:id/draft/regen
//
// PRD §4.3 + §9.1: regenerate the customer-facing draft summary block
// via the LLM router (bulk-text task class → Gemini Flash primary,
// Claude Haiku fallback per PRD §9.1's locked Q11 routing table). Third
// consumer of the lib/llmRouter.js scaffold (commit 583c06b) after
// talking-points (cf876af) and form-vs-call (4a7c623), and the FIRST
// non-Claude-Opus consumer — exercises the bulk-text → gemini-flash
// route per PRD §9.1. Until Q11 keys arrive the router returns
// deterministic [STUB-BULK-TEXT] synthetic text so the customer-facing
// PDF + share page can render SOMETHING and tests can pin the contract.
//
// ADMIN/MANAGER-gated: regenerating costs LLM tokens (in real mode) +
// surfaces a fresh block that propagates to the customer-facing share
// page; we don't want every USER firing it. USERs read the
// already-persisted summary via GET /itineraries/:id (draftSummary).
//
// Persists result.text to Itinerary.draftSummary so the next render
// serves the cached prose without re-billing the LLM. Operator-triggered
// only — DO NOT auto-trigger on itinerary create (respects LLM cost).
//
// PII discipline: contact name only — no email / phone / address in
// the payload. Mirrors the talking-points pattern. The router's own
// log line only emits token counts; don't add a console.log of
// `payload` here.
router.post(
  "/itineraries/:id/draft/regen",
  verifyToken,
  requireTravelTenant,
  requirePermission("itineraries", "update"),
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      // Re-fetch with the columns the LLM payload needs.
      // loadItineraryWithGuard's select is narrow (id + subBrand).
      const full = await prisma.itinerary.findFirst({
        where: { id: itin.id, tenantId: req.travelTenant.id },
        include: { items: { orderBy: { position: "asc" } } },
      });
      if (!full) {
        // Belt-and-braces — loadItineraryWithGuard just succeeded, so
        // this should never fire. Defensive in case of a concurrent
        // delete between the two reads.
        return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
      }

      // Contact for prompt context (name only). Tolerant of
      // contact-not-found — draft still renders against the itinerary
      // structure alone, just without the recipient framing.
      const contact = full.contactId
        ? await prisma.contact.findFirst({
          where: { id: full.contactId, tenantId: req.travelTenant.id },
          select: { name: true },
        })
        : null;

      // PII-minimal payload — mirrors talking-points pattern. NO contact
      // email / phone / address. totalAmount sent as Number so the LLM
      // sees a clean numeric (Prisma returns Decimal as string).
      const payload = {
        subBrand: full.subBrand,
        destination: full.destination,
        startDate: full.startDate,
        endDate: full.endDate,
        totalAmount: full.totalAmount != null ? Number(full.totalAmount) : null,
        currency: full.currency,
        items: full.items.map((it) => ({
          itemType: it.itemType,
          description: it.description,
          totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
        })),
        contact: {
          name: contact?.name || null,
        },
      };

      const result = await llmRouter.routeRequest({
        task: "bulk-text",
        payload,
        tenantId: req.travelTenant.id,
      });

      const generatedAt = new Date().toISOString();

      await prisma.itinerary.update({
        where: { id: full.id },
        data: { draftSummary: result.text },
      });

      res.status(201).json({
        id: full.id,
        draftSummary: result.text,
        model: result.model,
        stub: Boolean(result.stub),
        generatedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] draft regen error:", e.message);
      res.status(500).json({ error: "Failed to regenerate draft summary" });
    }
  },
);

// POST /api/travel/itineraries/:id/reject
//
// Body: { reason?: string } — optional rejection reason stored on the
// row (reuses pricingJson? no, that's pricing). We add the reason to a
// new column? No — keep it simple, store under `pricingJson` would be
// wrong. The schema doesn't have a rejectionReason field; the reason
// goes into an audit log entry if needed. For now the endpoint just
// flips status — reason is logged but not persisted on the row.
router.post("/itineraries/:id/reject", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, status: true },
    });
    if (full.status === "accepted") {
      return res.status(409).json({
        error: "Itinerary was accepted — create a new version via PUT to reject",
        code: "ALREADY_ACCEPTED",
      });
    }
    if (full.status === "rejected") {
      return res.status(409).json({ error: "Itinerary already rejected", code: "ALREADY_REJECTED" });
    }
    const { reason } = req.body || {};
    if (reason) {
      console.log(`[travel-itin] itinerary ${itin.id} rejected — reason: ${String(reason).slice(0, 200)}`);
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "rejected" },
    });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] reject error:", e.message);
    res.status(500).json({ error: "Failed to reject itinerary" });
  }
});

// POST /api/travel/itineraries/:id/save-as-template (ADMIN + MANAGER)
//
// G050 — Save current itinerary as template (PRD_TRAVEL_ITINERARY_UPGRADES
// FR-3.1.f). Operator built an itinerary the customer loved; the operator
// wants to lock this layout in as a reusable template. We:
//   1. Load the itinerary (via loadItineraryWithGuard for tenant + sub-brand
//      scope).
//   2. Load the itinerary's items so we can serialize the day-by-day plan
//      into templateJson.items[].
//   3. Create a new ItineraryTemplate row scoped to the same tenant +
//      sub-brand, with name + destinationName + durationDays + basePriceMinor
//      derived from the itinerary. Caller can override `name` via body
//      (operator-supplied template label).
//   4. Return the created template (id + name + …).
//
// Body shape (all optional):
//   { name?: string,          // override template name (default: itinerary.destination + " template")
//     category?: string,       // free-form category tag
//     description?: string     // 1-2 paragraph blurb
//   }
//
// RBAC: ADMIN + MANAGER only. USER → 403 (matches the templates POST gate).
//
// Note: this endpoint creates a NEW ItineraryTemplate row at version=1
// (it's a brand-new lineage, not a version of an existing template). The
// itinerary itself is unchanged — we don't bump its clonedFromTemplateId
// or other fields. Operators who want to lineage forward from the new
// template can do so on the next clone.
router.post(
  "/itineraries/:id/save-as-template",
  verifyToken,
  requireTravelTenant,
  requirePermission("itinerary_templates", "write"),
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const full = await prisma.itinerary.findFirst({
        where: { id: itin.id, tenantId: req.travelTenant.id },
        select: {
          id: true,
          subBrand: true,
          destination: true,
          startDate: true,
          endDate: true,
          totalAmount: true,
          currency: true,
        },
      });
      if (!full) {
        return res.status(404).json({
          error: "Itinerary not found",
          code: "NOT_FOUND",
        });
      }

      const items = await prisma.itineraryItem.findMany({
        where: { itineraryId: full.id },
        orderBy: [{ dayNumber: "asc" }, { position: "asc" }],
        select: {
          itemType: true,
          position: true,
          description: true,
          detailsJson: true,
          unitCost: true,
          markup: true,
          gstAmount: true,
          totalPrice: true,
          unit: true,
          quantity: true,
          direction: true,
          dayNumber: true,
          latitude: true,
          longitude: true,
        },
      });

      // Derive duration from date range OR max(dayNumber) — same heuristic
      // the editor uses to render day buckets. Floor at 1 so a 0-day
      // template never lands.
      let durationDays = 1;
      if (full.startDate && full.endDate) {
        const ms = new Date(full.endDate) - new Date(full.startDate);
        if (Number.isFinite(ms) && ms >= 0) {
          durationDays = Math.max(1, Math.floor(ms / 86400000) + 1);
        }
      }
      for (const it of items) {
        if (it.dayNumber && it.dayNumber > durationDays) {
          durationDays = it.dayNumber;
        }
      }

      // basePriceMinor derived from totalAmount (Decimal rupees → integer
      // paise/minor units). null when itinerary has no totalAmount yet.
      let basePriceMinor = null;
      if (full.totalAmount != null) {
        const major = Number(full.totalAmount);
        if (Number.isFinite(major)) {
          basePriceMinor = Math.round(major * 100);
        }
      }

      const body = req.body || {};
      const defaultName = `${full.destination || "Itinerary"} template`;
      const name =
        typeof body.name === "string" && body.name.trim() !== ""
          ? body.name.trim()
          : defaultName;
      const category =
        typeof body.category === "string" && body.category.trim() !== ""
          ? body.category.trim()
          : null;
      const description =
        typeof body.description === "string" && body.description.trim() !== ""
          ? body.description.trim()
          : null;

      // Serialize the day-by-day plan into templateJson.items[]. We strip
      // PII (descriptions are operator-facing; supplier ids etc. stay) and
      // preserve dayNumber + position so the clone path can reconstruct
      // the bucket layout exactly. Decimal columns serialize via String()
      // → Prisma re-parses on next create.
      const templateItems = items.map((it) => ({
        itemType: it.itemType,
        position: it.position,
        description: it.description,
        detailsJson: it.detailsJson,
        unit: it.unit,
        quantity: it.quantity != null ? String(it.quantity) : null,
        unitCost: it.unitCost != null ? String(it.unitCost) : null,
        markup: it.markup != null ? String(it.markup) : null,
        gstAmount: it.gstAmount != null ? String(it.gstAmount) : null,
        totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
        direction: it.direction,
        dayNumber: it.dayNumber,
        latitude: it.latitude,
        longitude: it.longitude,
      }));

      const templateJson = JSON.stringify({ items: templateItems });

      const created = await prisma.itineraryTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name,
          destinationName: full.destination || "Unknown",
          durationDays,
          description,
          category,
          subBrand: full.subBrand || null,
          basePriceMinor,
          currency: full.currency || null,
          templateJson,
          isActive: true,
          // version + isLatest + archivedAt take their defaults (1, true, null).
          // Metric columns also default (0, null, null).
        },
      });

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-itin] save-as-template error:", e.message);
      res.status(500).json({
        error: "Failed to save itinerary as template",
        code: "SAVE_AS_TEMPLATE_FAILED",
      });
    }
  },
);

// PUT /api/travel/itineraries/:id
//
// Per PRD §6.1: "PUT creates new version, links via parentItineraryId."
// This is the "revised" path — the customer pushed back, we recompute
// with a new structure, and ship a new row in the chain. The original
// row is preserved verbatim (history); the new row carries
// parentItineraryId=<originalId>, version=N+1.
router.put("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const original = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
    });
    if (!original) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, original.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const {
      destination, startDate, endDate,
      pricingJson, totalAmount, currency, items,
    } = req.body || {};

    // Find the highest version in the chain so we can increment.
    const chainRoot = original.parentItineraryId || original.id;
    const latest = await prisma.itinerary.findFirst({
      where: {
        tenantId: req.travelTenant.id,
        OR: [{ id: chainRoot }, { parentItineraryId: chainRoot }],
      },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version || 1) + 1;

    // Validate item shapes the same way POST does. Inline here to keep
    // imports contained — the assertValidItemType helper is already in
    // scope at the top of the file.
    const itemRows = [];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || typeof it !== "object") continue;
        if (!it.itemType || !it.description) {
          return res.status(400).json({
            error: `items[${i}]: itemType + description required`,
            code: "ITEM_MISSING_FIELDS",
          });
        }
        assertValidItemType(it.itemType);
        const itQty = it.quantity != null && it.quantity !== "" ? Number(it.quantity) : 1;
        itemRows.push({
          itemType: it.itemType,
          position: typeof it.position === "number" ? it.position : i,
          description: String(it.description),
          detailsJson: it.detailsJson ? String(it.detailsJson) : null,
          supplierId: it.supplierId ? parseInt(it.supplierId, 10) : null,
          unitCost: it.unitCost != null && it.unitCost !== "" ? Number(it.unitCost) : null,
          markup: it.markup != null && it.markup !== "" ? Number(it.markup) : null,
          gstAmount: it.gstAmount != null && it.gstAmount !== "" ? Number(it.gstAmount) : null,
          unit: it.unit ? String(it.unit) : "per_person",
          quantity: Number.isFinite(itQty) && itQty >= 0 ? itQty : 1,
          direction: it.direction ? String(it.direction) : null,
          totalPrice: computeItemLineTotal(it),
        });
      }
    }

    const newItin = await prisma.itinerary.create({
      data: {
        tenantId: req.travelTenant.id,
        subBrand: original.subBrand,
        contactId: original.contactId,
        leadId: original.leadId,
        status: "revised",
        version: nextVersion,
        parentItineraryId: chainRoot,
        destination: destination != null ? String(destination) : original.destination,
        startDate: startDate ? new Date(startDate) : original.startDate,
        endDate: endDate ? new Date(endDate) : original.endDate,
        pricingJson: pricingJson != null ? String(pricingJson) : original.pricingJson,
        totalAmount: totalAmount != null ? Number(totalAmount) : original.totalAmount,
        currency: currency || original.currency,
        items: itemRows.length > 0 ? { create: itemRows } : undefined,
      },
      include: { items: { orderBy: { position: "asc" } } },
    });

    // This PUT is the "redesign" path — it mints a new REVISED version. Notify
    // the customer their trip plan was updated (newItin carries contactId/dest).
    notifyCustomerTrip(newItin, "revised");

    res.status(201).json(newItin);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] put error:", e.message);
    res.status(500).json({ error: "Failed to revise itinerary" });
  }
});

// POST /api/travel/itineraries/:id/share
//
// Mints a shareToken (random URL-safe slug) and returns the share URL
// the advisor pastes into WhatsApp/email. Idempotent: re-calling on an
// itinerary that already has a shareToken returns the existing one
// rather than minting a new one (so old WhatsApp links keep working).
//
// PRD §4.7 (gap A3) — share-link security:
//   - Optional body `expiryDays` (CLAMPED to [1, 30], default 7 — see
//     lib/shareLinkPolicy). Every mint/re-mint refreshes shareExpiresAt,
//     which the response now carries.
//   - Re-sharing AFTER a revoke mints a FRESH token (the leaked/revoked
//     URL must stay dead forever) and clears shareRevokedAt.
router.post("/itineraries/:id/share", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);

    // Re-fetch with the columns we need. loadItineraryWithGuard's select is
    // narrow (id + subBrand); we want shareToken + revocation state here too.
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: {
        id: true, shareToken: true, shareRevokedAt: true,
        contactId: true, destination: true,
      },
    });
    if (!full) {
      // Belt-and-braces — loadItineraryWithGuard just succeeded, so this
      // would only fire under a concurrent delete. Surface clearly.
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }

    let token = full.shareToken;
    if (!token || full.shareRevokedAt != null) {
      // First share OR re-share after revoke. A revoked token is burned —
      // minting a fresh slug guarantees the old URL 404s on every row.
      // 32-char random → base64url. crypto already required at the top.
      token = crypto.randomBytes(24).toString("base64url");
    }
    const shareExpiresAt = computeShareExpiresAt((req.body || {}).expiryDays);
    await prisma.itinerary.update({
      where: { id: full.id },
      data: { shareToken: token, shareExpiresAt, shareRevokedAt: null },
    });

    const portalBase = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
    const shareUrl = `${portalBase}/p/itinerary/${token}`;
    // Q9 cut-over plumbing — resolve the per-sub-brand wabaId so when
    // Wati creds land, swapping the stub log for a real WhatsApp blast
    // is a 1-line change here. Today the dispatch is "advisor pastes
    // the URL into a chat manually"; tomorrow the resolved wabaId
    // routes the automated blast. requireTravelTenant doesn't include
    // subBrandConfigJson in its select, so we fetch it separately.
    const tenantCfgRow = await prisma.tenant.findUnique({
      where: { id: req.travelTenant.id },
      select: { subBrandConfigJson: true },
    });
    const cfg = resolveForSubBrand(tenantCfgRow, itin.subBrand);
    console.log(
      `[travel-itin] share token minted for itin ${full.id} (sub-brand=${itin.subBrand}) — ` +
      `WhatsApp dispatch via watiClient (wabaId=${cfg.wabaId || "(no-config)"})`,
    );
    // WhatsApp dispatch via watiClient (Q9) — sends the share URL to the
    // itinerary's contact. Stub mode (no WATI creds) logs + writes a QUEUED
    // row, keeping the historical "advisor pastes the URL manually" flow as
    // the fallback. `whatsapp` in the response is additive — existing
    // consumers that only read shareToken/shareUrl are unaffected.
    let whatsappStatus = "SKIPPED";
    if (full.contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: full.contactId, tenantId: req.travelTenant.id },
        select: { id: true, phone: true, name: true },
      });
      if (contact && contact.phone) {
        // Legacy rows can carry a long prose summary in `destination`
        // (pre-S113 materialise bug) — fall back to "trip" past 60 chars
        // so the customer-facing message stays clean.
        const destLabel = full.destination && full.destination.length <= 60
          ? full.destination
          : "trip";
        const sendResult = await watiClient.sendBestEffort({
          tenantId: req.travelTenant.id,
          subBrand: itin.subBrand,
          toPhone: contact.phone,
          contactId: contact.id,
          fallbackText:
            `Hi ${contact.name || "there"}! Your ${destLabel} itinerary is ready. ` +
            `View it here: ${shareUrl}`,
          broadcastName: "travel-itinerary-share",
        });
        whatsappStatus = sendResult.status;
      }
    }
    // G124 — per-document share audit row. Captures who minted the link
    // (req.user.userId), the truncated share-token (so audit-viewer can
    // correlate without leaking the bearer secret), and the sub-brand /
    // expiry context. Best-effort; never blocks the response.
    recordDocumentAccess({
      tenantId: req.travelTenant.id,
      userId: req.user.userId,
      documentType: "Itinerary",
      documentId: full.id,
      event: "share",
      shareTokenId: token,
      ipAddress: req.ip,
      userAgent: req.headers && req.headers["user-agent"],
      extra: {
        subBrand: itin.subBrand,
        shareExpiresAt: shareExpiresAt && shareExpiresAt.toISOString
          ? shareExpiresAt.toISOString()
          : null,
        whatsappStatus,
      },
    });
    res.json({ shareToken: token, shareUrl, shareExpiresAt, whatsapp: whatsappStatus });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      // Extremely unlikely with 24 random bytes — surface as 409.
      return res.status(409).json({ error: "shareToken collision — retry", code: "DUPLICATE_SHARE_TOKEN" });
    }
    // Log the full stack so a future gate failure has more than e.message
    // to work with — the prior commit's catch only logged the message and
    // we couldn't see what threw.
    console.error("[travel-itin] share error:", e.message, "\nstack:", e.stack);
    res.status(500).json({ error: "Failed to mint share token", code: "SHARE_FAILED" });
  }
});

// POST /api/travel/itineraries/:id/share/revoke
//
// PRD §4.7 (gap A3) — kill a live share link immediately (forwarded URL,
// deal fell through, wrong recipient). Same auth + tenant + sub-brand
// guards as the share-mint endpoint above.
//
// Semantics:
//   - 409 NOT_SHARED if the itinerary was never shared (no shareToken).
//   - Idempotent: re-revoking returns 200 with alreadyRevoked=true and
//     the ORIGINAL shareRevokedAt stamp (audit timeline stays truthful).
//   - The public route answers 410 SHARE_REVOKED while the token row is
//     revoked; a later re-share mints a FRESH token (see share above), so
//     the revoked URL stays dead forever.
//   - Best-effort ITINERARY_SHARE_REVOKED audit row — never blocks.
router.post("/itineraries/:id/share/revoke", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, shareToken: true, shareRevokedAt: true },
    });
    if (!full) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    if (!full.shareToken) {
      return res.status(409).json({ error: "Itinerary has never been shared", code: "NOT_SHARED" });
    }

    const alreadyRevoked = full.shareRevokedAt != null;
    let revokedAt = full.shareRevokedAt;
    if (!alreadyRevoked) {
      revokedAt = new Date();
      await prisma.itinerary.update({
        where: { id: full.id },
        data: { shareRevokedAt: revokedAt },
      });
      // Best-effort audit (mirrors travel_visa.js) — never blocks the response.
      writeAudit(
        "Itinerary",
        "ITINERARY_SHARE_REVOKED",
        full.id,
        req.user.userId,
        req.travelTenant.id,
        { subBrand: itin.subBrand, shareToken: full.shareToken },
      ).catch(() => {});
    }

    res.json({ revoked: true, alreadyRevoked, shareRevokedAt: revokedAt });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] share revoke error:", e.message, "\nstack:", e.stack);
    res.status(500).json({ error: "Failed to revoke share link", code: "SHARE_REVOKE_FAILED" });
  }
});

// GET /api/travel/itineraries/:id/pdf
//
// Streams a branded itinerary PDF (PRD §6.1). Sub-brand header band,
// trip summary, items table with unit-cost / markup / total, grand
// total band. Uses the existing renderTravelItineraryPdf in
// services/pdfRenderer.js (mirrors the v3.9.2 diagnostic PDF pattern).
//
// Tenant + sub-brand access enforced via loadItineraryWithGuard — same
// access discipline as every other /itineraries/:id endpoint.
//
// NOTE: this PDF is opened in a new browser tab via a plain <a href> (no
// Authorization header). The frontend passes the bearer JWT as a ?_t=
// query param; the global auth guard in server.js promotes it into the
// Authorization header for this exact path BEFORE verifyToken runs.
router.get("/itineraries/:id/pdf", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      include: { items: { orderBy: { position: "asc" } } },
    });
    if (!full) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    const contact = full.contactId
      ? await prisma.contact.findUnique({
        where: { id: full.contactId },
        select: { name: true, email: true, phone: true },
      })
      : { name: "Customer", email: null, phone: null };
    // PRD §4.7 (gap A3) — per-viewer diagonal watermark so a leaked or
    // forwarded PDF identifies who pulled it and when. The JWT only
    // carries userId (NOT name/email), so resolve the User row here.
    // Best-effort: a missing row still renders (timestamp-only mark).
    let viewerName = null;
    let viewerEmail = null;
    try {
      const viewer = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { name: true, email: true },
      });
      if (viewer) {
        viewerName = viewer.name || null;
        viewerEmail = viewer.email || null;
      }
    } catch (viewerErr) {
      console.error("[travel-itin] pdf viewer lookup failed:", viewerErr.message);
    }
    const pdfBuf = await renderTravelItineraryPdf(full, contact, {
      viewerWatermark: {
        viewerName,
        viewerEmail,
        timestamp: new Date().toISOString(),
      },
    });
    // Best-effort ITINERARY_PDF_DOWNLOAD audit row (PRD §4.7 — every
    // document pull is traceable). Never blocks the download.
    writeAudit(
      "Itinerary",
      "ITINERARY_PDF_DOWNLOAD",
      full.id,
      req.user.userId,
      req.travelTenant.id,
      { subBrand: full.subBrand, version: full.version || 1 },
    ).catch(() => {});
    // G124 — uniform DOCUMENT_DOWNLOAD row for the audit-viewer's Document
    // Access sub-tab. Captures the viewer's email (resolved above as
    // viewerEmail for the diagonal watermark) so an operator who pulled a
    // sensitive PDF is identifiable in the audit trail.
    recordDocumentAccess({
      tenantId: req.travelTenant.id,
      userId: req.user.userId,
      documentType: "Itinerary",
      documentId: full.id,
      event: "download",
      viewerEmail,
      ipAddress: req.ip,
      userAgent: req.headers && req.headers["user-agent"],
      extra: { subBrand: full.subBrand, version: full.version || 1 },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="itinerary-${full.id}-v${full.version || 1}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuf.length);
    res.send(pdfBuf);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] pdf error:", e.message, "\nstack:", e.stack);
    res.status(500).json({ error: "Failed to render itinerary PDF", code: "PDF_FAILED" });
  }
});

// ─── PUBLIC ENDPOINTS (no auth) — Phase 2 50%-advance booking (PRD §4.7) ──
//
// Lead receives a `shareToken` URL from the advisor (WhatsApp / email)
// and views their itinerary + pays the 50% deposit without logging in.
//
// Allowlisted in server.js openPaths under `/travel/itineraries/public`.
// shareToken is a 128-bit random slug (crypto.randomUUID() or 32-hex byte
// stream depending on caller) and @@unique on the schema — sufficient
// access control for a "share by link" surface, same model as the TMC
// microsite publicUuid pattern.
//
// What's intentionally NOT exposed:
//   - tenant id (only the slug-friendly tenant name)
//   - contactId / leadId
//   - cost / supplier / markup detail on items (only totalPrice +
//     human-readable description)
//   - portalPasswordHash and other PII (already scrubbed globally by
//     scrubResponse middleware)

// Strip an itinerary item to its public-safe projection.
function publicItemProjection(item) {
  return {
    id: item.id,
    itemType: item.itemType,
    position: item.position,
    description: item.description,
    detailsJson: item.detailsJson, // already curated by the advisor; advisor controls what lands here
    totalPrice: item.totalPrice,
  };
}

// GET /api/travel/itineraries/public/:shareToken
//
// Public read-only fetch by share token. Returns the customer-facing
// view of the itinerary including the 50%-advance summary so the
// payment widget can render the right amount.
router.get("/itineraries/public/:shareToken", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const itin = await prisma.itinerary.findUnique({
      where: { shareToken: token },
      include: { items: { orderBy: { position: "asc" } }, tenant: { select: { name: true, slug: true } } },
    });
    if (!itin) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    // Only advisor-completed itineraries (status >= sent) are publicly
    // viewable. A draft is internal work-in-progress; surfacing it would
    // be confusing for the lead.
    if (itin.status === "draft") {
      return res.status(404).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    }
    // PRD §4.7 (gap A3) — expiry/revocation gate. 410 Gone (not 404: the
    // resource existed; the link was withdrawn). Revoked wins over
    // expired; legacy rows with NULL shareExpiresAt never expire — see
    // lib/shareLinkPolicy.js for the full precedence contract.
    const linkState = shareLinkState(itin);
    if (linkState.code) {
      return res.status(410).json({
        error: linkState.code === "SHARE_REVOKED"
          ? "This share link has been revoked"
          : "This share link has expired",
        code: linkState.code,
      });
    }
    // Best-effort ITINERARY_SHARE_VIEW audit row (PRD §4.7 — who-viewed
    // traceability for shared docs). Anonymous public viewer → no userId;
    // writeAudit records it as a system-actor row. Never blocks.
    writeAudit(
      "Itinerary",
      "ITINERARY_SHARE_VIEW",
      itin.id,
      null,
      itin.tenantId,
      { subBrand: itin.subBrand, shareToken: itin.shareToken },
    ).catch(() => {});
    // G124 — additional uniform DOCUMENT_VIEW row so the audit-viewer's
    // Document Access sub-tab surfaces this alongside invoice/quote views.
    // Captures the anonymous viewer's IP + UA + truncated share token for
    // forensic correlation without leaking the bearer secret.
    recordDocumentAccess({
      tenantId: itin.tenantId,
      userId: null,
      documentType: "Itinerary",
      documentId: itin.id,
      event: "view",
      shareTokenId: itin.shareToken,
      ipAddress: req.ip,
      userAgent: req.headers && req.headers["user-agent"],
      extra: { subBrand: itin.subBrand },
    });
    const total = itin.totalAmount ? Number(itin.totalAmount) : 0;
    const advanceRatio = await getTravelAdvanceRatio(prisma, itin.tenantId, itin.subBrand);
    const advanceDue = total > 0 ? Math.round(total * advanceRatio * 100) / 100 : 0;
    const advancePaid = itin.advancePaidAmount ? Number(itin.advancePaidAmount) : 0;
    const balanceDue = Math.max(0, total - advancePaid);
    // Online pay button only shows when the TENANT has configured + activated
    // its OWN Razorpay keys (BYOK). Otherwise the customer can't pay online here
    // — the advisor arranges payment offline. (Our platform keys are never used
    // for customer payments — they're subscription-billing only.)
    const onlinePaymentEnabled = (await getTenantRazorpayCreds(itin.tenantId)) !== null;
    res.json({
      shareToken: itin.shareToken,
      tenantName: itin.tenant?.name || null,
      tenantSlug: itin.tenant?.slug || null,
      subBrand: itin.subBrand,
      destination: itin.destination,
      startDate: itin.startDate,
      endDate: itin.endDate,
      status: itin.status,
      totalAmount: total,
      currency: itin.currency,
      advanceRatio,
      advanceDue,
      advancePaid,
      advancePaidAt: itin.advancePaidAt,
      balanceDue,
      onlinePaymentEnabled,
      items: itin.items.map(publicItemProjection),
      pdfUrl: itin.pdfUrl,
      // PRD §4.3 — operator-generated executive summary block (null
      // until first POST /draft/regen lands). Customer-facing share
      // page + PDF render conditionally on this field.
      draftSummary: itin.draftSummary,
    });
  } catch (e) {
    console.error("[travel-itin-public] get error:", e.message);
    res.status(500).json({ error: "Failed to load itinerary" });
  }
});

// POST /api/travel/itineraries/public/:shareToken/record-advance-payment
//
// Phase 2 demo-mode endpoint: records that an advance payment has
// cleared. In production this will be hit by the payment gateway's
// webhook (Razorpay/Stripe) after a successful charge — the body
// fields map directly to gateway webhook payloads. Until those creds
// land (Q9 + payment-provider track) the endpoint accepts the values
// directly so the booking flow is operable end-to-end in demo/sandbox.
//
// Idempotent on paymentReference: re-submitting the same reference
// no-ops with a 200 + the existing state (gateway webhooks retry).
router.post("/itineraries/public/:shareToken/record-advance-payment", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const { amount, paymentReference } = req.body || {};
    if (amount == null || !paymentReference) {
      return res.status(400).json({
        error: "amount and paymentReference required",
        code: "MISSING_FIELDS",
      });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount must be positive", code: "INVALID_AMOUNT" });
    }

    const itin = await prisma.itinerary.findUnique({ where: { shareToken: token } });
    if (!itin) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    if (itin.status === "draft") {
      return res.status(409).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    }
    if (itin.status === "rejected" || itin.status === "fully_paid") {
      return res.status(409).json({
        error: `Cannot record advance against an itinerary in '${itin.status}' status`,
        code: "INVALID_STATE",
      });
    }

    // Idempotent webhook re-delivery: same paymentReference → just return
    // current state without mutating. Gateways re-fire on 5xx → idempotency
    // prevents double-counting advances.
    if (itin.paymentReference === String(paymentReference)) {
      return res.json({
        status: itin.status,
        advancePaidAmount: itin.advancePaidAmount ? Number(itin.advancePaidAmount) : 0,
        advancePaidAt: itin.advancePaidAt,
        paymentReference: itin.paymentReference,
        idempotent: true,
      });
    }

    const total = itin.totalAmount ? Number(itin.totalAmount) : 0;
    const newAdvanceTotal = Number(itin.advancePaidAmount || 0) + amt;
    // If the new running total equals or exceeds the trip total, mark
    // fully_paid; otherwise advance_paid. Floating-point tolerance is
    // 1 paisa (0.01) since totalAmount is stored as Decimal(15,2).
    const nextStatus = total > 0 && newAdvanceTotal + 0.01 >= total ? "fully_paid" : "advance_paid";

    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: {
        status: nextStatus,
        advancePaidAmount: newAdvanceTotal,
        advancePaidAt: new Date(),
        paymentReference: String(paymentReference),
        // Deposit landed → clear any pay-or-cancel at-risk flag set by
        // cron/paymentDeadlineEngine.js (keeps the advisor at-risk badge honest
        // if the customer pays late).
        paymentOverdueAt: null,
      },
    });

    // Thank the customer + confirm the booking in their portal (itin carries
    // contactId/destination/tenantId; updated.status is advance_paid|fully_paid).
    notifyCustomerTrip(itin, updated.status);

    res.status(201).json({
      status: updated.status,
      advancePaidAmount: Number(updated.advancePaidAmount),
      advancePaidAt: updated.advancePaidAt,
      paymentReference: updated.paymentReference,
      balanceDue: Math.max(0, total - Number(updated.advancePaidAmount)),
    });
  } catch (e) {
    console.error("[travel-itin-public] record-advance error:", e.message);
    res.status(500).json({ error: "Failed to record advance" });
  }
});

// ─── Razorpay online payment (PRD §4.7 — real gateway) ───────────────
//
// Real Razorpay checkout for the public share page. Uses the PLATFORM keys
// from env (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — the customer is
// unauthenticated, so tenant-scoped keys aren't resolvable here ("for now"
// per product). Two steps, mirroring routes/payments.js:
//   1. create-payment-order → mints a Razorpay order for the advance OR
//      balance amount; returns { orderId, amount(paise), currency, keyId }.
//   2. verify-payment → validates the checkout signature (HMAC-SHA256 of
//      `${order_id}|${payment_id}` with the key secret), refetches the
//      captured amount from Razorpay (never trusts a client amount), then
//      advances the itinerary's payment state (idempotent on payment id).
//
// Both are allow-listed via the `/travel/itineraries/public` openPath prefix.

// Amount (major units) due for a given payment kind on a shared itinerary.
async function resolveDueAmount(itin, kind) {
  const total = itin.totalAmount ? Number(itin.totalAmount) : 0;
  const paid = itin.advancePaidAmount ? Number(itin.advancePaidAmount) : 0;
  if (kind === "balance") return Math.max(0, total - paid);
  // advance: the configured advance ratio, net of anything already paid.
  const ratio = await getTravelAdvanceRatio(prisma, itin.tenantId, itin.subBrand);
  const advanceDue = total > 0 ? Math.round(total * ratio * 100) / 100 : 0;
  return Math.max(0, Math.round((advanceDue - paid) * 100) / 100);
}

router.post("/itineraries/public/:shareToken/create-payment-order", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const itin = await prisma.itinerary.findUnique({ where: { shareToken: token } });
    if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    if (itin.status === "draft") return res.status(409).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    if (itin.status === "rejected" || itin.status === "fully_paid") {
      return res.status(409).json({ error: `Cannot pay against an itinerary in '${itin.status}' status`, code: "INVALID_STATE" });
    }
    // Customer pays into the TENANT's own Razorpay account — never the platform's.
    // No (or inactive) tenant keys → block the payment with a clear message.
    const rp = await getTenantRazorpayClient(itin.tenantId);
    if (!rp) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const kind = req.body && req.body.kind === "balance" ? "balance" : "advance";
    const due = await resolveDueAmount(itin, kind);
    if (!(due > 0)) {
      return res.status(409).json({ error: "Nothing due for this itinerary", code: "NOTHING_DUE" });
    }
    const currency = (itin.currency || "INR").toUpperCase();
    const amountInt = Math.round(due * 100); // paise
    let order;
    try {
      order = await rp.client.orders.create({
        amount: amountInt,
        currency,
        receipt: `itin_${itin.id}_${kind}_${Date.now()}`,
        notes: { itineraryId: String(itin.id), shareToken: token, kind },
      });
    } catch (gErr) {
      console.error("[travel-itin-public] razorpay order error:", gErr && gErr.message);
      return res.status(502).json({ error: "Could not start payment. Please try again.", code: "GATEWAY_ERROR" });
    }
    res.json({
      orderId: order.id,
      amount: amountInt,
      amountMajor: due,
      currency,
      keyId: rp.keyId,
      kind,
      destination: itin.destination,
    });
  } catch (e) {
    console.error("[travel-itin-public] create-payment-order error:", e.message);
    res.status(500).json({ error: "Failed to start payment" });
  }
});

router.post("/itineraries/public/:shareToken/verify-payment", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields", code: "MISSING_FIELDS" });
    }
    const itin = await prisma.itinerary.findUnique({ where: { shareToken: token } });
    if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    if (itin.status === "draft") return res.status(409).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    // Resolve the TENANT's own Razorpay keys (the order was created with them)
    // and verify the checkout signature against the TENANT's key secret.
    const rp = await getTenantRazorpayClient(itin.tenantId);
    if (!rp) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    // Verify checkout signature: HMAC-SHA256(order_id|payment_id, key_secret).
    const expected = crypto
      .createHmac("sha256", rp.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const sig = String(razorpay_signature);
    const ok =
      expected.length === sig.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    if (!ok) {
      return res.status(400).json({ error: "Payment verification failed", code: "BAD_SIGNATURE" });
    }

    const total = itin.totalAmount ? Number(itin.totalAmount) : 0;

    // Idempotency: this payment id already recorded → return current state.
    if (itin.paymentReference === String(razorpay_payment_id)) {
      return res.json({
        status: itin.status,
        advancePaidAmount: Number(itin.advancePaidAmount || 0),
        advancePaidAt: itin.advancePaidAt,
        paymentReference: itin.paymentReference,
        balanceDue: Math.max(0, total - Number(itin.advancePaidAmount || 0)),
        idempotent: true,
      });
    }

    // Authoritative amount: fetch the captured payment from Razorpay rather
    // than trusting any client-supplied figure.
    let paidMajor = 0;
    try {
      const payment = await rp.client.payments.fetch(razorpay_payment_id);
      paidMajor = payment && payment.amount ? Number(payment.amount) / 100 : 0;
    } catch (fErr) {
      console.error("[travel-itin-public] razorpay payments.fetch error:", fErr && fErr.message);
      return res.status(502).json({ error: "Could not confirm payment. Please contact support.", code: "GATEWAY_ERROR" });
    }
    if (!(paidMajor > 0)) {
      return res.status(400).json({ error: "Payment not captured", code: "NOT_CAPTURED" });
    }

    const newTotalPaid = Number(itin.advancePaidAmount || 0) + paidMajor;
    const nextStatus = total > 0 && newTotalPaid + 0.01 >= total ? "fully_paid" : "advance_paid";
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: {
        status: nextStatus,
        advancePaidAmount: newTotalPaid,
        advancePaidAt: new Date(),
        paymentReference: String(razorpay_payment_id),
        // Deposit landed → clear any pay-or-cancel at-risk flag (see
        // cron/paymentDeadlineEngine.js).
        paymentOverdueAt: null,
      },
    });

    // Thank the customer + confirm the booking in their portal.
    notifyCustomerTrip(itin, updated.status);

    res.status(201).json({
      status: updated.status,
      advancePaidAmount: Number(updated.advancePaidAmount),
      advancePaidAt: updated.advancePaidAt,
      paymentReference: updated.paymentReference,
      balanceDue: Math.max(0, total - Number(updated.advancePaidAmount)),
    });
  } catch (e) {
    console.error("[travel-itin-public] verify-payment error:", e.message);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

// ─── Per-day cost aggregation (#907 slice 2) ────────────────────────
//
// GET /api/travel/itineraries/:id/day-costs
//
// Consumes lib/itineraryDayCostCalculator.js (slice 1, commit 3072e5bf).
// Loads the parent itinerary tenant-scoped + sub-brand-scoped, fetches its
// items, maps each ItineraryItem to the helper's expected shape
// ({ cost, itemType, dayOffset|dayNumber|date }) and returns the
// helper's `{ days, grandTotal, totalDays, averageDailyCost }` envelope.
//
// Day-source mapping (no native column on ItineraryItem — the source
// fields live inside the operator-supplied detailsJson payload):
//   - detailsJson.dayOffset  preferred (0-indexed from trip start)
//   - detailsJson.dayNumber  alternate (1-indexed)
//   - detailsJson.date       alternate (ISO; resolved against tripStart)
//
// tripStart precedence:
//   1. ?tripStart=ISODate query param (operator override)
//   2. itinerary.startDate
//   3. today UTC (helper default)
//
// Cost source per item: `totalPrice` preferred, falls back to `unitCost`.
// Items with neither resolved-day-source nor cost are still PASSED to the
// helper which skips them per its precedence rules (keeps the contract
// auditable from the helper side).
//
// Margin breakdown (#907 slice 5): each ItineraryItem row's `unitCost`,
// `markup`, and `gstAmount` flow through to the helper, which aggregates
// per-day `supplierCost` / `markupTotal` / `gstTotal` alongside the
// existing `totalCost`. Grand-totals mirror the per-day shape
// (`grandSupplierCost` / `grandMarkupTotal` / `grandGstTotal`) so the
// envelope carries a full-trip P&L without consumer re-summing.
router.get("/itineraries/:id/day-costs", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, startDate: true },
    });
    if (!full) {
      return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
    }

    const items = await prisma.itineraryItem.findMany({
      where: { itineraryId: full.id },
      orderBy: { position: "asc" },
    });

    // Resolve tripStart per precedence rules above.
    let tripStart;
    if (req.query.tripStart) {
      const overrideDate = new Date(String(req.query.tripStart));
      if (Number.isFinite(overrideDate.getTime())) {
        tripStart = overrideDate;
      }
    }
    if (!tripStart && full.startDate) tripStart = new Date(full.startDate);

    // Map ItineraryItem rows → helper input shape. Day source comes from
    // detailsJson (parsed); customer-facing `cost` is totalPrice (falls
    // back to unitCost); per-line margin components flow through so the
    // helper can surface supplierCost / markupTotal / gstTotal per day
    // (#907 slice 5).
    const helperItems = items.map((row) => {
      let details = {};
      if (row.detailsJson) {
        try { details = JSON.parse(row.detailsJson); } catch { /* malformed → fall through */ }
      }
      const cost = row.totalPrice != null
        ? Number(row.totalPrice)
        : row.unitCost != null ? Number(row.unitCost) : 0;
      const mapped = {
        id: row.id,
        itemType: row.itemType,
        description: row.description,
        cost,
        unitCost: row.unitCost != null ? Number(row.unitCost) : null,
        markup: row.markup != null ? Number(row.markup) : 0,
        gstAmount: row.gstAmount != null ? Number(row.gstAmount) : 0,
      };
      if (typeof details.dayOffset === "number") mapped.dayOffset = details.dayOffset;
      else if (typeof details.dayNumber === "number") mapped.dayNumber = details.dayNumber;
      else if (details.date) mapped.date = details.date;
      return mapped;
    });

    const result = computeDayCosts(helperItems, tripStart ? { tripStart } : {});

    res.json({
      itineraryId: full.id,
      ...result,
    });
  } catch (e) {
    if (e.status) {
      // loadItineraryWithGuard surfaces NOT_FOUND for cross-tenant; rename
      // to ITINERARY_NOT_FOUND for this endpoint's contract.
      if (e.code === "NOT_FOUND") {
        return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
      }
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[travel-itin] day-costs error:", e.message);
    res.status(500).json({ error: "Failed to compute per-day costs" });
  }
});

// ─── Bulk-clone day across itineraries (#907 slice 6) ───────────────
//
// POST /api/travel/itineraries/:id/clone-day
// Body: { sourceItineraryId: Int, sourceDayOffset: Int, targetDayOffset: Int }
//
// Copies all ItineraryItem rows from the source itinerary's specified day
// into the receiving (path-param) itinerary's target day. Day-source
// resolution mirrors the day-costs endpoint convention (#907 slice 2):
// the day-source lives in each item's detailsJson (`dayOffset` preferred,
// `dayNumber` fallback). The cloned rows have their detailsJson rewritten
// with `dayOffset: targetDayOffset` so the new home is unambiguous.
//
// Position assignment: append after the target itinerary's current max
// position (same pattern as POST /items).
//
// Tenant + sub-brand guard: BOTH itineraries must belong to the requester's
// tenant; the operator must have sub-brand access to BOTH (source via
// SUB_BRAND_DENIED on source-load, target via loadItineraryWithGuard).
// Sub-brands are NOT required to match — an admin authoring across TMC and
// Travel Stall can lift a Day-3 sightseeing block from one and drop it on
// the other.
//
// Returns 201 + `{ clonedCount, items: [...] }` where items are the freshly
// created rows. clonedCount = 0 (with empty items array) when the source
// day has no matching items — not an error.
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 + §6.5.
router.post("/itineraries/:id/clone-day", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const target = await loadItineraryWithGuard(req);
    const { sourceItineraryId, sourceDayOffset, targetDayOffset } = req.body || {};

    const sourceId = parseInt(sourceItineraryId, 10);
    if (!Number.isFinite(sourceId)) {
      return res.status(400).json({
        error: "sourceItineraryId is required and must be numeric",
        code: "INVALID_SOURCE_ID",
      });
    }
    const srcDay = parseInt(sourceDayOffset, 10);
    const tgtDay = parseInt(targetDayOffset, 10);
    if (!Number.isFinite(srcDay) || srcDay < 0) {
      return res.status(400).json({
        error: "sourceDayOffset must be a non-negative integer",
        code: "INVALID_SOURCE_DAY",
      });
    }
    if (!Number.isFinite(tgtDay) || tgtDay < 0) {
      return res.status(400).json({
        error: "targetDayOffset must be a non-negative integer",
        code: "INVALID_TARGET_DAY",
      });
    }

    // Same-itinerary same-day clone would silently duplicate every line.
    // Reject explicitly to surface operator intent (vs typo).
    if (sourceId === target.id && srcDay === tgtDay) {
      return res.status(400).json({
        error: "source and target day are identical; use POST /items to duplicate",
        code: "SAME_DAY_CLONE",
      });
    }

    // Tenant-scope the source load. SUB_BRAND_DENIED check below.
    const source = await prisma.itinerary.findFirst({
      where: { id: sourceId, tenantId: req.travelTenant.id },
      select: { id: true, subBrand: true },
    });
    if (!source) {
      return res.status(404).json({
        error: "Source itinerary not found",
        code: "SOURCE_NOT_FOUND",
      });
    }
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, source.subBrand)) {
      return res.status(403).json({
        error: "Sub-brand access denied for source itinerary",
        code: "SOURCE_SUB_BRAND_DENIED",
      });
    }

    // Pull all source items, filter to the requested source day via
    // detailsJson.dayOffset / dayNumber (#907 slice 2 convention).
    const sourceItems = await prisma.itineraryItem.findMany({
      where: { itineraryId: source.id },
      orderBy: { position: "asc" },
    });
    const matching = sourceItems.filter((row) => {
      if (!row.detailsJson) return false;
      let details;
      try { details = JSON.parse(row.detailsJson); } catch { return false; }
      if (typeof details.dayOffset === "number") return details.dayOffset === srcDay;
      if (typeof details.dayNumber === "number") return (details.dayNumber - 1) === srcDay;
      return false;
    });

    if (matching.length === 0) {
      return res.status(201).json({ clonedCount: 0, items: [] });
    }

    // Append after the target itinerary's current max position.
    const maxRow = await prisma.itineraryItem.findFirst({
      where: { itineraryId: target.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    let nextPos = (maxRow?.position ?? -1) + 1;

    const cloned = [];
    for (const row of matching) {
      // Rewrite detailsJson with the new dayOffset; preserve all other keys.
      let details = {};
      try { details = row.detailsJson ? JSON.parse(row.detailsJson) : {}; } catch { details = {}; }
      details.dayOffset = tgtDay;
      delete details.dayNumber; // avoid stale dual-source conflicts.

      const created = await prisma.itineraryItem.create({
        data: {
          itineraryId: target.id,
          itemType: row.itemType,
          position: nextPos++,
          description: row.description,
          detailsJson: JSON.stringify(details),
          supplierId: row.supplierId,
          unitCost: row.unitCost != null ? Number(row.unitCost) : null,
          markup: row.markup != null ? Number(row.markup) : null,
          gstAmount: row.gstAmount != null ? Number(row.gstAmount) : null,
          totalPrice: row.totalPrice != null ? Number(row.totalPrice) : null,
        },
      });
      cloned.push(created);
    }

    res.status(201).json({ clonedCount: cloned.length, items: cloned });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] clone-day error:", e.message);
    res.status(500).json({ error: "Failed to clone day" });
  }
});

// ─── Supplier-confirmation rollup (#907 slice 7) ─────────────────────
//
// GET /api/travel/itineraries/:id/supplier-rollup
//
// Operator-facing pre-PO view: "which suppliers are in this itinerary,
// and what do I need to confirm with each?" Aggregates ItineraryItem
// rows by supplierId. Items without supplierId fall into an `unassigned`
// bucket — surfaces gaps before the operator issues POs.
//
// Per-supplier rollup shape:
//   {
//     supplierId,           // null for unassigned bucket
//     supplierName,         // TravelSupplier.name; "Unassigned" for null
//     supplierCategory,     // hotel | flight | transport | visa-consul | other
//     contactPerson,        // free-form contact name (nullable)
//     phone, email,         // contact channels (nullable)
//     itemCount,            // number of ItineraryItem rows mapped to supplier
//     itemTypes,            // unique itemType strings ["hotel","transfer",...]
//     totalSupplierCost,    // sum(unitCost) — half-up to paise (2dp)
//     totalGst,             // sum(gstAmount)
//     totalSalePrice,       // sum(totalPrice)
//     marginTotal,          // totalSalePrice - totalSupplierCost - totalGst
//     marginPct,            // marginTotal / totalSalePrice * 100; null if sale=0
//     items: [{ id, itemType, description, unitCost, gstAmount, totalPrice }]
//   }
//
// Envelope:
//   { itineraryId, suppliers: [...], unassigned: {...} | null,
//     grandTotals: { supplierCost, gst, salePrice, marginTotal, marginPct },
//     supplierCount }
//
// Tenant + sub-brand guard via loadItineraryWithGuard (mirrors slices 2/5/6).
// Read-only — no audit log, no eventBus emit.
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 + §6 (operator
// "Confirmation pipe" workflow before PO issue).
router.get(
  "/itineraries/:id/supplier-rollup",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);

      const items = await prisma.itineraryItem.findMany({
        where: { itineraryId: itin.id },
        orderBy: { position: "asc" },
      });

      // Half-up to 2dp (paise precision). All money fields are Decimal(15,2)
      // on the DB; the conversion to Number is safe for ≤15-digit values.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Bucket items by supplierId (null bucket kept separate).
      /** @type {Map<number|null, Array<any>>} */
      const buckets = new Map();
      for (const row of items) {
        const key = row.supplierId == null ? null : row.supplierId;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }

      // Look up supplier metadata in a single query — only for supplierIds
      // that actually appear in this itinerary's items.
      const supplierIds = [...buckets.keys()].filter((k) => k !== null);
      const supplierMap = new Map();
      if (supplierIds.length > 0) {
        const rows = await prisma.travelSupplier.findMany({
          where: {
            id: { in: supplierIds },
            tenantId: req.travelTenant.id,
          },
          select: {
            id: true,
            name: true,
            supplierCategory: true,
            contactPerson: true,
            phone: true,
            email: true,
          },
        });
        for (const s of rows) supplierMap.set(s.id, s);
      }

      function rollupFor(supplierId, rows) {
        let totalSupplierCost = 0;
        let totalGst = 0;
        let totalSalePrice = 0;
        const itemTypeSet = new Set();
        const lineItems = [];
        for (const r of rows) {
          const unit = r.unitCost != null ? Number(r.unitCost) : 0;
          const gst = r.gstAmount != null ? Number(r.gstAmount) : 0;
          const sale = r.totalPrice != null ? Number(r.totalPrice) : 0;
          totalSupplierCost += unit;
          totalGst += gst;
          totalSalePrice += sale;
          itemTypeSet.add(r.itemType);
          lineItems.push({
            id: r.id,
            itemType: r.itemType,
            description: r.description,
            unitCost: r.unitCost != null ? round2(unit) : null,
            gstAmount: r.gstAmount != null ? round2(gst) : null,
            totalPrice: r.totalPrice != null ? round2(sale) : null,
          });
        }
        const supplierCost = round2(totalSupplierCost);
        const gstTotal = round2(totalGst);
        const sale = round2(totalSalePrice);
        const marginTotal = round2(sale - supplierCost - gstTotal);
        // marginPct null when sale=0 to avoid div-zero / Infinity.
        const marginPct = sale > 0 ? round2((marginTotal / sale) * 100) : null;
        const supplier = supplierId != null ? supplierMap.get(supplierId) : null;
        return {
          supplierId,
          supplierName: supplier ? supplier.name : (supplierId == null ? "Unassigned" : "Unknown supplier"),
          supplierCategory: supplier ? supplier.supplierCategory : null,
          contactPerson: supplier ? supplier.contactPerson : null,
          phone: supplier ? supplier.phone : null,
          email: supplier ? supplier.email : null,
          itemCount: rows.length,
          itemTypes: [...itemTypeSet].sort(),
          totalSupplierCost: supplierCost,
          totalGst: gstTotal,
          totalSalePrice: sale,
          marginTotal,
          marginPct,
          items: lineItems,
        };
      }

      const suppliers = [];
      let unassigned = null;
      for (const [supplierId, rows] of buckets.entries()) {
        const rollup = rollupFor(supplierId, rows);
        if (supplierId == null) {
          unassigned = rollup;
        } else {
          suppliers.push(rollup);
        }
      }
      // Stable order: assigned suppliers sorted by descending sale price
      // (operator wants the biggest spend up top), tiebreak by supplierId asc.
      suppliers.sort((a, b) => {
        if (b.totalSalePrice !== a.totalSalePrice) return b.totalSalePrice - a.totalSalePrice;
        return a.supplierId - b.supplierId;
      });

      // Grand totals span assigned + unassigned (operator's view of the
      // whole itinerary's PO surface).
      const allRollups = unassigned ? [...suppliers, unassigned] : suppliers;
      const grandSupplierCost = round2(
        allRollups.reduce((s, r) => s + r.totalSupplierCost, 0),
      );
      const grandGst = round2(allRollups.reduce((s, r) => s + r.totalGst, 0));
      const grandSalePrice = round2(
        allRollups.reduce((s, r) => s + r.totalSalePrice, 0),
      );
      const grandMargin = round2(grandSalePrice - grandSupplierCost - grandGst);
      const grandMarginPct = grandSalePrice > 0
        ? round2((grandMargin / grandSalePrice) * 100)
        : null;

      res.json({
        itineraryId: itin.id,
        supplierCount: suppliers.length,
        suppliers,
        unassigned,
        grandTotals: {
          supplierCost: grandSupplierCost,
          gst: grandGst,
          salePrice: grandSalePrice,
          marginTotal: grandMargin,
          marginPct: grandMarginPct,
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] supplier-rollup error:", e.message);
      res.status(500).json({ error: "Failed to compute supplier rollup" });
    }
  },
);

// GET /api/travel/itineraries/:id/versions
//
// #907 slice 9 — read-side companion to the PUT-creates-new-version flow.
// PUT /:id creates a new Itinerary row with parentItineraryId pointing at
// the chain root + version bumped. Operators need a one-call read to see
// the full revision history; without this they'd have to issue N findOne
// calls or query Prisma directly.
//
// Semantics:
//   - Resolves the chain root: original.parentItineraryId || original.id.
//     The "root" is itself the v1 row; all subsequent versions point at it.
//   - Returns ALL siblings (including the root) sorted by version asc.
//   - Per-version payload is intentionally lean — id, version, status,
//     destination, totalAmount, currency, itemCount, createdAt, updatedAt,
//     isRoot, isLatest. The full item list lives behind GET /:id; this
//     endpoint is the index, not the detail.
//   - Item counts are computed in a single groupBy ($queryRaw-free) so
//     the route stays O(1) regardless of chain length.
//   - Tenant guard + sub-brand check are inherited from
//     loadItineraryWithGuard — 401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED.
//
// Response shape:
//   {
//     itineraryId: <id requested>,
//     chainRootId: <id of v1>,
//     versionCount: N,
//     latestVersionId: <id of most-recent>,
//     versions: [
//       { id, version, status, destination, totalAmount, currency,
//         itemCount, createdAt, updatedAt, isRoot, isLatest },
//       ...
//     ],
//   }
//
// PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §5.1 (Versioning).
router.get("/itineraries/:id/versions", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);

    // Resolve chain root — the row whose id equals the parent pointer of
    // every later version. The original PUT handler uses the same logic.
    const original = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, parentItineraryId: true },
    });
    if (!original) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    const chainRootId = original.parentItineraryId || original.id;

    // Fetch the full chain in a single query — root + every sibling that
    // points at the root via parentItineraryId.
    const rows = await prisma.itinerary.findMany({
      where: {
        tenantId: req.travelTenant.id,
        OR: [{ id: chainRootId }, { parentItineraryId: chainRootId }],
      },
      orderBy: { version: "asc" },
      select: {
        id: true,
        version: true,
        status: true,
        destination: true,
        totalAmount: true,
        currency: true,
        parentItineraryId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Per-version item counts in a single groupBy keyed on itineraryId.
    // Empty chain → no groupBy call (Prisma will happily run it, but
    // skipping is cheaper and keeps the response symmetrical when the
    // chain is single-row).
    const ids = rows.map((r) => r.id);
    const counts = new Map();
    if (ids.length > 0) {
      const grouped = await prisma.itineraryItem.groupBy({
        by: ["itineraryId"],
        where: { itineraryId: { in: ids } },
        _count: { _all: true },
      });
      for (const g of grouped) counts.set(g.itineraryId, g._count?._all || 0);
    }

    // Latest = highest version (rows are version-asc, so last entry).
    // Stable when versions are unique; ties are not expected (PUT bumps
    // by 1 each time) but defaulted-by-id-asc just in case.
    const latestVersionId = rows.length > 0 ? rows[rows.length - 1].id : null;

    const versions = rows.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      destination: r.destination,
      totalAmount: r.totalAmount != null ? Number(r.totalAmount) : null,
      currency: r.currency,
      itemCount: counts.get(r.id) || 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      isRoot: r.id === chainRootId,
      isLatest: r.id === latestVersionId,
    }));

    res.json({
      itineraryId: itin.id,
      chainRootId,
      versionCount: versions.length,
      latestVersionId,
      versions,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] versions error:", e.message);
    res.status(500).json({ error: "Failed to fetch version chain" });
  }
});

// GET /api/travel/itineraries/:id/cost-breakdown.csv
//
// #907 slice 13 — downloadable spreadsheet view of the per-day cost
// breakdown. The JSON sibling `GET /:id/day-costs` (slice 2 + slice 5)
// returns the same numbers; this endpoint streams them as CSV so
// operators can paste into a quote sheet, email to finance, or open in
// Excel without round-tripping through the UI export-button cycle.
//
// Columns (one row per day):
//   dayOffset, itemCount, totalCost, supplierCost, markupTotal,
//   gstTotal, marginTotal, marginPct
// plus a trailing TOTAL row spanning the trip.
//
// Half-up rounding inherited from computeDayCosts. marginTotal =
// totalCost - supplierCost - gstTotal (mirrors the supplier-rollup
// margin identity so the two reports reconcile). marginPct is blank
// (not "Infinity") when totalCost = 0.
//
// CSV escape rules per RFC 4180: numeric cells unquoted; the empty
// marginPct cell stays empty (no double-quote pair). Header line
// matches the column list above exactly.
//
// Filename: `itinerary-<id>-cost-breakdown.csv` — pinned shape so
// frontend tests can assert Content-Disposition without parsing.
//
// Sub-path placement is BEFORE any `/:id` catch-all (Express ordering
// rule). The `.csv` suffix is a literal route token — Express treats
// `/cost-breakdown.csv` as a single static segment, no extension
// detection needed.
//
// Tenant + sub-brand guard delegated to loadItineraryWithGuard — same
// 401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts as siblings.
//
// PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §5.3 (Analytics export)
// + §3.6(d) (pricing transparency).
router.get(
  "/itineraries/:id/cost-breakdown.csv",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const full = await prisma.itinerary.findFirst({
        where: { id: itin.id, tenantId: req.travelTenant.id },
        select: { id: true, startDate: true },
      });
      if (!full) {
        return res
          .status(404)
          .json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
      }

      const items = await prisma.itineraryItem.findMany({
        where: { itineraryId: full.id },
        orderBy: { position: "asc" },
      });

      let tripStart;
      if (req.query.tripStart) {
        const overrideDate = new Date(String(req.query.tripStart));
        if (Number.isFinite(overrideDate.getTime())) {
          tripStart = overrideDate;
        }
      }
      if (!tripStart && full.startDate) tripStart = new Date(full.startDate);

      // Map ItineraryItem → helper input shape (same projection as
      // the JSON day-costs endpoint — keeps the two surfaces in lockstep).
      const helperItems = items.map((row) => {
        let details = {};
        if (row.detailsJson) {
          try {
            details = JSON.parse(row.detailsJson);
          } catch {
            /* malformed → fall through */
          }
        }
        const cost =
          row.totalPrice != null
            ? Number(row.totalPrice)
            : row.unitCost != null
              ? Number(row.unitCost)
              : 0;
        const mapped = {
          id: row.id,
          itemType: row.itemType,
          description: row.description,
          cost,
          unitCost: row.unitCost != null ? Number(row.unitCost) : null,
          markup: row.markup != null ? Number(row.markup) : 0,
          gstAmount: row.gstAmount != null ? Number(row.gstAmount) : 0,
        };
        if (typeof details.dayOffset === "number") mapped.dayOffset = details.dayOffset;
        else if (typeof details.dayNumber === "number") mapped.dayNumber = details.dayNumber;
        else if (details.date) mapped.date = details.date;
        return mapped;
      });

      const result = computeDayCosts(helperItems, tripStart ? { tripStart } : {});

      // Half-up to 2dp — matches helper's internal rounding so the two
      // surfaces stay byte-identical for the same input.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      const header = [
        "dayOffset",
        "itemCount",
        "totalCost",
        "supplierCost",
        "markupTotal",
        "gstTotal",
        "marginTotal",
        "marginPct",
      ];
      const lines = [header.join(",")];

      for (const day of result.days) {
        const margin = round2(day.totalCost - day.supplierCost - day.gstTotal);
        const marginPct =
          day.totalCost > 0 ? round2((margin / day.totalCost) * 100) : null;
        lines.push(
          [
            day.dayOffset,
            day.itemCount,
            round2(day.totalCost),
            round2(day.supplierCost),
            round2(day.markupTotal),
            round2(day.gstTotal),
            margin,
            marginPct == null ? "" : marginPct,
          ].join(","),
        );
      }

      // Grand-total trailer — operators paste this into the bottom of
      // their quote sheet without re-summing.
      const grandMargin = round2(
        result.grandTotal - result.grandSupplierCost - result.grandGstTotal,
      );
      const grandMarginPct =
        result.grandTotal > 0
          ? round2((grandMargin / result.grandTotal) * 100)
          : null;
      const totalItemCount = result.days.reduce((s, d) => s + d.itemCount, 0);
      lines.push(
        [
          "TOTAL",
          totalItemCount,
          round2(result.grandTotal),
          round2(result.grandSupplierCost),
          round2(result.grandMarkupTotal),
          round2(result.grandGstTotal),
          grandMargin,
          grandMarginPct == null ? "" : grandMarginPct,
        ].join(","),
      );

      const csv = lines.join("\n") + "\n";
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=itinerary-${full.id}-cost-breakdown.csv`,
      );
      res.send(csv);
    } catch (e) {
      if (e.status) {
        if (e.code === "NOT_FOUND") {
          return res
            .status(404)
            .json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
        }
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-itin] cost-breakdown-csv error:", e.message);
      res.status(500).json({ error: "Failed to export cost breakdown CSV" });
    }
  },
);

// ─── Aggregation rollup (#907 slice 14) ─────────────────────────────
//
// GET /api/travel/itineraries/:id/totals
//
// Pure read-only aggregation over ItineraryItem rows for one itinerary.
// Returns counts + money sums bucketed by itemType plus grand totals.
// Sibling to the day-costs (#907 slice 2) + supplier-rollup (#907
// slice 7) endpoints — those slice the same row set by day and by
// supplier respectively; this one slices by itemType.
//
// Query params:
//   - itemType (optional) — restrict aggregation to a single itemType.
//     Unknown values return 400 INVALID_ITEM_TYPE. The byItemType
//     envelope STILL contains all 6 keys (the non-matching ones stay
//     zero-filled) so the consumer-side rendering shape is stable.
//
// Tenant + sub-brand guard via loadItineraryWithGuard (same as the
// other item-level endpoints — inherits the 401 / 403 SUB_BRAND_DENIED
// / 404 NOT_FOUND envelope shape).
//
// Money rounding: half-up to 2dp via Number.EPSILON (idiom shared
// across the rest of the file).
//
// Response shape (stable):
//   {
//     itineraryId,
//     totalItems,
//     grand: { totalUnitCost, totalMarkup, totalGstAmount, totalPrice },
//     byItemType: {
//       flight:    { count, totalUnitCost, totalMarkup, totalGstAmount, totalPrice },
//       hotel:     { ... },
//       transfer:  { ... },
//       activity:  { ... },
//       visa:      { ... },
//       insurance: { ... }
//     }
//   }
//
// Refs docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3.
router.get("/itineraries/:id/totals", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);

    // Optional itemType filter — unknown values reject up front.
    let typeFilter = null;
    if (req.query.itemType !== undefined) {
      const t = String(req.query.itemType);
      if (!VALID_ITEM_TYPES.includes(t)) {
        return res.status(400).json({
          error: `itemType must be one of: ${VALID_ITEM_TYPES.join(", ")}`,
          code: "INVALID_ITEM_TYPE",
        });
      }
      typeFilter = t;
    }

    const where = { itineraryId: itin.id };
    if (typeFilter) where.itemType = typeFilter;

    const items = await prisma.itineraryItem.findMany({
      where,
      select: {
        itemType: true,
        unitCost: true,
        markup: true,
        gstAmount: true,
        totalPrice: true,
      },
    });

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const toNum = (v) => (v == null ? 0 : Number(v));

    // Zero-fill all 6 buckets up-front so the response shape is stable
    // even when an itinerary has zero items of a given type.
    const byItemType = {};
    for (const t of VALID_ITEM_TYPES) {
      byItemType[t] = {
        count: 0,
        totalUnitCost: 0,
        totalMarkup: 0,
        totalGstAmount: 0,
        totalPrice: 0,
      };
    }

    let totalUnitCost = 0;
    let totalMarkup = 0;
    let totalGstAmount = 0;
    let totalPrice = 0;

    for (const row of items) {
      const u = toNum(row.unitCost);
      const m = toNum(row.markup);
      const g = toNum(row.gstAmount);
      const p = toNum(row.totalPrice);
      const bucket = byItemType[row.itemType];
      // Defensive — if a row somehow carries an itemType outside
      // VALID_ITEM_TYPES (schema enum widened later, mock drift, etc.)
      // skip it rather than spread money into a non-existent bucket.
      if (!bucket) continue;
      bucket.count += 1;
      bucket.totalUnitCost += u;
      bucket.totalMarkup += m;
      bucket.totalGstAmount += g;
      bucket.totalPrice += p;
      totalUnitCost += u;
      totalMarkup += m;
      totalGstAmount += g;
      totalPrice += p;
    }

    // Round all money fields half-up to 2dp; counts stay integer.
    for (const t of VALID_ITEM_TYPES) {
      const b = byItemType[t];
      b.totalUnitCost = round2(b.totalUnitCost);
      b.totalMarkup = round2(b.totalMarkup);
      b.totalGstAmount = round2(b.totalGstAmount);
      b.totalPrice = round2(b.totalPrice);
    }

    res.json({
      itineraryId: itin.id,
      totalItems: items.length,
      grand: {
        totalUnitCost: round2(totalUnitCost),
        totalMarkup: round2(totalMarkup),
        totalGstAmount: round2(totalGstAmount),
        totalPrice: round2(totalPrice),
      },
      byItemType,
    });
  } catch (e) {
    if (e.status) {
      if (e.code === "NOT_FOUND") {
        return res
          .status(404)
          .json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
      }
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[travel-itin] totals error:", e.message);
    res.status(500).json({ error: "Failed to compute itinerary totals" });
  }
});

// ─── S113 (2026-06-11): the FR-3.6/S14-S46 POST /itineraries/suggest
// handler that previously lived here has been removed. PR #1142 added a
// NEW POST /itineraries/suggest handler higher in this file (FR-3.4 path,
// "Suggest itinerary" wired through llmRouter) that Express dispatches
// first-match-wins — making the original block unreachable dead code.
//
// The new canonical contract is pinned by:
//   - e2e/tests/travel-itinerary-suggest-api.spec.js (PR #1142 sibling)
//   - the FR-3.4 handler block earlier in this file
//
// The structured-JSON suggestionJson shape is produced inline in the
// FR-3.4 handler above (S120 removed a prototype service module that
// duplicated this logic — dead code). The canonical alive LLM service
// pattern is now tmcDiagnosticPrompts + marketingFlyerCopyLLM /
// marketingFlyerImageLLM. Real-mode swap is gated on CREDS_TRACKER
// Q-IT-2 (Gemini key).

// POST /api/travel/itineraries/from-suggestion
//
// S90 — PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6 step (d). Operator
// has used POST /itineraries/suggest to brainstorm; this endpoint
// materialises the accepted suggestion into a real `Itinerary` row +
// `ItineraryItem` children. Transactional — either everything lands or
// nothing does (no half-baked itineraries left behind on a mid-stream
// item insert failure).
//
// USER+ gate (every travel sales operator). PRD §4.1 diagnostic-first
// guard applies: the contact must have a completed diagnostic for the
// chosen sub-brand or 403 DIAGNOSTIC_REQUIRED comes back.
//
// Request body:
//   {
//     suggestionJson: {                            // REQUIRED — output of /suggest
//       daySplit?: [ {                             // FR-3.4 handler emits `daySplit`
//         dayNumber: int,                          //   (canonical key)
//         theme?: string,
//         items: [ { itemType, description,
//                    estimatedCost?, latitude?,
//                    longitude?, suggestedSupplierName? }, ... ]
//       }, ... ],
//       days?: [ {...same shape...} ],             // Accepted alias for forward-
//                                                  //   compat with the prompt's
//                                                  //   `suggestionJson.days[]`
//                                                  //   wording.
//       summary?: string,                          // Used as itinerary.name
//                                                  //   default if no name given.
//       thematicNotes?: string,
//     },
//     contactId: int,                              // REQUIRED — see SHAPE-DRIFT
//                                                  //   below; schema makes
//                                                  //   contactId NON-NULL.
//     subBrand?: string,                           // Optional; defaults from the
//                                                  //   contact's accessible
//                                                  //   sub-brand if missing.
//     destination?: string,                        // Optional; defaults from
//                                                  //   suggestionJson.summary
//                                                  //   or 'Suggested itinerary'.
//   }
//
// Response 201:
//   {
//     itinerary: { id, ..., items: [...] },
//     itemsCreated: int,
//     daysProcessed: int,
//   }
//
// Errors:
//   400 INVALID_SUGGESTION_JSON  — missing / not-object / no day array
//   400 INVALID_DAY              — day missing dayNumber or items
//   400 ITEM_MISSING_NAME        — item missing name/description
//   400 INVALID_ITEM_TYPE        — item itemType outside VALID_ITEM_TYPES
//   400 CONTACT_ID_REQUIRED      — contactId not provided (schema gap below)
//   400 INVALID_CONTACT_ID       — contactId not a positive int
//   400 INVALID_SUB_BRAND        — subBrand outside enum
//   403 SUB_BRAND_DENIED         — caller lacks sub-brand access
//   403 DIAGNOSTIC_REQUIRED      — PRD §4.1 guard
//   404 CONTACT_NOT_FOUND        — cross-tenant contact lookup
//   500 ITINERARY_MATERIALISE_FAILED
//
// SHAPE DRIFT (prompt vs schema vs service):
//   - Prompt body says `contactId` is optional. Prisma schema says
//     `Itinerary.contactId Int` (not nullable). To avoid orphan-create
//     attempts that die at the DB layer with an opaque P2003, this route
//     ENFORCES contactId as required + returns CONTACT_ID_REQUIRED 400.
//     This is consistent with the canonical POST /itineraries route.
//   - Prompt says items come from `suggestionJson.days[]`. The FR-3.4
//     handler emits `suggestionJson.daySplit[]`. We accept both keys
//     (daySplit takes precedence) so the prompt's example works AND the
//     production pipeline works.
//   - Service items shape uses `description` + `itemType` (NOT `name`).
//     We treat `name` OR `description` as the source; whichever is set
//     becomes ItineraryItem.description (which is required per schema).
//   - Service items can supply `estimatedCost` (number); we map to
//     ItineraryItem.unitCost. quantity defaults to 1, totalPrice computed
//     via computeItemLineTotal.
router.post(
  "/itineraries/from-suggestion",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const { suggestionJson, contactId, subBrand, destination } = req.body || {};

      // 1. suggestionJson validation
      if (
        !suggestionJson
        || typeof suggestionJson !== "object"
        || Array.isArray(suggestionJson)
      ) {
        return res.status(400).json({
          error: "suggestionJson required (must be an object)",
          code: "INVALID_SUGGESTION_JSON",
        });
      }
      // Accept both `daySplit` (service-emitted) and `days` (prompt-named).
      const days = Array.isArray(suggestionJson.daySplit)
        ? suggestionJson.daySplit
        : Array.isArray(suggestionJson.days)
          ? suggestionJson.days
          : null;
      if (!days || days.length === 0) {
        return res.status(400).json({
          error: "suggestionJson.daySplit (or .days) must be a non-empty array",
          code: "INVALID_SUGGESTION_JSON",
        });
      }

      // 2. contactId validation — REQUIRED at the route layer (schema gap;
      //    see SHAPE DRIFT note above).
      if (contactId == null || contactId === "") {
        return res.status(400).json({
          error: "contactId required",
          code: "CONTACT_ID_REQUIRED",
        });
      }
      const cid = parseInt(contactId, 10);
      if (!Number.isFinite(cid) || cid < 1) {
        return res.status(400).json({
          error: "contactId must be a positive integer",
          code: "INVALID_CONTACT_ID",
        });
      }

      // 3. Verify contact belongs to caller's tenant. Cross-tenant → 404
      //    (not 403) so we don't leak the existence of other tenants' rows.
      const contact = await prisma.contact.findFirst({
        where: { id: cid, tenantId: req.travelTenant.id },
        select: { id: true },
      });
      if (!contact) {
        return res.status(404).json({
          error: "Contact not found",
          code: "CONTACT_NOT_FOUND",
        });
      }

      // 4. subBrand validation (optional but enum-validated when present).
      let effectiveSubBrand = subBrand;
      if (effectiveSubBrand) {
        assertValidSubBrand(effectiveSubBrand);
      } else {
        // Default to the operator's first accessible sub-brand when omitted.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (allowed instanceof Set && allowed.size > 0) {
          effectiveSubBrand = [...allowed][0];
        } else {
          // No access set narrowing (ADMIN) — fall through to 'travelstall'
          // as a sane default matching the other create paths' habit.
          effectiveSubBrand = "travelstall";
        }
      }

      // 5. Sub-brand access check (mirrors POST /itineraries).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, effectiveSubBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      // 6. PRD §4.1 diagnostic-first guard (mirrors POST /itineraries).
      await assertCompletedDiagnostic(prisma, req.travelTenant.id, cid, effectiveSubBrand);

      // 7. Flatten days/items into ItineraryItem rows with up-front
      //    validation so any bad row rejects before the transaction opens.
      const itemRows = [];
      let position = 0;
      for (let dIdx = 0; dIdx < days.length; dIdx += 1) {
        const day = days[dIdx];
        if (!day || typeof day !== "object") {
          return res.status(400).json({
            error: `day[${dIdx}] must be an object`,
            code: "INVALID_DAY",
          });
        }
        const dayNumber = day.dayNumber != null
          ? parseInt(day.dayNumber, 10)
          : dIdx + 1;
        if (!Number.isFinite(dayNumber) || dayNumber < 1) {
          return res.status(400).json({
            error: `day[${dIdx}].dayNumber must be a positive integer`,
            code: "INVALID_DAY",
          });
        }
        const dayItems = Array.isArray(day.items) ? day.items : null;
        if (!dayItems) {
          return res.status(400).json({
            error: `day[${dIdx}].items must be an array`,
            code: "INVALID_DAY",
          });
        }

        for (let iIdx = 0; iIdx < dayItems.length; iIdx += 1) {
          const src = dayItems[iIdx];
          if (!src || typeof src !== "object") {
            return res.status(400).json({
              error: `day[${dIdx}].items[${iIdx}] must be an object`,
              code: "ITEM_MISSING_NAME",
            });
          }
          // Accept either `name` (prompt wording) or `description` (service
          // shape). Whichever is present becomes ItineraryItem.description.
          const desc = (src.description != null && String(src.description).trim() !== "")
            ? String(src.description)
            : (src.name != null && String(src.name).trim() !== "")
              ? String(src.name)
              : null;
          if (!desc) {
            return res.status(400).json({
              error: `day[${dIdx}].items[${iIdx}] missing name/description`,
              code: "ITEM_MISSING_NAME",
            });
          }
          // itemType defaults to 'activity' when absent (service-emitted
          // items always set it; user-supplied days[] from the prompt
          // example may not).
          const itemType = src.itemType ? String(src.itemType) : "activity";
          assertValidItemType(itemType);

          // Map cost: service uses `estimatedCost`; the create route uses
          // `unitCost`. Either is acceptable from the suggestion source.
          const unitCost = src.unitCost != null && src.unitCost !== ""
            ? Number(src.unitCost)
            : (src.estimatedCost != null && src.estimatedCost !== "")
              ? Number(src.estimatedCost)
              : null;

          // Lat/lng pass-through (Float? in schema).
          const latitude = (src.latitude != null && src.latitude !== "")
            ? Number(src.latitude)
            : (src.lat != null && src.lat !== "")
              ? Number(src.lat)
              : null;
          const longitude = (src.longitude != null && src.longitude !== "")
            ? Number(src.longitude)
            : (src.lng != null && src.lng !== "")
              ? Number(src.lng)
              : null;

          // notes pass-through — into detailsJson as { notes, suggestedSupplierName? }
          const detailsObj = {};
          if (src.notes != null && String(src.notes).trim() !== "") {
            detailsObj.notes = String(src.notes);
          }
          if (src.suggestedSupplierName != null
            && String(src.suggestedSupplierName).trim() !== "") {
            detailsObj.suggestedSupplierName = String(src.suggestedSupplierName);
          }
          if (src.durationMinutes != null && src.durationMinutes !== "") {
            const dm = Number(src.durationMinutes);
            if (Number.isFinite(dm) && dm >= 0) detailsObj.durationMinutes = dm;
          }
          if (src.locationName != null && String(src.locationName).trim() !== "") {
            detailsObj.locationName = String(src.locationName);
          }

          const itemRow = {
            itemType,
            position,
            description: desc,
            detailsJson: Object.keys(detailsObj).length > 0
              ? JSON.stringify(detailsObj)
              : null,
            unitCost,
            quantity: 1,
            markup: null,
            gstAmount: null,
            unit: "per_person",
            dayNumber,
            latitude: Number.isFinite(latitude) ? latitude : null,
            longitude: Number.isFinite(longitude) ? longitude : null,
            // G051 — items materialised on this path are LLM-drafted by
            // contract. PRD FR-3.4.h asks for a provenance flag on each item
            // so the editor can render an "AI-drafted" badge. Items created
            // via POST /itineraries or POST /:id/items default to false; only
            // this materialise path sets true.
            draftedByAi: true,
            totalPrice: computeItemLineTotal({
              unitCost,
              quantity: 1,
              markup: null,
              gstAmount: null,
            }),
          };
          itemRows.push(itemRow);
          position += 1;
        }
      }

      // 8. Resolve productTier default from latest diagnostic (PRD §6.4 —
      //    mirrors POST /itineraries).
      const latest = await findLatestDiagnostic(
        prisma,
        req.travelTenant.id,
        cid,
        effectiveSubBrand,
      );
      const productTier = (latest && latest.recommendedTier) || null;

      // 9. Resolve destination — body > suggestionJson.summary > placeholder.
      //    The `destination` column is VARCHAR(191); cap to 190 on EVERY
      //    branch. The summary fallback in particular is the LLM's multi-
      //    paragraph prose, which overflowed the column (Column: destination
      //    "value too long") when the client didn't pass an explicit
      //    destination. Clients should send `destination`; this is the guard.
      const effectiveDestination = (destination && String(destination).trim() !== "")
        ? String(destination).trim().slice(0, 190)
        : (suggestionJson.summary && String(suggestionJson.summary).trim() !== "")
          ? String(suggestionJson.summary).trim().slice(0, 190)
          : "Suggested itinerary";

      // 10. Transactional create — Itinerary + ItineraryItem rows in one
      //     shot via Prisma's nested create. Atomic by Prisma's contract.
      const itinerary = await prisma.itinerary.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: effectiveSubBrand,
          contactId: cid,
          status: "draft",
          productTier,
          destination: effectiveDestination,
          currency: "INR",
          totalAmount: itemRows.reduce(
            (s, it) => s + (Number.isFinite(it.totalPrice) ? Number(it.totalPrice) : 0),
            0,
          ),
          items: itemRows.length > 0 ? { create: itemRows } : undefined,
        },
        include: { items: { orderBy: { position: "asc" } } },
      });

      // 11. Audit-log emission. PRD FR-3.6 (d) needs to be traceable when
      //     an operator materialises an LLM suggestion into committed rows.
      try {
        await writeAudit(
          "Itinerary",
          "itinerary.materialised-from-suggestion",
          itinerary.id,
          req.user.userId,
          req.travelTenant.id,
          {
            subBrand: effectiveSubBrand,
            contactId: cid,
            daysProcessed: days.length,
            itemsCreated: itemRows.length,
            destination: effectiveDestination,
            summarySource: !!suggestionJson.summary,
          },
        );
      } catch (auditErr) {
        // Audit failure is non-fatal — itinerary has landed; log + move on.
        console.error("[travel-itin] materialise audit failed:", auditErr.message);
      }

      // Notify the customer — a materialised suggestion is a customer-visible
      // draft offer, same as a hand-built create.
      if (["draft", "sent", "revised"].includes(itinerary.status)) notifyCustomerTrip(itinerary, "sent");

      return res.status(201).json({
        itinerary,
        itemsCreated: itemRows.length,
        daysProcessed: days.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] materialise error:", e.message);
      return res.status(500).json({
        error: "Failed to materialise itinerary from suggestion",
        code: "ITINERARY_MATERIALISE_FAILED",
      });
    }
  },
);

module.exports = router;
// Exposed for tests/smokes — the customer-portal notification emitter used by
// every itinerary-create + revise + payment path.
module.exports.notifyCustomerTrip = notifyCustomerTrip;
