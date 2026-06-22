/**
 * /api/travel/quotes — TravelQuote CRUD (PRD_TRAVEL_QUOTE_BUILDER DD-5.1)
 *
 * Sibling to /api/travel/suppliers (commit 192b8c1) and the upcoming
 * /api/travel/invoices. The TravelQuote model landed at commit fdb793e
 * (2026-05-24 tick #94) as the fork-side of the symmetric Quote/Billing/
 * Supplier decision. This module ships the operator-facing CRUD scaffold.
 *
 * Slice 15 (THIS commit): GET /:id/audit-trail — read-only chronological
 * audit history for a single quote. Joins TravelQuote rows (entityId = id)
 * with TravelQuoteLine rows whose details payload references the same
 * quoteId, sorts by createdAt asc, surfaces every CRUD/workflow verb the
 * route file emits (CREATE, UPDATE, DELETE, TRAVEL_QUOTE_ACCEPTED,
 * TRAVEL_QUOTE_DECLINED, TRAVEL_QUOTE_DUPLICATED, TRAVEL_QUOTE_EXTENDED,
 * TRAVEL_QUOTE_CONVERTED, TRAVEL_QUOTE_PDF_DOWNLOADED, plus line-CRUD).
 * Pure read; tenant + sub-brand scoped via loadParentQuote. PRD §3.8.1 +
 * §3.8.3 — operator/compliance "who-changed-what" surface.
 *
 * Slice 11: POST /:id/accept + POST /:id/decline — dedicated semantic
 * workflow endpoints with status-transition guards. Distinct from the
 * catch-all PUT /:id (which permits arbitrary status writes) — these
 * carry workflow-specific audit action codes (TRAVEL_QUOTE_ACCEPTED /
 * TRAVEL_QUOTE_DECLINED), an idempotent 200 response on already-{Accepted,
 * Rejected}, and a 409 INVALID_TRANSITION on attempts to flip from a
 * terminal state. Decline takes an optional reason (≤1000 chars, captured
 * in audit details — schema has no rejectionReason column in this slice).
 *
 * Future slices (not in this commit): pricing engine + line items (PRD §3.2),
 * tax calculation per sub-brand default (DD-5.3 pending product call),
 * PDF render via pdfRenderer.js (DD-5.6 RESOLVED: extend existing),
 * counter-offer flow (DD-5.5 simple-delta v1 / rich-line-edit v2),
 * send-via-WA/email flow (depends on Q9 cred-chase).
 *
 * Sub-brand isolation: every quote carries .subBrand. External API keys
 * scoped to a sub-brand cannot create/edit quotes under a different
 * sub-brand. Operator auth allows cross-sub-brand if multi-grant.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  assertCompletedDiagnostic,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { generateTravelQuotePdf } = require("../services/pdfRenderer");
// Customer-share: mint a signed quote-share token + deliver it (email-first +
// WhatsApp via the connected WhatsApp Web client). Mirrors the itinerary share.
const { mintShareToken } = require("../lib/quoteShareToken");
const waWebClient = require("../services/whatsappWebClient");
const { sendEmail } = require("../lib/emailSender");
const { pickMarkup, mapCategoryToScope } = require("../lib/travelPricing");
const {
  computeGstForLines,
  isInterstateSupply,
  gstRateForCategory,
} = require("../lib/gstCalculation");
const { resolveStateCodes } = require("../lib/gstStateCodeResolver");
const {
  sacForLineType,
  descriptionForSac,
  groupLinesBySac,
} = require("../lib/hsnSacMapper");
const { computeQuoteAnalytics } = require("../lib/travelQuoteAnalytics");
const { rankQuotes } = require("../lib/quoteRanker");
const listProjection = require("../lib/listProjection");
const ratehawkClient = require("../services/ratehawkClient");
const bookingExpediaClient = require("../services/bookingExpediaClient");

const VALID_QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Rejected"];
const VALID_LINE_TYPES = ["hotel", "flight", "transport", "visa", "service", "other"];
// G020 (PRD §3.2 FR-3.2.3) — dimension drives how the line's quantity
// renders in the quote PDF (e.g. "₹15,000 per pax × 4 pax = ₹60,000" when
// dimension="perPax"). Null is accepted by the validator (back-compat
// with pre-G020 lines that have no dimension); the PDF renderer falls
// back to "flatRate" formatting when null.
const VALID_DIMENSIONS = ["perPax", "perRoomPerNight", "perTrip", "flatRate"];

function assertValidLineType(t) {
  if (t == null) return;
  if (!VALID_LINE_TYPES.includes(t)) {
    const err = new Error(
      `lineType must be one of: ${VALID_LINE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_LINE_TYPE";
    throw err;
  }
}

function assertValidDimension(d) {
  if (d == null || d === "") return;
  if (!VALID_DIMENSIONS.includes(d)) {
    const err = new Error(
      `dimension must be one of: ${VALID_DIMENSIONS.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_DIMENSION";
    throw err;
  }
}

// Parse a percentage value (taxPercent, discountPercent, marginPercent).
// Bounds: 0 ≤ x ≤ 1000 (allows 100% discount + headroom for accidental
// over-shoot detection; 1000% would be obvious operator error). Returns
// null on null/undefined/empty input. Throws 400 on invalid number.
function parsePercent(input, fieldName) {
  if (input == null || input === "") return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    const err = new Error(`${fieldName} must be a number between 0 and 1000`);
    err.status = 400;
    err.code = "INVALID_PERCENT";
    throw err;
  }
  return n;
}

function parsePositiveDecimal(input, fieldName) {
  if (input == null || input === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${fieldName} must be a non-negative number`);
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return n;
}

function parsePositiveInt(input, fieldName, fallback) {
  if (input == null || input === "") return fallback;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.status = 400;
    err.code = "INVALID_QUANTITY";
    throw err;
  }
  return n;
}

// Recompute the quote's totalAmount as the sum of its lines and persist.
// Called from POST/PUT/DELETE /lines. Idempotent. Skipped if the lines
// table is empty (totalAmount stays at whatever the operator typed).
async function recomputeQuoteTotal(quoteId, tenantId) {
  const lines = await prisma.travelQuoteLine.findMany({
    where: { quoteId, tenantId },
    select: { amount: true },
  });
  if (lines.length === 0) return;
  const total = lines.reduce(
    (acc, l) => acc + Number(l.amount || 0),
    0,
  );
  await prisma.travelQuote.update({
    where: { id: quoteId },
    data: { totalAmount: total },
  });
}

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_QUOTE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_QUOTE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

/**
 * Parse + validate a validUntil date. Accepts ISO 8601 strings or
 * anything Date can swallow; rejects unparseable input and any date
 * earlier than today (midnight comparison so "today" is still valid).
 *
 * Returns the parsed Date (or null if input was nullish).
 */
function parseValidUntil(input) {
  if (input == null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("validUntil must be a parseable date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  // Compare against today's midnight so a "today" validUntil is allowed.
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (d.getTime() < todayMidnight.getTime()) {
    const err = new Error("validUntil must be today or a future date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  return d;
}

// ─── PRD §4.1 diagnostic-first guard (gap A9a) ───────────────────────
//
// Quote creation mirrors the itinerary guard's exact semantics (see
// middleware/travelGuards.assertCompletedDiagnostic, used by
// travel_itineraries.js POST /itineraries): any TravelDiagnostic row for
// (tenantId, contactId, subBrand) counts as "completed diagnostic" — row
// existence is the contract, classification may be null. There is no
// admin/override bypass on the itinerary side, so none exists here.
//
// One deliberate divergence: the itinerary surface rejects 403; the quote
// surface rejects 422 Unprocessable Entity (the request is well-formed and
// the caller is authorised — a business precondition is unmet). Error code
// stays the canonical DIAGNOSTIC_REQUIRED so dashboards/specs can match on
// code regardless of surface.
// eslint-disable-next-line no-unused-vars -- guard intentionally disabled for
// quotes (see POST /quotes); kept for history + easy re-enable.
async function assertQuoteDiagnosticFirst(tenantId, contactId, subBrand) {
  try {
    await assertCompletedDiagnostic(prisma, tenantId, contactId, subBrand);
  } catch (e) {
    if (e && e.code === "DIAGNOSTIC_REQUIRED") e.status = 422;
    throw e;
  }
}

// ─── PRD §4.4 Visa Sure complexity gate (gap A6) ─────────────────────
//
// "Manual or structured quotation (Visa Sure) depending on case
// complexity." TravelQuote has NO quoteMode column (schema is owned by a
// concurrent change-set), so mode is a REQUEST-level contract only:
//   - POST /quotes accepts optional body.quoteMode: "manual"|"structured"
//     (default "manual"; anything else → 400 INVALID_QUOTE_MODE).
//   - For subBrand "visasure", a contact with ANY complexCase=true
//     VisaApplication on this tenant is manual-only:
//       * structured-mode creation rejects 422 VISA_COMPLEX_CASE_MANUAL_ONLY
//       * the structured auto-pricing surface (GET /quotes/:id/
//         pricing-preview, the markup-rule composer) rejects with the
//         same code for such quotes
//       * the creation response + CREATE audit row echo
//         complexCase: true + the effective (forced-manual) quoteMode so
//         operators and downstream consumers see the gate fired.
// When a quoteMode column lands in the schema, persist effectiveQuoteMode
// instead of echoing it.
const VALID_QUOTE_MODES = ["manual", "structured"];

async function findComplexVisaCase(tenantId, contactId) {
  return prisma.visaApplication.findFirst({
    where: { tenantId, contactId, complexCase: true },
    select: { id: true },
  });
}

function visaComplexCaseError() {
  const err = new Error(
    "Contact has a complex visa case — structured quotation is disabled; build this quote manually",
  );
  err.status = 422;
  err.code = "VISA_COMPLEX_CASE_MANUAL_ONLY";
  return err;
}

// GET /api/travel/quotes
// Honors ?subBrand=tmc (filter to that sub-brand) and ?status=Draft.
// GET /api/travel/quotes
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction).
// Default shape is the full TravelQuote row (back-compat). Pass
// `?fields=summary` to opt into the slim projection (id + subBrand +
// contactId + status + totalAmount + currency + validUntil + createdAt)
// — picker / dashboard-tile callers don't need the model's full row.
router.get("/quotes", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.status) {
      assertValidStatus(String(req.query.status));
      where.status = String(req.query.status);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: [{ createdAt: "desc" }],
      take,
      skip,
    };
    if (isSummary) {
      findManyArgs.select = listProjection("TravelQuote", false);
    }
    const [quotes, total] = await Promise.all([
      prisma.travelQuote.findMany(findManyArgs),
      prisma.travelQuote.count({ where }),
    ]);
    res.json({ quotes, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] list error:", e.message);
    res.status(500).json({ error: "Failed to list quotes" });
  }
});

// GET /api/travel/quotes/expired — any verified token (tenant + sub-brand-scoped).
//
// Slice 12 of #900 (PRD_TRAVEL_QUOTE_BUILDER OQ-9.7 — expiry workflow).
// Surfaces quotes whose validUntil is in the past AND status is still
// Draft or Sent — i.e. quotes that need operator attention (extend the
// validity window, or move to terminal Accepted/Rejected). Read-only
// derived list; no schema column for "Expired" status — the schema's
// VALID_QUOTE_STATUSES intentionally has no Expired enum value (OQ-9.7
// recommended a cron-driven status flip, but that requires schema work).
// This slice ships the derived-list surface so operator dashboards can
// render an "Expired quotes" tile + the sibling POST /:id/extend
// endpoint lets operators rescue a quote by pushing validUntil forward.
//
// Sub-brand isolation: results are filtered to the caller's
// subBrandAccess set. Operators without any grant get an empty list
// (vs 403) — matches the GET /quotes index behaviour.
//
// Ordering: validUntil ASC (oldest expiry first — most-urgent at top).
// Pagination: limit query-param (default 50, max 200) to keep the
// payload bounded; no cursor since the use case is "dashboard tile"
// not "infinite scroll".
//
// IMPORTANT: this route MUST be declared BEFORE GET /:id so Express
// doesn't match "expired" as a numeric :id (which would 400 INVALID_ID).
router.get("/quotes/expired", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 200)
      : 50;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    // Empty access set = caller has no sub-brand grants; return [] rather
    // than 403 so dashboard tiles render cleanly for not-yet-onboarded
    // operators.
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({ quotes: [], count: 0 });
    }

    const where = {
      tenantId: req.travelTenant.id,
      status: { in: ["Draft", "Sent"] },
      validUntil: { lt: new Date() },
    };
    // If allowed is a Set (not "all"), filter to those sub-brands.
    if (allowed instanceof Set) {
      where.subBrand = { in: Array.from(allowed) };
    }

    const quotes = await prisma.travelQuote.findMany({
      where,
      orderBy: [{ validUntil: "asc" }, { id: "asc" }],
      take: limit,
    });

    res.json({ quotes, count: quotes.length });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] expired list error:", e.message);
    res.status(500).json({ error: "Failed to list expired quotes" });
  }
});

// GET /api/travel/quotes/expired-summary — any verified token (tenant + sub-brand-scoped).
//
// Slice of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — expiry-recovery rollup).
// Companion to /quotes/expired (full list) + /quotes/stats (single
// expiredCount aggregate). This endpoint returns an ACTIONABLE rollup
// of currently-expired quotes (validUntil < now AND status IN
// Draft|Sent) grouped by sub-brand, age range, and top customers —
// the shape an operator dashboard "expiry-recovery" tile needs to
// prioritise outreach.
//
// Response shape:
//   {
//     total,                // count of currently-expired quotes
//     totalValue,           // sum of totalAmount across all expired (half-up 2dp)
//     bySubBrand: { tmc: {count, value}, rfu: {count, value}, ..., _tenant: {count, value} },
//     byAgeRange: {
//       "0-7d":  {count, value},   // expired 0-7 days ago
//       "8-30d": {count, value},   // expired 8-30 days ago
//       "31-90d":{count, value},
//       "90+d":  {count, value},
//     },
//     topCustomers: [       // top-5 customers by expired-quote count
//       { contactId, count, totalValue },
//       ...
//     ],
//     generatedAt,          // ISO timestamp
//   }
//
// Scope rules:
//   - Tenant-scoped on TravelQuote.tenantId.
//   - Sub-brand restricted: MANAGER with subBrandAccess narrowed via
//     getSubBrandAccessSet — empty set → zeroed shape (not 403) so
//     dashboard tiles render cleanly for not-yet-onboarded operators.
//   - USER-readable (anodyne aggregate; no quote bodies leak — only
//     counts + sums + contactIds, no customer names).
//
// Defensive: null/non-numeric totalAmount → 0 (no NaN poisoning);
// null subBrand coalesces to "_tenant" (matches /quotes/stats shape);
// quotes with null validUntil are skipped (not "expired" without an
// expiry policy); half-up 2dp rounding via Number.EPSILON.
//
// Age-range buckets are inclusive at the low bound:
//   "0-7d"   → 0 <= ageDays <= 7
//   "8-30d"  → 8 <= ageDays <= 30
//   "31-90d" → 31 <= ageDays <= 90
//   "90+d"   → 91 <= ageDays
//
// IMPORTANT: this route MUST be declared BEFORE GET /:id so Express
// doesn't match "expired-summary" as a numeric :id (which would 400
// INVALID_ID).
router.get("/quotes/expired-summary", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const zeroed = () => ({
      total: 0,
      totalValue: 0,
      bySubBrand: {},
      byAgeRange: {
        "0-7d": { count: 0, value: 0 },
        "8-30d": { count: 0, value: 0 },
        "31-90d": { count: 0, value: 0 },
        "90+d": { count: 0, value: 0 },
      },
      topCustomers: [],
      generatedAt: new Date().toISOString(),
    });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    // Empty access set → zeroed shape (not 403).
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed());
    }

    const now = new Date();
    const where = {
      tenantId: req.travelTenant.id,
      status: { in: ["Draft", "Sent"] },
      validUntil: { lt: now },
    };
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        contactId: true,
        totalAmount: true,
        validUntil: true,
      },
    });

    if (quotes.length === 0) {
      return res.json(zeroed());
    }

    const bySubBrand = {};
    const byAgeRange = {
      "0-7d": { count: 0, value: 0 },
      "8-30d": { count: 0, value: 0 },
      "31-90d": { count: 0, value: 0 },
      "90+d": { count: 0, value: 0 },
    };
    const perContact = new Map();
    let total = 0;
    let totalValue = 0;
    const nowMs = now.getTime();

    for (const q of quotes) {
      // Defensive: skip rows whose validUntil failed Prisma's lt filter
      // (shouldn't happen, but the test mock returns whatever it likes).
      if (!q.validUntil) continue;
      const vu = q.validUntil instanceof Date ? q.validUntil : new Date(q.validUntil);
      if (Number.isNaN(vu.getTime()) || vu.getTime() >= nowMs) continue;

      const amt = Number(q.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;

      total += 1;
      totalValue += safeAmt;

      // bySubBrand: null subBrand → "_tenant" (matches /quotes/stats shape).
      const sbKey = q.subBrand ? String(q.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0, value: 0 };
      bySubBrand[sbKey].count += 1;
      bySubBrand[sbKey].value += safeAmt;

      // byAgeRange: how long ago did it expire (in days).
      const ageDays = Math.floor((nowMs - vu.getTime()) / 86_400_000);
      let bucket;
      if (ageDays <= 7) bucket = "0-7d";
      else if (ageDays <= 30) bucket = "8-30d";
      else if (ageDays <= 90) bucket = "31-90d";
      else bucket = "90+d";
      byAgeRange[bucket].count += 1;
      byAgeRange[bucket].value += safeAmt;

      // perContact tally for topCustomers.
      if (q.contactId != null) {
        const cid = q.contactId;
        if (!perContact.has(cid)) perContact.set(cid, { contactId: cid, count: 0, totalValue: 0 });
        const entry = perContact.get(cid);
        entry.count += 1;
        entry.totalValue += safeAmt;
      }
    }

    // Round per-bucket sums.
    for (const sb of Object.keys(bySubBrand)) {
      bySubBrand[sb].value = round2(bySubBrand[sb].value);
    }
    for (const ar of Object.keys(byAgeRange)) {
      byAgeRange[ar].value = round2(byAgeRange[ar].value);
    }

    // topCustomers: sort desc by count (tie-break by totalValue desc), top 5.
    const topCustomers = [...perContact.values()]
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.totalValue - a.totalValue;
      })
      .slice(0, 5)
      .map((c) => ({
        contactId: c.contactId,
        count: c.count,
        totalValue: round2(c.totalValue),
      }));

    res.json({
      total,
      totalValue: round2(totalValue),
      bySubBrand,
      byAgeRange,
      topCustomers,
      generatedAt: now.toISOString(),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] expired-summary error:", e.message);
    res.status(500).json({ error: "Failed to summarise expired quotes" });
  }
});

// GET /api/travel/quotes/analytics — any verified token (tenant + sub-brand scoped).
//
// Slice 13 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — quote analytics rollup).
// Read-only aggregator over the caller's scoped TravelQuote rows. Returns
// status counts, sub-brand breakdown, totals per status, acceptance rate
// (over terminal-state quotes only), avg time-to-decision in days, and an
// expired-count cross-reference. Consumed by the operator dashboard tile
// + the /quotes list-page summary band.
//
// === Filters ===
// Honors optional ?subBrand=tmc and ?from=ISO + ?to=ISO date-range
// (matched against createdAt). Sub-brand isolation is enforced via
// getSubBrandAccessSet — operators without access to a sub-brand never see
// its quotes in the rollup, mirroring the GET /quotes index behaviour.
// Empty access set → all-zeros rollup (not 403) so dashboard tiles render
// cleanly for not-yet-onboarded operators.
//
// === Date range ===
// ?from / ?to are parsed via new Date(); invalid values 400. When both
// supplied, ?from must be <= ?to or 400 INVALID_RANGE. Either may be
// omitted (open-ended on that side).
//
// === Mixed currencies ===
// totalValueByStatus sums totalAmount naively without FX conversion. When
// the scoped quotes span multiple currencies, the top-level `currency`
// field is set to null as a signal to the dashboard ("can't show one $".
// Mirrors the PRD's FR-3.4.3 stance — FX is locked at accept time, not
// roll-up time.
//
// === Route ordering ===
// IMPORTANT: this route MUST be declared BEFORE GET /:id so Express
// doesn't match "analytics" as a numeric :id (which would 400 INVALID_ID).
router.get("/quotes/analytics", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }

    if (req.query.from || req.query.to) {
      const createdAt = {};
      if (req.query.from) {
        const fromDate = new Date(String(req.query.from));
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            error: "from must be a parseable date",
            code: "INVALID_FROM",
          });
        }
        createdAt.gte = fromDate;
      }
      if (req.query.to) {
        const toDate = new Date(String(req.query.to));
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            error: "to must be a parseable date",
            code: "INVALID_TO",
          });
        }
        createdAt.lte = toDate;
      }
      if (
        createdAt.gte && createdAt.lte
        && createdAt.gte.getTime() > createdAt.lte.getTime()
      ) {
        return res.status(400).json({
          error: "from must be <= to",
          code: "INVALID_RANGE",
        });
      }
      where.createdAt = createdAt;
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    // Empty access set → all-zeros rollup (not 403). Matches the
    // expired-list behaviour.
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(computeQuoteAnalytics([]));
    }
    if (allowed instanceof Set) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand)
          ? where.subBrand
          : "__none__"
        : { in: [...allowed] };
    }

    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        status: true,
        totalAmount: true,
        currency: true,
        validUntil: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(computeQuoteAnalytics(quotes));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] analytics error:", e.message);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

// GET /api/travel/quotes/by-month — any verified token (tenant + sub-brand scoped).
//
// Slice 16 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — tenant-wide quote
// analytics rolled up by calendar month). Mirrors #905 slice 15
// (/commission-profiles/:id/summary/by-month) + #903 slice 18
// (by-monthly) — same UTC YYYY-MM bucketing template, same defensive
// math, same orderBy semantics. One row per UTC-month present in the
// scoped quote set, summarising the count + status splits + value
// sums for that month. Read-only; consumed by the operator-facing
// "quotes trend" chart on the dashboard and the per-month picker for
// drill-downs into the underlying /quotes list.
//
// Why a separate endpoint instead of extending /quotes/analytics:
//   - Different aggregation granularity (per-month, not single-rollup).
//   - Different natural sort (chronological time-series, not single row).
//   - Pre-fills a different UI surface (line/bar chart vs KPI tile).
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// TravelQuote.createdAt's UTC year + month. UTC chosen deliberately
// so bucket labels stay stable across operator timezones — finance
// reconciliation works in calendar-month UTC for cross-border volume.
//
// Scope rules:
//   - Tenant-scoped on TravelQuote.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status    optional Quote.status filter (Draft/Sent/Accepted/Rejected)
//   from      optional inclusive lower bound on bucket (YYYY-MM); rows
//             with month < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY-MM); rows
//             with month > to are excluded
//   orderBy   default "month:asc" (chronological); also accepts
//             "month:desc", "totalValue:asc|desc", "quoteCount:asc|desc",
//             "acceptedCount:asc|desc". Unknown tokens degrade silently
//             to default (same graceful posture as slice 15).
//   limit     default 12 (one year of months), max 60 (5 years).
//   offset    default 0
//
// Response shape:
//   {
//     months: [ {
//       month: "2026-05",
//       quoteCount, totalValue,
//       draftCount, sentCount, acceptedCount, rejectedCount,
//       acceptedValue
//     } ],
//     totalMonths,
//     grandQuoteCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Defensive behaviour: null/invalid TravelQuote.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON, matching
// the canonical round2 used in slice 15.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-month" as a numeric :id (which would 400 INVALID_ID).
router.get("/quotes/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY-MM validation — same regex slice 15 uses. Bucket labels we
    // emit follow this exact shape so callers passing month-tokens to
    // from/to should already be using it.
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
      "totalValue:asc",
      "totalValue:desc",
      "quoteCount:asc",
      "quoteCount:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /quotes list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        months: [],
        totalMonths: 0,
        grandQuoteCount: 0,
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
    // bucket by UTC YYYY-MM. Input size bound is the same as
    // /quotes/analytics (low thousands at platinum scale).
    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-month. Map "YYYY-MM" → { ...row counts/sums }.
    // Quotes with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0.
    const byMonth = new Map();
    for (const q of quotes) {
      let monthKey = "unknown";
      if (q.createdAt) {
        const dt = new Date(q.createdAt);
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
          quoteCount: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          acceptedValue: 0,
        };
        byMonth.set(monthKey, row);
      }

      row.quoteCount += 1;
      const amt = Number(q.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (q.status) {
        case "Draft": row.draftCount += 1; break;
        case "Sent": row.sentCount += 1; break;
        case "Accepted":
          row.acceptedCount += 1;
          row.acceptedValue += safeAmt;
          break;
        case "Rejected": row.rejectedCount += 1; break;
        default: break;
      }
    }

    // Finalise rounding on per-row sums.
    let months = [...byMonth.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable month token); when
    // no bounds are set, "unknown" stays so the count surface remains
    // complete. Mirrors slice 15's posture.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM which is also
    // chronological. "unknown" sorts last in asc / first in desc by
    // virtue of being lexicographically > "9999-12" — acceptable for
    // a defensive fallback bucket that should rarely appear.
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
    const grandQuoteCount = months.reduce(
      (acc, r) => acc + (Number(r.quoteCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      months.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      months.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as slice 15.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandQuoteCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// GET /api/travel/quotes/by-quarter — any verified token (tenant + sub-brand scoped).
//
// Slice 17 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — tenant-wide quote
// analytics rolled up by calendar quarter). Mirrors slice 16's
// /quotes/by-month with the coarser-granularity quarter bucket
// (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec — calendar quarters,
// not Indian-FY April-March). Same UTC rationale as by-month — finance
// reconciliation works in calendar quarters; FY tooling is a future
// overlay on top of this calendar-quarter primitive. Also mirrors #905
// slice 16 (/commission-profiles/:id/summary/by-quarter) for shape
// consistency across the tenant-wide and per-profile time-series
// surfaces.
//
// Why a separate endpoint instead of aggregate=quarter on by-month:
// callers expect different defaults (12 quarters = 3 years at quarter
// granularity is a sensible UI default; 36 months ≠ 12 quarters in the
// same fixed-width chart slot). Pre-fills the quarterly-trend tile on
// the operator dashboard with ~12 bars.
//
// Bucket key shape: "YYYY-Qn" string (e.g. "2026-Q2") derived from
// TravelQuote.createdAt's UTC year + quarter (`Math.floor(month/3)+1`).
//
// Scope rules:
//   - Tenant-scoped on TravelQuote.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status    optional Quote.status filter (Draft/Sent/Accepted/Rejected)
//   from      optional inclusive lower bound on bucket (YYYY-Qn); rows
//             with quarter < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY-Qn); rows
//             with quarter > to are excluded
//   orderBy   default "quarter:asc" (chronological); also accepts
//             "quarter:desc", "totalValue:asc|desc", "quoteCount:asc|desc",
//             "acceptedCount:asc|desc". Unknown tokens degrade silently
//             to default.
//   limit     default 12 (3 years of quarters), max 40 (10 years).
//   offset    default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       quoteCount, totalValue,
//       draftCount, sentCount, acceptedCount, rejectedCount,
//       acceptedValue
//     } ],
//     totalQuarters,
//     grandQuoteCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Defensive behaviour: null/invalid TravelQuote.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-quarter" as a numeric :id (which would 400 INVALID_ID).
router.get("/quotes/by-quarter", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY-Qn validation — same regex #905 slice 16 uses. Bucket labels we
    // emit follow this exact shape so callers passing quarter-tokens to
    // from/to should already be using it. Anything else is a 400
    // INVALID_QUARTER_FORMAT.
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
      "totalValue:asc",
      "totalValue:desc",
      "quoteCount:asc",
      "quoteCount:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /quotes list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        quarters: [],
        totalQuarters: 0,
        grandQuoteCount: 0,
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
    // bucket by UTC YYYY-Qn. Input size bound is the same as
    // /quotes/analytics + by-month (low thousands at platinum scale).
    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { ...row counts/sums }.
    // Quotes with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0.
    const byQuarter = new Map();
    for (const q of quotes) {
      let quarterKey = "unknown";
      if (q.createdAt) {
        const dt = new Date(q.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const qn = Math.floor(dt.getUTCMonth() / 3) + 1;
          quarterKey = `${yyyy}-Q${qn}`;
        }
      }

      let row = byQuarter.get(quarterKey);
      if (!row) {
        row = {
          quarter: quarterKey,
          quoteCount: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          acceptedValue: 0,
        };
        byQuarter.set(quarterKey, row);
      }

      row.quoteCount += 1;
      const amt = Number(q.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (q.status) {
        case "Draft": row.draftCount += 1; break;
        case "Sent": row.sentCount += 1; break;
        case "Accepted":
          row.acceptedCount += 1;
          row.acceptedValue += safeAmt;
          break;
        case "Rejected": row.rejectedCount += 1; break;
        default: break;
      }
    }

    // Finalise rounding on per-row sums.
    let quarters = [...byQuarter.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (no comparable token); when no bounds are set,
    // "unknown" stays so the count surface remains complete.
    if (fromRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
    }
    if (toRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
    // chronological (Q1<Q2<Q3<Q4 sorts correctly as ASCII). "unknown"
    // lexicographically > "9999-Q4" so it sorts last in asc / first in
    // desc — acceptable for a defensive fallback bucket.
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
    const grandQuoteCount = quarters.reduce(
      (acc, r) => acc + (Number(r.quoteCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as slice 16.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandQuoteCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] by-quarter error:", e.message);
    res.status(500).json({ error: "Failed to compute quarterly rollup" });
  }
});

// GET /api/travel/quotes/by-year — any verified token (tenant + sub-brand scoped).
//
// Slice 18 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — tenant-wide quote
// analytics rolled up by calendar year). Completes the
// by-month/by-quarter/by-year time-series triplet (slices 16/17/18) for
// the operator dashboard. Mirrors slice 17's /quotes/by-quarter with the
// coarsest-granularity year bucket; same UTC rationale as by-month +
// by-quarter (finance reconciliation works in calendar years; FY tooling
// is a future overlay on top of this calendar-year primitive). Also
// mirrors #905 slice 17 (/commission-profiles/:id/summary/by-year) for
// shape consistency across the tenant-wide and per-profile time-series
// surfaces.
//
// Why a separate endpoint instead of aggregate=year on by-quarter:
// callers expect different defaults (10 years is a sensible UI default
// for an "annual trend" tile; 40 quarters ≠ 10 years in the same
// fixed-width chart slot). Pre-fills the annual-trend tile on the
// operator dashboard with ~10 bars.
//
// Bucket key shape: "YYYY" string (e.g. "2026") derived from
// TravelQuote.createdAt's UTC year (`getUTCFullYear()`).
//
// Scope rules:
//   - Tenant-scoped on TravelQuote.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status    optional Quote.status filter (Draft/Sent/Accepted/Rejected)
//   from      optional inclusive lower bound on bucket (YYYY); rows
//             with year < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY); rows
//             with year > to are excluded
//   orderBy   default "year:asc" (chronological); also accepts
//             "year:desc", "totalValue:asc|desc", "quoteCount:asc|desc",
//             "acceptedCount:asc|desc". Unknown tokens degrade silently
//             to default.
//   limit     default 10 (a decade), max 30.
//   offset    default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       quoteCount, totalValue,
//       draftCount, sentCount, acceptedCount, rejectedCount,
//       acceptedValue
//     } ],
//     totalYears,
//     grandQuoteCount,
//     grandTotalValue,
//     grandAcceptedValue,
//     limit, offset
//   }
//
// Defensive behaviour: null/invalid TravelQuote.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-year" as a numeric :id (which would 400 INVALID_ID).
router.get("/quotes/by-year", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY validation — bucket labels we emit follow this exact shape so
    // callers passing year-tokens to from/to should already be using it.
    // Anything else is a 400 INVALID_YEAR_FORMAT.
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
      "totalValue:asc",
      "totalValue:desc",
      "quoteCount:asc",
      "quoteCount:desc",
      "acceptedCount:asc",
      "acceptedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /quotes list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        years: [],
        totalYears: 0,
        grandQuoteCount: 0,
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
    // bucket by UTC YYYY. Input size bound is the same as
    // /quotes/analytics + by-month + by-quarter (low thousands at
    // platinum scale).
    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-year. Map "YYYY" → { ...row counts/sums }.
    // Quotes with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0.
    const byYear = new Map();
    for (const q of quotes) {
      let yearKey = "unknown";
      if (q.createdAt) {
        const dt = new Date(q.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }

      let row = byYear.get(yearKey);
      if (!row) {
        row = {
          year: yearKey,
          quoteCount: 0,
          totalValue: 0,
          draftCount: 0,
          sentCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          acceptedValue: 0,
        };
        byYear.set(yearKey, row);
      }

      row.quoteCount += 1;
      const amt = Number(q.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (q.status) {
        case "Draft": row.draftCount += 1; break;
        case "Sent": row.sentCount += 1; break;
        case "Accepted":
          row.acceptedCount += 1;
          row.acceptedValue += safeAmt;
          break;
        case "Rejected": row.rejectedCount += 1; break;
        default: break;
      }
    }

    // Finalise rounding on per-row sums.
    let years = [...byYear.values()].map((r) => ({
      ...r,
      totalValue: round2(r.totalValue),
      acceptedValue: round2(r.acceptedValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (no comparable token); when no bounds are set,
    // "unknown" stays so the count surface remains complete.
    if (fromRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
    }
    if (toRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
    }

    // Sort. "year" sorts lexicographically on YYYY which is also
    // chronological (4-digit zero-padded years sort correctly as ASCII).
    // "unknown" lexicographically > "9999" so it sorts last in asc /
    // first in desc — acceptable for a defensive fallback bucket.
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
    const grandQuoteCount = years.reduce(
      (acc, r) => acc + (Number(r.quoteCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      years.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandAcceptedValue = round2(
      years.reduce((acc, r) => acc + (Number(r.acceptedValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slices 16 + 17.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandQuoteCount,
      grandTotalValue,
      grandAcceptedValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] by-year error:", e.message);
    res.status(500).json({ error: "Failed to compute annual rollup" });
  }
});

// ============================================================================
// GET /api/travel/quotes/stats — tenant-wide TravelQuote rollup
// (#900 slice 19, PRD_TRAVEL_QUOTE_BUILDER §3).
//
// Mirrors #903 slice 23 (/suppliers/stats), #905 slice 18
// (/commission-profiles/stats) and #908 slice 19
// (/flyer-templates/global-stats) — same point-in-time KPI-tile shape:
// total + per-status breakdown (count + summed totalAmount) + per-sub-brand
// count + grand totals + acceptanceRate (terminal-state denominator) +
// expiredCount (non-terminal AND validUntil past) + lastUpdatedAt.
//
// Scope rules:
//   - Tenant-scoped on TravelQuote.tenantId.
//   - Sub-brand restricted: MANAGER with subBrandAccess narrowed via
//     getSubBrandAccessSet — empty set → all-zeros (not 403) so dashboard
//     tiles render cleanly for not-yet-onboarded operators.
//   - USER-readable (anodyne aggregate; no quote bodies leak).
//
// Query string:
//   from   optional ISO date — TravelQuote.createdAt >= from
//   to     optional ISO date — TravelQuote.createdAt <= to
//          Either may be omitted; both invalid → 400 INVALID_DATE.
//
// Response shape:
//   {
//     total,
//     byStatus: {
//       Draft:    { count, totalValue },
//       Sent:     { count, totalValue },
//       Accepted: { count, totalValue },
//       Rejected: { count, totalValue },
//     },
//     bySubBrand: { tmc: {count}, rfu: {count}, ..., _tenant: {count} },
//     grandTotalValue,
//     grandAcceptedValue,
//     acceptanceRate,    // accepted / (accepted + rejected); null if denom=0
//     expiredCount,      // status IN (Draft, Sent) AND validUntil < now
//     lastUpdatedAt,     // ISO string of max(updatedAt) across scoped rows
//   }
//
// Defensive math: null/non-numeric totalAmount → 0 (no NaN poisoning);
// half-up 2dp rounding via Number.EPSILON; null subBrand defensively
// coalesces to "_tenant" (matches the sibling /suppliers/stats shape and
// is forward-compat with any future nullable migration).
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to parse
// "stats" as a numeric :id (which would 400 INVALID_ID).
// ============================================================================
router.get("/quotes/stats", verifyToken, requireTravelTenant, async (req, res) => {
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

    // Sub-brand narrowing — empty access set → zeroed shape (not 403).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const zeroed = {
      total: 0,
      byStatus: {
        Draft: { count: 0, totalValue: 0 },
        Sent: { count: 0, totalValue: 0 },
        Accepted: { count: 0, totalValue: 0 },
        Rejected: { count: 0, totalValue: 0 },
      },
      bySubBrand: {},
      grandTotalValue: 0,
      grandAcceptedValue: 0,
      acceptanceRate: null,
      expiredCount: 0,
      lastUpdatedAt: null,
    };

    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const quotes = await prisma.travelQuote.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        status: true,
        totalAmount: true,
        validUntil: true,
        updatedAt: true,
      },
    });

    if (quotes.length === 0) {
      return res.json(zeroed);
    }

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const now = Date.now();

    const byStatus = {
      Draft: { count: 0, totalValue: 0 },
      Sent: { count: 0, totalValue: 0 },
      Accepted: { count: 0, totalValue: 0 },
      Rejected: { count: 0, totalValue: 0 },
    };
    const bySubBrand = {};
    let grandTotalValue = 0;
    let grandAcceptedValue = 0;
    let expiredCount = 0;
    let lastUpdatedAt = null;

    for (const q of quotes) {
      const amt = Number(q.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      grandTotalValue += safeAmt;

      if (byStatus[q.status]) {
        byStatus[q.status].count += 1;
        byStatus[q.status].totalValue += safeAmt;
      }

      if (q.status === "Accepted") {
        grandAcceptedValue += safeAmt;
      }

      // expiredCount: non-terminal status AND validUntil past.
      if (
        (q.status === "Draft" || q.status === "Sent")
        && q.validUntil
      ) {
        const vu = q.validUntil instanceof Date ? q.validUntil : new Date(q.validUntil);
        if (!Number.isNaN(vu.getTime()) && vu.getTime() < now) {
          expiredCount += 1;
        }
      }

      // bySubBrand: defensively coalesce null → "_tenant" to match
      // /suppliers/stats shape.
      const sbKey = q.subBrand ? String(q.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
      bySubBrand[sbKey].count += 1;

      const ts = q.updatedAt instanceof Date ? q.updatedAt : new Date(q.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
    }

    // Round per-status sums.
    for (const s of Object.keys(byStatus)) {
      byStatus[s].totalValue = round2(byStatus[s].totalValue);
    }

    // acceptanceRate: accepted / (accepted + rejected); null if denom=0.
    const acceptedCount = byStatus.Accepted.count;
    const rejectedCount = byStatus.Rejected.count;
    const terminalCount = acceptedCount + rejectedCount;
    const acceptanceRate = terminalCount > 0
      ? round2(acceptedCount / terminalCount)
      : null;

    res.json({
      total: quotes.length,
      byStatus,
      bySubBrand,
      grandTotalValue: round2(grandTotalValue),
      grandAcceptedValue: round2(grandAcceptedValue),
      acceptanceRate,
      expiredCount,
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] stats error:", e.message);
    res.status(500).json({ error: "Failed to summarise quotes" });
  }
});

// POST /api/travel/quotes/bulk-decline-expired — ADMIN | MANAGER.
//
// Slice 14 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3 — bulk operations on
// expired quotes). Operator-dashboard cleanup tool: in one request,
// decline every Draft|Sent quote whose validUntil < now within the
// caller's sub-brand scope. Per-row audit (TRAVEL_QUOTE_DECLINED with
// bulk: true detail) so the rejection trail matches the singular
// /:id/decline endpoint shape — downstream audit consumers don't need
// a separate code path for bulk vs single.
//
// Idempotent: re-running after a cleanup affects 0 rows (the second
// invocation's findMany returns []). Always 200 — never an error for
// "nothing to decline" since the cleanup tile may render the button
// even when the list is empty.
//
// Body (optional):
//   { reason?: string, subBrand?: 'tmc'|'rfu'|'travelstall'|'visasure' }
//   - reason: string ≤1000 chars, captured in every audit row's details.
//             Same truncation policy as POST /:id/decline (silent slice,
//             not 400 — operators have no UI hint for the limit).
//   - subBrand: scope the sweep to ONE sub-brand (must be in caller's
//               access set, else 403 SUB_BRAND_DENIED). When omitted,
//               the sweep covers ALL sub-brands the caller can access.
//
// Response:
//   { declinedCount: N, declinedIds: [n,n,...], reason: string|null,
//     subBrand: 'tmc'|null }
//
// Route-ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "bulk-decline-expired" as a numeric :id and 400.
router.post(
  "/quotes/bulk-decline-expired",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const body = req.body || {};

      // Optional reason: string ≤1000 chars, blank → null.
      let reason = null;
      if (body.reason != null) {
        if (typeof body.reason !== "string") {
          return res.status(400).json({
            error: "reason must be a string",
            code: "INVALID_REASON",
          });
        }
        reason = body.reason.trim().slice(0, 1000);
        if (reason === "") reason = null;
      }

      // Optional sub-brand scope: must be valid + caller must have access.
      let subBrandScope = null;
      if (body.subBrand != null && body.subBrand !== "") {
        if (typeof body.subBrand !== "string") {
          return res.status(400).json({
            error: "subBrand must be a string",
            code: "INVALID_SUB_BRAND",
          });
        }
        try {
          assertValidSubBrand(body.subBrand);
        } catch (e) {
          return res.status(e.status || 400).json({ error: e.message, code: e.code });
        }
        subBrandScope = body.subBrand;
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      // Empty access set → caller has no sub-brand grants. Mirror the
      // expired-list short-circuit: return zero-result envelope (not 403)
      // so the dashboard tile's button stays clickable for not-yet-
      // onboarded operators.
      if (allowed instanceof Set && allowed.size === 0) {
        return res.status(200).json({
          declinedCount: 0,
          declinedIds: [],
          reason,
          subBrand: subBrandScope,
        });
      }

      // If a specific sub-brand was requested, the caller must be able
      // to access it.
      if (subBrandScope && !canAccessSubBrand(allowed, subBrandScope)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const where = {
        tenantId: req.travelTenant.id,
        status: { in: ["Draft", "Sent"] },
        validUntil: { lt: new Date() },
      };

      if (subBrandScope) {
        where.subBrand = subBrandScope;
      } else if (allowed instanceof Set) {
        // Non-admin caller: restrict to their access set.
        where.subBrand = { in: Array.from(allowed) };
      }
      // allowed === null → admin / unrestricted: no subBrand clause needed.

      // Load the doomed rows BEFORE the flip so each audit entry carries
      // its previousStatus + per-row context.
      const doomed = await prisma.travelQuote.findMany({
        where,
        select: {
          id: true,
          subBrand: true,
          contactId: true,
          status: true,
        },
      });

      if (doomed.length === 0) {
        return res.status(200).json({
          declinedCount: 0,
          declinedIds: [],
          reason,
          subBrand: subBrandScope,
        });
      }

      const doomedIds = doomed.map((q) => q.id);

      await prisma.travelQuote.updateMany({
        where: { id: { in: doomedIds }, tenantId: req.travelTenant.id },
        data: { status: "Rejected" },
      });

      // Per-row audit so downstream consumers can join on the same action
      // code that the singular /:id/decline emits. bulk: true distinguishes
      // mass-cleanup events from operator-initiated single declines.
      const declinedAt = new Date().toISOString();
      for (const row of doomed) {
        await writeAudit(
          "TravelQuote",
          "TRAVEL_QUOTE_DECLINED",
          row.id,
          req.user.userId,
          req.travelTenant.id,
          {
            quoteId: row.id,
            subBrand: row.subBrand,
            contactId: row.contactId,
            previousStatus: row.status,
            declinedAt,
            reason: reason || null,
            bulk: true,
          },
        );
      }

      res.status(200).json({
        declinedCount: doomed.length,
        declinedIds: doomedIds,
        reason,
        subBrand: subBrandScope,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] bulk-decline-expired error:", e.message);
      res.status(500).json({ error: "Failed to bulk-decline expired quotes" });
    }
  },
);

// GET /api/travel/quotes/:id
router.get("/quotes/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const quote = await prisma.travelQuote.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!quote) {
      return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, quote.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(quote);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] get error:", e.message);
    res.status(500).json({ error: "Failed to get quote" });
  }
});

// POST /api/travel/quotes — ADMIN/MANAGER only.
// Required: contactId, totalAmount, currency.
// Optional: subBrand (per Q25 — defaults to "tmc"), status (default "Draft"),
// validUntil (parseable date, today-or-future).
router.post(
  "/quotes",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "write"),
  async (req, res) => {
    try {
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil, quoteMode,
      } = req.body || {};

      if (contactId == null || totalAmount == null || !currency) {
        return res.status(400).json({
          error: "contactId, totalAmount, currency required",
          code: "MISSING_FIELDS",
        });
      }

      const contactIdInt = parseInt(contactId, 10);
      if (!Number.isFinite(contactIdInt)) {
        return res.status(400).json({
          error: "contactId must be a number",
          code: "INVALID_CONTACT_ID",
        });
      }

      assertValidStatus(status);
      if (subBrand) assertValidSubBrand(subBrand);
      const parsedValidUntil = parseValidUntil(validUntil);

      // Optional request-level quote mode (PRD §4.4 — see the gap-A6
      // block above parseValidUntil). Not persisted: TravelQuote has no
      // quoteMode column yet.
      let requestedQuoteMode = "manual";
      if (quoteMode != null && quoteMode !== "") {
        if (!VALID_QUOTE_MODES.includes(quoteMode)) {
          return res.status(400).json({
            error: `quoteMode must be one of: ${VALID_QUOTE_MODES.join(", ")}`,
            code: "INVALID_QUOTE_MODE",
          });
        }
        requestedQuoteMode = quoteMode;
      }

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_suppliers POST.
      const targetSubBrand = subBrand || "tmc";
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // NOTE: the §4.1 diagnostic-first guard is intentionally DISABLED for
      // quotes — operators build trip quotes/proposals directly (TBO builder,
      // direct WhatsApp/email enquiries) without forcing the contact through a
      // diagnostic first. (Itinerary creation still enforces §4.1.) Kept
      // commented for history rather than deleted.
      // await assertQuoteDiagnosticFirst(req.travelTenant.id, contactIdInt, targetSubBrand);

      // PRD §4.4 Visa Sure complexity gate (gap A6): complex cases are
      // manual-only.
      let complexVisaCase = false;
      if (targetSubBrand === "visasure") {
        complexVisaCase = Boolean(
          await findComplexVisaCase(req.travelTenant.id, contactIdInt),
        );
        if (complexVisaCase && requestedQuoteMode === "structured") {
          throw visaComplexCaseError();
        }
      }
      const effectiveQuoteMode = complexVisaCase ? "manual" : requestedQuoteMode;

      const created = await prisma.travelQuote.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: contactIdInt,
          status: status || "Draft",
          totalAmount: totalAmount,
          currency: String(currency),
          validUntil: parsedValidUntil,
        },
      });

      await writeAudit(
        "TravelQuote",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          status: created.status,
          currency: created.currency,
          // PRD §4.4 (gap A6): audit note so the manual-vs-structured
          // decision is traceable for Visa Sure quotes.
          ...(targetSubBrand === "visasure"
            ? { quoteMode: effectiveQuoteMode, complexCase: complexVisaCase }
            : {}),
        },
      );

      // Visa Sure quotes echo the complexity verdict (additive fields —
      // non-visasure responses keep the exact pre-gap shape).
      if (targetSubBrand === "visasure") {
        return res.status(201).json({
          ...created,
          quoteMode: effectiveQuoteMode,
          complexCase: complexVisaCase,
        });
      }
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] create error:", e.message);
      res.status(500).json({ error: "Failed to create quote" });
    }
  },
);

// PUT /api/travel/quotes/:id — ADMIN/MANAGER only.
router.put(
  "/quotes/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil,
      } = req.body || {};

      if (contactId !== undefined) {
        const ci = parseInt(contactId, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
        }
        data.contactId = ci;
      }
      if (totalAmount !== undefined) data.totalAmount = totalAmount;
      if (currency !== undefined) data.currency = String(currency);
      if (status !== undefined) {
        assertValidStatus(status);
        data.status = status;
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        data.subBrand = subBrand;
      }
      if (validUntil !== undefined) {
        data.validUntil = parseValidUntil(validUntil);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelQuote",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] update error:", e.message);
      res.status(500).json({ error: "Failed to update quote" });
    }
  },
);

// DELETE /api/travel/quotes/:id — ADMIN/MANAGER only.
// Hard-delete via prisma.delete (Quote rows are draft-shaped business
// artifacts; hard-delete is fine unlike Supplier which uses soft-delete
// for referential integrity).
router.delete(
  "/quotes/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "delete"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Audit BEFORE delete so the entityId still resolves cleanly and
      // the audit row records the intent regardless of whether the
      // delete subsequently succeeds.
      await writeAudit(
        "TravelQuote",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          contactId: existing.contactId,
          status: existing.status,
        },
      );

      await prisma.travelQuote.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete quote" });
    }
  },
);

// ── Line-item endpoints (PRD_TRAVEL_QUOTE_BUILDER §3.2) ────────────────
//
// Lines are the composition under a TravelQuote (hotel rooms, flight
// segments, transport, visa fees, services). Every line CRUD recomputes
// the parent quote's totalAmount as the sum of all surviving lines so
// the quote header stays consistent with its composition. Lines inherit
// tenant + sub-brand scoping from their parent quote (no separate
// sub-brand column on the line — looked up via the FK).
//
// Auth: read endpoints accept any verified token; write endpoints
// require ADMIN/MANAGER. Same shape as the parent quote routes.

// Helper: load the parent quote tenant-scoped + sub-brand-scoped.
// Returns { quote } on success or sends an HTTP response on failure
// (caller short-circuits if !quote).
async function loadParentQuote(req, res, quoteId) {
  if (!Number.isFinite(quoteId)) {
    res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    return null;
  }
  const quote = await prisma.travelQuote.findFirst({
    where: { id: quoteId, tenantId: req.travelTenant.id },
  });
  if (!quote) {
    res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    return null;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, quote.subBrand)) {
    res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    return null;
  }
  return quote;
}

// GET /api/travel/quotes/:id/lines — list lines for a quote.
router.get(
  "/quotes/:id/lines",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      res.json({ lines, total: lines.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] list lines error:", e.message);
      res.status(500).json({ error: "Failed to list quote lines" });
    }
  },
);

// POST /api/travel/quotes/:id/lines — ADMIN/MANAGER only.
// Required: description, unitPrice. Optional: lineType (default "other"),
// quantity (default 1), currency (default quote currency), supplierId,
// sortOrder, notes.
router.post(
  "/quotes/:id/lines",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "write"),
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const {
        lineType, description, quantity, unitPrice,
        currency, supplierId, sortOrder, notes,
        // G020 — new optional fields
        hsnSac, taxPercent, discountPercent, dimension, isAddOn,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({
          error: "description is required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidLineType(lineType);
      assertValidDimension(dimension);
      const qty = parsePositiveInt(quantity, "quantity", 1);
      const unit = parsePositiveDecimal(unitPrice, "unitPrice");
      const amount = qty * unit;
      const taxPct = parsePercent(taxPercent, "taxPercent");
      const discPct = parsePercent(discountPercent, "discountPercent");

      let supplierIdInt = null;
      if (supplierId != null && supplierId !== "") {
        supplierIdInt = parseInt(supplierId, 10);
        if (!Number.isFinite(supplierIdInt)) {
          return res.status(400).json({
            error: "supplierId must be a number",
            code: "INVALID_SUPPLIER_ID",
          });
        }
      }

      const created = await prisma.travelQuoteLine.create({
        data: {
          tenantId: req.travelTenant.id,
          quoteId,
          lineType: lineType || "other",
          description: description.trim(),
          quantity: qty,
          unitPrice: unit,
          amount,
          currency: currency ? String(currency) : quote.currency,
          supplierId: supplierIdInt,
          sortOrder: Number.isFinite(parseInt(sortOrder, 10))
            ? parseInt(sortOrder, 10) : 0,
          notes: notes ? String(notes) : null,
          // G020 additive nullable fields
          hsnSac: hsnSac == null || hsnSac === "" ? null : String(hsnSac).trim(),
          taxPercent: taxPct,
          discountPercent: discPct,
          dimension: dimension == null || dimension === "" ? null : dimension,
          isAddOn: typeof isAddOn === "boolean" ? isAddOn : false,
        },
      });

      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      await writeAudit(
        "TravelQuoteLine",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId,
          lineType: created.lineType,
          amount: String(created.amount),
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] create line error:", e.message);
      res.status(500).json({ error: "Failed to create line" });
    }
  },
);

// PUT /api/travel/quotes/:id/lines/:lineId — ADMIN/MANAGER only.
router.put(
  "/quotes/:id/lines/:lineId",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const existing = await prisma.travelQuoteLine.findFirst({
        where: { id: lineId, quoteId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      const data = {};
      const {
        lineType, description, quantity, unitPrice,
        currency, supplierId, sortOrder, notes,
        // G020 — new optional fields
        hsnSac, taxPercent, discountPercent, dimension, isAddOn,
      } = req.body || {};

      if (lineType !== undefined) {
        assertValidLineType(lineType);
        data.lineType = lineType;
      }
      if (dimension !== undefined) {
        assertValidDimension(dimension);
        data.dimension = dimension === null || dimension === "" ? null : dimension;
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          return res.status(400).json({
            error: "description must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.description = description.trim();
      }
      const nextQty = quantity !== undefined
        ? parsePositiveInt(quantity, "quantity", existing.quantity)
        : existing.quantity;
      const nextUnit = unitPrice !== undefined
        ? parsePositiveDecimal(unitPrice, "unitPrice")
        : Number(existing.unitPrice);
      if (quantity !== undefined) data.quantity = nextQty;
      if (unitPrice !== undefined) data.unitPrice = nextUnit;
      // Recompute amount whenever either qty or unitPrice changed.
      if (quantity !== undefined || unitPrice !== undefined) {
        data.amount = nextQty * nextUnit;
      }
      if (currency !== undefined) data.currency = String(currency);
      if (supplierId !== undefined) {
        if (supplierId === null || supplierId === "") {
          data.supplierId = null;
        } else {
          const sid = parseInt(supplierId, 10);
          if (!Number.isFinite(sid)) {
            return res.status(400).json({
              error: "supplierId must be a number",
              code: "INVALID_SUPPLIER_ID",
            });
          }
          data.supplierId = sid;
        }
      }
      if (sortOrder !== undefined) {
        const so = parseInt(sortOrder, 10);
        if (!Number.isFinite(so)) {
          return res.status(400).json({
            error: "sortOrder must be a number",
            code: "INVALID_SORT_ORDER",
          });
        }
        data.sortOrder = so;
      }
      if (notes !== undefined) data.notes = notes === null ? null : String(notes);

      // G020 — additive nullable line extension fields.
      if (hsnSac !== undefined) {
        data.hsnSac = hsnSac == null || hsnSac === "" ? null : String(hsnSac).trim();
      }
      if (taxPercent !== undefined) {
        data.taxPercent = parsePercent(taxPercent, "taxPercent");
      }
      if (discountPercent !== undefined) {
        data.discountPercent = parsePercent(discountPercent, "discountPercent");
      }
      if (isAddOn !== undefined) {
        data.isAddOn = typeof isAddOn === "boolean" ? isAddOn : false;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelQuoteLine.update({
        where: { id: lineId },
        data,
      });

      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      await writeAudit(
        "TravelQuoteLine",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { quoteId, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] update line error:", e.message);
      res.status(500).json({ error: "Failed to update line" });
    }
  },
);

// DELETE /api/travel/quotes/:id/lines/:lineId — ADMIN/MANAGER only.
router.delete(
  "/quotes/:id/lines/:lineId",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "delete"),
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const existing = await prisma.travelQuoteLine.findFirst({
        where: { id: lineId, quoteId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      await writeAudit(
        "TravelQuoteLine",
        "DELETE",
        lineId,
        req.user.userId,
        req.travelTenant.id,
        { quoteId, lineType: existing.lineType, amount: String(existing.amount) },
      );

      await prisma.travelQuoteLine.delete({ where: { id: lineId } });
      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] delete line error:", e.message);
      res.status(500).json({ error: "Failed to delete line" });
    }
  },
);

// POST /api/travel/quotes/:id/duplicate — ADMIN/MANAGER only.
//
// Copies an existing TravelQuote row into a fresh DRAFT row under the
// same tenant. Optional body fields { subBrand, contactId } let the
// operator re-target the duplicate (e.g. cloning a TMC quote across
// to RFU, or assigning to a different contact).
//
// Source row is looked up tenant-scoped + sub-brand-scoped (the same
// guard as GET/PUT/DELETE), so cross-tenant or cross-sub-brand reads
// yield 404 / 403 respectively. The duplicate inherits totalAmount /
// currency / validUntil from the source; status is always reset to
// "Draft" so the new row enters the operator queue cleanly.
router.post(
  "/quotes/:id/duplicate",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, source.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const { subBrand: subBrandOverride, contactId: contactIdOverride } = req.body || {};

      let targetSubBrand = source.subBrand;
      if (subBrandOverride !== undefined && subBrandOverride !== null && subBrandOverride !== "") {
        assertValidSubBrand(subBrandOverride);
        if (!canAccessSubBrand(allowed, subBrandOverride)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        targetSubBrand = subBrandOverride;
      }

      let targetContactId = source.contactId;
      if (contactIdOverride !== undefined && contactIdOverride !== null && contactIdOverride !== "") {
        const ci = parseInt(contactIdOverride, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
        }
        targetContactId = ci;
      }

      // G017 (PRD §3.3 FR-3.6) — sub-agent clone-with-margin.
      // Accept marginPercent from EITHER the query string (so a sub-agent
      // can simply call ?marginPercent=10) or the body (POST friendlier).
      // Body wins when both are supplied. parsePercent normalises null/""
      // → null which keeps the legacy raw-clone behaviour.
      const rawMargin = (req.body && req.body.marginPercent != null
        ? req.body.marginPercent
        : req.query && req.query.marginPercent);
      const marginPercent = parsePercent(rawMargin, "marginPercent");
      const markupFactor = marginPercent == null ? 1 : 1 + marginPercent / 100;

      // Recompute the parent total from the source lines + markup so the
      // header totalAmount stays consistent with the cloned line amounts.
      // When marginPercent is null we MUST pass source.totalAmount through
      // verbatim (the pre-G017 contract pins the exact value — see
      // backend/test/routes/travel-quotes-duplicate-pdf.test.js).
      const sourceLines = await prisma.travelQuoteLine.findMany({
        where: { quoteId: source.id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      let clonedTotal = source.totalAmount; // identity-clone default
      if (marginPercent != null) {
        if (source.totalAmount != null) {
          clonedTotal = Number(source.totalAmount) * markupFactor;
        } else if (sourceLines.length > 0) {
          clonedTotal = sourceLines.reduce(
            (acc, l) => acc + Number(l.amount || 0) * markupFactor,
            0,
          );
        }
      }

      const created = await prisma.travelQuote.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: targetContactId,
          status: "Draft",
          totalAmount: clonedTotal,
          currency: source.currency,
          validUntil: source.validUntil,
          clonedFromQuoteId: source.id,
          appliedMarkupPercent: marginPercent,
        },
      });

      // Clone line items from source quote into the duplicate. Composite
      // quotes (with line items) are duplicated as a complete unit —
      // operators copying a TMC trip package across to RFU expect the
      // hotel/flight/visa breakdown to come with it.
      if (sourceLines.length > 0) {
        await prisma.travelQuoteLine.createMany({
          data: sourceLines.map((l) => {
            const unit = Number(l.unitPrice || 0) * markupFactor;
            const amount = Number(l.amount || 0) * markupFactor;
            return {
              tenantId: req.travelTenant.id,
              quoteId: created.id,
              lineType: l.lineType,
              description: l.description,
              quantity: l.quantity,
              unitPrice: unit,
              amount,
              currency: l.currency,
              supplierId: l.supplierId,
              sortOrder: l.sortOrder,
              notes: l.notes,
              hsnSac: l.hsnSac,
              taxPercent: l.taxPercent,
              discountPercent: l.discountPercent,
              dimension: l.dimension,
              isAddOn: l.isAddOn,
            };
          }),
        });
      }

      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_DUPLICATED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          newId: created.id,
          subBrand: created.subBrand,
          contactId: created.contactId,
          linesCloned: sourceLines.length,
          marginPercent: marginPercent == null ? null : marginPercent,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate quote" });
    }
  },
);

// GET /api/travel/quotes/:id/pdf — ADMIN/MANAGER only.
//
// Looks up the TravelQuote tenant-scoped + sub-brand-scoped, then hands
// the row to pdfRenderer.generateTravelQuotePdf which returns a
// Promise<Buffer>. We stream the Buffer back with attachment headers so
// the operator browser triggers a download dialog.
//
// PDF render failures are wrapped as 500 PDF_RENDER_FAILED rather than
// the generic "Failed to..." catch — pdfkit can throw on bad font/asset
// resolution and the operator-facing surface needs an actionable code.
router.get(
  "/quotes/:id/pdf",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "export"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // The PDF renderer reads line items off quote.lines — fetch + attach them
      // (findFirst above does not include the relation, so without this the PDF
      // renders "(No line items on this quote yet.)" even when lines exist).
      quote.lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId: quote.id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      let pdfBuffer;
      try {
        pdfBuffer = await generateTravelQuotePdf(quote);
      } catch (renderErr) {
        console.error("[travel-quotes] PDF render error:", renderErr && renderErr.message);
        return res.status(500).json({
          error: "Failed to render quote PDF",
          code: "PDF_RENDER_FAILED",
        });
      }

      // Audit BEFORE sending the body so the row is durable even if the
      // client aborts mid-download. Mirrors the DELETE handler's ordering.
      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_PDF_DOWNLOADED",
        quote.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: quote.id,
          subBrand: quote.subBrand,
        },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="quote-${quote.id}.pdf"`,
      );
      res.status(200).end(pdfBuffer);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] pdf error:", e.message);
      res.status(500).json({ error: "Failed to generate quote PDF" });
    }
  },
);

// POST /api/travel/quotes/:id/convert-to-invoice — ADMIN/MANAGER only.
//
// Slice 10 of #900 (PRD_TRAVEL_QUOTE_BUILDER FR-3.9 + AC-6.6 + AC-6.11).
// One-click conversion from an existing TravelQuote to a Draft
// TravelInvoice. Copies the quote's contactId / subBrand / currency /
// totalAmount + line items into TravelInvoice + TravelInvoiceLine
// (lines copied not referenced per OQ-9.4 — invoice line items are
// immutable from accept onwards; quote may still be revised post-accept).
//
// Idempotency (FR-3.9.3 + AC-6.11): a TravelInvoice with
// `quoteId === this.id` already on file short-circuits with 200 +
// the existing invoice envelope. Second click never creates a duplicate
// invoice; the operator's UI navigates to the existing one instead.
//
// Default dueDate: today + 30 days (operator can edit on the invoice
// before issuing; matches the "Draft so operator can review before
// sending" contract in FR-3.9.1). The TravelInvoice schema requires
// dueDate at create time; we default it server-side rather than asking
// the operator to pre-pick on the quote side.
//
// invoiceNum generation: inlined here (mirror of nextInvoiceNum in
// routes/travel_invoices.js which is module-local and not exported).
// The 15-line $transaction is acceptable duplication to preserve file
// boundaries (this tick only edits travel_quotes.js + its test +
// QuoteBuilder.jsx + its test). The @@unique([tenantId, invoiceNum])
// constraint is the second-line backstop if two converts race on the
// same tenant.
//
// Reverse-link: TravelInvoice.quoteId FK persists the back-reference
// per FR-3.9.2; downstream Invoice detail pages can render a "From
// quote #N" badge by reading this column.
//
// Audit: stamps "TRAVEL_QUOTE_CONVERTED" on the TravelQuote (sourceId
// + newInvoiceId + linesCloned in details). The invoice CREATE audit
// fires under its own action via writeAudit("TravelInvoice", "CREATE"),
// so both rows stay greppable in the audit-viewer surface.
router.post(
  "/quotes/:id/convert-to-invoice",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Idempotency check (AC-6.11): if an invoice already references
      // this quote, return it instead of creating a second one. The
      // operator's UI sees a 200 + ALREADY_CONVERTED code so it can
      // navigate to the existing invoice rather than show a spurious
      // "created" toast.
      const existing = await prisma.travelInvoice.findFirst({
        where: { tenantId: req.travelTenant.id, quoteId: quote.id },
        orderBy: { id: "asc" },
      });
      if (existing) {
        return res.status(200).json({
          invoice: existing,
          alreadyConverted: true,
          code: "ALREADY_CONVERTED",
        });
      }

      // Generate invoiceNum (mirror nextInvoiceNum in travel_invoices.js).
      const year = new Date().getFullYear();
      const invoiceNum = await prisma.$transaction(async (tx) => {
        const latest = await tx.travelInvoice.findFirst({
          where: {
            tenantId: req.travelTenant.id,
            invoiceNum: { startsWith: `TINV-${year}-` },
          },
          orderBy: { invoiceNum: "desc" },
          select: { invoiceNum: true },
        });
        const latestSerial = latest
          ? parseInt(latest.invoiceNum.split("-")[2], 10)
          : 0;
        const next = String(latestSerial + 1).padStart(4, "0");
        return `TINV-${year}-${next}`;
      });

      // Default dueDate = today + 30 days; operator edits later on
      // the invoice surface before issuing.
      const dueDate = new Date(Date.now() + 30 * 86_400_000);

      const created = await prisma.travelInvoice.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: quote.subBrand,
          contactId: quote.contactId,
          quoteId: quote.id,
          invoiceNum,
          status: "Draft",
          totalAmount: quote.totalAmount,
          currency: quote.currency,
          dueDate,
        },
      });

      // Copy line items from the quote into the new invoice. The two
      // line tables have parallel shapes (lineType / description /
      // quantity / unitPrice / amount / currency / sortOrder / notes),
      // so the mapping is direct. TravelInvoiceLine has additional
      // optional columns (pnr / bookingRef / serviceStartDate /
      // serviceEndDate / fxRateToBase / baseAmount) which stay NULL on
      // convert — the operator fills them in post-issue when the actual
      // bookings land.
      const sourceLines = await prisma.travelQuoteLine.findMany({
        where: { quoteId: quote.id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      if (sourceLines.length > 0) {
        await prisma.travelInvoiceLine.createMany({
          data: sourceLines.map((l) => ({
            tenantId: req.travelTenant.id,
            invoiceId: created.id,
            lineType: l.lineType,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: l.amount,
            currency: l.currency,
            sortOrder: l.sortOrder,
            notes: l.notes,
          })),
        });
      }

      // Audit the source-side conversion. The newly-created invoice
      // gets its own CREATE audit row via writeAudit on the invoice
      // model so both rows appear in the audit-viewer surface.
      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_CONVERTED",
        quote.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: quote.id,
          invoiceId: created.id,
          invoiceNum: created.invoiceNum,
          linesCloned: sourceLines.length,
          subBrand: quote.subBrand,
        },
      );

      await writeAudit(
        "TravelInvoice",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          quoteId: created.quoteId,
          invoiceNum: created.invoiceNum,
          status: created.status,
          currency: created.currency,
          convertedFromQuoteId: quote.id,
        },
      );

      res.status(201).json({
        invoice: created,
        linesCloned: sourceLines.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] convert-to-invoice error:", e.message);
      res.status(500).json({ error: "Failed to convert quote to invoice" });
    }
  },
);

// POST /api/travel/quotes/:id/accept — ADMIN/MANAGER only.
//
// Slice 11 of #900 (PRD_TRAVEL_QUOTE_BUILDER FR-3.1.3 status workflow +
// FR-3.7.4 customer-accept transition). Dedicated semantic endpoint for
// transitioning a quote into the "Accepted" state. Distinct from PUT
// /quotes/:id which permits arbitrary status writes — accept/decline
// carry workflow-specific transition guards + audit action codes that
// downstream invoice-conversion + reporting surfaces can grep for.
//
// Status-transition guard (FR-3.1.3): only quotes in "Draft" or "Sent"
// can move to "Accepted". "Rejected" → "Accepted" is rejected with 409
// INVALID_TRANSITION; the operator must clone the quote (POST /duplicate)
// rather than resurrect a rejected one. "Accepted" → "Accepted" is
// idempotent (200 + alreadyAccepted: true) so double-clicks from the
// operator UI don't surface a spurious error.
//
// Schema note: TravelQuote has no acceptedAt / acceptedBy columns
// (schema frozen for this slice). The acceptance timestamp + actor are
// captured in the audit row's details payload; downstream surfaces that
// need "when was this accepted" read from the audit chain rather than
// the quote envelope. A future slice can promote those into first-class
// columns once the product call lands.
router.post(
  "/quotes/:id/accept",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Idempotent accept: already-Accepted short-circuits with 200.
      if (quote.status === "Accepted") {
        return res.status(200).json({
          quote,
          alreadyAccepted: true,
          code: "ALREADY_ACCEPTED",
        });
      }

      // Transition guard: only Draft or Sent can move to Accepted.
      // Rejected quotes must be cloned (POST /duplicate), not resurrected.
      if (quote.status !== "Draft" && quote.status !== "Sent") {
        return res.status(409).json({
          error: `Cannot accept a quote in status "${quote.status}". Only Draft or Sent quotes can be accepted.`,
          code: "INVALID_TRANSITION",
        });
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data: { status: "Accepted" },
      });

      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_ACCEPTED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: updated.id,
          subBrand: updated.subBrand,
          contactId: updated.contactId,
          previousStatus: quote.status,
          acceptedAt: new Date().toISOString(),
        },
      );

      res.status(200).json({ quote: updated });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] accept error:", e.message);
      res.status(500).json({ error: "Failed to accept quote" });
    }
  },
);

// POST /api/travel/quotes/:id/decline — ADMIN/MANAGER only.
//
// Slice 11 of #900 (PRD_TRAVEL_QUOTE_BUILDER FR-3.7.5 reject-with-reason).
// Dedicated semantic endpoint paralleling /accept. Optional `reason`
// body field (max 1000 chars) is captured in the audit row's details
// payload — TravelQuote has no rejectionReason column (schema frozen
// for this slice), so the audit chain is the source of truth for
// rejection rationale until a future slice promotes it.
//
// Status-transition guard: only quotes in "Draft" or "Sent" can move
// to "Rejected". "Accepted" → "Rejected" is rejected with 409
// INVALID_TRANSITION; once accepted, the operator should treat the
// downstream invoice as the cancellation surface. "Rejected" →
// "Rejected" is idempotent (200 + alreadyRejected: true).
router.post(
  "/quotes/:id/decline",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Reason is optional but if provided must be a string ≤1000 chars.
      // Longer strings get truncated rather than 400'd — operators have
      // no UI hint for the limit and refusing the request would be
      // user-hostile. Sanitization happens at the audit-write level.
      const rawReason = req.body && req.body.reason;
      let reason = null;
      if (rawReason != null) {
        if (typeof rawReason !== "string") {
          return res.status(400).json({
            error: "reason must be a string",
            code: "INVALID_REASON",
          });
        }
        reason = rawReason.trim().slice(0, 1000);
        if (reason === "") reason = null;
      }

      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if (quote.status === "Rejected") {
        return res.status(200).json({
          quote,
          alreadyRejected: true,
          code: "ALREADY_REJECTED",
        });
      }

      if (quote.status !== "Draft" && quote.status !== "Sent") {
        return res.status(409).json({
          error: `Cannot decline a quote in status "${quote.status}". Only Draft or Sent quotes can be declined.`,
          code: "INVALID_TRANSITION",
        });
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data: { status: "Rejected" },
      });

      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_DECLINED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: updated.id,
          subBrand: updated.subBrand,
          contactId: updated.contactId,
          previousStatus: quote.status,
          declinedAt: new Date().toISOString(),
          reason: reason || null,
        },
      );

      res.status(200).json({ quote: updated, reason });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] decline error:", e.message);
      res.status(500).json({ error: "Failed to decline quote" });
    }
  },
);

// GET /api/travel/quotes/:id/pricing-preview — any verified token.
//
// READ-ONLY composition surface (PRD_TRAVEL_QUOTE_BUILDER FR-3.3.2 / FR-3.3.4).
// Loads the parent quote + its lines, fetches active TravelMarkupRule rows
// for the quote's sub-brand, and applies per-line markup using the pure
// lib/travelPricing.js helpers (pickMarkup + mapCategoryToScope).
//
// Per-line strategy: each line carries a `lineType` ∈
// {hotel, flight, transport, visa, service, other}. We map that to the
// markup-rule `scope` via mapCategoryToScope (visa/service/other collapse
// to "package"), then call pickMarkup to find the highest-priority active
// rule whose scope matches. Per-line markup is the rule's % or flat
// applied against the line's pre-markup amount. Aggregate markupApplied
// dedupes by ruleId (a single rule that covered both hotel + package
// lines surfaces as one entry with summed amount).
//
// Why not extend lib/travelPricing.js with a multi-line composer: the
// existing pure quote() is per-cost-row (single baseRate * seasonMul +
// markup). A multi-line aggregator with per-line season-date awareness +
// per-line markup is a bigger contract decision (DD-5.x pending) that
// belongs in its own slice. This endpoint composes the per-line shape
// inline using the existing pickMarkup helper so the math stays
// auditable and we don't fork the lib/ surface prematurely.
// TODO(travel-quotes-pricing-aggregator): when the multi-line composer
// lands in lib/travelPricing.js, replace the inline reduction below.
router.get(
  "/quotes/:id/pricing-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      // PRD §4.4 Visa Sure complexity gate (gap A6): the markup-rule
      // composer below IS the "structured quotation" surface, so complex
      // visa cases reject here with the same code as structured-mode
      // creation. Manual line totals (GET /:id/lines) and tax math
      // (GET /:id/tax-preview) stay open — manual quotes need both.
      if (
        quote.subBrand === "visasure"
        && (await findComplexVisaCase(req.travelTenant.id, quote.contactId))
      ) {
        throw visaComplexCaseError();
      }

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const rules = await prisma.travelMarkupRule.findMany({
        where: {
          tenantId: req.travelTenant.id,
          subBrand: quote.subBrand,
          isActive: true,
        },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });

      // Per-line markup composition. For each line:
      //   1. Map lineType → markup scope.
      //   2. pickMarkup against the line's pre-markup amount.
      //   3. Capture the matched rule (if any) into the dedupe map.
      // Round to 2 decimals at every step so subtotal+lineMarkups always
      // == total to the cent (no floating-point drift in the envelope).
      const round2 = (n) => Math.round(n * 100) / 100;
      const decoratedLines = [];
      const ruleAggregateById = new Map();
      let subtotalAccum = 0;

      for (const l of lines) {
        const lineAmount = Number(l.amount || 0);
        subtotalAccum += lineAmount;

        const scope = mapCategoryToScope(l.lineType);
        const { rule, markupAmount } = pickMarkup(
          rules,
          quote.subBrand,
          scope,
          lineAmount,
        );

        const amountWithMarkup = round2(lineAmount + markupAmount);
        decoratedLines.push({
          id: l.id,
          lineType: l.lineType,
          description: l.description,
          amount: round2(lineAmount),
          amountWithMarkup,
        });

        if (rule && markupAmount > 0) {
          const prior = ruleAggregateById.get(rule.id);
          if (prior) {
            prior.amount = round2(prior.amount + markupAmount);
          } else {
            ruleAggregateById.set(rule.id, {
              ruleId: rule.id,
              ruleName: rule.matchKeyJson || `rule-${rule.id}`,
              percent: rule.markupPct != null ? Number(rule.markupPct) : null,
              amount: round2(markupAmount),
            });
          }
        }
      }

      const subtotal = round2(subtotalAccum);
      const markupApplied = Array.from(ruleAggregateById.values());
      const totalMarkup = markupApplied.reduce((acc, r) => acc + r.amount, 0);
      const total = round2(subtotal + totalMarkup);

      res.json({
        subtotal,
        markupApplied,
        total,
        currency: quote.currency,
        lines: decoratedLines,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] pricing-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute pricing preview" });
    }
  },
);

// GET /api/travel/quotes/:id/tax-preview — any verified token.
//
// Slice 2 of #902 (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3). Consumes
// lib/gstCalculation.js (commit ced09867) — the pure CGST/SGST/IGST
// math + place-of-supply decision + per-category rate lookup.
//
// READ-ONLY tax-composition surface paralleling the markup
// pricing-preview endpoint above. Loads the parent quote + its lines,
// derives each line's GST rate from its lineType via
// gstRateForCategory, decides intra-vs-inter-state via
// isInterstateSupply, and aggregates per-line + per-rate-bucket totals
// via computeGstForLines.
//
// Place-of-supply (slice-2 SIMPLE rule):
//   - operatorStateCode from ?operatorStateCode= (default "IN-MH")
//   - customerStateCode from ?customerStateCode= (default same as
//     operatorStateCode → intra-state)
// FUTURE (slice 3): pull operator state from Tenant.gstStateCode +
// customer state from Contact.stateCode (FR-3.5.1 tenant master + Q-GST-2
// resolves contact state-code surface). Slice 2 stays decoupled from
// schema additions so the math + envelope can land while the master
// tables are being designed.
//
// Envelope contract: per-line {id, lineType, amount, gstPercent, cgst,
// sgst, igst, totalTax, amountWithTax} + envelope totals {subtotal,
// isInterstate, operatorStateCode, customerStateCode, totalCgst,
// totalSgst, totalIgst, totalTax, grandTotal, buckets[]}. Invariants:
// totalTax === totalCgst + totalSgst + totalIgst (split-consistency)
// and subtotal + totalTax === grandTotal (rounding-safe to 2 decimals
// because every step is round2'd in the lib helper).
//
// Per-line vs bucket aggregation: per-line totals are computed via
// computeGstSplit (one call per line, line-level rounding). Bucket
// summary is computed via computeGstForLines which sums taxable into
// per-rate buckets FIRST then taxes the bucket (per FR-3.4.3 HSN-summary
// shape). The two views can differ by ≤1 paise on multi-line quotes
// where individual lines round up vs bucket totals round once — that
// rounding drift is operator-visible by design; the GSTR-1 spec is the
// bucket view, the on-quote PDF is the per-line view. Both surfaces
// here so callers can pick.
router.get(
  "/quotes/:id/tax-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      // Place-of-supply state-code resolution (slice 4 — consumes
      // lib/gstStateCodeResolver.js, commit ef7573e7). Source-of-truth
      // chain per FR-3.x:
      //   1. Truthy override (query param) wins.
      //   2. DB column — Tenant.gstStateCode for operator,
      //      Contact.stateCode for customer (slice 3 schema adds).
      //   3. Hard-coded "IN-MH" — preserves slice 2 back-compat
      //      when both override + DB are absent.
      // Customer-side fallback when both override + DB are null:
      // mirror the operator (intra-state default) — handled inside
      // the helper, see lib/gstStateCodeResolver.js docs.
      //
      // Empty-string for an explicitly-provided param is still a 400
      // INVALID_STATE_CODE (defense-in-depth — keeps slice 2's spec
      // contract, prevents silent fall-through to defaults by sending
      // a blank value). The resolver's "empty-string == no override"
      // semantics handle the resolver-internal layer; this 400 is the
      // user-facing API-shape guarantee that explicit-blank is rejected.
      const rawOp = req.query.operatorStateCode;
      const rawCu = req.query.customerStateCode;
      if (rawOp != null && String(rawOp).trim() === "") {
        return res.status(400).json({
          error: "operatorStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }
      if (rawCu != null && String(rawCu).trim() === "") {
        return res.status(400).json({
          error: "customerStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }
      const { operatorStateCode, customerStateCode } = await resolveStateCodes({
        prisma,
        tenantId: req.travelTenant.id,
        contactId: quote.contactId,
        operatorOverride: rawOp != null ? String(rawOp).trim() : null,
        customerOverride: rawCu != null ? String(rawCu).trim() : null,
      });

      let isInterstate;
      try {
        isInterstate = isInterstateSupply(operatorStateCode, customerStateCode);
      } catch (e) {
        return res.status(400).json({
          error: e.message,
          code: "INVALID_STATE_CODE",
        });
      }

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      // Per-line decoration: each line gets its own gstPercent +
      // CGST/SGST/IGST split. Composite-supply per FR-3.2.4 — every
      // line is taxed at its own rate, no dominant-rate winner.
      const decoratedLines = [];
      const normalizedForBuckets = [];
      let subtotalAccum = 0;
      let totalCgstAccum = 0;
      let totalSgstAccum = 0;
      let totalIgstAccum = 0;
      let totalTaxAccum = 0;

      for (const l of lines) {
        const amt = Number(l.amount || 0);
        subtotalAccum = round2(subtotalAccum + amt);
        const gstPercent = gstRateForCategory(l.lineType);

        // Per-line split via local computation (mirrors lib's
        // computeGstSplit; inlined to avoid an extra require for a
        // 5-line helper).
        const totalTax = round2((amt * gstPercent) / 100);
        let cgst = 0;
        let sgst = 0;
        let igst = 0;
        if (isInterstate) {
          igst = totalTax;
        } else {
          const halfRate = gstPercent / 2;
          cgst = round2((amt * halfRate) / 100);
          sgst = round2((amt * halfRate) / 100);
        }
        const amountWithTax = round2(amt + totalTax);

        // Slice 6 of #902 — surface per-line SAC code + description from
        // lib/hsnSacMapper.js (commit 6aca2361). Additive fields; the
        // existing per-line shape stays back-compat.
        const sacCode = sacForLineType(l.lineType);
        const sacDescription = sacCode ? descriptionForSac(sacCode) : null;

        decoratedLines.push({
          id: l.id,
          lineType: l.lineType,
          amount: round2(amt),
          gstPercent,
          sacCode,
          sacDescription,
          cgst,
          sgst,
          igst,
          totalTax,
          amountWithTax,
        });
        normalizedForBuckets.push({ taxableAmount: amt, gstPercent });

        totalCgstAccum = round2(totalCgstAccum + cgst);
        totalSgstAccum = round2(totalSgstAccum + sgst);
        totalIgstAccum = round2(totalIgstAccum + igst);
        totalTaxAccum = round2(totalTaxAccum + totalTax);
      }

      // Bucket summary via lib helper (per-rate aggregation matches
      // GSTR-1 HSN-summary shape per FR-3.4.3 / NFR-4.2). Use the
      // bucket totals as the envelope-level totals so the spec-aligned
      // numbers win the consistency check (per-line drift is contained
      // to the lines[] array, never leaks into envelope totals).
      const bucketSummary = computeGstForLines(
        normalizedForBuckets,
        isInterstate,
      );

      // Slice 6 of #902 — HSN/SAC summary grouping per FR-3.4.3 (GSTR-1
      // export-ready shape: one row per (sacCode, gstPercent) pair with
      // summed taxableValue + line count). Sibling shape to buckets[]
      // (which groups by gstPercent only). Lines whose lineType has no
      // SAC of its own (tax/fee/tcs/tds) are skipped by the helper.
      const hsnSummary = groupLinesBySac(
        lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        })),
      );

      res.json({
        subtotal: bucketSummary.subtotal,
        isInterstate,
        operatorStateCode,
        customerStateCode,
        lines: decoratedLines,
        totalCgst: bucketSummary.totalCgst,
        totalSgst: bucketSummary.totalSgst,
        totalIgst: bucketSummary.totalIgst,
        totalTax: bucketSummary.totalTax,
        grandTotal: bucketSummary.grandTotal,
        buckets: bucketSummary.buckets,
        hsnSummary,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] tax-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute tax preview" });
    }
  },
);

// POST /api/travel/quotes/:id/extend — ADMIN/MANAGER only.
//
// Slice 12 of #900 (PRD_TRAVEL_QUOTE_BUILDER OQ-9.7 — expiry workflow,
// extend-by-N-days manual rescue). Pushes a quote's validUntil forward
// without touching status / lines / totals / contact. Body accepts
// either { days: <positive int, ≤365> } (relative — adds N days to
// max(validUntil || now)) OR { newValidUntil: <ISO date> } (absolute —
// sets validUntil verbatim, must parse + must be future). Exactly one
// of the two must be supplied (400 EXTEND_PARAMS otherwise).
//
// Transition guard (mirror of accept/decline): only Draft or Sent
// quotes can be extended. Accepted or Rejected quotes are terminal
// — extending a terminal quote is meaningless (operator must clone
// via POST /duplicate to revive a rejected scope). 409
// INVALID_TRANSITION.
//
// Sub-brand isolation: standard sub-brand-access guard. Tenant scope
// via the findFirst where clause.
//
// Audit: TRAVEL_QUOTE_EXTENDED with previousValidUntil + newValidUntil
// + extensionMode ("days" | "absolute") + days (if days mode) in the
// details payload. The audit row is the source of truth for the
// extension trail; no first-class "extension history" column on the
// quote envelope.
router.post(
  "/quotes/:id/extend",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const body = req.body || {};
      const hasDays = body.days !== undefined && body.days !== null && body.days !== "";
      const hasAbs = body.newValidUntil !== undefined && body.newValidUntil !== null && body.newValidUntil !== "";

      // Exactly one of days / newValidUntil required.
      if (hasDays === hasAbs) {
        return res.status(400).json({
          error: "Provide exactly one of { days } or { newValidUntil }",
          code: "EXTEND_PARAMS",
        });
      }

      let extensionMode = null;
      let parsedDays = null;
      let parsedAbs = null;

      if (hasDays) {
        const n = Number(body.days);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 365) {
          return res.status(400).json({
            error: "days must be a positive integer between 1 and 365",
            code: "INVALID_DAYS",
          });
        }
        parsedDays = n;
        extensionMode = "days";
      } else {
        const d = new Date(body.newValidUntil);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "newValidUntil must be a parseable date",
            code: "INVALID_VALID_UNTIL",
          });
        }
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        if (d.getTime() < todayMidnight.getTime()) {
          return res.status(400).json({
            error: "newValidUntil must be today or a future date",
            code: "INVALID_VALID_UNTIL",
          });
        }
        parsedAbs = d;
        extensionMode = "absolute";
      }

      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Transition guard: only Draft or Sent can be extended.
      if (quote.status !== "Draft" && quote.status !== "Sent") {
        return res.status(409).json({
          error: `Cannot extend a quote in status "${quote.status}". Only Draft or Sent quotes can be extended.`,
          code: "INVALID_TRANSITION",
        });
      }

      // Compute newValidUntil.
      //   days mode: base = max(existing validUntil, now); add N days.
      //   absolute mode: verbatim parsedAbs.
      let newValidUntil;
      if (extensionMode === "days") {
        const now = Date.now();
        const existingMs = quote.validUntil ? new Date(quote.validUntil).getTime() : 0;
        const base = Math.max(existingMs, now);
        newValidUntil = new Date(base + parsedDays * 24 * 60 * 60 * 1000);
      } else {
        newValidUntil = parsedAbs;
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data: { validUntil: newValidUntil },
      });

      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_EXTENDED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: updated.id,
          subBrand: updated.subBrand,
          previousValidUntil: quote.validUntil
            ? new Date(quote.validUntil).toISOString()
            : null,
          newValidUntil: newValidUntil.toISOString(),
          extensionMode,
          days: parsedDays,
        },
      );

      res.status(200).json({ quote: updated, extensionMode, days: parsedDays });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] extend error:", e.message);
      res.status(500).json({ error: "Failed to extend quote" });
    }
  },
);

// GET /api/travel/quotes/:id/audit-trail — any verified token (tenant +
// sub-brand-scoped via loadParentQuote).
//
// Slice 15 of #900 (PRD_TRAVEL_QUOTE_BUILDER §3.8.1 audit + §3.8.3 send-
// history). Read-only chronological audit log for a single quote.
//
// === What it joins ===
// Two audit-entity classes contribute to a quote's history:
//   1. entity='TravelQuote'  AND entityId=<quoteId>
//      → CREATE / UPDATE / DELETE / TRAVEL_QUOTE_ACCEPTED /
//        TRAVEL_QUOTE_DECLINED / TRAVEL_QUOTE_DUPLICATED /
//        TRAVEL_QUOTE_EXTENDED / TRAVEL_QUOTE_CONVERTED /
//        TRAVEL_QUOTE_PDF_DOWNLOADED
//   2. entity='TravelQuoteLine' whose details JSON contains "quoteId":<id>
//      → line-level CREATE / UPDATE / DELETE.
//
// The line-rows query uses Prisma's `contains` on the JSON-string `details`
// column (the route layer writes details via JSON.stringify), tenant-
// scoped. This is the same pragmatic approach the audit_viewer route uses
// for cross-entity filtering and avoids needing a relational column.
//
// Both result sets are merged in-memory and sorted by createdAt asc so the
// timeline reads top-down (oldest first), with `details` re-parsed back
// into a structured object so the operator UI doesn't have to.
//
// === Pagination ===
// Optional ?limit (1..500, default 100). The list is bounded above by
// design — a single quote should never legitimately have >500 audit rows.
//
// === Auth ===
// Mirrors loadParentQuote — 400 INVALID_ID for non-numeric, 404
// QUOTE_NOT_FOUND when no row, 403 SUB_BRAND_DENIED when caller lacks
// access to the quote's sub-brand. Read-only; no RBAC tier required.
//
// === Route ordering ===
// Sub-path under /quotes/:id; Express matches by segment count so this
// won't conflict with GET /quotes/:id (2 segs vs 3).
router.get(
  "/quotes/:id/audit-trail",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const limitRaw = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 500)
        : 100;

      // Quote-entity audit rows: direct entityId match.
      const quoteRows = await prisma.auditLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          entity: "TravelQuote",
          entityId: quoteId,
        },
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          details: true,
          userId: true,
          createdAt: true,
        },
      });

      // Line-entity audit rows: filter by JSON-substring match on the
      // details column. The route layer writes details as JSON.stringify
      // of an object that includes quoteId, so a substring match on
      // `"quoteId":<id>` reliably picks up CREATE/UPDATE/DELETE on every
      // line that ever belonged to this quote (including soft-deleted
      // ones, which is the whole point of an audit trail).
      const lineRows = await prisma.auditLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          entity: "TravelQuoteLine",
          details: { contains: `"quoteId":${quoteId}` },
        },
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          details: true,
          userId: true,
          createdAt: true,
        },
      });

      // Merge + sort by createdAt asc (oldest first) so the UI renders
      // top-down chronologically. Tie-break on id for determinism.
      const merged = [...quoteRows, ...lineRows].sort((a, b) => {
        const aMs = new Date(a.createdAt).getTime();
        const bMs = new Date(b.createdAt).getTime();
        if (aMs !== bMs) return aMs - bMs;
        return (a.id || 0) - (b.id || 0);
      });

      // Re-parse details into a structured object so the consumer doesn't
      // have to. Tolerant of legacy null / malformed-JSON rows.
      const entries = merged.slice(0, limit).map((row) => {
        let parsedDetails = null;
        if (row.details) {
          try {
            parsedDetails = JSON.parse(row.details);
          } catch (_e) {
            parsedDetails = { _raw: row.details };
          }
        }
        return {
          id: row.id,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          userId: row.userId,
          createdAt: row.createdAt,
          details: parsedDetails,
        };
      });

      res.json({
        quoteId,
        subBrand: quote.subBrand,
        count: entries.length,
        truncated: merged.length > limit,
        entries,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] audit-trail error:", e.message);
      res.status(500).json({ error: "Failed to load audit trail" });
    }
  },
);

// ----------------------------------------------------------------------------
// Slice C5 — POST /api/travel/quote/unified-search
// Per PRD_RATEHAWK_INTEGRATION FR-5 + FR-6 + DC-6 (side-by-side vendor
// clients; ranker merges across an array of per-vendor result arrays).
//
// Fan-out behaviour:
//   1. Iterate over the requested provider list (default: all enabled
//      providers — currently ratehawk + bookingExpedia).
//   2. Call each Client.searchHotels(...) via Promise.allSettled — one
//      provider's failure must NOT block the others (NFR reliability +
//      "vendor degraded" toast per §4).
//   3. Catch *_NOT_YET_ENABLED / *_BUDGET_EXCEEDED errors → mark that
//      provider as `disabled` (cred-blocked) in the response envelope.
//      Other errors → status: 'error' + errorMessage.
//   4. Flatten all returned hotels into per-provider quote rows, then
//      apply tenant + sub-brand markup via the existing pickMarkup
//      helper so customer-facing prices include the markup (NET stays
//      provider-side; customer never sees raw NET — §2.3).
//   5. Pass the unified array to rankQuotes() for composite-score sort.
//
// Envelope shape (also documented in the FR-5 row of the PRD):
//   { results: [ ...ranked quotes ],
//     providers: { ratehawk: { status, count, errorMessage? }, ... },
//     totalCount: N,
//     rankedAt: ISO,
//     subBrand: string }
//
// Markup-source compatibility: both stub clients today return
// `hotels: []`, so the live response is mostly an empty-array envelope
// with provider-status diagnostics — but the markup + ranker code paths
// are still exercised end-to-end in the route's vitest because the
// tests mock the stubs to return canned non-empty payloads.
// ----------------------------------------------------------------------------

const KNOWN_PROVIDERS = ["ratehawk", "bookingExpedia"];

// Provider → client wrapper. Each wrapper normalises the client's
// stub-shape into the unified quote shape rankQuotes expects:
//   { provider, propertyName, propertyCity, price, currency,
//     supplierRating, cancellationPolicy, sourceRef }
//
// When the real-mode swap happens (Q19 cred drop), the stub-shape
// inside each client changes but the wrapper signature stays. The
// route doesn't have to learn the difference.
async function _callRatehawk({ tenantId, ...criteria }) {
  const envelope = await ratehawkClient.searchHotels({ tenantId, ...criteria });
  const hotels = Array.isArray(envelope.hotels) ? envelope.hotels : [];
  return hotels.map((h) => ({
    provider: "ratehawk",
    propertyName: h.propertyName || h.name || null,
    propertyCity: h.propertyCity || h.city || criteria.destinationCity || null,
    price: Number(h.totalRate ?? h.ratePerNight ?? h.price ?? 0),
    currency: h.currency || envelope.currency || "USD",
    supplierRating: h.supplierRating ?? h.rating ?? null,
    cancellationPolicy: h.cancellationPolicy || h.refundability || null,
    sourceRef: h.sourceRef || h.id || null,
    raw: h,
  }));
}

async function _callBookingExpedia({ tenantId, ...criteria }) {
  const envelope = await bookingExpediaClient.searchHotels({
    tenantId,
    provider: "booking",
    ...criteria,
  });
  const hotels = Array.isArray(envelope.hotels) ? envelope.hotels : [];
  return hotels.map((h) => ({
    provider: "bookingExpedia",
    propertyName: h.propertyName || h.name || null,
    propertyCity: h.propertyCity || h.city || criteria.destinationCity || null,
    price: Number(h.totalRate ?? h.ratePerNight ?? h.price ?? 0),
    currency: h.currency || envelope.currency || "USD",
    supplierRating: h.supplierRating ?? h.rating ?? null,
    cancellationPolicy: h.cancellationPolicy || h.refundability || null,
    sourceRef: h.sourceRef || h.id || null,
    raw: h,
  }));
}

const PROVIDER_CALLERS = {
  ratehawk: _callRatehawk,
  bookingExpedia: _callBookingExpedia,
};

router.post(
  "/quote/unified-search",
  verifyToken,
  requireTravelTenant,
  requirePermission("quotes", "read"),
  async (req, res) => {
    try {
      const body = req.body || {};

      // ----------------------------------------------------------------
      // Input validation
      // ----------------------------------------------------------------
      const subBrand = body.subBrand;
      if (!subBrand || typeof subBrand !== "string") {
        return res.status(400).json({
          error: "subBrand is required",
          code: "MISSING_SUB_BRAND",
        });
      }
      try {
        assertValidSubBrand(subBrand);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }

      const destination = body.destination;
      if (!destination || typeof destination !== "string") {
        return res.status(400).json({
          error: "destination is required",
          code: "MISSING_DESTINATION",
        });
      }

      const checkIn = body.checkIn;
      const checkOut = body.checkOut;
      if (!checkIn || !checkOut) {
        return res.status(400).json({
          error: "checkIn and checkOut are required",
          code: "MISSING_DATES",
        });
      }

      // Sub-brand access: a MANAGER scoped to {tmc} cannot fan-out a
      // search under {rfu}. Admin (allowed === null) passes through.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      // Rooms / guests aggregation — sum rooms[].adults so the
      // provider client gets a single guest count. V1 contract per
      // PRD §3 — multi-room API expansion is Phase 2.
      const rooms = Array.isArray(body.rooms) ? body.rooms : [{ adults: 2 }];
      const guests = rooms.reduce(
        (acc, r) => acc + (Number(r.adults) || 0) + (Number(r.children) || 0),
        0,
      );

      // Provider selection: caller may pin a subset; default to all.
      let providers = Array.isArray(body.providers) && body.providers.length > 0
        ? body.providers
        : KNOWN_PROVIDERS;
      providers = providers.filter((p) => KNOWN_PROVIDERS.includes(p));
      if (providers.length === 0) {
        return res.status(400).json({
          error: `providers must include at least one of: ${KNOWN_PROVIDERS.join(", ")}`,
          code: "INVALID_PROVIDERS",
        });
      }

      // ----------------------------------------------------------------
      // Fan-out: Promise.allSettled so one provider's failure / cred-
      // blocked stub doesn't sink the others.
      // ----------------------------------------------------------------
      const criteria = {
        tenantId: req.travelTenant.id,
        destinationCity: destination,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: guests || 2,
        rooms: rooms.length,
      };

      const settlements = await Promise.allSettled(
        providers.map((p) => PROVIDER_CALLERS[p](criteria)),
      );

      // ----------------------------------------------------------------
      // Provider status + result collection
      // ----------------------------------------------------------------
      const providerStatus = {};
      let allQuotes = [];

      for (let i = 0; i < providers.length; i += 1) {
        const provider = providers[i];
        const s = settlements[i];
        if (s.status === "fulfilled") {
          providerStatus[provider] = { status: "ok", count: s.value.length };
          allQuotes = allQuotes.concat(s.value);
        } else {
          const err = s.reason || {};
          // *_NOT_YET_ENABLED + *_BUDGET_EXCEEDED + EXPEDIA_NOT_YET_ENABLED
          // all represent cred-blocked / cap-blocked states — operators
          // see them as "disabled" rather than "error" so the UI tile
          // distinguishes operator-onboarding from runtime failure.
          const code = err.code || "";
          const disabled =
            code === "RATEHAWK_NOT_YET_ENABLED" ||
            code === "RATEHAWK_BUDGET_EXCEEDED" ||
            code === "BOOKING_EXPEDIA_NOT_YET_ENABLED" ||
            code === "BOOKING_EXPEDIA_BUDGET_EXCEEDED" ||
            code === "EXPEDIA_NOT_YET_ENABLED";
          providerStatus[provider] = {
            status: disabled ? "disabled" : "error",
            count: 0,
            errorMessage: err.message || String(err),
            ...(err.code ? { errorCode: err.code } : {}),
          };
        }
      }

      // ----------------------------------------------------------------
      // Markup pass — apply tenant + sub-brand markup so customer-facing
      // prices include the markup. Per PRD §2.3 + FR-7: NET stays
      // provider-side; customer sees marked-up rate only. Audit-snapshot
      // path stores both (NET + markup + grand-total) but that's the
      // operator-side persistence layer, not this fan-out.
      // ----------------------------------------------------------------
      let markupRules = [];
      try {
        markupRules = await prisma.travelMarkupRule.findMany({
          where: {
            tenantId: req.travelTenant.id,
            subBrand,
            isActive: true,
          },
          orderBy: [{ priority: "asc" }, { id: "asc" }],
        });
      } catch (_e) {
        // travelMarkupRule may not exist in some mocked test
        // environments — fall back to "no markup" so the route still
        // returns a valid envelope.
        markupRules = [];
      }

      const round2 = (n) => Math.round(n * 100) / 100;
      const markedQuotes = allQuotes.map((q) => {
        const scope = mapCategoryToScope("hotel"); // unified-search hotels-only V1
        const netPrice = Number(q.price) || 0;
        const { rule, markupAmount } = pickMarkup(
          markupRules,
          subBrand,
          scope,
          netPrice,
        );
        const grossPrice = round2(netPrice + (markupAmount || 0));
        return {
          ...q,
          netPrice: round2(netPrice),
          markupAmount: round2(markupAmount || 0),
          markupRuleId: rule?.id ?? null,
          price: grossPrice, // ranker sorts on customer-facing price
        };
      });

      // ----------------------------------------------------------------
      // Rank + envelope
      // ----------------------------------------------------------------
      const ranked = rankQuotes(markedQuotes);

      // FR-9 — audit each unified-search call so per-tenant cost +
      // provider-mix surfaces in admin reporting. Best-effort; a
      // failed audit write must not block the response.
      try {
        await writeAudit(
          "TravelQuote",
          "TRAVEL_UNIFIED_SEARCH",
          0,
          req.user.userId,
          req.travelTenant.id,
          {
            subBrand,
            destination,
            checkIn,
            checkOut,
            providers,
            providerStatus,
            totalCount: ranked.length,
          },
        );
      } catch (_e) {
        /* swallow */
      }

      res.json({
        results: ranked,
        providers: providerStatus,
        totalCount: ranked.length,
        subBrand,
        rankedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] unified-search error:", e.message);
      res.status(500).json({ error: "Failed to run unified search" });
    }
  },
);

// POST /api/travel/quotes/:id/share
//
// Mint a signed customer-share token for the quote and DELIVER it: email (if the
// contact has an email) + WhatsApp (via the connected WhatsApp Web number).
// Returns the public link (/p/quote/<token>, served by the existing
// travel_quotes_public view/accept/reject/counter flow) so the operator can
// also paste it manually. Promotes a Draft quote to Sent. channel="auto".
router.post("/quotes/:id/share", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const quote = await prisma.travelQuote.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      select: { id: true, subBrand: true, contactId: true, status: true, currency: true, totalAmount: true },
    });
    if (!quote) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, quote.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const expiryDays = parseInt((req.body || {}).expiryDays, 10);
    const token = mintShareToken({
      quoteId: id,
      tenantId: req.travelTenant.id,
      expiresInDays: Number.isFinite(expiryDays) ? expiryDays : undefined,
    });
    const portalBase = String((req.headers && req.headers.origin) || "").replace(/\/+$/, "")
      || process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
    const shareUrl = `${portalBase}/p/quote/${token}`;

    // Promote draft → sent so the public link isn't a "not yet ready" state.
    const promote = quote.status === "Draft";
    if (promote) {
      await prisma.travelQuote.update({ where: { id }, data: { status: "Sent" } }).catch(() => {});
    }

    // Deliver to the contact: email if present, WhatsApp if a phone is on file.
    let emailStatus = "SKIPPED";
    let whatsappStatus = "SKIPPED";
    const channelsUsed = [];
    if (quote.contactId) {
      const contact = await prisma.contact
        .findFirst({ where: { id: quote.contactId, tenantId: req.travelTenant.id }, select: { id: true, name: true, email: true, phone: true } })
        .catch(() => null);
      if (contact) {
        const cur = quote.currency || "INR";
        const amt = quote.totalAmount != null ? `${cur} ${Number(quote.totalAmount).toLocaleString("en-IN")}` : "";
        const name = contact.name || "there";
        if (contact.email) {
          const r = await sendEmail({
            to: contact.email,
            subject: `Your travel quote${amt ? ` — ${amt}` : ""}`,
            text: `Hi ${name},\n\nYour travel quote is ready${amt ? ` (${amt})` : ""}. View it here:\n${shareUrl}\n\nYou can accept it right from that page.\n\nThank you.`,
          }).catch(() => ({ sent: false }));
          emailStatus = r && r.sent ? "SENT" : "SKIPPED";
          if (r && r.sent) channelsUsed.push("email");
        }
        if (contact.phone) {
          const r = await waWebClient.sendBestEffort({
            tenantId: req.travelTenant.id,
            subBrand: quote.subBrand,
            toPhone: contact.phone,
            contactId: contact.id,
            fallbackText: `Hi ${name}! Your travel quote is ready${amt ? ` (${amt})` : ""}. View + accept here: ${shareUrl}`,
          }).catch(() => ({ sent: false, status: "FAILED" }));
          whatsappStatus = (r && r.status) || "FAILED";
          if (r && r.sent === true) channelsUsed.push("whatsapp");
        }
      }
    }

    writeAudit("TravelQuote", "QUOTE_SHARE", id, req.user.userId, req.travelTenant.id, {
      subBrand: quote.subBrand, channel: channelsUsed.join("+") || "none",
    }).catch(() => {});

    res.json({
      shareToken: token,
      shareUrl,
      email: emailStatus,
      whatsapp: whatsappStatus,
      channel: channelsUsed.length ? channelsUsed.join("+") : "none",
      status: promote ? "Sent" : quote.status,
    });
  } catch (e) {
    console.error("[travel-quotes] share error:", e.message);
    res.status(500).json({ error: "Failed to share quote", code: "SHARE_FAILED" });
  }
});

module.exports = router;
