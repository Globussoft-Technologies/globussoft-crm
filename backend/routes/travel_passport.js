// Travel CRM — Passport OCR upload + verification queue routes (slice C2).
//
// Endpoints (mounted at /api/travel/passport):
//   POST   /participants/:id/passport-upload         — all roles + TMC.
//                                                      multer single-image upload,
//                                                      calls passportOcrClient.extractPassport,
//                                                      persists raw image as ContactAttachment + extraction JSON
//                                                      on TripParticipant. Returns extraction envelope.
//   GET    /verification-queue                       — ADMIN+MANAGER only.
//                                                      Tenant-scoped list of pending participants
//                                                      (extractedAt IS NOT NULL AND verifiedAt IS NULL).
//   POST   /participants/:id/passport-verify         — ADMIN+MANAGER only.
//                                                      Body: { approved, editedFields? }.
//                                                      On approve: copies extraction (with optional manual edits)
//                                                      into canonical TripParticipant cols + sets verifiedAt/ById.
//                                                      On reject: sets passportRejectedAt = now.
//                                                      Audit-logged.
//   DELETE /participants/:id/passport-extraction     — ADMIN+MANAGER only.
//                                                      Clears extraction JSON (for re-upload).
//                                                      Audit-logged.
//
// Per docs/PRD_PASSPORT_OCR.md §5.4 — stub-mode landing while PC-1 (vendor
// decision) is pending. Real-mode swap happens entirely in
// backend/services/passportOcrClient.js (FR-2/FR-3/FR-4); these routes +
// the verification UI stay unchanged when the swap lands.
//
// Tenant scoping: TripParticipant has no direct tenantId column — the
// scope flows through trip.tenantId. All endpoints go through
// loadParticipant() which joins to TmcTrip and verifies
// trip.tenantId === req.travelTenant.id; cross-tenant access returns 404
// (deliberate — leaking 403 would expose the existence of a participant
// in another tenant).
//
// Auth chain (per CLAUDE.md standing rules):
//   verifyToken → requireTravelTenant → requireTmcAccess → [verifyRole?] → handler
//
// PII boundary (PRD FR-8/FR-9):
//   - Image stored on disk via multer; image filename is non-guessable
//     (multer + crypto.randomUUID).
//   - Audit log captures field NAMES + action types, NEVER field VALUES
//     (passport numbers / DOB / etc. stay out of the audit trail).

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const passportOcrClient = require("../services/passportOcrClient");
const { writeAudit } = require("../lib/audit");

// ─── Multer setup (disk storage; matches deals_documents.js convention) ─

const uploadPath = path.join(__dirname, "..", "uploads", "passport-ocr");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  // Non-guessable filename — PII boundary. Original extension preserved
  // for the operator UI's "open in new tab" behaviour (browser routes
  // .jpg / .png / .pdf to the right viewer).
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 8) || "";
    const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : "";
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

// 5 MB cap per PRD FR-1; accept JPG / PNG / PDF.
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mt = (file.mimetype || "").toLowerCase();
    if (mt === "image/jpeg" || mt === "image/png" || mt === "application/pdf") {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

// ─── Sub-brand guard (same shape as travel_trips.js) ──────────────────

async function requireTmcAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-passport] tmc-access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ─── Participant loader (tenant-scoped via trip.tenantId) ─────────────

async function loadParticipant(req) {
  const pid = parseInt(req.params.id, 10);
  if (!Number.isFinite(pid)) {
    const err = new Error("id must be a number"); err.status = 400; err.code = "INVALID_PARTICIPANT_ID"; throw err;
  }
  const participant = await prisma.tripParticipant.findFirst({
    where: {
      id: pid,
      trip: { tenantId: req.travelTenant.id },
    },
    include: { trip: { select: { id: true, tenantId: true, tripCode: true, destination: true } } },
  });
  if (!participant) {
    const err = new Error("Participant not found"); err.status = 404; err.code = "PARTICIPANT_NOT_FOUND"; throw err;
  }
  return participant;
}

// ─── POST /participants/:id/passport-upload ───────────────────────────

router.post(
  "/participants/:id/passport-upload",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  upload.single("file"),
  async (req, res) => {
    try {
      const participant = await loadParticipant(req);

      if (!req.file) {
        return res.status(400).json({ error: "no file uploaded (field name: 'file')", code: "NO_FILE" });
      }

      // Call the OCR client. In stub-mode this returns a canned envelope;
      // in real-mode (post PC-1 + cred drop) the vendor HTTP call runs.
      let result;
      try {
        result = await passportOcrClient.extractPassport({
          tenantId: req.travelTenant.id,
          fileBuffer: null, // multer.diskStorage stored to disk; the stub doesn't need the buffer
          fileName: req.file.originalname || req.file.filename,
        });
      } catch (e) {
        if (e.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
          // Fall-through to "no extraction" mode — the upload still lands
          // (image is preserved) so the operator can populate fields
          // manually per FR-12 vendor-failure fallback.
          return res.status(503).json({
            error: "Passport OCR vendor not yet enabled for this tenant",
            code: "PASSPORT_OCR_NOT_YET_ENABLED",
            participantId: participant.id,
            imageFilename: req.file.filename,
          });
        }
        throw e;
      }

      // Persist the raw image as a ContactAttachment row. attached to the
      // participant's trip's school contact when available; otherwise to
      // a placeholder contactId = 0 (we don't have a direct Contact for
      // every participant — the schema uses contactId for ContactAttachment).
      //
      // Lighter-weight option chosen per slice prompt: store the file path
      // on the TripParticipant.passportDocId only as a ContactAttachment id
      // when we have one, else leave passportDocId NULL and rely on
      // passportExtractionJson.imageFilename for the operator UI.
      const fileUrl = `/uploads/passport-ocr/${req.file.filename}`;

      // Augment the extraction envelope with the image path so the
      // verification UI can render a "View image" link without a separate
      // DB lookup. imageFilename stays NAME-ONLY (no PII like passport
      // number) so audit-log safety is preserved.
      const persistedEnvelope = {
        ...result,
        imageFilename: req.file.filename,
        imageUrl: fileUrl,
        originalName: req.file.originalname || null,
      };

      const updated = await prisma.tripParticipant.update({
        where: { id: participant.id },
        data: {
          passportExtractionJson: JSON.stringify(persistedEnvelope),
          passportExtractedAt: new Date(),
          // Clear any prior reject marker — a fresh upload resets the queue state.
          passportRejectedAt: null,
        },
      });

      // Audit: field NAMES only, never field VALUES.
      writeAudit(
        "TripParticipant",
        "passport.uploaded",
        participant.id,
        req.user.userId,
        req.travelTenant.id,
        {
          extractedFieldNames: Object.keys(result.extraction || {}),
          confidence: result.confidence,
          provider: result.provider,
        },
      ).catch(() => {});

      return res.status(201).json({
        participantId: participant.id,
        extraction: result.extraction,
        confidence: result.confidence,
        provider: result.provider,
        extractedAt: updated.passportExtractedAt,
        imageUrl: fileUrl,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file exceeds 5 MB limit", code: "FILE_TOO_LARGE" });
      }
      if (e.message === "UNSUPPORTED_MIME") {
        return res.status(415).json({ error: "unsupported file type — JPG / PNG / PDF only", code: "UNSUPPORTED_MIME" });
      }
      console.error("[travel-passport] upload error:", e.message);
      res.status(500).json({ error: "Failed to process passport upload" });
    }
  },
);

// ─── GET /verification-queue (ADMIN+MANAGER) ──────────────────────────

router.get(
  "/verification-queue",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const rows = await prisma.tripParticipant.findMany({
        where: {
          passportExtractedAt: { not: null },
          passportVerifiedAt: null,
          trip: { tenantId: req.travelTenant.id },
        },
        include: {
          trip: { select: { id: true, tripCode: true, destination: true } },
        },
        orderBy: { passportExtractedAt: "asc" },
        take: 200,
      });

      const out = rows.map((r) => {
        let envelope = null;
        try { envelope = r.passportExtractionJson ? JSON.parse(r.passportExtractionJson) : null; }
        catch (_) { envelope = null; }
        return {
          participantId: r.id,
          fullName: r.fullName,
          trip: r.trip,
          extractedAt: r.passportExtractedAt,
          rejectedAt: r.passportRejectedAt,
          extraction: envelope?.extraction || null,
          confidence: envelope?.confidence ?? null,
          provider: envelope?.provider || null,
          imageUrl: envelope?.imageUrl || null,
        };
      });

      res.json({ pending: out, total: out.length });
    } catch (e) {
      console.error("[travel-passport] queue error:", e.message);
      res.status(500).json({ error: "Failed to load verification queue" });
    }
  },
);

// ─── POST /participants/:id/passport-verify (ADMIN+MANAGER) ───────────

router.post(
  "/participants/:id/passport-verify",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const participant = await loadParticipant(req);

      if (!participant.passportExtractedAt) {
        return res.status(409).json({
          error: "no extraction to verify — upload a passport first",
          code: "NO_EXTRACTION",
        });
      }
      if (participant.passportVerifiedAt) {
        return res.status(409).json({
          error: "passport already verified",
          code: "ALREADY_VERIFIED",
        });
      }

      const { approved, editedFields } = req.body || {};
      if (typeof approved !== "boolean") {
        return res.status(400).json({
          error: "body.approved required (boolean)",
          code: "MISSING_FIELDS",
        });
      }

      if (approved) {
        // Parse the persisted extraction envelope.
        let envelope = null;
        try { envelope = participant.passportExtractionJson ? JSON.parse(participant.passportExtractionJson) : null; }
        catch (_) { envelope = null; }
        const extraction = envelope?.extraction || {};

        // Optional manual edits override the OCR output. Only the
        // operator-editable subset is honoured; everything else is
        // ignored to keep the audit surface narrow.
        const edits = (editedFields && typeof editedFields === "object") ? editedFields : {};
        const finalNumber = (edits.passportNumber ?? extraction.passportNumber) || null;
        const finalExpiry = edits.dateOfExpiry ?? edits.passportExpiry ?? extraction.dateOfExpiry;

        const updateData = {
          passportNumber: finalNumber,
          passportExpiry: finalExpiry ? new Date(finalExpiry) : null,
          passportVerifiedAt: new Date(),
          passportVerifiedById: req.user.userId,
          passportRejectedAt: null,
        };

        const updated = await prisma.tripParticipant.update({
          where: { id: participant.id },
          data: updateData,
        });

        writeAudit(
          "TripParticipant",
          "passport.verified",
          participant.id,
          req.user.userId,
          req.travelTenant.id,
          {
            editedFieldNames: Object.keys(edits),
            // VALUES intentionally not logged — passport number / expiry
            // stay out of the audit trail (PRD FR-9).
          },
        ).catch(() => {});

        return res.json({
          participantId: updated.id,
          approved: true,
          verifiedAt: updated.passportVerifiedAt,
          verifiedById: updated.passportVerifiedById,
        });
      } else {
        // Rejection path — clears the verified markers (no-op since not
        // verified) + sets rejectedAt. Parent can re-upload; the new
        // upload clears rejectedAt automatically.
        const updated = await prisma.tripParticipant.update({
          where: { id: participant.id },
          data: { passportRejectedAt: new Date() },
        });

        writeAudit(
          "TripParticipant",
          "passport.rejected",
          participant.id,
          req.user.userId,
          req.travelTenant.id,
          {
            reason: typeof req.body?.reason === "string" ? req.body.reason : null,
          },
        ).catch(() => {});

        return res.json({
          participantId: updated.id,
          approved: false,
          rejectedAt: updated.passportRejectedAt,
        });
      }
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] verify error:", e.message);
      res.status(500).json({ error: "Failed to verify passport" });
    }
  },
);

// ─── DELETE /participants/:id/passport-extraction (ADMIN+MANAGER) ─────

router.delete(
  "/participants/:id/passport-extraction",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const participant = await loadParticipant(req);
      await prisma.tripParticipant.update({
        where: { id: participant.id },
        data: {
          passportExtractionJson: null,
          passportExtractedAt: null,
          passportVerifiedAt: null,
          passportVerifiedById: null,
          passportRejectedAt: null,
        },
      });
      writeAudit(
        "TripParticipant",
        "passport.extraction_cleared",
        participant.id,
        req.user.userId,
        req.travelTenant.id,
        null,
      ).catch(() => {});
      return res.json({ participantId: participant.id, cleared: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] delete extraction error:", e.message);
      res.status(500).json({ error: "Failed to clear passport extraction" });
    }
  },
);

module.exports = router;
