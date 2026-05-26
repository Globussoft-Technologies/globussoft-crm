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
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const tenantId = req.travelTenant.id;

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
      prisma.tmcTrip.count({ where: scoped(req, allowed) }),
      prisma.tmcTrip.groupBy({
        by: ["status"],
        where: scoped(req, allowed),
        _count: { _all: true },
      }),
      prisma.tmcTrip.count({
        where: scoped(req, allowed, { departDate: { gte: now, lte: thirtyDaysAhead } }),
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
      // microsite row has tenantId but inherits scope through the trip.
      prisma.tripMicrosite.count({ where: { tenantId } }),
      prisma.tripMicrosite.count({
        where: { tenantId, expiresAt: { lt: now } },
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
        where: scoped(req, allowed),
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
