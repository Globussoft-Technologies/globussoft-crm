// Travel CRM — TMC trip billing + rooming surface.
//
// Rooming assignments + payment plan + per-participant instalments.
// All sub-routes are scoped to a TmcTrip via :tripId in the URL.
//
// Endpoints:
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN", "MANAGER"]),
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
  verifyRole(["ADMIN"]),
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
