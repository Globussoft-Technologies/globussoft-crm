// Travel CRM — Owner Dashboard aggregate (Phase 1).
//
// Replaces the Day-1 placeholder Dashboard.jsx with a real KPI surface.
// One endpoint: GET /api/travel/dashboard returns counts + recent-activity
// payload composed via Promise.all so the page renders in one round-trip.
//
// Endpoint shape:
//   {
//     trips:        { total, byStatus: { confirmed, "in-trip", completed, cancelled }, upcoming30d },
//     diagnostics:  { totalLast30d, byClassification: { ... } },
//     itineraries:  { total, byStatus: { draft, sent, revised, accepted, rejected } },
//     microsites:   { published, expired },
//     costMaster:   { activeRows, bySubBrand: { tmc, rfu, ... } },
//     pricingRules: { seasons, markupRules },
//     recentTrips:  [{ id, tripCode, destination, departDate, status }, ...]  // newest 5
//   }
//
// All counts are tenant-scoped via requireTravelTenant and (where relevant)
// narrowed by the caller's subBrandAccess set — a TMC-ops user doesn't see
// RFU counts polluting their dashboard. Admins (allowed=null) see everything.
//
// The endpoint deliberately does NOT include PII (no participant names, no
// payment amounts). Recent activity is limited to trip-level metadata which
// the user could already see on /travel/trips. PII drilldowns live on the
// detail pages (#207-style RBAC), not the aggregate.

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  narrowWhereBySubBrand,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");

// Build a Prisma `where` clause for tenant + sub-brand scoping. The
// narrowWhereBySubBrand helper mutates and returns; we wrap it so each
// aggregate query starts from a fresh object (don't share references —
// Prisma chokes on shared `where`).
function scoped(req, allowed, extra = {}) {
  const where = { tenantId: req.travelTenant.id, ...extra };
  narrowWhereBySubBrand(where, allowed);
  return where;
}

// `groupBy(status)` returns rows like [{ status: "confirmed", _count: { _all: N }}, ...].
// Flatten to { confirmed: N, "in-trip": M, ... } so the frontend can read by key.
function flattenGroupCount(rows, key) {
  const out = {};
  for (const r of rows) {
    out[r[key]] = r._count?._all ?? 0;
  }
  return out;
}

router.get("/dashboard", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    let allowed = await getSubBrandAccessSet(req.user.userId);
    const tenantId = req.travelTenant.id;

    // Optional ?subBrand= narrows the dashboard to a single sub-brand. This
    // is what the sidebar sub-brand switcher drives — picking "TMC" should
    // recompute every tile against TMC only, not the caller's full grant set.
    // "All" (no param) leaves `allowed` at the caller's natural access.
    //
    // Security: we never WIDEN access here. We intersect the requested brand
    // with what the caller may already see (canAccessSubBrand). A scoped user
    // asking for a brand outside their grant collapses to a deny-all empty set
    // → zero rows, consistent with narrowWhereBySubBrand's silent-empty rule
    // (no 403; the user simply can't see what they aren't entitled to).
    const requestedSubBrand = req.query.subBrand;
    if (requestedSubBrand) {
      assertValidSubBrand(requestedSubBrand); // 400 INVALID_SUB_BRAND on garbage
      allowed = canAccessSubBrand(allowed, requestedSubBrand)
        ? new Set([requestedSubBrand])
        : new Set();
    }

    // TmcTrip is TMC-only and has NO `subBrand` column, so it must NOT go
    // through narrowWhereBySubBrand (which would inject `subBrand: { in: [...] }`
    // and crash Prisma with "Unknown argument `subBrand`" for any sub-brand-
    // scoped caller). Instead gate on whether the caller can see TMC at all
    // (admins/full-access → yes; scoped users → only if "tmc" is in their set),
    // mirroring tmcSummary() in travel_reports.js. When they can't, force an
    // unsatisfiable filter so the trip aggregates resolve to zero.
    const canTmc = canAccessSubBrand(allowed, "tmc");
    function tmcWhere(extra = {}) {
      const where = { tenantId, ...extra };
      if (!canTmc) where.id = -1; // unsatisfiable → zero rows, never matches
      return where;
    }

    // 30-day cutoff used by both diagnostics + trip "upcoming" tile.
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Fire all aggregates in parallel — each is a single Prisma call, so the
    // whole endpoint resolves in ~one round-trip's worth of DB latency.
    const [
      tripTotal,
      tripByStatus,
      tripUpcoming30d,
      diagTotal30d,
      diagByClass,
      itinTotal,
      itinByStatus,
      micrositePublished,
      micrositeExpired,
      costMasterActive,
      costMasterBySubBrand,
      seasonCount,
      markupRuleCount,
      recentTripsRaw,
    ] = await Promise.all([
      prisma.tmcTrip.count({ where: tmcWhere() }),
      prisma.tmcTrip.groupBy({
        by: ["status"],
        where: tmcWhere(),
        _count: { _all: true },
      }),
      prisma.tmcTrip.count({
        where: tmcWhere({ departDate: { gte: now, lte: thirtyDaysAhead } }),
      }),
      prisma.travelDiagnostic.count({
        where: scoped(req, allowed, { createdAt: { gte: thirtyDaysAgo } }),
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["classification"],
        where: scoped(req, allowed, { createdAt: { gte: thirtyDaysAgo } }),
        _count: { _all: true },
      }),
      prisma.itinerary.count({ where: scoped(req, allowed) }),
      prisma.itinerary.groupBy({
        by: ["status"],
        where: scoped(req, allowed),
        _count: { _all: true },
      }),
      // Microsites live on TmcTrip — only the TMC sub-brand has them. The
      // sub-brand scope on the parent trip is the source of truth; the
      // microsite row has tenantId but inherits scope through the trip. Gate
      // on canTmc so a non-TMC scope (e.g. switcher set to RFU) shows 0 rather
      // than leaking tenant-wide microsite counts into an RFU-only view.
      prisma.tripMicrosite.count({ where: tmcWhere() }),
      prisma.tripMicrosite.count({
        where: tmcWhere({ expiresAt: { lt: now } }),
      }),
      prisma.travelCostMaster.count({
        where: scoped(req, allowed, { isActive: true }),
      }),
      prisma.travelCostMaster.groupBy({
        by: ["subBrand"],
        where: scoped(req, allowed, { isActive: true }),
        _count: { _all: true },
      }),
      prisma.travelSeasonCalendar.count({ where: scoped(req, allowed) }),
      prisma.travelMarkupRule.count({
        where: scoped(req, allowed, { isActive: true }),
      }),
      prisma.tmcTrip.findMany({
        where: tmcWhere(),
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          tripCode: true,
          destination: true,
          departDate: true,
          returnDate: true,
          status: true,
        },
      }),
    ]);

    res.json({
      trips: {
        total: tripTotal,
        byStatus: flattenGroupCount(tripByStatus, "status"),
        upcoming30d: tripUpcoming30d,
      },
      diagnostics: {
        totalLast30d: diagTotal30d,
        byClassification: flattenGroupCount(diagByClass, "classification"),
      },
      itineraries: {
        total: itinTotal,
        byStatus: flattenGroupCount(itinByStatus, "status"),
      },
      microsites: {
        published: micrositePublished,
        expired: micrositeExpired,
      },
      costMaster: {
        activeRows: costMasterActive,
        bySubBrand: flattenGroupCount(costMasterBySubBrand, "subBrand"),
      },
      pricingRules: {
        seasons: seasonCount,
        markupRules: markupRuleCount,
      },
      recentTrips: recentTripsRaw,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-dashboard] aggregate error:", e.message);
    res.status(500).json({ error: "Failed to compute dashboard" });
  }
});

module.exports = router;
