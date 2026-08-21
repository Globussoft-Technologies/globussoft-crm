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
const unzipper = require("unzipper");

const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const passportOcrClient = require("../services/passportOcrClient");
const { writeAudit } = require("../lib/audit");
const { removeScanFromEnvelopeJson } = require("../lib/passportFileStore");
const visaDocStore = require("../lib/visaDocStore");
const { findPassportIdentityCandidates, persistPassportIdentity } = require("../lib/passportIdentityLinker");

async function safeFindPassportIdentityCandidates(args, context = "travel-passport") {
  try {
    return await findPassportIdentityCandidates(args);
  } catch (err) {
    console.warn("[travel-passport][passport-identity:" + context + "] candidate lookup skipped:", err?.message || err);
    return [];
  }
}

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

const BULK_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const BULK_MAX_FILES = 100;

function parseEnvelopeJson(json) {
  try { return json ? JSON.parse(json) : null; } catch (_) { return null; }
}

function mimeTypeFromFilename(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".pdf") return "application/pdf";
  return null;
}

function normalizeNameKey(value) {
  return String(value || "").toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "").trim();
}

function extractionNameKeys(extraction) {
  const surname = String(extraction?.surname || "").trim();
  const given = String(extraction?.givenNames || "").trim();
  const keys = new Set();
  const one = normalizeNameKey(`${given} ${surname}`.trim());
  const two = normalizeNameKey(`${surname} ${given}`.trim());
  if (one) keys.add(one);
  if (two) keys.add(two);
  return [...keys];
}

async function storeBufferScan(buffer, mimeType) {
  const safeExt = PASSPORT_MIME_EXT[(mimeType || "").toLowerCase()];
  if (!safeExt) {
    const err = new Error("unsupported file type - JPG / PNG / PDF only");
    err.status = 415;
    err.code = "UNSUPPORTED_MIME";
    throw err;
  }
  const filename = `${crypto.randomUUID()}${safeExt}`;
  const filePath = path.join(uploadPath, filename);
  await fs.promises.writeFile(filePath, buffer);
  return {
    filename,
    filePath,
    fileUrl: `/api/uploads/passport-ocr/${filename}`,
  };
}

async function buildPassportListRows(tenantId, opts = {}) {
  const [tripRows, customerRows] = await Promise.all([
    prisma.tripParticipant.findMany({
      where: {
        trip: { tenantId },
        OR: [
          { passportExtractedAt: { not: null } },
          { passportVerifiedAt: { not: null } },
          { passportRejectedAt: { not: null } },
        ],
      },
      include: {
        trip: { select: { id: true, tripCode: true, destination: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 5000,
    }),
    prisma.customerTraveller.findMany({
      where: {
        tenantId,
        OR: [
          { passportExtractedAt: { not: null } },
          { passportVerifiedAt: { not: null } },
          { passportRejectedAt: { not: null } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 5000,
    }),
  ]);

  const contactIds = [...new Set(customerRows.map((row) => Number(row.contactId)).filter((id) => Number.isFinite(id) && id > 0))];
  const contactRows = contactIds.length
    ? await prisma.contact.findMany({
        where: { tenantId, id: { in: contactIds }, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true, subBrand: true },
      })
    : [];
  const contactById = new Map(contactRows.map((row) => [row.id, row]));

  const tripOut = tripRows.map((r) => {
    const envelope = parseEnvelopeJson(r.passportExtractionJson);
    return {
      kind: "trip",
      id: r.id,
      fullName: r.fullName,
      trip: r.trip,
      subBrand: "tmc",
      relationship: null,
      contactId: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      importInbox: false,
      passportNumber: r.passportNumber || envelope?.extraction?.passportNumber || null,
      extractedAt: r.passportExtractedAt,
      verifiedAt: r.passportVerifiedAt,
      rejectedAt: r.passportRejectedAt,
      status: r.passportVerifiedAt ? "verified" : r.passportRejectedAt ? "rejected" : "pending",
      confidence: envelope?.confidence ?? null,
      provider: envelope?.provider || null,
      imageUrl: envelope?.imageUrl || null,
      originalName: envelope?.originalName || null,
    };
  });

  const customerOut = customerRows.map((r) => {
    const envelope = parseEnvelopeJson(r.passportExtractionJson);
    const contact = contactById.get(Number(r.contactId)) || null;
    const importInbox = r.subBrand === "passport_inbox" || r.relationship === "bulk_import_inbox" || Number(r.contactId) === 0;
    return {
      kind: "customer",
      id: r.id,
      fullName: r.fullName,
      trip: null,
      subBrand: r.subBrand,
      relationship: r.relationship || null,
      contactId: Number.isFinite(Number(r.contactId)) ? Number(r.contactId) : null,
      contactName: contact?.name || null,
      contactEmail: contact?.email || null,
      contactPhone: contact?.phone || null,
      importInbox,
      passportNumber: r.passportNumber || envelope?.extraction?.passportNumber || null,
      extractedAt: r.passportExtractedAt,
      verifiedAt: r.passportVerifiedAt,
      rejectedAt: r.passportRejectedAt,
      status: r.passportVerifiedAt ? "verified" : r.passportRejectedAt ? "rejected" : "pending",
      confidence: envelope?.confidence ?? null,
      provider: envelope?.provider || null,
      imageUrl: envelope?.imageUrl || null,
      originalName: envelope?.originalName || null,
    };
  });

  const allRows = [...tripOut, ...customerOut].sort((a, b) => {
    const aTime = new Date(a.verifiedAt || a.rejectedAt || a.extractedAt || 0).getTime();
    const bTime = new Date(b.verifiedAt || b.rejectedAt || b.extractedAt || 0).getTime();
    return bTime - aTime;
  });

  const query = String(opts.query || "").trim().toLowerCase();
  const statusFilter = String(opts.status || "").trim().toLowerCase();
  const sourceFilter = String(opts.source || "").trim().toLowerCase();
  const filtered = allRows.filter((row) => {
    if (statusFilter && row.status !== statusFilter) return false;
    if (sourceFilter === "trip" && row.kind !== "trip") return false;
    if (sourceFilter === "customer" && (row.kind !== "customer" || row.importInbox)) return false;
    if (sourceFilter === "inbox" && !row.importInbox) return false;
    if (!query) return true;
    const hay = [
      row.fullName,
      row.passportNumber,
      row.originalName,
      row.subBrand,
      row.relationship,
      row.contactName,
      row.contactEmail,
      row.contactPhone,
      row.trip?.tripCode,
      row.trip?.destination,
      row.status,
      row.importInbox ? "imported passport inbox" : null,
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(query);
  });

  const pageSize = Math.max(1, Math.min(50, Number.parseInt(opts.pageSize, 10) || 3));
  const page = Math.max(1, Number.parseInt(opts.page, 10) || 1);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize);

  return {
    rows,
    total,
    page: safePage,
    pageSize,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    query,
    statusFilter,
    sourceFilter,
  };
}

async function loadBulkMatchCandidates(tenantId) {
  const [tripRows, customerRows] = await Promise.all([
    prisma.tripParticipant.findMany({
      where: { trip: { tenantId } },
      include: { trip: { select: { id: true, tripCode: true, destination: true } } },
      take: 5000,
    }),
    prisma.customerTraveller.findMany({
      where: { tenantId },
      take: 5000,
    }),
  ]);

  const all = [
    ...tripRows.map((row) => ({ kind: "trip", row })),
    ...customerRows.map((row) => ({ kind: "customer", row })),
  ];

  const byName = new Map();
  for (const item of all) {
    const key = normalizeNameKey(item.row.fullName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  return { all, byName };
}

function chooseBulkSubject(candidateIndex, fileName, extraction) {
  const fileKey = normalizeNameKey(fileName);
  const fileMatches = fileKey ? (candidateIndex.byName.get(fileKey) || []) : [];
  if (fileMatches.length === 1) return { subject: fileMatches[0], matchedBy: "filename" };
  if (fileMatches.length > 1) return { error: "Multiple traveller matches found for filename" };

  for (const key of extractionNameKeys(extraction)) {
    const matches = candidateIndex.byName.get(key) || [];
    if (matches.length === 1) return { subject: matches[0], matchedBy: "ocr_name" };
    if (matches.length > 1) return { error: "Multiple traveller matches found for extracted name" };
  }
  return { error: "No traveller matched this passport filename or OCR name" };
}

async function persistPassportExtractionForSubject(subject, req, fileMeta, result, matchedBy) {
  const stored = await storeBufferScan(fileMeta.buffer, fileMeta.mimetype);
  try {
    const identityCandidates = await safeFindPassportIdentityCandidates({
      tenantId: req.travelTenant.id,
      sourceType: subject.kind,
      sourceId: subject.row.id,
      extraction: result.extraction,
      fullName: subject.row.fullName,
      phone: subject.kind === "trip" ? subject.row.parentPhone : null,
    }, "bulk-upload");

    const persistedEnvelope = {
      ...result,
      imageFilename: stored.filename,
      imageUrl: stored.fileUrl,
      originalName: fileMeta.originalname || null,
      identityCandidates,
      bulkMatchedBy: matchedBy,
    };

    if (subject.kind === "trip") {
      await prisma.tripParticipant.update({
        where: { id: subject.row.id },
        data: {
          passportExtractionJson: JSON.stringify(persistedEnvelope),
          passportExtractedAt: new Date(),
          passportRejectedAt: null,
        },
      });
      await removeScanFromEnvelopeJson(subject.row.passportExtractionJson, stored.filename);
      writeAudit("TripParticipant", "passport.uploaded", subject.row.id, req.user.userId, req.travelTenant.id, {
        extractedFieldNames: Object.keys(result.extraction || {}),
        confidence: result.confidence,
        provider: result.provider,
        bulk: true,
        matchedBy,
      }).catch(() => {});
    } else {
      await prisma.customerTraveller.update({
        where: { id: subject.row.id },
        data: {
          passportExtractionJson: JSON.stringify(persistedEnvelope),
          passportExtractedAt: new Date(),
          passportRejectedAt: null,
        },
      });
      await removeScanFromEnvelopeJson(subject.row.passportExtractionJson, stored.filename);
      writeAudit("CustomerTraveller", "passport.uploaded", subject.row.id, req.user.userId, req.travelTenant.id, {
        extractedFieldNames: Object.keys(result.extraction || {}),
        confidence: result.confidence,
        provider: result.provider,
        bulk: true,
        matchedBy,
      }).catch(() => {});
    }

    return { stored, identityCandidates };
  } catch (err) {
    await fs.promises.unlink(stored.filePath).catch(() => {});
    throw err;
  }
}

function buildBulkInboxName(fileName, extraction) {
  const given = String(extraction?.givenNames || "").trim();
  const surname = String(extraction?.surname || "").trim();
  const extractedName = `${given} ${surname}`.trim();
  if (extractedName) return extractedName;
  const raw = path.basename(String(fileName || ""), path.extname(String(fileName || "")));
  return raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Imported passport";
}

async function persistPassportImportInbox(req, fileMeta, result) {
  const stored = await storeBufferScan(fileMeta.buffer, fileMeta.mimetype);
  try {
    const fullName = buildBulkInboxName(fileMeta.originalname, result.extraction || {});
    const identityCandidates = await safeFindPassportIdentityCandidates({
      tenantId: req.travelTenant.id,
      sourceType: "customer",
      sourceId: null,
      extraction: result.extraction,
      fullName,
    }, "bulk-upload-inbox");

    const persistedEnvelope = {
      ...result,
      imageFilename: stored.filename,
      imageUrl: stored.fileUrl,
      originalName: fileMeta.originalname || null,
      identityCandidates,
      bulkMatchedBy: "import_inbox",
      importInbox: true,
    };

    const created = await prisma.customerTraveller.create({
      data: {
        tenantId: req.travelTenant.id,
        contactId: 0,
        subBrand: "passport_inbox",
        fullName,
        relationship: "bulk_import_inbox",
        passportNumber: result.extraction?.passportNumber || null,
        passportExpiry: result.extraction?.dateOfExpiry ? new Date(result.extraction.dateOfExpiry) : null,
        passportExtractionJson: JSON.stringify(persistedEnvelope),
        passportExtractedAt: new Date(),
        passportRejectedAt: null,
      },
    });

    writeAudit("CustomerTraveller", "passport.bulk_imported_unmatched", created.id, req.user.userId, req.travelTenant.id, {
      extractedFieldNames: Object.keys(result.extraction || {}),
      confidence: result.confidence,
      provider: result.provider,
      bulk: true,
      matchedBy: "import_inbox",
      autoCreated: true,
    }).catch(() => {});

    return { created, identityCandidates, stored };
  } catch (err) {
    await fs.promises.unlink(stored.filePath).catch(() => {});
    throw err;
  }
}

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BULK_ARCHIVE_MAX_BYTES, files: BULK_MAX_FILES + 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const ext = path.extname(String(file.originalname || "")).toLowerCase();
    if (file.fieldname === "archive") {
      if ((mime === "application/zip" || mime === "application/x-zip-compressed") && ext === ".zip") return cb(null, true);
      return cb(new Error("UNSUPPORTED_ARCHIVE"));
    }
    if (file.fieldname === "files" && PASSPORT_MIME_EXT[mime]) return cb(null, true);
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

function bulkUploadHandler(req, res, next) {
  bulkUpload.fields([{ name: "archive", maxCount: 1 }, { name: "files", maxCount: BULK_MAX_FILES }])(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "bulk upload exceeds size limit", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err && err.message === "UNSUPPORTED_ARCHIVE") {
      return res.status(415).json({ error: "unsupported archive type - upload a ZIP file", code: "UNSUPPORTED_ARCHIVE" });
    }
    if (err && err.message === "UNSUPPORTED_MIME") {
      return res.status(415).json({ error: "unsupported file type - JPG / PNG / PDF only", code: "UNSUPPORTED_MIME" });
    }
    if (err) return next(err);

    try {
      const archive = req.files?.archive?.[0] || null;
      const directFiles = Array.isArray(req.files?.files) ? req.files.files : [];
      if (!archive && directFiles.length === 0) {
        return res.status(400).json({ error: "upload a ZIP archive or one or more passport files", code: "NO_FILES" });
      }
      if (archive && directFiles.length > 0) {
        return res.status(400).json({ error: "choose either a ZIP archive or direct files, not both", code: "AMBIGUOUS_BULK_SOURCE" });
      }
      if (!archive) return next();

      const directory = await unzipper.Open.buffer(archive.buffer);
      const entries = directory.files.filter((entry) => entry.type === "File");
      if (entries.length > BULK_MAX_FILES) {
        return res.status(413).json({ error: `ZIP contains too many files (max ${BULK_MAX_FILES})`, code: "TOO_MANY_FILES" });
      }
      const extracted = [];
      for (const entry of entries) {
        const entryName = path.basename(entry.path || "");
        const mimeType = mimeTypeFromFilename(entryName);
        if (!mimeType) continue;
        if (Number(entry.vars?.uncompressedSize || 0) > 5 * 1024 * 1024) {
          return res.status(413).json({ error: `ZIP entry too large: ${entryName}`, code: "FILE_TOO_LARGE" });
        }
        extracted.push({
          fieldname: "files",
          originalname: entryName,
          mimetype: mimeType,
          buffer: await entry.buffer(),
          size: Number(entry.vars?.uncompressedSize || 0),
        });
      }
      req.files.files = extracted;
      next();
    } catch (e) {
      console.error("[travel-passport] bulk archive parse error:", e.message);
      res.status(400).json({ error: "Could not read ZIP archive", code: "INVALID_ARCHIVE" });
    }
  });
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
      const identityCandidates = await safeFindPassportIdentityCandidates({
        tenantId: req.travelTenant.id,
        sourceType: "trip",
        sourceId: participant.id,
        extraction: result.extraction,
        fullName: participant.fullName,
        phone: participant.parentPhone,
      });
      persistedEnvelope.identityCandidates = identityCandidates;

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
          identityCandidateCount: identityCandidates.length,
        },
      ).catch(() => {});

      return res.status(201).json({
        participantId: participant.id,
        extraction: result.extraction,
        confidence: result.confidence,
        provider: result.provider,
        extractedAt: updated.passportExtractedAt,
        imageUrl: fileUrl,
        identityCandidates,
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

// Passport list - uploaded scans across all statuses.

router.get(
  "/passport-list",
  verifyToken,
  requirePermission("passport", "read"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const result = await buildPassportListRows(req.travelTenant.id, {
        query: req.query.q,
        status: req.query.status,
        source: req.query.source,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      res.json({
        passports: result.rows,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
        hasPrev: result.hasPrev,
        hasNext: result.hasNext,
        q: result.query,
        status: result.statusFilter,
        source: result.sourceFilter,
      });
    } catch (e) {
      console.error("[travel-passport] list error:", e.message);
      res.status(500).json({ error: "Failed to load passport list" });
    }
  },
);

router.get(
  "/contact-search",
  verifyToken,
  requirePermission("passport", "read"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const limit = Math.max(1, Math.min(25, Number.parseInt(req.query.limit, 10) || 10));
      const where = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
      };
      if (q) {
        where.OR = [
          { name: { contains: q } },
          { email: { contains: q } },
          { phone: { contains: q } },
        ];
      }
      const contacts = await prisma.contact.findMany({
        where,
        select: { id: true, name: true, email: true, phone: true, subBrand: true },
        orderBy: { id: "desc" },
        take: limit,
      });
      res.json({ contacts });
    } catch (e) {
      console.error("[travel-passport] contact search error:", e.message);
      res.status(500).json({ error: "Failed to search contacts" });
    }
  },
);

// Bulk upload - accepts either a ZIP archive or multiple direct passport files.

router.post(
  "/bulk-upload",
  verifyToken,
  requirePermission("passport", "update"),
  requireTravelTenant,
  requireTmcAccess,
  bulkUploadHandler,
  async (req, res) => {
    try {
      const files = Array.isArray(req.files?.files) ? req.files.files : [];
      if (!files.length) {
        return res.status(400).json({ error: "no passport files found in upload", code: "NO_FILES" });
      }

      const candidates = await loadBulkMatchCandidates(req.travelTenant.id);
      const results = [];
      for (const file of files) {
        const item = { fileName: file.originalname, size: file.size };
        try {
          const result = await passportOcrClient.extractPassport({
            tenantId: req.travelTenant.id,
            fileBuffer: file.buffer,
            fileName: file.originalname,
            mimeType: file.mimetype,
          });
          const match = chooseBulkSubject(candidates, file.originalname, result.extraction || {});
          if (match.error) {
            const inbox = await persistPassportImportInbox(req, file, result);
            results.push({
              ...item,
              status: "queued",
              message: "Imported into passport inbox for later review",
              matchedTo: inbox.created.fullName,
              kind: "customer",
              matchedBy: "import_inbox",
              passportNumber: result.extraction?.passportNumber || null,
            });
            continue;
          }
          const subject = match.subject;
          if (subject.row.passportVerifiedAt) {
            results.push({ ...item, status: "skipped", message: "Passport already verified for this traveller", matchedTo: subject.row.fullName, kind: subject.kind });
            continue;
          }
          if (subject.row.passportExtractedAt && !subject.row.passportRejectedAt) {
            results.push({ ...item, status: "skipped", message: "Passport already queued for verification", matchedTo: subject.row.fullName, kind: subject.kind });
            continue;
          }

          await persistPassportExtractionForSubject(subject, req, file, result, match.matchedBy);
          results.push({
            ...item,
            status: "queued",
            matchedTo: subject.row.fullName,
            kind: subject.kind,
            matchedBy: match.matchedBy,
            passportNumber: result.extraction?.passportNumber || null,
          });
        } catch (e) {
          if (e.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
            results.push({ ...item, status: "failed", message: "Passport OCR is not enabled for this tenant" });
          } else {
            results.push({ ...item, status: "failed", message: e.message || "Failed to process passport" });
          }
        }
      }

      const queued = results.filter((r) => r.status === "queued").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const failed = results.filter((r) => r.status === "failed").length;
      res.json({ total: results.length, queued, skipped, failed, results });
    } catch (e) {
      console.error("[travel-passport] bulk upload error:", e.message);
      res.status(500).json({ error: "Failed to process bulk passport upload" });
    }
  },
);

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
          identityCandidates: envelope?.identityCandidates || [],
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
          identityCandidates: envelope?.identityCandidates || [],
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
      const identityCandidates = await safeFindPassportIdentityCandidates({
        tenantId: req.travelTenant.id,
        sourceType: "trip",
        sourceId: participant.id,
        extraction: envelope.extraction,
        fullName: participant.fullName,
        phone: participant.parentPhone,
      });
      persistedEnvelope.identityCandidates = identityCandidates;

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
        identityCandidates,
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

        const finalExtraction = {
          ...extraction,
          ...edits,
          passportNumber: finalNumber,
          dateOfExpiry: finalExpiry || extraction.dateOfExpiry || null,
        };
        const identityCandidates = await safeFindPassportIdentityCandidates({
          tenantId: req.travelTenant.id,
          sourceType: "trip",
          sourceId: participant.id,
          extraction: finalExtraction,
          fullName: participant.fullName,
          phone: participant.parentPhone,
        });

        const passportIdentity = await persistPassportIdentity({
          tenantId: req.travelTenant.id,
          sourceType: "trip_participant",
          sourceId: participant.id,
          extraction: finalExtraction,
          fullName: participant.fullName,
          phone: participant.parentPhone,
          verifiedAt: new Date(),
          verifiedById: req.user.userId,
          envelope: { ...envelope, extraction: finalExtraction },
        });

        const updateData = {
          passportNumber: finalNumber,
          passportExpiry: finalExpiry ? new Date(finalExpiry) : null,
          passportIdentityId: passportIdentity?.id || null,
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
            identityCandidateCount: identityCandidates.length,
            passportIdentityLinked: Boolean(passportIdentity?.id),
            // VALUES intentionally not logged — passport number / expiry
            // stay out of the audit trail (PRD FR-9).
          },
        ).catch(() => {});

        return res.json({
          participantId: updated.id,
          approved: true,
          verifiedAt: updated.passportVerifiedAt,
          verifiedById: updated.passportVerifiedById,
          identityCandidates,
          passportIdentityId: passportIdentity?.id || null,
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

router.post(
  "/customer-travellers/:id/assign-contact",
  verifyToken,
  requirePermission("passport", "update"),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const traveller = await loadCustomerTraveller(req);
      if (!(traveller.subBrand === "passport_inbox" || traveller.relationship === "bulk_import_inbox" || Number(traveller.contactId) === 0)) {
        return res.status(409).json({ error: "Only imported inbox passports can be assigned from this screen", code: "NOT_INBOX_PASSPORT" });
      }

      const contactId = Number.parseInt(req.body?.contactId, 10);
      const relationship = String(req.body?.relationship || "self").trim().toLowerCase();
      const allowedRelationships = new Set(["self", "spouse", "child", "parent", "other"]);
      if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "body.contactId required", code: "INVALID_CONTACT_ID" });
      }
      if (!allowedRelationships.has(relationship)) {
        return res.status(400).json({ error: "body.relationship invalid", code: "INVALID_RELATIONSHIP" });
      }

      const contact = await prisma.contact.findFirst({
        where: { id: contactId, tenantId: req.travelTenant.id, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true, subBrand: true },
      });
      if (!contact) {
        return res.status(404).json({ error: "Contact not found", code: "CONTACT_NOT_FOUND" });
      }

      const updated = await prisma.customerTraveller.update({
        where: { id: traveller.id },
        data: {
          contactId: contact.id,
          subBrand: contact.subBrand || "tmc",
          relationship,
        },
      });

      writeAudit(
        "CustomerTraveller",
        "passport.assigned_to_contact",
        traveller.id,
        req.user.userId,
        req.travelTenant.id,
        { contactId: contact.id, relationship },
      ).catch(() => {});

      return res.json({
        travellerId: updated.id,
        contactId: contact.id,
        contactName: contact.name,
        relationship,
        assigned: true,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-passport] assign-contact error:", e.message);
      res.status(500).json({ error: "Failed to assign passport to contact" });
    }
  },
);

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

        const finalExtraction = {
          ...extraction,
          ...edits,
          passportNumber: finalNumber,
          dateOfExpiry: finalExpiry || extraction.dateOfExpiry || null,
        };
        const identityCandidates = await safeFindPassportIdentityCandidates({
          tenantId: req.travelTenant.id,
          sourceType: "customer",
          sourceId: traveller.id,
          extraction: finalExtraction,
          fullName: traveller.fullName,
        });

        const passportIdentity = await persistPassportIdentity({
          tenantId: req.travelTenant.id,
          contactId: traveller.contactId,
          sourceType: "customer_traveller",
          sourceId: traveller.id,
          extraction: finalExtraction,
          fullName: traveller.fullName,
          verifiedAt: new Date(),
          verifiedById: req.user.userId,
          envelope: { ...envelope, extraction: finalExtraction },
        });

        const updated = await prisma.customerTraveller.update({
          where: { id: traveller.id },
          data: {
            passportNumber: finalNumber,
            passportExpiry: finalExpiry ? new Date(finalExpiry) : null,
            passportIdentityId: passportIdentity?.id || null,
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
          { editedFieldNames: Object.keys(edits), identityCandidateCount: identityCandidates.length, passportIdentityLinked: Boolean(passportIdentity?.id) },
        ).catch(() => {});

        return res.json({
          travellerId: updated.id,
          approved: true,
          verifiedAt: updated.passportVerifiedAt,
          verifiedById: updated.passportVerifiedById,
          identityCandidates,
          passportIdentityId: passportIdentity?.id || null,
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
