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
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const passportOcrClient = require("../services/passportOcrClient");
const { writeAudit } = require("../lib/audit");
const { removeScanFromEnvelopeJson } = require("../lib/passportFileStore");
const visaDocStore = require("../lib/visaDocStore");

// ─── Multer setup (disk storage; matches deals_documents.js convention) ─

const uploadPath = path.join(__dirname, "..", "uploads", "passport-ocr");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// The saved extension is derived from the ALLOWLISTED mimetype, NOT the
// client-supplied originalname. originalname and Content-Type are
// independent attacker-controlled multipart fields, so deriving the
// extension from originalname lets a part pass the image/* fileFilter
// while saving as "<uuid>.html" / ".svg" with an HTML/SVG body — which
// the public /uploads static mount would then serve with an executable
// content-type (stored XSS via the operator "View image" link). Pinning
// to the mimetype means the file can only be .jpg / .png / .pdf.
const PASSPORT_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  // Non-guessable filename — PII boundary. Extension comes from the
  // validated mimetype so the browser routes it to the right viewer.
  filename: (req, file, cb) => {
    const safeExt = PASSPORT_MIME_EXT[(file.mimetype || "").toLowerCase()] || "";
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

// 5 MB cap per PRD FR-1; accept JPG / PNG / PDF.
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (PASSPORT_MIME_EXT[(file.mimetype || "").toLowerCase()]) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

// Wrap multer so its rejections become the intended 413/415 here, instead of
// falling through to the global error handler as a 500 (multer calls
// next(err), which skips the route handler — so the handler's own catch never
// sees these). Mirrors the portal route's wrapper.
function uploadHandler(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file exceeds 5 MB limit", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err && err.message === "UNSUPPORTED_MIME") {
      return res.status(415).json({ error: "unsupported file type — JPG / PNG / PDF only", code: "UNSUPPORTED_MIME" });
    }
    if (err) return next(err);
    next();
  });
}

// Best-effort delete of an uploaded scan — diskStorage writes req.file BEFORE
// the handler runs, so every non-success branch must remove it or the raw
// passport scan is orphaned on disk (disk-fill + untracked PII).
function unlinkUploadedScan(req) {
  if (req.file && req.file.filename) {
    fs.unlink(path.join(uploadPath, req.file.filename), () => {});
  }
}

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
  uploadHandler,
  async (req, res) => {
    try {
      let participant;
      try {
        participant = await loadParticipant(req);
      } catch (e) {
        // loadParticipant runs AFTER multer wrote the file — clean it up.
        unlinkUploadedScan(req);
        throw e;
      }

      if (!req.file) {
        return res.status(400).json({ error: "no file uploaded (field name: 'file')", code: "NO_FILE" });
      }

      // Call the OCR client (local tesseract + MRZ parser).
      let result;
      try {
        result = await passportOcrClient.extractPassport({
          tenantId: req.travelTenant.id,
          filePath: req.file.path, // multer.diskStorage path — the OCR engine reads it
          fileName: req.file.originalname || req.file.filename,
          mimeType: req.file.mimetype,
        });
      } catch (e) {
        if (e.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
          // OCR disabled — don't keep the orphaned scan; the operator can
          // re-upload once it's enabled.
          unlinkUploadedScan(req);
          return res.status(503).json({
            error: "Passport OCR is not enabled for this tenant",
            code: "PASSPORT_OCR_NOT_YET_ENABLED",
            participantId: participant.id,
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
      // /api/uploads (not bare /uploads): in production only /api/* is proxied
      // to the backend, so a bare /uploads link 404s to the SPA host.
      const fileUrl = `/api/uploads/passport-ocr/${req.file.filename}`;

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

      // Supersede the previous scan so a re-upload doesn't orphan it. Awaited
      // so the delete completes before we respond (no leak on a sudden restart).
      await removeScanFromEnvelopeJson(participant.passportExtractionJson, req.file.filename);

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
      // Multer 413/415 are handled in uploadHandler before this runs. Anything
      // reaching here is a handler-level failure — clean up the stored scan.
      unlinkUploadedScan(req);
      console.error("[travel-passport] upload error:", e.message);
      res.status(500).json({ error: "Failed to process passport upload" });
    }
  },
);

// ─── GET /verification-queue (ADMIN+MANAGER) ──────────────────────────

router.get(
  "/verification-queue",
  verifyToken,
  requirePermission("passport", "read"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      // The queue unions TWO passport sources, both pending the same gate
      // (extractedAt NOT NULL AND verifiedAt NULL):
      //   - TripParticipant   (kind "trip")     — TMC operator + microsite flow
      //   - CustomerTraveller (kind "customer") — unified portal flow, all 4
      //                                            sub-brands (PRD_PASSPORT_OCR)
      // Each row carries a `kind` discriminator so the operator UI calls the
      // right verify/reject/clear endpoint; ids can collide across the two
      // tables, so the UI keys on `${kind}:${id}`.
      const parseEnvelope = (json) => {
        try { return json ? JSON.parse(json) : null; } catch (_) { return null; }
      };

      const [tripRows, customerRows] = await Promise.all([
        prisma.tripParticipant.findMany({
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
        }),
        prisma.customerTraveller.findMany({
          where: {
            passportExtractedAt: { not: null },
            passportVerifiedAt: null,
            tenantId: req.travelTenant.id,
          },
          orderBy: { passportExtractedAt: "asc" },
          take: 200,
        }),
      ]);

      const tripOut = tripRows.map((r) => {
        const envelope = parseEnvelope(r.passportExtractionJson);
        return {
          kind: "trip",
          id: r.id,
          participantId: r.id, // back-compat alias
          fullName: r.fullName,
          trip: r.trip,
          subBrand: "tmc",
          relationship: null,
          extractedAt: r.passportExtractedAt,
          rejectedAt: r.passportRejectedAt,
          extraction: envelope?.extraction || null,
          confidence: envelope?.confidence ?? null,
          provider: envelope?.provider || null,
          imageUrl: envelope?.imageUrl || null,
          mrzFound: envelope?.mrzFound ?? null,
          note: envelope?.note || null,
        };
      });

      const customerOut = customerRows.map((r) => {
        const envelope = parseEnvelope(r.passportExtractionJson);
        return {
          kind: "customer",
          id: r.id,
          fullName: r.fullName,
          trip: null,
          subBrand: r.subBrand,
          relationship: r.relationship || null,
          extractedAt: r.passportExtractedAt,
          rejectedAt: r.passportRejectedAt,
          extraction: envelope?.extraction || null,
          confidence: envelope?.confidence ?? null,
          provider: envelope?.provider || null,
          imageUrl: envelope?.imageUrl || null,
          mrzFound: envelope?.mrzFound ?? null,
          note: envelope?.note || null,
        };
      });

      // Oldest-first across both sources so the operator works the true FIFO.
      const out = [...tripOut, ...customerOut].sort(
        (a, b) => new Date(a.extractedAt).getTime() - new Date(b.extractedAt).getTime(),
      );

      res.json({ pending: out, total: out.length });
    } catch (e) {
      console.error("[travel-passport] queue error:", e.message);
      res.status(500).json({ error: "Failed to load verification queue" });
    }
  },
);

// ─── POST /participants/:id/requeue-registration-docs (ADMIN+MANAGER) ──
//
// Re-syncs the passport from the microsite-uploaded document stored on the
// participant's linked PendingTripRegistration. Called by the admin UI when
// the post-approval OCR fire-and-forget didn't set passportExtractedAt
// (e.g. participants approved before the bug fix). Returns a manual envelope
// if OCR is disabled so the participant always surfaces in the queue.

router.post(
  "/participants/:id/requeue-registration-docs",
  verifyToken,
  requirePermission("passport", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const participant = await loadParticipant(req);

      if (participant.passportExtractedAt) {
        return res.status(409).json({
          error: "Passport already queued — clear the extraction first if you want to re-sync",
          code: "ALREADY_QUEUED",
        });
      }

      const registration = await prisma.pendingTripRegistration.findFirst({
        where: { convertedToParticipantId: participant.id },
        select: { id: true, extrasJson: true },
      });

      if (!registration) {
        return res.status(404).json({
          error: "No linked registration found for this participant",
          code: "NO_REGISTRATION",
        });
      }

      let regDocs = {};
      try {
        const extras = registration.extrasJson ? JSON.parse(registration.extrasJson) : {};
        regDocs = extras.documents || {};
      } catch (_) { regDocs = {}; }

      const passportDesc = regDocs.passport;
      if (!passportDesc?.key) {
        return res.status(404).json({
          error: "Registration has no passport document — participant must upload manually",
          code: "NO_REGISTRATION_DOCS",
        });
      }

      const buffer = await visaDocStore.readDocBuffer(passportDesc);
      if (!buffer) {
        return res.status(422).json({
          error: "Could not read the registration document — file may have been moved or deleted",
          code: "DOC_NOT_READABLE",
        });
      }

      const extMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf" };
      const ext = (passportDesc.key || "").split(".").pop().toLowerCase();
      const mimeType = extMap[ext] || "image/jpeg";

      let envelope;
      try {
        envelope = await passportOcrClient.extractPassport({
          tenantId: req.travelTenant.id,
          fileBuffer: buffer,
          mimeType,
        });
      } catch (_ocrErr) {
        envelope = {
          extraction: {
            passportNumber: null, surname: null, givenNames: null,
            dateOfBirth: null, sex: null, nationality: null,
            dateOfExpiry: null, mrz: null,
          },
          confidence: 0,
          provider: "manual",
          mrzFound: false,
          note: "Automatic extraction unavailable — please verify passport fields manually.",
        };
      }

      const resolvedUrl = await visaDocStore.resolveViewUrl({
        attachmentUrl: passportDesc.url,
        attachmentKey: passportDesc.key,
        attachmentStorage: passportDesc.storage,
      });

      const persistedEnvelope = {
        ...envelope,
        imageUrl: resolvedUrl || passportDesc.url || null,
        extractedAt: new Date().toISOString(),
        source: "registration_sync",
      };

      await prisma.tripParticipant.update({
        where: { id: participant.id },
        data: {
          passportExtractionJson: JSON.stringify(persistedEnvelope),
          passportExtractedAt: new Date(),
          passportRejectedAt: null,
        },
      });

      writeAudit(
        "TripParticipant",
        "passport.requeued_from_registration",
        participant.id,
        req.user.userId,
        req.travelTenant.id,
        { registrationId: registration.id, provider: envelope.provider, confidence: envelope.confidence },
      ).catch(() => {});

      return res.json({
        participantId: participant.id,
        extraction: envelope.extraction,
        confidence: envelope.confidence,
        provider: envelope.provider,
        extractedAt: new Date(),
        note: envelope.note || null,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] requeue-registration-docs error:", e.message);
      res.status(500).json({ error: "Failed to requeue registration documents" });
    }
  },
);

// ─── POST /participants/:id/passport-verify (ADMIN+MANAGER) ───────────

router.post(
  "/participants/:id/passport-verify",
  verifyToken,
  requirePermission("passport", "update"),
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

        // Don't let a blank extraction (OCR failed → all null) be approved
        // into a "verified" record with no number/expiry. The operator must
        // fill at least one via editedFields, or reject instead.
        if (!finalNumber && !finalExpiry) {
          return res.status(422).json({
            error: "Can't approve an empty passport — enter the passport number or expiry, or reject it.",
            code: "EMPTY_EXTRACTION",
          });
        }

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
  requirePermission("passport", "update"),
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
      // Delete the stored scan (S3/disk) so "Clear → re-upload" doesn't orphan
      // it. Awaited so the delete completes before responding.
      await removeScanFromEnvelopeJson(participant.passportExtractionJson);
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

// ─── Customer-traveller (portal-originated) verification ──────────────
//
// Parallel to the TripParticipant endpoints above, but targeting the
// CustomerTraveller table — the unified portal passport store for all 4
// sub-brands. Same ADMIN+MANAGER gate; tenant scoping is direct via the
// row's tenantId column (CustomerTraveller has no trip to join through).

async function loadCustomerTraveller(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number"); err.status = 400; err.code = "INVALID_TRAVELLER_ID"; throw err;
  }
  const traveller = await prisma.customerTraveller.findFirst({
    where: { id, tenantId: req.travelTenant.id },
  });
  if (!traveller) {
    const err = new Error("Traveller not found"); err.status = 404; err.code = "TRAVELLER_NOT_FOUND"; throw err;
  }
  return traveller;
}

// POST /customer-travellers/:id/passport-verify (ADMIN+MANAGER)
router.post(
  "/customer-travellers/:id/passport-verify",
  verifyToken,
  requirePermission("passport", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const traveller = await loadCustomerTraveller(req);
      if (!traveller.passportExtractedAt) {
        return res.status(409).json({ error: "no extraction to verify — upload a passport first", code: "NO_EXTRACTION" });
      }
      if (traveller.passportVerifiedAt) {
        return res.status(409).json({ error: "passport already verified", code: "ALREADY_VERIFIED" });
      }
      const { approved, editedFields } = req.body || {};
      if (typeof approved !== "boolean") {
        return res.status(400).json({ error: "body.approved required (boolean)", code: "MISSING_FIELDS" });
      }

      if (approved) {
        let envelope = null;
        try { envelope = traveller.passportExtractionJson ? JSON.parse(traveller.passportExtractionJson) : null; }
        catch (_) { envelope = null; }
        const extraction = envelope?.extraction || {};
        const edits = (editedFields && typeof editedFields === "object") ? editedFields : {};
        const finalNumber = (edits.passportNumber ?? extraction.passportNumber) || null;
        const finalExpiry = edits.dateOfExpiry ?? edits.passportExpiry ?? extraction.dateOfExpiry;

        if (!finalNumber && !finalExpiry) {
          return res.status(422).json({
            error: "Can't approve an empty passport — enter the passport number or expiry, or reject it.",
            code: "EMPTY_EXTRACTION",
          });
        }

        const updated = await prisma.customerTraveller.update({
          where: { id: traveller.id },
          data: {
            passportNumber: finalNumber,
            passportExpiry: finalExpiry ? new Date(finalExpiry) : null,
            passportVerifiedAt: new Date(),
            passportVerifiedById: req.user.userId,
            passportRejectedAt: null,
          },
        });

        writeAudit(
          "CustomerTraveller",
          "passport.verified",
          traveller.id,
          req.user.userId,
          req.travelTenant.id,
          { editedFieldNames: Object.keys(edits) },
        ).catch(() => {});

        return res.json({
          travellerId: updated.id,
          approved: true,
          verifiedAt: updated.passportVerifiedAt,
          verifiedById: updated.passportVerifiedById,
        });
      } else {
        const updated = await prisma.customerTraveller.update({
          where: { id: traveller.id },
          data: { passportRejectedAt: new Date() },
        });
        writeAudit(
          "CustomerTraveller",
          "passport.rejected",
          traveller.id,
          req.user.userId,
          req.travelTenant.id,
          { reason: typeof req.body?.reason === "string" ? req.body.reason : null },
        ).catch(() => {});
        return res.json({ travellerId: updated.id, approved: false, rejectedAt: updated.passportRejectedAt });
      }
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] customer verify error:", e.message);
      res.status(500).json({ error: "Failed to verify passport" });
    }
  },
);

// DELETE /customer-travellers/:id/passport-extraction (ADMIN+MANAGER)
router.delete(
  "/customer-travellers/:id/passport-extraction",
  verifyToken,
  requirePermission("passport", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const traveller = await loadCustomerTraveller(req);
      await prisma.customerTraveller.update({
        where: { id: traveller.id },
        data: {
          passportExtractionJson: null,
          passportExtractedAt: null,
          passportVerifiedAt: null,
          passportVerifiedById: null,
          passportRejectedAt: null,
        },
      });
      // Delete the stored scan (S3/disk) — portal uploads live in S3, so a
      // "Clear → re-upload" must remove the old object, not just the DB row.
      // Awaited so the delete completes before responding.
      await removeScanFromEnvelopeJson(traveller.passportExtractionJson);
      writeAudit(
        "CustomerTraveller",
        "passport.extraction_cleared",
        traveller.id,
        req.user.userId,
        req.travelTenant.id,
        null,
      ).catch(() => {});
      return res.json({ travellerId: traveller.id, cleared: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] customer clear error:", e.message);
      res.status(500).json({ error: "Failed to clear passport extraction" });
    }
  },
);

module.exports = router;
