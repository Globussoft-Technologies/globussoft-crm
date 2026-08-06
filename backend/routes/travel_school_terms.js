// Travel CRM - TMC school term / holiday / exam-blackout calendar CRUD,
// bulk import, and source-document uploads.
//
// Why this surface exists:
//   - School trips must fit the academic calendar.
//   - There is no public API for per-school term calendars.
//   - Operators therefore need 3 practical input paths:
//       1. Manual row entry
//       2. CSV / Excel import when a school shares dates in tabular form
//       3. PDF / image upload of the school's published calendar for reference
//
// Mounted at /api/travel-school-terms
//
// Endpoints:
//   GET    /                     list rows
//   GET    /check                date-check helper
//   GET    /template             CSV / XLSX import template
//   POST   /import               bulk CSV / XLSX import
//   GET    /uploads              list uploaded source documents
//   POST   /uploads              upload PDF / image source document
//   DELETE /uploads/:uploadId    delete uploaded source document
//   POST   /                     create row
//   PUT    /:id                  update row
//   DELETE /:id                  soft-delete row

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");
const { parseCsv } = require("../lib/csvHelpers");
const { parseXlsxBuffer, toXlsxBuffer } = require("../lib/csvIO");

const VALID_KINDS = ["term", "holiday", "exam-blackout"];
const VALID_SOURCES = ["manual", "seed", "website"];
const MAX_IMPORT_ROWS = 5000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TEMPLATE_HEADERS = [
  "schoolName",
  "board",
  "kind",
  "label",
  "startDate",
  "endDate",
  "source",
  "isActive",
];
const TEMPLATE_ROWS = [
  {
    schoolName: "Delhi Public School Bangalore",
    board: "CBSE",
    kind: "holiday",
    label: "Summer Break 2027",
    startDate: "2027-04-10",
    endDate: "2027-06-05",
    source: "manual",
    isActive: "true",
  },
];

const UPLOAD_DIR = path.join(
  __dirname,
  "..",
  "uploads",
  "travel-school-term-calendars",
);
const UPLOAD_INDEX_PATH = path.join(UPLOAD_DIR, "index.json");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const UPLOAD_MIME_EXT = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function parseDateOrNull(input) {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normaliseOptionalText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return sanitizeText(trimmed);
}

function normaliseKind(value) {
  const kind = value ? String(value).trim() : "holiday";
  if (!VALID_KINDS.includes(kind)) {
    const err = new Error(`kind must be one of ${VALID_KINDS.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_KIND";
    throw err;
  }
  return kind;
}

function normaliseSource(value) {
  const source = value ? String(value).trim() : "manual";
  return VALID_SOURCES.includes(source) ? source : "manual";
}

function normaliseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return fallback;
}

function buildTemplateCsv() {
  const lines = [
    TEMPLATE_HEADERS.join(","),
    TEMPLATE_ROWS.map((row) => TEMPLATE_HEADERS.map((h) => row[h] || "").join(",")).join(""),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const mt = String(file.mimetype || "").toLowerCase();
  return (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  );
}

function parseSpreadsheetFile(file) {
  if (!file || !file.buffer || file.buffer.length === 0) return { headers: [], rows: [] };
  if (isXlsxUpload(file)) return parseXlsxBuffer(file.buffer);
  return parseCsv(file.buffer.toString("utf8"));
}

function readUploadIndex() {
  try {
    if (!fs.existsSync(UPLOAD_INDEX_PATH)) return [];
    const raw = fs.readFileSync(UPLOAD_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUploadIndex(rows) {
  fs.writeFileSync(UPLOAD_INDEX_PATH, JSON.stringify(rows, null, 2), "utf8");
}

function listTenantUploads(tenantId) {
  return readUploadIndex()
    .filter((row) => Number(row.tenantId) === Number(tenantId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function unlinkIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

router.get("/", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.schoolName) where.schoolName = String(req.query.schoolName);
    if (req.query.kind) where.kind = String(req.query.kind);
    if (req.query.board) where.board = String(req.query.board);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;

    const rows = await prisma.travelSchoolTerm.findMany({
      where,
      orderBy: [{ startDate: "desc" }],
      take: Math.min(parseInt(req.query.limit, 10) || 200, 500),
    });
    res.json(rows);
  } catch (e) {
    console.error("[travel-school-terms] list error:", e.message);
    res.status(500).json({ error: "Failed to list school terms" });
  }
});

router.get("/check", verifyToken, async (req, res) => {
  try {
    const date = parseDateOrNull(req.query.date);
    if (!date) {
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)", code: "INVALID_DATE" });
    }
    // Trips can only be scheduled forward, so a past date is a data-entry
    // slip rather than a question worth answering. Compared in UTC against
    // UTC midnight because parseDateOrNull turns "YYYY-MM-DD" into UTC
    // midnight — mixing in local time here would misjudge the boundary by
    // a day for anyone east or west of the server. Today itself is allowed.
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    if (date.getTime() < todayUtc.getTime()) {
      return res.status(400).json({
        error: "Pick today or a future date — past dates can't be scheduled.",
        code: "PAST_DATE",
      });
    }
    const where = {
      tenantId: req.user.tenantId,
      isActive: true,
      startDate: { lte: date },
      endDate: { gte: date },
    };
    if (req.query.schoolName) {
      where.OR = [{ schoolName: String(req.query.schoolName) }, { schoolName: null }];
    }
    const matches = await prisma.travelSchoolTerm.findMany({ where, orderBy: { startDate: "asc" } });
    const blocking = matches.filter((m) => m.kind === "term" || m.kind === "exam-blackout");
    // Three distinct outcomes, not two. `ok` alone can't tell "this date is
    // inside a holiday window, go ahead" apart from "no window covers this
    // date at all" — both leave `blocking` empty, so a date with no calendar
    // data was reading as a confirmed green light. `status` separates them:
    //   blocked — a term / exam-blackout window covers the date
    //   clear   — a window covers it and none of them block (i.e. a holiday)
    //   unknown — nothing on file for this date; we can't vouch for it
    // `ok` and `inWindow` keep their original meaning for existing callers.
    let status;
    if (blocking.length > 0) status = "blocked";
    else if (matches.length > 0) status = "clear";
    else status = "unknown";
    res.json({
      date: req.query.date,
      inWindow: matches.length > 0,
      ok: blocking.length === 0,
      status,
      blocking: blocking.map((m) => ({ kind: m.kind, label: m.label, schoolName: m.schoolName })),
      matches: matches.map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        schoolName: m.schoolName,
        startDate: m.startDate,
        endDate: m.endDate,
      })),
    });
  } catch (e) {
    console.error("[travel-school-terms] check error:", e.message);
    res.status(500).json({ error: "Failed to check date" });
  }
});

router.get("/template", verifyToken, requirePermission("school_terms", "read"), async (req, res) => {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return res.status(400).json({ error: "format must be csv or xlsx", code: "INVALID_FORMAT" });
    }
    if (format === "xlsx") {
      const buf = toXlsxBuffer(TEMPLATE_HEADERS, TEMPLATE_ROWS, "School Terms");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="travel-school-terms-template.xlsx"');
      return res.end(buf);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="travel-school-terms-template.csv"');
    return res.end(buildTemplateCsv());
  } catch (e) {
    console.error("[travel-school-terms] template error:", e.message);
    res.status(500).json({ error: "Failed to build template" });
  }
});

router.post(
  "/import",
  verifyToken,
  requirePermission("school_terms", "write"),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: "No CSV/Excel file uploaded", code: "NO_FILE" });
      }
      const parsed = parseSpreadsheetFile(req.file);
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      if (rows.length === 0) {
        return res.status(400).json({ error: "Spreadsheet is empty", code: "EMPTY_FILE" });
      }
      if (rows.length > MAX_IMPORT_ROWS) {
        return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS}`, code: "TOO_MANY_ROWS" });
      }

      const errors = [];
      let imported = 0;
      let updated = 0;
      let skipped = 0;

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] || {};
        const rowNumber = Number(row.__row) || i + 2;
        try {
          const label = normaliseOptionalText(row.label);
          const start = parseDateOrNull(row.startDate);
          const end = parseDateOrNull(row.endDate);
          if (!label || !start || !end) {
            throw new Error("label, startDate, and endDate are required");
          }
          if (end < start) throw new Error("endDate must be on or after startDate");

          const data = {
            tenantId: req.user.tenantId,
            subBrand: "tmc",
            schoolName: normaliseOptionalText(row.schoolName),
            board: normaliseOptionalText(row.board),
            kind: normaliseKind(row.kind),
            label,
            startDate: start,
            endDate: end,
            source: normaliseSource(row.source),
            isActive: normaliseBoolean(row.isActive, true),
          };

          const existing = await prisma.travelSchoolTerm.findFirst({
            where: {
              tenantId: req.user.tenantId,
              schoolName: data.schoolName,
              board: data.board,
              kind: data.kind,
              label: data.label,
            },
            orderBy: [{ id: "desc" }],
          });

          if (existing) {
            await prisma.travelSchoolTerm.update({
              where: { id: existing.id },
              data: {
                startDate: data.startDate,
                endDate: data.endDate,
                source: data.source,
                isActive: data.isActive,
              },
            });
            updated += 1;
          } else {
            await prisma.travelSchoolTerm.create({ data });
            imported += 1;
          }
        } catch (err) {
          skipped += 1;
          errors.push({
            rowNumber,
            reason: err?.message || "Invalid row",
            label: String(row.label || ""),
          });
        }
      }

      res.json({ total: rows.length, imported, updated, skipped, errors });
    } catch (e) {
      if (e instanceof multer.MulterError && e.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File exceeds 10 MB limit", code: "FILE_TOO_LARGE" });
      }
      console.error("[travel-school-terms] import error:", e.message);
      res.status(500).json({ error: "Failed to import school terms" });
    }
  },
);

router.get("/uploads", verifyToken, requirePermission("school_terms", "read"), async (req, res) => {
  try {
    res.json({ uploads: listTenantUploads(req.user.tenantId) });
  } catch (e) {
    console.error("[travel-school-terms] uploads list error:", e.message);
    res.status(500).json({ error: "Failed to list uploaded calendars" });
  }
});

router.post(
  "/uploads",
  verifyToken,
  requirePermission("school_terms", "write"),
  upload.single("file"),
  async (req, res) => {
    let savedPath = null;
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: "No file uploaded", code: "NO_FILE" });
      }
      const mime = String(req.file.mimetype || "").toLowerCase();
      const ext = UPLOAD_MIME_EXT[mime];
      if (!ext) {
        return res.status(415).json({
          error: "unsupported file type - PDF / JPG / PNG / WEBP only",
          code: "UNSUPPORTED_MIME",
        });
      }
      const uploadId = crypto.randomUUID();
      const storedName = `${req.user.tenantId}-${uploadId}${ext}`;
      savedPath = path.join(UPLOAD_DIR, storedName);
      fs.writeFileSync(savedPath, req.file.buffer);

      const row = {
        id: uploadId,
        tenantId: req.user.tenantId,
        schoolName: normaliseOptionalText(req.body?.schoolName),
        board: normaliseOptionalText(req.body?.board),
        label: normaliseOptionalText(req.body?.label),
        originalName: req.file.originalname || storedName,
        storedName,
        mimeType: mime,
        sizeBytes: req.file.size || req.file.buffer.length,
        fileUrl: `/api/uploads/travel-school-term-calendars/${storedName}`,
        createdAt: new Date().toISOString(),
        uploadedBy: req.user.userId,
      };
      const indexRows = readUploadIndex();
      indexRows.push(row);
      writeUploadIndex(indexRows);
      res.status(201).json(row);
    } catch (e) {
      unlinkIfExists(savedPath);
      if (e instanceof multer.MulterError && e.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File exceeds 10 MB limit", code: "FILE_TOO_LARGE" });
      }
      console.error("[travel-school-terms] upload error:", e.message);
      res.status(500).json({ error: "Failed to upload school calendar" });
    }
  },
);

router.delete(
  "/uploads/:uploadId",
  verifyToken,
  requirePermission("school_terms", "delete"),
  async (req, res) => {
    try {
      const uploadId = String(req.params.uploadId || "").trim();
      if (!uploadId) {
        return res.status(400).json({ error: "uploadId is required", code: "INVALID_UPLOAD_ID" });
      }
      const rows = readUploadIndex();
      const idx = rows.findIndex(
        (row) => row.id === uploadId && Number(row.tenantId) === Number(req.user.tenantId),
      );
      if (idx === -1) {
        return res.status(404).json({ error: "Upload not found", code: "UPLOAD_NOT_FOUND" });
      }
      const [removed] = rows.splice(idx, 1);
      writeUploadIndex(rows);
      unlinkIfExists(path.join(UPLOAD_DIR, removed.storedName));
      res.json({ success: true });
    } catch (e) {
      console.error("[travel-school-terms] delete upload error:", e.message);
      res.status(500).json({ error: "Failed to delete uploaded calendar" });
    }
  },
);

router.post("/", verifyToken, requirePermission("school_terms", "write"), async (req, res) => {
  try {
    const { schoolName, board, kind, label, startDate, endDate, source } = req.body || {};
    if (!label || !startDate || !endDate) {
      return res.status(400).json({ error: "label, startDate and endDate are required", code: "MISSING_FIELDS" });
    }
    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (!start || !end) {
      return res.status(400).json({ error: "startDate/endDate must be valid dates", code: "INVALID_DATE" });
    }
    if (end < start) {
      return res.status(400).json({ error: "endDate must be on or after startDate", code: "INVALID_DATE" });
    }

    const row = await prisma.travelSchoolTerm.create({
      data: {
        tenantId: req.user.tenantId,
        subBrand: "tmc",
        schoolName: normaliseOptionalText(schoolName),
        board: normaliseOptionalText(board),
        kind: normaliseKind(kind),
        label: sanitizeText(String(label)),
        startDate: start,
        endDate: end,
        source: normaliseSource(source),
      },
    });
    res.status(201).json(row);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-school-terms] create error:", e.message);
    res.status(500).json({ error: "Failed to create school term" });
  }
});

router.put("/:id", verifyToken, requirePermission("school_terms", "update"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.travelSchoolTerm.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) {
      return res.status(404).json({ error: "School term not found", code: "NOT_FOUND" });
    }
    const { schoolName, board, kind, label, startDate, endDate, isActive } = req.body || {};
    const data = {};
    if (schoolName !== undefined) data.schoolName = normaliseOptionalText(schoolName);
    if (board !== undefined) data.board = normaliseOptionalText(board);
    if (label !== undefined) data.label = sanitizeText(String(label));
    if (kind !== undefined) data.kind = normaliseKind(kind);
    if (startDate !== undefined) {
      const d = parseDateOrNull(startDate);
      if (!d) return res.status(400).json({ error: "startDate must be a valid date", code: "INVALID_DATE" });
      data.startDate = d;
    }
    if (endDate !== undefined) {
      const d = parseDateOrNull(endDate);
      if (!d) return res.status(400).json({ error: "endDate must be a valid date", code: "INVALID_DATE" });
      data.endDate = d;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;

    const row = await prisma.travelSchoolTerm.update({ where: { id }, data });
    res.json(row);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-school-terms] update error:", e.message);
    res.status(500).json({ error: "Failed to update school term" });
  }
});

router.delete("/:id", verifyToken, requirePermission("school_terms", "delete"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.travelSchoolTerm.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) {
      return res.status(404).json({ error: "School term not found", code: "NOT_FOUND" });
    }
    await prisma.travelSchoolTerm.update({ where: { id }, data: { isActive: false } });
    res.json({ success: true });
  } catch (e) {
    console.error("[travel-school-terms] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete school term" });
  }
});

module.exports = router;
