// Travel CRM — TMC trip CRUD routes (Phase 1 MVP).
//
// Endpoints:
//   GET    /api/travel/trips                                   — list trips
//   POST   /api/travel/trips                                   — create trip
//   GET    /api/travel/trips/:id                               — fetch with children
//   PATCH  /api/travel/trips/:id                               — amend trip
//   DELETE /api/travel/trips/:id                               — ADMIN only (cascades)
//
//   GET    /api/travel/trips/:id/participants                  — list participants
//   POST   /api/travel/trips/:id/participants                  — add participant
//   PATCH  /api/travel/trips/:id/participants/:pid             — amend participant
//   DELETE /api/travel/trips/:id/participants/:pid             — remove participant
//
//   POST   /api/travel/trips/:tripId/participants/:participantId/digilocker/initiate
//                                                              — start DigiLocker OAuth (stub-mode, PRD §4.5)
//   POST   /api/travel/trips/:tripId/participants/:participantId/digilocker/callback
//                                                              — exchange state+code, persist Aadhaar last-4 + token
//
//   GET    /api/travel/trips/:id/documents                     — list required docs
//   POST   /api/travel/trips/:id/documents                     — add required doc
//   DELETE /api/travel/trips/:id/documents/:docId              — remove required doc
//
// DEFERRED to Phase 1.5 (schema is in place; routes pending):
//   - RoomingAssignment (depends on participant assignment UX)
//   - TripPaymentPlan + TripInstalmentPayment (billing flow + reminder cron)
//
// All trips are subBrand="tmc" implicitly (the model only exists for TMC).
// Sub-brand access for ADMINs is full; non-admins need "tmc" in
// User.subBrandAccess[].
//
// tripCode is unique per-tenant via the @unique constraint. Duplicate
// codes return 409 DUPLICATE_TRIP_CODE.
//
// PII: TripParticipant carries passport + Aadhaar token (encrypted). The
// route stores aadhaarTokenId as-is (encrypted at the application layer
// before submit, never by this route); raw Aadhaar numbers MUST NOT be
// stored (Q14 + Aadhaar Act §29 — see TRAVEL_CRM_RISKS.md R8).

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const digilockerClient = require("../services/digilockerClient");

const VALID_TRIP_STATUSES = ["confirmed", "in-trip", "completed", "cancelled"];

// TMC-only access guard. Trips ARE tmc-only, so we just check that "tmc"
// is in the allowed set (or that the user has full access).
async function requireTmcAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-trips] tmc-access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ─── Trip CRUD ────────────────────────────────────────────────────────

// GET /api/travel/trips
router.get("/trips", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.status) {
      if (!VALID_TRIP_STATUSES.includes(String(req.query.status))) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      where.status = String(req.query.status);
    }
    if (req.query.schoolContactId) {
      const sid = parseInt(req.query.schoolContactId, 10);
      if (Number.isFinite(sid)) where.schoolContactId = sid;
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [trips, total] = await Promise.all([
      prisma.tmcTrip.findMany({
        where,
        orderBy: { departDate: "asc" },
        take,
        skip,
        include: { _count: { select: { participants: true, documentRequirements: true } } },
      }),
      prisma.tmcTrip.count({ where }),
    ]);
    res.json({ trips, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-trips] list error:", e.message);
    res.status(500).json({ error: "Failed to list trips" });
  }
});

// POST /api/travel/trips
router.post("/trips", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const {
      tripCode, schoolContactId, destination, departDate, returnDate,
      legalEntity, pricePerStudent, status, micrositeUrl, driveFolderId,
    } = req.body || {};

    if (!tripCode || !schoolContactId || !destination || !departDate || !returnDate) {
      return res.status(400).json({
        error: "tripCode, schoolContactId, destination, departDate, returnDate required",
        code: "MISSING_FIELDS",
      });
    }
    const sid = parseInt(schoolContactId, 10);
    if (!Number.isFinite(sid)) {
      return res.status(400).json({ error: "schoolContactId must be a number", code: "INVALID_CONTACT_ID" });
    }
    if (status && !VALID_TRIP_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }
    const depart = new Date(departDate);
    const ret = new Date(returnDate);
    if (!Number.isFinite(depart.getTime()) || !Number.isFinite(ret.getTime())) {
      return res.status(400).json({ error: "invalid date", code: "INVALID_DATE" });
    }
    if (ret < depart) {
      return res.status(400).json({ error: "returnDate must be on or after departDate", code: "INVERTED_DATES" });
    }

    const created = await prisma.tmcTrip.create({
      data: {
        tenantId: req.travelTenant.id,
        tripCode: String(tripCode),
        schoolContactId: sid,
        destination: String(destination),
        departDate: depart,
        returnDate: ret,
        legalEntity: legalEntity || "tmc_nexus",
        pricePerStudent: pricePerStudent != null ? Number(pricePerStudent) : null,
        status: status || "confirmed",
        micrositeUrl: micrositeUrl || null,
        driveFolderId: driveFolderId || null,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "tripCode already in use", code: "DUPLICATE_TRIP_CODE" });
    }
    console.error("[travel-trips] create error:", e.message);
    res.status(500).json({ error: "Failed to create trip" });
  }
});

// GET /api/travel/trips/:id
router.get("/trips/:id", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const trip = await prisma.tmcTrip.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      include: {
        participants: { orderBy: { id: "asc" } },
        documentRequirements: { orderBy: { id: "asc" } },
        paymentPlan: true,
        microsite: true,
      },
    });
    if (!trip) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });
    res.json(trip);
  } catch (e) {
    console.error("[travel-trips] get error:", e.message);
    res.status(500).json({ error: "Failed to get trip" });
  }
});

// PATCH /api/travel/trips/:id
router.patch("/trips/:id", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.tmcTrip.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });

    const data = {};
    const {
      destination, departDate, returnDate, legalEntity,
      pricePerStudent, status, micrositeUrl, driveFolderId,
    } = req.body || {};

    if (destination !== undefined) data.destination = String(destination);
    if (departDate !== undefined) {
      const d = new Date(departDate);
      if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: "invalid departDate", code: "INVALID_DATE" });
      data.departDate = d;
    }
    if (returnDate !== undefined) {
      const d = new Date(returnDate);
      if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: "invalid returnDate", code: "INVALID_DATE" });
      data.returnDate = d;
    }
    if (legalEntity !== undefined) data.legalEntity = String(legalEntity);
    if (pricePerStudent !== undefined) data.pricePerStudent = pricePerStudent != null ? Number(pricePerStudent) : null;
    if (status !== undefined) {
      if (!VALID_TRIP_STATUSES.includes(status)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      data.status = status;
    }
    if (micrositeUrl !== undefined) data.micrositeUrl = micrositeUrl || null;
    if (driveFolderId !== undefined) data.driveFolderId = driveFolderId || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    // Cross-field check: if both dates being amended, verify ordering.
    if (data.departDate && data.returnDate && data.returnDate < data.departDate) {
      return res.status(400).json({ error: "returnDate must be on or after departDate", code: "INVERTED_DATES" });
    }

    const updated = await prisma.tmcTrip.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "tripCode already in use", code: "DUPLICATE_TRIP_CODE" });
    }
    console.error("[travel-trips] patch error:", e.message);
    res.status(500).json({ error: "Failed to update trip" });
  }
});

// DELETE /api/travel/trips/:id — ADMIN only, cascades through children.
router.delete(
  "/trips/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.tmcTrip.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });
      await prisma.tmcTrip.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-trips] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete trip" });
    }
  },
);

// ─── Participants ─────────────────────────────────────────────────────

async function loadTrip(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    select: { id: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "NOT_FOUND"; throw err;
  }
  return trip;
}

router.get("/trips/:id/participants", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const rows = await prisma.tripParticipant.findMany({
      where: { tripId: trip.id },
      orderBy: { id: "asc" },
    });
    res.json({ participants: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participants list error:", e.message);
    res.status(500).json({ error: "Failed to list participants" });
  }
});

router.post("/trips/:id/participants", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const {
      fullName, passportNumber, passportExpiry, passportDocId,
      aadhaarLast4, aadhaarTokenId, parentName, parentPhone, parentEmail,
      medicalNotes, consentCapturedAt,
    } = req.body || {};
    if (!fullName) {
      return res.status(400).json({ error: "fullName required", code: "MISSING_FIELDS" });
    }
    // Aadhaar Act §29 safety — refuse if caller submits a raw 12-digit
    // Aadhaar number. Only `aadhaarLast4` (display) + `aadhaarTokenId`
    // (DigiLocker token) are allowed in storage.
    if (aadhaarLast4 && !/^\d{4}$/.test(String(aadhaarLast4))) {
      return res.status(400).json({
        error: "aadhaarLast4 must be exactly 4 digits (don't submit full Aadhaar number)",
        code: "INVALID_AADHAAR_LAST4",
      });
    }

    const created = await prisma.tripParticipant.create({
      data: {
        tripId: trip.id,
        fullName: String(fullName),
        passportNumber: passportNumber || null,
        passportExpiry: passportExpiry ? new Date(passportExpiry) : null,
        passportDocId: passportDocId ? parseInt(passportDocId, 10) : null,
        aadhaarLast4: aadhaarLast4 || null,
        aadhaarTokenId: aadhaarTokenId || null,
        parentName: parentName || null,
        parentPhone: parentPhone || null,
        parentEmail: parentEmail || null,
        medicalNotes: medicalNotes || null,
        consentCapturedAt: consentCapturedAt ? new Date(consentCapturedAt) : null,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant create error:", e.message);
    res.status(500).json({ error: "Failed to create participant" });
  }
});

router.patch("/trips/:id/participants/:pid", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid)) {
      return res.status(400).json({ error: "pid must be a number", code: "INVALID_PARTICIPANT_ID" });
    }
    const existing = await prisma.tripParticipant.findFirst({
      where: { id: pid, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Participant not found", code: "PARTICIPANT_NOT_FOUND" });

    const data = {};
    const allowed = [
      "fullName", "passportNumber", "passportExpiry", "passportDocId",
      "aadhaarLast4", "aadhaarTokenId", "parentName", "parentPhone", "parentEmail",
      "medicalNotes", "consentCapturedAt",
    ];
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = req.body[k];
        if (k === "aadhaarLast4" && v && !/^\d{4}$/.test(String(v))) {
          return res.status(400).json({
            error: "aadhaarLast4 must be exactly 4 digits",
            code: "INVALID_AADHAAR_LAST4",
          });
        }
        if (k === "passportExpiry" || k === "consentCapturedAt") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "passportDocId") {
          data[k] = v ? parseInt(v, 10) : null;
        } else {
          data[k] = v ?? null;
        }
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }
    const updated = await prisma.tripParticipant.update({ where: { id: pid }, data });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant patch error:", e.message);
    res.status(500).json({ error: "Failed to update participant" });
  }
});

router.delete("/trips/:id/participants/:pid", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid)) {
      return res.status(400).json({ error: "pid must be a number", code: "INVALID_PARTICIPANT_ID" });
    }
    const existing = await prisma.tripParticipant.findFirst({
      where: { id: pid, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Participant not found", code: "PARTICIPANT_NOT_FOUND" });
    await prisma.tripParticipant.delete({ where: { id: pid } });
    res.json({ deleted: true, id: pid });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant delete error:", e.message);
    res.status(500).json({ error: "Failed to delete participant" });
  }
});

// ─── DigiLocker Aadhaar verification (stub-mode) ─────────────────────
//
// PRD §4.5 + §4.7. Currently uses the stub client in
// services/digilockerClient.js — real OAuth flow lands when the
// Travel Stall partner-registration creds (Q3) drop. Swap point is
// that single file; routes + DB shape stay identical.
//
// /initiate creates an OAuth-state-tracking row + returns the URL the
// browser would redirect to. /callback verifies the state, exchanges
// the (state, code) pair for an Aadhaar last-4 + opaque token, and
// writes those onto the TripParticipant. The token NEVER appears in
// any HTTP response — only persisted server-side (matches the existing
// `aadhaarTokenId` convention for opaque PII tokens).

async function loadTripAndParticipant(req) {
  const tripId = parseInt(req.params.tripId, 10);
  const participantId = parseInt(req.params.participantId, 10);
  if (!Number.isFinite(tripId)) {
    const err = new Error("tripId must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  if (!Number.isFinite(participantId)) {
    const err = new Error("participantId must be a number"); err.status = 400; err.code = "INVALID_PARTICIPANT_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id: tripId, tenantId: req.travelTenant.id },
    select: { id: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "NOT_FOUND"; throw err;
  }
  const participant = await prisma.tripParticipant.findFirst({
    where: { id: participantId, tripId: trip.id },
    select: { id: true, tripId: true },
  });
  if (!participant) {
    const err = new Error("Participant not found"); err.status = 404; err.code = "PARTICIPANT_NOT_FOUND"; throw err;
  }
  return { trip, participant };
}

// POST /api/travel/trips/:tripId/participants/:participantId/digilocker/initiate
router.post(
  "/trips/:tripId/participants/:participantId/digilocker/initiate",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const { participant } = await loadTripAndParticipant(req);
      const { redirectUri } = req.body || {};
      if (!redirectUri || typeof redirectUri !== "string") {
        return res.status(400).json({ error: "redirectUri required", code: "MISSING_FIELDS" });
      }
      const { state, oauthUrl } = await digilockerClient.initiateSession({
        participantId: participant.id,
        redirectUri,
      });
      const session = await prisma.digilockerSession.create({
        data: {
          tenantId: req.travelTenant.id,
          participantId: participant.id,
          state,
          status: "initiated",
          redirectUri,
        },
        select: { id: true, state: true },
      });
      res.status(200).json({ state: session.state, oauthUrl, sessionId: session.id });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trips] digilocker initiate error:", e.message);
      res.status(500).json({ error: "Failed to initiate DigiLocker session" });
    }
  },
);

// POST /api/travel/trips/:tripId/participants/:participantId/digilocker/callback
router.post(
  "/trips/:tripId/participants/:participantId/digilocker/callback",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const { participant } = await loadTripAndParticipant(req);
      const { state, code } = req.body || {};
      if (!state || typeof state !== "string") {
        return res.status(400).json({ error: "state required", code: "MISSING_FIELDS" });
      }
      // Scope by tenant + participant so a state leaked from one tenant
      // can't be used to write Aadhaar onto another tenant's participant.
      const session = await prisma.digilockerSession.findFirst({
        where: { state, tenantId: req.travelTenant.id, participantId: participant.id },
      });
      if (!session) {
        return res.status(404).json({ error: "DigiLocker session not found", code: "SESSION_NOT_FOUND" });
      }
      if (session.status === "verified") {
        // Replay protection — the state has already been consumed.
        return res.status(409).json({ error: "DigiLocker session already verified", code: "INVALID_STATE" });
      }
      if (session.status === "expired" || session.status === "failed") {
        return res.status(410).json({ error: `DigiLocker session ${session.status}`, code: "SESSION_GONE" });
      }
      const { aadhaarLast4, aadhaarTokenId } = await digilockerClient.exchangeCallback({ state, code });

      await prisma.$transaction([
        prisma.digilockerSession.update({
          where: { id: session.id },
          data: {
            status: "verified",
            verifiedAt: new Date(),
            resultLast4: aadhaarLast4,
            resultTokenId: aadhaarTokenId,
          },
        }),
        prisma.tripParticipant.update({
          where: { id: participant.id },
          data: { aadhaarLast4, aadhaarTokenId },
        }),
      ]);

      // NOTE: never leak resultTokenId / aadhaarTokenId in the response —
      // token stays server-side per the route header convention.
      res.status(200).json({ verified: true, aadhaarLast4 });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trips] digilocker callback error:", e.message);
      res.status(500).json({ error: "Failed to complete DigiLocker verification" });
    }
  },
);

// ─── Document requirements ────────────────────────────────────────────

router.get("/trips/:id/documents", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const rows = await prisma.tripDocumentRequirement.findMany({
      where: { tripId: trip.id },
      orderBy: { id: "asc" },
    });
    res.json({ documents: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] docs list error:", e.message);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

router.post("/trips/:id/documents", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const { docType, required } = req.body || {};
    if (!docType) {
      return res.status(400).json({ error: "docType required", code: "MISSING_FIELDS" });
    }
    const created = await prisma.tripDocumentRequirement.create({
      data: {
        tripId: trip.id,
        docType: String(docType),
        required: required !== false,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] doc create error:", e.message);
    res.status(500).json({ error: "Failed to create document requirement" });
  }
});

router.delete("/trips/:id/documents/:docId", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const docId = parseInt(req.params.docId, 10);
    if (!Number.isFinite(docId)) {
      return res.status(400).json({ error: "docId must be a number", code: "INVALID_DOC_ID" });
    }
    const existing = await prisma.tripDocumentRequirement.findFirst({
      where: { id: docId, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Document req not found", code: "DOC_NOT_FOUND" });
    await prisma.tripDocumentRequirement.delete({ where: { id: docId } });
    res.json({ deleted: true, id: docId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] doc delete error:", e.message);
    res.status(500).json({ error: "Failed to delete document requirement" });
  }
});

module.exports = router;
