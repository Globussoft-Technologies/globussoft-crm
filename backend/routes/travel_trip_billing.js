// Travel CRM — TMC trip billing + rooming surface.
//
// Rooming assignments + payment plan + per-participant instalments.
// All sub-routes are scoped to a TmcTrip via :tripId in the URL.
//
// Endpoints:
//   GET    /api/travel/trip-billing/stats                     — USER+ tenant-wide TMC rollup
//   GET    /api/travel/trips/:tripId/rooming                  — list rooms
//   POST   /api/travel/trips/:tripId/rooming                  ADMIN+MGR
//   PATCH  /api/travel/trips/:tripId/rooming/:roomId          ADMIN+MGR
//   DELETE /api/travel/trips/:tripId/rooming/:roomId          ADMIN
//   GET    /api/travel/trips/:tripId/rooming/export.xlsx      ADMIN+MGR
//
//   GET    /api/travel/trips/:tripId/payment-plan             — single plan
//   PUT    /api/travel/trips/:tripId/payment-plan             ADMIN+MGR (upsert)
//   DELETE /api/travel/trips/:tripId/payment-plan             ADMIN
//
//   GET    /api/travel/trips/:tripId/instalments              — list per-participant
//   POST   /api/travel/trips/:tripId/instalments              ADMIN+MGR — bulk-create for one participant
//   PATCH  /api/travel/trips/:tripId/instalments/:id          ADMIN+MGR — mark paid
//   DELETE /api/travel/trips/:tripId/instalments/:id          ADMIN
//
// Plan has 1:1 relationship with trip (schema @unique([tripId])).
// PUT semantics: create-or-replace (upsert). Phase 1.5 will add
// /instalments/from-plan that materialises the plan's instalmentsJson
// into actual TripInstalmentPayment rows per participant.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");

const VALID_ROOM_TYPES = ["single", "twin", "triple", "quad"];
const VALID_INSTALMENT_STATUSES = ["pending", "partial", "paid", "overdue"];

async function requireTmcAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-trip-billing] access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

async function loadTrip(req) {
  const tripId = parseInt(req.params.tripId, 10);
  if (!Number.isFinite(tripId)) {
    const err = new Error("tripId must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id: tripId, tenantId: req.travelTenant.id },
    select: { id: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "TRIP_NOT_FOUND"; throw err;
  }
  return trip;
}

// ============================================================================
// GET /api/travel/trip-billing/stats — tenant-wide TMC trip-billing rollup
// (PRD_TRAVEL §TMC).
//
// First rollup endpoint for backend/routes/travel_trip_billing.js. Mirrors
// the canonical /suppliers/stats + /commission-profiles/stats shape — a
// USER-readable anodyne aggregate that powers the TMC ops dashboard's
// trip-billing KPI strip ("4 plans · 23 instalments [12 paid · 8 pending ·
// 2 partial · 1 overdue] · ₹4.5L received · 6 rooms · last plan 3h ago").
//
// Distinct from /trips/:tripId/{rooming,payment-plan,instalments} per-trip
// surfaces — this is the tenant-wide aggregate across ALL TMC trips in the
// caller's tenant. Without this, the frontend would have to fan-out a per-
// trip fetch and reduce client-side — same anti-pattern flagged by the
// "client-side aggregation over paginated endpoint" standing rule.
//
// TMC-locked: the whole travel_trip_billing.js route is sub-brand-gated to
// TMC callers via requireTmcAccess (mirrors per-trip endpoints exactly).
// A non-TMC MANAGER receives 403 SUB_BRAND_DENIED before any aggregation
// runs.
//
// Children don't carry tenantId directly. The schema scopes RoomingAssignment,
// TripPaymentPlan, and TripInstalmentPayment via FK → TmcTrip → tenantId.
// Canonical pattern: fetch the trip-id set first (tenantId-scoped), then
// aggregate the 3 child models scoped to those trip-ids.
//
// Behaviour:
//   - Empty tenant: zeroed envelope with empty buckets + lastPlanCreatedAt=null.
//   - totalTrips: count of trips owning at least one billing row (plan or
//     instalment or rooming).
//   - totalPlans: count of TripPaymentPlan rows for tenant's trips.
//   - totalInstalments: count of TripInstalmentPayment rows.
//   - instalmentsByStatus: { pending, partial, paid, overdue } per the
//     VALID_INSTALMENT_STATUSES enum, pre-seeded so every key exists.
//   - totalReceived: sum of paidAmount on instalments where status='paid',
//     rounded to 2dp.
//   - totalRoomingAssignments: count of RoomingAssignment rows.
//   - lastPlanCreatedAt: ISO of max(createdAt) across plans, or null.
//
// ?from / ?to (ISO date bounds) filter ALL 3 child rows by their createdAt.
// Invalid date → 400 INVALID_DATE.
//
// USER-readable: anodyne aggregate (counts + sums + timestamps); safe.
// No audit row written — read-only meta surface; matches /suppliers/stats.
//
// Express route ordering: literal-path /trip-billing/stats MUST be declared
// BEFORE any /trips/:tripId/... handler — otherwise a stray request to
// /trips/trip-billing/anything would 400 INVALID_ID before reaching here.
// Placed at the top of the route declarations for safety.
// ============================================================================
router.get(
  "/trip-billing/stats",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on the child rows' createdAt
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      let fromDate = null;
      let toDate = null;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        fromDate = d;
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        toDate = d;
      }

      // Fetch this tenant's trip-id set first. Children don't carry tenantId
      // directly — they scope via FK → TmcTrip → tenantId.
      const trips = await prisma.tmcTrip.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const tripIds = trips.map((t) => t.id);

      // Empty short-circuit — return zeroed shape.
      if (tripIds.length === 0) {
        return res.json({
          totalTrips: 0,
          totalPlans: 0,
          totalInstalments: 0,
          instalmentsByStatus: { pending: 0, partial: 0, paid: 0, overdue: 0 },
          totalReceived: 0,
          totalRoomingAssignments: 0,
          lastPlanCreatedAt: null,
        });
      }

      // Build a createdAt clause shared across all child queries.
      const createdAtClause = {};
      if (fromDate) createdAtClause.gte = fromDate;
      if (toDate) createdAtClause.lte = toDate;
      const hasDateClause = Object.keys(createdAtClause).length > 0;

      const planWhere = { tripId: { in: tripIds } };
      const instalmentWhere = { tripId: { in: tripIds } };
      const roomingWhere = { tripId: { in: tripIds } };
      if (hasDateClause) {
        planWhere.createdAt = createdAtClause;
        instalmentWhere.createdAt = createdAtClause;
        roomingWhere.createdAt = createdAtClause;
      }

      // Aggregate the 3 child models scoped to tripIds.
      const [
        plans,
        instalments,
        totalRoomingAssignments,
      ] = await Promise.all([
        prisma.tripPaymentPlan.findMany({
          where: planWhere,
          select: { tripId: true, createdAt: true },
        }),
        prisma.tripInstalmentPayment.findMany({
          where: instalmentWhere,
          select: { tripId: true, status: true, paidAmount: true },
        }),
        prisma.roomingAssignment.count({ where: roomingWhere }),
      ]);

      // Counts + per-status bucketing.
      const instalmentsByStatus = { pending: 0, partial: 0, paid: 0, overdue: 0 };
      let totalReceived = 0;
      for (const ins of instalments) {
        const status = String(ins.status || "pending");
        if (VALID_INSTALMENT_STATUSES.includes(status)) {
          instalmentsByStatus[status] += 1;
        }
        if (status === "paid") {
          const amt = Number(ins.paidAmount);
          if (Number.isFinite(amt)) totalReceived += amt;
        }
      }

      // lastPlanCreatedAt: max(createdAt) across plans.
      let lastPlanCreatedAt = null;
      for (const p of plans) {
        const ts = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
        if (Number.isNaN(ts.getTime())) continue;
        if (!lastPlanCreatedAt || ts > lastPlanCreatedAt) lastPlanCreatedAt = ts;
      }

      // totalTrips: count of distinct trip-ids appearing in any of the 3
      // child sets. A trip with at least one billing row counts.
      const tripsWithBilling = new Set();
      for (const p of plans) tripsWithBilling.add(p.tripId);
      for (const ins of instalments) tripsWithBilling.add(ins.tripId);
      // Rooming is fetched as a count above (perf — most ops dashboards just
      // need the bare number). For the totalTrips set we add rooming-only
      // trips via a lightweight distinct-id fetch IF any rooming rows exist.
      if (totalRoomingAssignments > 0) {
        const roomingTrips = await prisma.roomingAssignment.findMany({
          where: roomingWhere,
          select: { tripId: true },
          distinct: ["tripId"],
        });
        for (const r of roomingTrips) tripsWithBilling.add(r.tripId);
      }

      // Half-up round to 2dp — matches sibling stats endpoints.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      res.json({
        totalTrips: tripsWithBilling.size,
        totalPlans: plans.length,
        totalInstalments: instalments.length,
        instalmentsByStatus,
        totalReceived: round2(totalReceived),
        totalRoomingAssignments,
        lastPlanCreatedAt: lastPlanCreatedAt ? lastPlanCreatedAt.toISOString() : null,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trip-billing] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise trip billing" });
    }
  },
);

// ============================================================================
// GET /api/travel/trip-billing/by-month — tenant-wide TMC instalment monthly
// rollup (PRD_TRAVEL §TMC trip-billing).
//
// Sibling to /trip-billing/stats (slice shipped earlier — single point-in-time
// KPI tile). /by-month is the per-month time series across the same TMC
// instalment population — powers the trip-billing dashboard's trend chart so
// the operator can see how cash collection has trended over time without
// fan-out-and-reduce on the frontend.
//
// Mirrors /suppliers/by-month + /commission-profiles/by-month + /quotes/by-month
// shape — one row per UTC YYYY-MM bucket, JS-side aggregation over a light
// findMany projection, default orderBy=month:asc, pagination AFTER aggregation
// + sort + filter, NO audit row written.
//
// TMC-locked: the whole travel_trip_billing.js route is sub-brand-gated to TMC
// callers via requireTmcAccess (mirrors per-trip endpoints + /stats exactly).
// A non-TMC MANAGER receives 403 SUB_BRAND_DENIED before any aggregation runs.
//
// Tenant scoping: TripInstalmentPayment children don't carry tenantId directly.
// The schema scopes via FK → TmcTrip → tenantId. Canonical pattern (matching
// /stats): fetch the trip-id set first (tenantId-scoped), then aggregate the
// child rows scoped to those trip-ids.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid → 400
//                     INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Per-bucket breakdown:
//   - count: total instalment rows landing in this month bucket
//   - byStatus: { pending, partial, paid, overdue } — the four
//     VALID_INSTALMENT_STATUSES values, pre-seeded so every key exists on
//     every bucket (schema is lowercase per prisma/schema.prisma:4594 — the
//     instalment.status enum is lowercase strings, NOT uppercase; mirrors
//     the /stats handler at the top of this file)
//   - totalReceived: sum of paidAmount across this bucket's rows, half-up
//     rounded to 2dp. Matches /stats's totalReceived semantics.
//
// "unknown" bucket: rows with null/invalid createdAt land here so the count
// surface stays accurate. Excluded when ?from / ?to is set (no comparable
// month token); included otherwise.
//
// Express route ordering: literal-path /trip-billing/by-month MUST be declared
// BEFORE any /trips/:tripId/... handler or `:tripId="trip-billing"` would
// 400 INVALID_ID before reaching this handler. Placed adjacent to
// /trip-billing/stats at the top.
// ============================================================================
router.get(
  "/trip-billing/by-month",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors /suppliers/by-month.
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
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Tenant scoping — fetch this tenant's TMC trip-id set first.
      const trips = await prisma.tmcTrip.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const tripIds = trips.map((t) => t.id);

      // Empty short-circuit — return zeroed envelope.
      if (tripIds.length === 0) {
        return res.json({
          total: 0,
          rows: [],
        });
      }

      // Light projection — status + paidAmount + createdAt is enough for the
      // bucket totals. tripId scoping replaces tenantId (children don't carry
      // tenantId directly).
      const instalments = await prisma.tripInstalmentPayment.findMany({
        where: { tripId: { in: tripIds } },
        select: { status: true, paidAmount: true, createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → {count, byStatus, totalReceived}.
      // Null/invalid createdAt rows land in "unknown".
      const byMonth = new Map();
      for (const ins of instalments) {
        let monthKey = "unknown";
        if (ins.createdAt) {
          const dt = ins.createdAt instanceof Date
            ? ins.createdAt
            : new Date(ins.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            monthKey = `${yyyy}-${mm}`;
          }
        }

        let bucket = byMonth.get(monthKey);
        if (!bucket) {
          bucket = {
            month: monthKey,
            count: 0,
            byStatus: { pending: 0, partial: 0, paid: 0, overdue: 0 },
            totalReceived: 0,
          };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;

        const status = String(ins.status || "pending");
        if (VALID_INSTALMENT_STATUSES.includes(status)) {
          bucket.byStatus[status] += 1;
        }

        const amt = Number(ins.paidAmount);
        if (Number.isFinite(amt)) bucket.totalReceived += amt;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either bound
      // is set (no comparable token); kept otherwise so the count surface
      // remains complete. Mirrors /suppliers/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Half-up round totalReceived to 2dp per bucket — matches /stats and
      // sibling /by-month endpoints' precision posture.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
      for (const r of months) r.totalReceived = round2(r.totalReceived);

      // Sort. "month" sorts lexicographically on YYYY-MM (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-12") — acceptable for a defensive fallback bucket that should
      // rarely appear.
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

      const total = months.length;

      // Pagination AFTER aggregation + sort + filter, same as /suppliers/by-month.
      const paged = months.slice(skip, skip + take);

      res.json({
        total,
        rows: paged,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trip-billing] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ─── Rooming ─────────────────────────────────────────────────────────

router.get("/trips/:tripId/rooming", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const rows = await prisma.roomingAssignment.findMany({
      where: { tripId: trip.id },
      orderBy: { roomNumber: "asc" },
    });
    res.json({ rooming: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trip-billing] rooming list error:", e.message);
    res.status(500).json({ error: "Failed to list rooming" });
  }
});

router.post(
  "/trips/:tripId/rooming",
  verifyToken,
  requirePermission("trips", "write"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const { roomNumber, roomType, participantIds } = req.body || {};
      if (!roomNumber || !roomType || !Array.isArray(participantIds)) {
        return res.status(400).json({
          error: "roomNumber, roomType, participantIds[] required",
          code: "MISSING_FIELDS",
        });
      }
      if (!VALID_ROOM_TYPES.includes(roomType)) {
        return res.status(400).json({
          error: `roomType must be one of: ${VALID_ROOM_TYPES.join(", ")}`,
          code: "INVALID_ROOM_TYPE",
        });
      }
      const capLimit = { single: 1, twin: 2, triple: 3, quad: 4 }[roomType];
      if (participantIds.length > capLimit) {
        return res.status(400).json({
          error: `roomType "${roomType}" allows at most ${capLimit} participants`,
          code: "ROOM_CAPACITY_EXCEEDED",
        });
      }
      // Sanity: all participantIds must belong to this trip
      if (participantIds.length > 0) {
        const ids = participantIds.map((x) => parseInt(x, 10)).filter(Number.isFinite);
        const count = await prisma.tripParticipant.count({
          where: { id: { in: ids }, tripId: trip.id },
        });
        if (count !== ids.length) {
          return res.status(400).json({
            error: "one or more participantIds aren't on this trip",
            code: "PARTICIPANTS_OFF_TRIP",
          });
        }
      }
      const created = await prisma.roomingAssignment.create({
        data: {
          tripId: trip.id,
          roomNumber: String(roomNumber),
          roomType,
          participantIds: JSON.stringify(participantIds),
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] rooming create error:", err.message);
      res.status(500).json({ error: "Failed to create rooming" });
    }
  },
);

router.patch(
  "/trips/:tripId/rooming/:roomId",
  verifyToken,
  requirePermission("trips", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const roomId = parseInt(req.params.roomId, 10);
      if (!Number.isFinite(roomId)) return res.status(400).json({ error: "roomId must be a number", code: "INVALID_ROOM_ID" });
      const existing = await prisma.roomingAssignment.findFirst({
        where: { id: roomId, tripId: trip.id },
      });
      if (!existing) return res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });

      const data = {};
      const { roomNumber, roomType, participantIds } = req.body || {};
      if (roomNumber !== undefined) data.roomNumber = String(roomNumber);
      if (roomType !== undefined) {
        if (!VALID_ROOM_TYPES.includes(roomType)) {
          return res.status(400).json({ error: "invalid roomType", code: "INVALID_ROOM_TYPE" });
        }
        data.roomType = roomType;
      }
      if (participantIds !== undefined) {
        if (!Array.isArray(participantIds)) return res.status(400).json({ error: "participantIds must be an array", code: "INVALID_PARTICIPANTS" });
        const finalType = data.roomType || existing.roomType;
        const capLimit = { single: 1, twin: 2, triple: 3, quad: 4 }[finalType];
        if (participantIds.length > capLimit) {
          return res.status(400).json({
            error: `roomType "${finalType}" allows at most ${capLimit} participants`,
            code: "ROOM_CAPACITY_EXCEEDED",
          });
        }
        data.participantIds = JSON.stringify(participantIds);
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.roomingAssignment.update({ where: { id: roomId }, data });
      res.json(updated);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] rooming patch error:", err.message);
      res.status(500).json({ error: "Failed to update rooming" });
    }
  },
);

router.delete(
  "/trips/:tripId/rooming/:roomId",
  verifyToken,
  requirePermission("trips", "delete"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const roomId = parseInt(req.params.roomId, 10);
      if (!Number.isFinite(roomId)) return res.status(400).json({ error: "roomId must be a number", code: "INVALID_ROOM_ID" });
      const existing = await prisma.roomingAssignment.findFirst({
        where: { id: roomId, tripId: trip.id },
      });
      if (!existing) return res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      await prisma.roomingAssignment.delete({ where: { id: roomId } });
      res.json({ deleted: true, id: roomId });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] rooming delete error:", err.message);
      res.status(500).json({ error: "Failed to delete rooming" });
    }
  },
);

// GET /api/travel/trips/:tripId/rooming/export.xlsx
//
// Streams a single-sheet XLSX of this trip's rooming assignments.
// Columns: Room # / Room type / Capacity / Occupancy / Participants
// (joined names looked up from TripParticipant.fullName via the
// participantIds JSON-array column on RoomingAssignment).
//
// URL shape: path segment (`/rooming/export.xlsx`) rather than dot-on-
// param (`/rooming.xlsx`). A repo-wide grep for `/:\w+\.\w+["']` returns
// zero hits, so the established pattern is path-segment delimiting
// (compare `/itineraries/:id/pdf` in travel_itineraries.js:925). Keeps
// route-matcher behaviour unambiguous — `:tripId` cannot accidentally
// swallow a trailing `.xlsx`.
//
// Auth: same gates as the destructive rooming routes — verifyToken +
// ADMIN/MANAGER + requireTravelTenant + requireTmcAccess. The viewer
// already has GET /rooming so we deliberately don't tighten further.
router.get(
  "/trips/:tripId/rooming/export.xlsx",
  verifyToken,
  requirePermission("trips", "export"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      // Load rooms + the trip's participant roster in parallel — we
      // join participantIds (JSON-string array of TripParticipant.id)
      // to fullName via the roster map.
      const [rooms, participants] = await Promise.all([
        prisma.roomingAssignment.findMany({
          where: { tripId: trip.id },
          orderBy: { roomNumber: "asc" },
        }),
        prisma.tripParticipant.findMany({
          where: { tripId: trip.id },
          select: { id: true, fullName: true },
        }),
      ]);
      const nameById = new Map(participants.map((p) => [p.id, p.fullName]));

      const XLSX = require("xlsx");
      const ROOM_CAPACITY = { single: 1, twin: 2, triple: 3, quad: 4 };
      const aoa = [
        ["Room #", "Room type", "Capacity", "Occupancy", "Participants"],
      ];
      for (const room of rooms) {
        let pids = [];
        try {
          pids = JSON.parse(room.participantIds || "[]");
        } catch (_e) {
          pids = [];
        }
        if (!Array.isArray(pids)) pids = [];
        const names = pids
          .map((pid) => nameById.get(Number(pid)) || `#${pid}`)
          .join(", ");
        const capacity = ROOM_CAPACITY[room.roomType] || pids.length;
        aoa.push([
          room.roomNumber,
          room.roomType,
          capacity,
          pids.length,
          names,
        ]);
      }

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Column widths — rough heuristic for readability in Excel.
      ws["!cols"] = [
        { wch: 10 }, // Room #
        { wch: 10 }, // Room type
        { wch: 10 }, // Capacity
        { wch: 10 }, // Occupancy
        { wch: 60 }, // Participants
      ];
      XLSX.utils.book_append_sheet(wb, ws, "Rooming");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="rooming-trip-${trip.id}.xlsx"`,
      );
      res.send(buf);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trip-billing] rooming xlsx error:", e.message);
      res.status(500).json({ error: "Failed to export rooming XLSX" });
    }
  },
);

// ─── Payment plan ────────────────────────────────────────────────────

router.get(
  "/trips/:tripId/payment-plan",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const plan = await prisma.tripPaymentPlan.findUnique({ where: { tripId: trip.id } });
      if (!plan) return res.status(404).json({ error: "Payment plan not found", code: "NOT_FOUND" });
      res.json(plan);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] plan get error:", err.message);
      res.status(500).json({ error: "Failed to get payment plan" });
    }
  },
);

router.put(
  "/trips/:tripId/payment-plan",
  verifyToken,
  requirePermission("trips", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const { instalmentsJson, graceDays } = req.body || {};
      if (!instalmentsJson) {
        return res.status(400).json({ error: "instalmentsJson required", code: "MISSING_FIELDS" });
      }
      // Validate JSON parseability + non-empty array shape.
      let parsed;
      try {
        parsed = JSON.parse(instalmentsJson);
      } catch (_e) {
        return res.status(400).json({ error: "instalmentsJson is not valid JSON", code: "INVALID_JSON" });
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return res.status(400).json({ error: "instalmentsJson must be a non-empty array", code: "EMPTY_INSTALMENTS" });
      }

      const plan = await prisma.tripPaymentPlan.upsert({
        where: { tripId: trip.id },
        update: {
          instalmentsJson: String(instalmentsJson),
          graceDays: graceDays != null ? parseInt(graceDays, 10) : 0,
        },
        create: {
          tripId: trip.id,
          instalmentsJson: String(instalmentsJson),
          graceDays: graceDays != null ? parseInt(graceDays, 10) : 0,
        },
      });
      res.json(plan);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] plan put error:", err.message);
      res.status(500).json({ error: "Failed to save payment plan" });
    }
  },
);

router.delete(
  "/trips/:tripId/payment-plan",
  verifyToken,
  requirePermission("trips", "delete"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const existing = await prisma.tripPaymentPlan.findUnique({ where: { tripId: trip.id } });
      if (!existing) return res.status(404).json({ error: "Payment plan not found", code: "NOT_FOUND" });
      await prisma.tripPaymentPlan.delete({ where: { tripId: trip.id } });
      res.json({ deleted: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] plan delete error:", err.message);
      res.status(500).json({ error: "Failed to delete payment plan" });
    }
  },
);

// ─── Per-participant instalments ─────────────────────────────────────

router.get(
  "/trips/:tripId/instalments",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const where = { tripId: trip.id };
      if (req.query.participantId) {
        const pid = parseInt(req.query.participantId, 10);
        if (Number.isFinite(pid)) where.participantId = pid;
      }
      if (req.query.status) {
        if (!VALID_INSTALMENT_STATUSES.includes(String(req.query.status))) {
          return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
        }
        where.status = String(req.query.status);
      }
      const rows = await prisma.tripInstalmentPayment.findMany({
        where,
        orderBy: [{ participantId: "asc" }, { instalmentIndex: "asc" }],
        take: 500,
      });
      res.json({ instalments: rows });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] instalment list error:", err.message);
      res.status(500).json({ error: "Failed to list instalments" });
    }
  },
);

router.post(
  "/trips/:tripId/instalments",
  verifyToken,
  requirePermission("trips", "write"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const { participantId, instalmentIndex, dueDate, amount } = req.body || {};
      if (!participantId || instalmentIndex == null || !dueDate || amount == null) {
        return res.status(400).json({
          error: "participantId, instalmentIndex, dueDate, amount required",
          code: "MISSING_FIELDS",
        });
      }
      const pid = parseInt(participantId, 10);
      const idx = parseInt(instalmentIndex, 10);
      const amt = Number(amount);
      if (!Number.isFinite(pid) || !Number.isFinite(idx) || !Number.isFinite(amt) || amt < 0) {
        return res.status(400).json({ error: "invalid numeric input", code: "INVALID_INPUT" });
      }
      const due = new Date(dueDate);
      if (!Number.isFinite(due.getTime())) {
        return res.status(400).json({ error: "invalid dueDate", code: "INVALID_DATE" });
      }
      // Participant must be on this trip
      const participant = await prisma.tripParticipant.findFirst({
        where: { id: pid, tripId: trip.id },
        select: { id: true },
      });
      if (!participant) {
        return res.status(400).json({ error: "participantId not on this trip", code: "PARTICIPANT_OFF_TRIP" });
      }

      const created = await prisma.tripInstalmentPayment.create({
        data: {
          tripId: trip.id,
          participantId: pid,
          instalmentIndex: idx,
          dueDate: due,
          amount: amt,
          status: "pending",
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] instalment create error:", err.message);
      res.status(500).json({ error: "Failed to create instalment" });
    }
  },
);

router.patch(
  "/trips/:tripId/instalments/:id",
  verifyToken,
  requirePermission("trips", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.tripInstalmentPayment.findFirst({
        where: { id, tripId: trip.id },
      });
      if (!existing) return res.status(404).json({ error: "Instalment not found", code: "NOT_FOUND" });

      const data = {};
      const { amount, paidAmount, paidAt, status, invoiceId } = req.body || {};
      if (amount !== undefined) {
        const a = Number(amount);
        if (!Number.isFinite(a) || a < 0) return res.status(400).json({ error: "invalid amount", code: "INVALID_AMOUNT" });
        data.amount = a;
      }
      if (paidAmount !== undefined) {
        const p = Number(paidAmount);
        if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: "invalid paidAmount", code: "INVALID_AMOUNT" });
        data.paidAmount = p;
      }
      if (paidAt !== undefined) data.paidAt = paidAt ? new Date(paidAt) : null;
      if (status !== undefined) {
        if (!VALID_INSTALMENT_STATUSES.includes(status)) {
          return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
        }
        data.status = status;
      }
      if (invoiceId !== undefined) data.invoiceId = invoiceId ? parseInt(invoiceId, 10) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.tripInstalmentPayment.update({ where: { id }, data });
      res.json(updated);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] instalment patch error:", err.message);
      res.status(500).json({ error: "Failed to update instalment" });
    }
  },
);

router.delete(
  "/trips/:tripId/instalments/:id",
  verifyToken,
  requirePermission("trips", "delete"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.tripInstalmentPayment.findFirst({
        where: { id, tripId: trip.id },
      });
      if (!existing) return res.status(404).json({ error: "Instalment not found", code: "NOT_FOUND" });
      await prisma.tripInstalmentPayment.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-trip-billing] instalment delete error:", err.message);
      res.status(500).json({ error: "Failed to delete instalment" });
    }
  },
);

module.exports = router;
