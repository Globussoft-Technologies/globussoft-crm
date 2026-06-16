// ─────────────────────────────────────────────────────────────────────
// /api/travel-school-terms — TMC school term / holiday / exam-blackout
// calendar CRUD + a date-check helper.
//
// Why: school trips must fit the academic calendar (trips run in breaks, not
// during term-time or exams). There is NO public API for a specific school's
// term/holiday/exam dates, so the data is captured by asking the school
// (source='manual'), seeded with India baseline windows (source='seed'), and
// a future "import from the school's website" feed (source='website').
//
// Endpoints:
//   GET    /                 list, filter by ?schoolName / ?kind / ?board / ?isActive
//   GET    /check?date=...    does a date fall in any active window? (+ ?schoolName)
//   POST   /                  create (ADMIN-only)
//   PUT    /:id               update (ADMIN-only)
//   DELETE /:id               soft-delete via isActive=false (ADMIN-only)
//
// Tenant-scoped on req.user.tenantId. Sub-brand defaults to 'tmc'.
// ─────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");

const VALID_KINDS = ["term", "holiday", "exam-blackout"];

function parseDateOrNull(input) {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// GET / — list term windows (tenant-scoped), newest start first.
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

// GET /check?date=YYYY-MM-DD[&schoolName=...] — which active windows contain
// the date. A school's own rows AND baseline (schoolName=null) rows both apply.
router.get("/check", verifyToken, async (req, res) => {
  try {
    const date = parseDateOrNull(req.query.date);
    if (!date) {
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)", code: "INVALID_DATE" });
    }
    const where = {
      tenantId: req.user.tenantId,
      isActive: true,
      startDate: { lte: date },
      endDate: { gte: date },
    };
    if (req.query.schoolName) {
      // The school's own windows OR baseline (null-school) windows.
      where.OR = [{ schoolName: String(req.query.schoolName) }, { schoolName: null }];
    }
    const matches = await prisma.travelSchoolTerm.findMany({ where, orderBy: { startDate: "asc" } });

    // A trip on this date is "safe" only if it doesn't land in term-time or
    // exams. Holidays are fine (trips are meant to run then).
    const blocking = matches.filter((m) => m.kind === "term" || m.kind === "exam-blackout");
    res.json({
      date: req.query.date,
      inWindow: matches.length > 0,
      ok: blocking.length === 0,
      blocking: blocking.map((m) => ({ kind: m.kind, label: m.label, schoolName: m.schoolName })),
      matches: matches.map((m) => ({
        id: m.id, kind: m.kind, label: m.label, schoolName: m.schoolName,
        startDate: m.startDate, endDate: m.endDate,
      })),
    });
  } catch (e) {
    console.error("[travel-school-terms] check error:", e.message);
    res.status(500).json({ error: "Failed to check date" });
  }
});

// POST / — create a window (ADMIN-only).
router.post("/", verifyToken, requirePermission("school_terms", "write"), async (req, res) => {
  try {
    const { schoolName, board, kind, label, startDate, endDate, source } = req.body || {};
    if (!label || !startDate || !endDate) {
      return res.status(400).json({ error: "label, startDate and endDate are required", code: "MISSING_FIELDS" });
    }
    const k = kind ? String(kind) : "holiday";
    if (!VALID_KINDS.includes(k)) {
      return res.status(400).json({ error: `kind must be one of ${VALID_KINDS.join(", ")}`, code: "INVALID_KIND" });
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
        schoolName: schoolName ? sanitizeText(String(schoolName)) : null,
        board: board ? sanitizeText(String(board)) : null,
        kind: k,
        label: sanitizeText(String(label)),
        startDate: start,
        endDate: end,
        source: source === "website" || source === "seed" ? source : "manual",
      },
    });
    res.status(201).json(row);
  } catch (e) {
    console.error("[travel-school-terms] create error:", e.message);
    res.status(500).json({ error: "Failed to create school term" });
  }
});

// PUT /:id — update (ADMIN-only).
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
    if (schoolName !== undefined) data.schoolName = schoolName ? sanitizeText(String(schoolName)) : null;
    if (board !== undefined) data.board = board ? sanitizeText(String(board)) : null;
    if (label !== undefined) data.label = sanitizeText(String(label));
    if (kind !== undefined) {
      const k = String(kind);
      if (!VALID_KINDS.includes(k)) {
        return res.status(400).json({ error: `kind must be one of ${VALID_KINDS.join(", ")}`, code: "INVALID_KIND" });
      }
      data.kind = k;
    }
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
    console.error("[travel-school-terms] update error:", e.message);
    res.status(500).json({ error: "Failed to update school term" });
  }
});

// DELETE /:id — soft-delete (ADMIN-only).
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
