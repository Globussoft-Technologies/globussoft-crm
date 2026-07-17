// Travel CRM — Owner Dashboard aggregate (Phase 1).
//
// Replaces the Day-1 placeholder Dashboard.jsx with a real KPI surface.
// GET /api/travel/dashboard returns counts + recent-activity payload
// composed via Promise.all so the page renders in one round-trip.
// GET /api/travel/dashboard/workload (MANAGER/ADMIN) returns the staff-wise
// open/overdue task rollup (PRD §4.1 manager view — see the handler's
// JSDoc at the bottom of this file).
//
// Endpoint shape:
//   {
//     trips:        { total, byStatus: { confirmed, "in-trip", completed, cancelled }, upcoming30d },
//     diagnostics:  { totalLast30d, byClassification: { ... } },
//     itineraries:  { total, byStatus: { draft, sent, revised, accepted, rejected } },
//     landingPages: { total, published },
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
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  narrowWhereBySubBrand,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { computeTeamWorkload } = require("../lib/travelWorkload");

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
      landingPageTotal,
      landingPagePublished,
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
      // Landing pages are tenant-scoped and support subBrand filtering.
      prisma.landingPage.count({ where: scoped(req, allowed) }),
      prisma.landingPage.count({
        where: scoped(req, allowed, { status: "PUBLISHED" }),
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
      landingPages: {
        total: landingPageTotal,
        published: landingPagePublished,
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

// GET /api/travel/dashboard/workload — MANAGER/ADMIN only (PRD §4.1
// gap A9b: "Manager view — pending tasks, delayed tasks, staff-wise
// workload across brands").
//
// Aggregates OPEN tasks (status != "Completed", not soft-deleted) for the
// caller's travel tenant into per-staff + tenant-level counts via
// lib/travelWorkload.computeTeamWorkload (pure math; vitest-covered).
//
// Response shape:
//   {
//     perUser: [{ userId, name, email, role, openTasks, overdueTasks,
//                 bySubBrand: { tmc: {open, overdue}, ..., _none: {...} } }],
//     unassigned: { openTasks, overdueTasks, bySubBrand },
//     totals:     { openTasks, overdueTasks, bySubBrand },
//     staffCount,
//     generatedAt,
//   }
//
// Semantics:
//   - "pending" = open task (status != "Completed"); "delayed" = open AND
//     dueDate < now. overdueTasks ⊆ openTasks. Tasks with no dueDate are
//     never overdue.
//   - Task has NO subBrand column — brand attribution is derived from the
//     linked Contact.subBrand. Tasks without a contact (or with an
//     untagged contact) bucket under "_none". Per-user/tenant TOTALS are
//     therefore always complete; the bySubBrand split is best-effort by
//     design (documented PRD-gap note: work items aren't brand-scoped in
//     the schema).
//   - RBAC: MANAGER/ADMIN (verifyRole) — staff names/emails are a
//     manager-grade surface, same posture as /api/users.
//   - Sub-brand narrowing: optional ?subBrand= mirrors GET /dashboard
//     (intersected with the caller's access set, never widened; garbage →
//     400 INVALID_SUB_BRAND). When a narrowing applies, only tasks whose
//     contact carries one of the allowed brands are counted — a deny-all
//     intersection returns the zeroed envelope (silent-empty rule), not
//     403. Full-access callers (?subBrand absent, allowed=null) see every
//     open task including contact-less ones.
router.get(
  "/dashboard/workload",
  verifyToken,
  requireTravelTenant,
  requirePermission("reports", "read"),
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      let allowed = await getSubBrandAccessSet(req.user.userId);

      const requestedSubBrand = req.query.subBrand;
      if (requestedSubBrand) {
        assertValidSubBrand(requestedSubBrand); // 400 INVALID_SUB_BRAND
        allowed = canAccessSubBrand(allowed, requestedSubBrand)
          ? new Set([requestedSubBrand])
          : new Set();
      }

      const taskWhere = {
        tenantId,
        deletedAt: null,
        status: { not: "Completed" },
      };
      if (allowed instanceof Set) {
        if (allowed.size === 0) {
          // Deny-all intersection → unsatisfiable filter → zeroed
          // envelope (consistent with narrowWhereBySubBrand's
          // silent-empty rule).
          taskWhere.id = -1;
        } else {
          taskWhere.contact = { subBrand: { in: [...allowed] } };
        }
      }

      const [users, tasks] = await Promise.all([
        prisma.user.findMany({
          where: { tenantId },
          select: { id: true, name: true, email: true, role: true, userType: true },
        }),
        prisma.task.findMany({
          where: taskWhere,
          select: {
            userId: true,
            dueDate: true,
            contact: { select: { subBrand: true } },
          },
        }),
      ]);

      const now = new Date();
      res.json({
        ...computeTeamWorkload(users, tasks, now),
        generatedAt: now.toISOString(),
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-dashboard] workload error:", e.message);
      res.status(500).json({ error: "Failed to compute workload" });
    }
  },
);

module.exports = router;
