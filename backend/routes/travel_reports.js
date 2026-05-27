// Travel CRM — Reports aggregates (Phase 1 §4.9).
//
// Three endpoints, each tenant-scoped + sub-brand-narrowed by the caller's
// `subBrandAccess`. Returns DRILL-DOWN data — the Owner Dashboard
// (travel_dashboard.js) is the summary tier (single counts); these are the
// next layer (groupings, top-N, trend lines) for the Reports page.
//
//   GET /api/travel/reports/tmc          TMC analytics
//   GET /api/travel/reports/rfu          RFU analytics
//   GET /api/travel/reports/cross-brand  Multi-sub-brand revenue + conversion
//
// All aggregates fire via Promise.all so each endpoint resolves in
// ~one round-trip. None of the payloads include PII (no participant names,
// no contact emails); they're shaped for charts / tables.

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

function scoped(req, allowed, extra = {}) {
  const where = { tenantId: req.travelTenant.id, ...extra };
  if (allowed !== null) {
    // When the caller has a narrow access set, intersect on subBrand.
    if (where.subBrand !== undefined) {
      // Caller-pinned subBrand wins; if denied, the route handler will
      // 403 separately. This branch is only hit when the route function
      // pre-set subBrand (e.g. TMC report fixes subBrand="tmc").
      if (!canAccessSubBrand(allowed, where.subBrand)) {
        where.subBrand = "__none__";
      }
    } else {
      where.subBrand = { in: [...allowed] };
    }
  }
  return where;
}

function flattenGroupCount(rows, key, field = "_count") {
  const out = {};
  for (const r of rows) {
    out[r[key]] = field === "_count" ? (r._count?._all ?? 0) : (r[field] ?? 0);
  }
  return out;
}

function flattenGroupSum(rows, key, sumField) {
  const out = {};
  for (const r of rows) {
    const v = r._sum?.[sumField];
    out[r[key]] = v != null ? Number(v) : 0;
  }
  return out;
}

// ── TMC analytics ──────────────────────────────────────────────────
//
// TMC is school-trips. Revenue computed as pricePerStudent × participantCount
// for confirmed/in-trip/completed trips. Repeat schools = contacts with ≥2
// trips. Conversion-by-diagnostic-score requires joining trips to the
// originating diagnostic, which TmcTrip doesn't link directly — we approximate
// by Deal.subBrand='tmc' joined to Deal.diagnosticId.

router.get("/reports/tmc", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    // Hard-block TMC reports for users with no TMC access.
    if (!canAccessSubBrand(allowed, "tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }

    const tenantId = req.travelTenant.id;

    // All trips, separated by status: active = confirmed | in-trip | completed.
    // cancelled trips are excluded from revenue totals.
    const ACTIVE_STATUSES = ["confirmed", "in-trip", "completed"];

    const [
      tripsByStatus,
      activeTrips,
      participantCountsByTrip,
      tmcDealsByStage,
      tmcDealAmountByStage,
      tmcDiagnosticsByClassification,
    ] = await Promise.all([
      prisma.tmcTrip.groupBy({
        by: ["status"],
        where: { tenantId },
        _count: { _all: true },
      }),
      prisma.tmcTrip.findMany({
        where: { tenantId, status: { in: ACTIVE_STATUSES } },
        select: {
          id: true,
          destination: true,
          pricePerStudent: true,
          schoolContactId: true,
        },
      }),
      prisma.tripParticipant.groupBy({
        by: ["tripId"],
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: { tenantId, subBrand: "tmc", deletedAt: null },
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: { tenantId, subBrand: "tmc", deletedAt: null },
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["classification"],
        where: { tenantId, subBrand: "tmc" },
        _count: { _all: true },
      }),
    ]);

    // Build a quick lookup: tripId → participantCount.
    const participantByTrip = {};
    for (const row of participantCountsByTrip) {
      participantByTrip[row.tripId] = row._count?._all ?? 0;
    }

    // Revenue by destination = SUM(pricePerStudent × participantCount).
    // Tracked schools = set of schoolContactId for repeat-school detection.
    const revByDest = {};
    const schoolTripCount = {};
    let totalRevenue = 0;
    for (const trip of activeTrips) {
      const headcount = participantByTrip[trip.id] || 0;
      const price = trip.pricePerStudent ? Number(trip.pricePerStudent) : 0;
      const tripRevenue = price * headcount;
      revByDest[trip.destination] = (revByDest[trip.destination] || 0) + tripRevenue;
      totalRevenue += tripRevenue;
      schoolTripCount[trip.schoolContactId] = (schoolTripCount[trip.schoolContactId] || 0) + 1;
    }

    // Top destinations sorted by revenue DESC, take 10.
    const topDestinations = Object.entries(revByDest)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([destination, revenue]) => ({ destination, revenue }));

    const schools = Object.keys(schoolTripCount).length;
    const repeatSchools = Object.values(schoolTripCount).filter((c) => c >= 2).length;

    res.json({
      trips: {
        total: tripsByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
        byStatus: flattenGroupCount(tripsByStatus, "status"),
        active: activeTrips.length,
      },
      revenue: {
        total: totalRevenue,
        topDestinations,
        currency: "INR",
      },
      schools: {
        unique: schools,
        repeat: repeatSchools,
        repeatRatePct: schools > 0 ? Number(((repeatSchools / schools) * 100).toFixed(2)) : 0,
      },
      deals: {
        byStage: flattenGroupCount(tmcDealsByStage, "stage"),
        amountByStage: flattenGroupSum(tmcDealAmountByStage, "stage", "amount"),
      },
      diagnostics: {
        byClassification: flattenGroupCount(tmcDiagnosticsByClassification, "classification"),
      },
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] TMC error:", e.message);
    res.status(500).json({ error: "Failed to compute TMC report" });
  }
});

// ── RFU analytics ──────────────────────────────────────────────────
//
// RFU is Umrah pilgrimage. Revenue lives in Itinerary.totalAmount. Tier
// (entry/primary/premium) lives in TravelDiagnostic.recommendedTier — to
// link revenue to tier we'd need diagnostic→contact→itinerary joins; for
// the first ship we group separately and let the frontend correlate.

router.get("/reports/rfu", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, "rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    const tenantId = req.travelTenant.id;

    const [
      itinByStatus,
      itinAmountByStatus,
      rfuDealsByStage,
      rfuDealAmountByStage,
      rfuDiagByTier,
      rfuDiagByClassification,
      itinByContact,
    ] = await Promise.all([
      prisma.itinerary.groupBy({
        by: ["status"],
        where: { tenantId, subBrand: "rfu" },
        _count: { _all: true },
      }),
      prisma.itinerary.groupBy({
        by: ["status"],
        where: { tenantId, subBrand: "rfu" },
        _sum: { totalAmount: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: { tenantId, subBrand: "rfu", deletedAt: null },
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: { tenantId, subBrand: "rfu", deletedAt: null },
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["recommendedTier"],
        where: { tenantId, subBrand: "rfu" },
        _count: { _all: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["classification"],
        where: { tenantId, subBrand: "rfu" },
        _count: { _all: true },
      }),
      prisma.itinerary.groupBy({
        by: ["contactId"],
        where: { tenantId, subBrand: "rfu" },
        _count: { _all: true },
      }),
    ]);

    const customers = itinByContact.length;
    const repeatCustomers = itinByContact.filter((r) => (r._count?._all ?? 0) >= 2).length;

    res.json({
      itineraries: {
        total: itinByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
        byStatus: flattenGroupCount(itinByStatus, "status"),
        amountByStatus: flattenGroupSum(itinAmountByStatus, "status", "totalAmount"),
      },
      deals: {
        byStage: flattenGroupCount(rfuDealsByStage, "stage"),
        amountByStage: flattenGroupSum(rfuDealAmountByStage, "stage", "amount"),
      },
      diagnostics: {
        byTier: flattenGroupCount(rfuDiagByTier, "recommendedTier"),
        byClassification: flattenGroupCount(rfuDiagByClassification, "classification"),
      },
      customers: {
        unique: customers,
        repeat: repeatCustomers,
        repeatRatePct: customers > 0 ? Number(((repeatCustomers / customers) * 100).toFixed(2)) : 0,
      },
      currency: "INR",
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] RFU error:", e.message);
    res.status(500).json({ error: "Failed to compute RFU report" });
  }
});

// ── Cross-brand summary ────────────────────────────────────────────
//
// Side-by-side comparison of all sub-brands the caller can see. Won deals
// only for revenue totals. Conversion = won / (won + lost) for stages
// reached terminal state.

router.get("/reports/cross-brand", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const tenantId = req.travelTenant.id;

    // Build the subBrand filter only when caller has restricted access.
    const dealWhere = { tenantId, deletedAt: null, subBrand: { not: null } };
    if (allowed !== null) dealWhere.subBrand = { in: [...allowed] };

    const [dealsBySubBrandStage, dealAmountBySubBrandStage, diagBySubBrand] = await Promise.all([
      prisma.deal.groupBy({
        by: ["subBrand", "stage"],
        where: dealWhere,
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["subBrand", "stage"],
        where: dealWhere,
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["subBrand"],
        where: scoped(req, allowed),
        _count: { _all: true },
      }),
    ]);

    // Reshape into per-sub-brand object: { tmc: { won, lost, ... }, rfu: ... }
    const subBrands = {};
    function ensure(b) {
      if (!subBrands[b]) {
        subBrands[b] = {
          dealsByStage: {},
          dealAmountByStage: {},
          diagnostics: 0,
        };
      }
      return subBrands[b];
    }
    for (const r of dealsBySubBrandStage) {
      ensure(r.subBrand).dealsByStage[r.stage] = r._count?._all ?? 0;
    }
    for (const r of dealAmountBySubBrandStage) {
      const v = r._sum?.amount;
      ensure(r.subBrand).dealAmountByStage[r.stage] = v != null ? Number(v) : 0;
    }
    for (const r of diagBySubBrand) {
      ensure(r.subBrand).diagnostics = r._count?._all ?? 0;
    }

    // Compute won + conversion per sub-brand.
    for (const b of Object.keys(subBrands)) {
      const stages = subBrands[b].dealsByStage;
      const won = stages.won || 0;
      const lost = stages.lost || 0;
      subBrands[b].won = won;
      subBrands[b].lost = lost;
      subBrands[b].wonRevenue = subBrands[b].dealAmountByStage.won || 0;
      subBrands[b].conversionPct = (won + lost) > 0
        ? Number(((won / (won + lost)) * 100).toFixed(2))
        : 0;
    }

    res.json({ subBrands, currency: "INR" });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] cross-brand error:", e.message);
    res.status(500).json({ error: "Failed to compute cross-brand report" });
  }
});

// ── One-shot dashboard summary ─────────────────────────────────────
//
// GET /api/travel/reports/summary
//
// Rolls up TMC + RFU + cross-brand into a single snapshot keyed for the
// Reports landing-page header. Each sub-section is a SUMMARY of the
// corresponding /reports/<x> endpoint's payload — top-level counts and
// totals only, not the full rows / topN lists / per-stage breakdowns.
// The frontend dashboard header renders this one payload; deeper
// drill-down pages still call the existing /reports/tmc | /rfu |
// /cross-brand for the full detail.
//
// Graceful degradation: each section is wrapped independently. If the
// caller can't see a sub-brand (e.g. MANAGER with subBrandAccess=["rfu"]
// hits the summary → tmc + crossBrand sections are null) OR the
// underlying aggregate query throws, the section becomes `null` while
// the others survive. This avoids a single broken table killing the
// whole dashboard.
//
// Query params:
//   ?from=ISO  ?to=ISO   — optional createdAt bounds; forwarded as a
//                          where.createdAt filter to every sub-query.
//
// Response shape:
//   {
//     tmc:        { trips, revenue, schools }   | null,
//     rfu:        { itineraries, customers }    | null,
//     crossBrand: { subBrandCount, totalWon, totalLost, totalWonRevenue }
//                                               | null,
//     generatedAt: ISO,
//   }

function parseDateRange(req) {
  const range = {};
  if (req.query.from) {
    const d = new Date(req.query.from);
    if (!isNaN(d.getTime())) range.gte = d;
  }
  if (req.query.to) {
    const d = new Date(req.query.to);
    if (!isNaN(d.getTime())) range.lte = d;
  }
  return Object.keys(range).length ? range : null;
}

async function tmcSummary(req, allowed, dateRange) {
  if (!canAccessSubBrand(allowed, "tmc")) return null;
  const tenantId = req.travelTenant.id;
  const ACTIVE_STATUSES = ["confirmed", "in-trip", "completed"];

  const tripWhere = { tenantId };
  if (dateRange) tripWhere.createdAt = dateRange;
  const activeWhere = { ...tripWhere, status: { in: ACTIVE_STATUSES } };

  const [tripsByStatus, activeTrips, participantCountsByTrip] = await Promise.all([
    prisma.tmcTrip.groupBy({ by: ["status"], where: tripWhere, _count: { _all: true } }),
    prisma.tmcTrip.findMany({
      where: activeWhere,
      select: { id: true, pricePerStudent: true, schoolContactId: true },
    }),
    prisma.tripParticipant.groupBy({ by: ["tripId"], _count: { _all: true } }),
  ]);

  const participantByTrip = {};
  for (const row of participantCountsByTrip) {
    participantByTrip[row.tripId] = row._count?._all ?? 0;
  }

  let totalRevenue = 0;
  const schoolTripCount = {};
  for (const trip of activeTrips) {
    const headcount = participantByTrip[trip.id] || 0;
    const price = trip.pricePerStudent ? Number(trip.pricePerStudent) : 0;
    totalRevenue += price * headcount;
    schoolTripCount[trip.schoolContactId] =
      (schoolTripCount[trip.schoolContactId] || 0) + 1;
  }
  const schools = Object.keys(schoolTripCount).length;
  const repeatSchools = Object.values(schoolTripCount).filter((c) => c >= 2).length;

  return {
    trips: {
      total: tripsByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
      active: activeTrips.length,
    },
    revenue: { total: totalRevenue, currency: "INR" },
    schools: {
      unique: schools,
      repeat: repeatSchools,
      repeatRatePct: schools > 0
        ? Number(((repeatSchools / schools) * 100).toFixed(2))
        : 0,
    },
  };
}

async function rfuSummary(req, allowed, dateRange) {
  if (!canAccessSubBrand(allowed, "rfu")) return null;
  const tenantId = req.travelTenant.id;

  const itinWhere = { tenantId, subBrand: "rfu" };
  if (dateRange) itinWhere.createdAt = dateRange;

  const [itinByStatus, itinAmountByStatus, itinByContact] = await Promise.all([
    prisma.itinerary.groupBy({
      by: ["status"], where: itinWhere, _count: { _all: true },
    }),
    prisma.itinerary.groupBy({
      by: ["status"], where: itinWhere, _sum: { totalAmount: true },
    }),
    prisma.itinerary.groupBy({
      by: ["contactId"], where: itinWhere, _count: { _all: true },
    }),
  ]);

  let totalRevenue = 0;
  for (const r of itinAmountByStatus) {
    const v = r._sum?.totalAmount;
    if (v != null) totalRevenue += Number(v);
  }
  const customers = itinByContact.length;
  const repeatCustomers = itinByContact.filter(
    (r) => (r._count?._all ?? 0) >= 2,
  ).length;

  return {
    itineraries: {
      total: itinByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
      revenue: totalRevenue,
    },
    customers: {
      unique: customers,
      repeat: repeatCustomers,
      repeatRatePct: customers > 0
        ? Number(((repeatCustomers / customers) * 100).toFixed(2))
        : 0,
    },
    currency: "INR",
  };
}

async function crossBrandSummary(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  const dealWhere = { tenantId, deletedAt: null, subBrand: { not: null } };
  if (allowed !== null) {
    if (allowed.size === 0) return null;
    dealWhere.subBrand = { in: [...allowed] };
  }
  if (dateRange) dealWhere.createdAt = dateRange;

  const [dealsBySubBrandStage, dealAmountBySubBrandStage] = await Promise.all([
    prisma.deal.groupBy({
      by: ["subBrand", "stage"], where: dealWhere, _count: { _all: true },
    }),
    prisma.deal.groupBy({
      by: ["subBrand", "stage"], where: dealWhere, _sum: { amount: true },
    }),
  ]);

  const subBrandSet = new Set();
  let totalWon = 0;
  let totalLost = 0;
  for (const r of dealsBySubBrandStage) {
    subBrandSet.add(r.subBrand);
    const c = r._count?._all ?? 0;
    if (r.stage === "won") totalWon += c;
    else if (r.stage === "lost") totalLost += c;
  }
  let totalWonRevenue = 0;
  for (const r of dealAmountBySubBrandStage) {
    if (r.stage === "won") {
      const v = r._sum?.amount;
      if (v != null) totalWonRevenue += Number(v);
    }
  }
  const conversionPct = (totalWon + totalLost) > 0
    ? Number(((totalWon / (totalWon + totalLost)) * 100).toFixed(2))
    : 0;

  return {
    subBrandCount: subBrandSet.size,
    totalWon,
    totalLost,
    totalWonRevenue,
    conversionPct,
    currency: "INR",
  };
}

router.get("/reports/summary", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const dateRange = parseDateRange(req);

    // Graceful degradation: each section resolves independently. A throw
    // OR a sub-brand-restriction collapses that section to null instead
    // of failing the whole snapshot. This keeps the dashboard partially
    // usable when one aggregate path is unhealthy.
    const wrap = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        console.error(`[travel-reports] summary.${label} error:`, e.message);
        return null;
      }
    };

    const [tmc, rfu, crossBrand] = await Promise.all([
      wrap("tmc", () => tmcSummary(req, allowed, dateRange)),
      wrap("rfu", () => rfuSummary(req, allowed, dateRange)),
      wrap("crossBrand", () => crossBrandSummary(req, allowed, dateRange)),
    ]);

    res.json({
      tmc,
      rfu,
      crossBrand,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] summary error:", e.message);
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

module.exports = router;
