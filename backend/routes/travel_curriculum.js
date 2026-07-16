/**
 * /api/travel-curriculum — TravelCurriculumMapping CRUD (PC-1 + PC-2/3/4/5
 * resolved 2026-05-24, tick #180).
 *
 * The TravelCurriculumMapping model (prisma/schema.prisma:4869, shipped
 * tick #178 commit 3441fda4, key-byte triage tick #179 b2d188ff) is TMC's
 * curriculum-to-destination mapping table — given a student's curriculum +
 * grade + subject, the diagnostic engine surfaces candidate destinations
 * sorted by fitScore.
 *
 * Per PC-7 — academic-team / advisor-head owns authorship; PC-1 — V1 ships
 * CBSE + ICSE rows with IB + Cambridge enabled but unseeded. Authoring is
 * tenant-wide ADMIN, not sub-brand-scoped, so the route mounts at
 * /api/travel-curriculum (sibling of /api/embassy-rules) rather than under
 * the /api/travel/* prefix.
 *
 * Endpoints
 * ---------
 *   GET    /api/travel-curriculum         — list, filterable by
 *                                            ?curriculum / ?grade / ?subject /
 *                                            ?isActive  (tenant-scoped)
 *   GET    /api/travel-curriculum/:id     — single mapping (tenant-scoped)
 *   POST   /api/travel-curriculum         — create (ADMIN-only)
 *   PUT    /api/travel-curriculum/:id     — update (ADMIN-only)
 *   DELETE /api/travel-curriculum/:id     — soft-delete via isActive=false
 *                                            (ADMIN-only; NO hard delete —
 *                                            preserves history for the
 *                                            diagnostic engine's audit trail)
 *
 * Validation
 * ----------
 *   - curriculum / grade / subject: non-empty strings (tenant + curriculum +
 *     grade + subject + learningOutcome composite uniqueness enforced at DB)
 *   - fitScore: integer in [1, 100] when provided (default 50 from schema)
 *   - destinationId: integer when provided (FK to TmcTrip resolved at
 *     read-time by the consumer, not bound here)
 *
 * Error envelope
 * --------------
 *   400 INVALID_ID                 — non-numeric path id
 *   400 MISSING_FIELDS             — curriculum / grade / subject absent on create
 *   400 INVALID_FIT_SCORE          — fitScore out of 1-100 range or non-integer
 *   400 INVALID_DESTINATION_ID     — destinationId not an integer
 *   400 EMPTY_BODY                 — PUT with no updatable fields
 *   403 RBAC_DENIED                — verifyRole gate
 *   404 CURRICULUM_NOT_FOUND       — id absent or cross-tenant
 *   409 CURRICULUM_DUPLICATE       — @@unique([tenantId, curriculum, grade,
 *                                       subject, learningOutcome]) violation
 *
 * Tenant scoping: every read uses `req.user.tenantId`; every write stamps
 * `tenantId` from the same source. The body cannot override (stripDangerous
 * middleware drops req.body.tenantId before this handler sees it, AND the
 * handler never reads it anyway per CLAUDE.md ESLint rule).
 *
 * createdById is stamped from `req.user.userId` on POST and cannot be
 * reassigned via PUT.
 */

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");
const {
  parseCsv: parseCurriculumCsv,
  serializeCsv: serializeCurriculumCsv,
  ALLOWED_CURRICULA: CURRICULUM_CSV_ALLOWED,
} = require("../lib/curriculumCsvParser");

// C6 — multer for /import.csv (memory storage, 5 MB cap matches csv_io.js +
// travel_csv_io.js conventions).
const curriculumUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Scoped text-body parser for /import.csv when the client posts a raw
// text/csv body (vs. multipart/form-data). Mounted at /import.csv path
// only so other handlers in this router aren't affected.
router.use("/import.csv", express.text({
  type: ["text/csv", "text/plain"],
  limit: "5mb",
}));

// Helper — read CSV from either multer (form-data file) or raw text body.
function readCurriculumCsvBody(req) {
  if (req.file && req.file.buffer) return req.file.buffer.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body.csv === "string") return req.body.csv;
  return null;
}

// 7 canonical TMC skills per docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md
// §3.3 + TMC_PENDING_FEATURES.md §Q3. Case-insensitive match on the
// learningOutcome field — coverage endpoint reports which of these 7 have
// ≥1 mapping per (curriculum, grade).
const TMC_CANONICAL_SKILLS = [
  "Empathy",
  "Self-awareness",
  "Collaboration and teamwork",
  "Mindfulness",
  "Lifelong learning and curiosity",
  "Cultural respect and inclusion",
  "Emotional resilience",
];

function assertNonEmptyString(input, fieldName, errorCode) {
  if (typeof input !== "string" || input.trim() === "") {
    const err = new Error(`${fieldName} must be a non-empty string`);
    err.status = 400;
    err.code = errorCode;
    throw err;
  }
}

function assertValidFitScore(input) {
  // Allow null/undefined — schema default (50) applies on create, no-op on update.
  if (input === undefined || input === null) return;
  if (!Number.isInteger(input) || input < 1 || input > 100) {
    const err = new Error("fitScore must be an integer between 1 and 100");
    err.status = 400;
    err.code = "INVALID_FIT_SCORE";
    throw err;
  }
}

function assertValidDestinationId(input) {
  if (input === undefined || input === null) return;
  if (!Number.isInteger(input)) {
    const err = new Error("destinationId must be an integer");
    err.status = 400;
    err.code = "INVALID_DESTINATION_ID";
    throw err;
  }
}

// Translate Prisma's P2002 (unique constraint violation) to a 409 with a
// stable code so the SPA / specs can distinguish it from generic 500s.
function isPrismaUniqueViolation(e) {
  return e && (e.code === "P2002" || /Unique constraint/i.test(e.message || ""));
}

// GET /api/travel-curriculum — list with optional filters.
router.get("/", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    if (req.query.curriculum !== undefined) {
      where.curriculum = String(req.query.curriculum);
    }
    if (req.query.grade !== undefined) {
      where.grade = String(req.query.grade);
    }
    if (req.query.subject !== undefined) {
      where.subject = String(req.query.subject);
    }
    if (req.query.isActive !== undefined) {
      // Accept 'true' / 'false' / '1' / '0'; anything else falls through
      // to the truthiness check (so ?isActive=yes works too).
      const v = String(req.query.isActive).toLowerCase();
      where.isActive = !(v === "false" || v === "0");
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [mappings, total] = await Promise.all([
      prisma.travelCurriculumMapping.findMany({
        where,
        orderBy: [{ fitScore: "desc" }, { createdAt: "desc" }],
        take,
        skip,
      }),
      prisma.travelCurriculumMapping.count({ where }),
    ]);
    res.json({ mappings, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-curriculum] list error:", e.message);
    res.status(500).json({ error: "Failed to list curriculum mappings" });
  }
});

// ============================================================================
// GET /api/travel-curriculum/stats — tenant-wide curriculum-mapping rollup.
//
// PRD_TRAVEL_TMC §3 — surfaces the academic-team's authoring progress
// (how many rows per curriculum / per grade / per subject, active vs
// archived, latest authorship timestamp). Powers a small header strip on
// the Curriculum admin page so the academic-team can see at-a-glance which
// (curriculum, grade, subject) combinations still need coverage.
//
// Sibling pattern: mirrors /suppliers/stats (#903 slice 23) +
// /commission-profiles/stats (#905 slice 18) +
// /diagnostics/stats (PRD_TRAVEL_RFU_DIAGNOSTIC §3). USER-readable
// anodyne aggregate — counts + bucket maps + latest-timestamp, no PII,
// no fitRationale text. Same contract as sibling /stats endpoints.
//
// Query params (all optional):
//   ?from / ?to — ISO date bounds on TravelCurriculumMapping.createdAt
//                 (gte / lte). Invalid → 400 INVALID_DATE.
//
// Response shape:
//   {
//     total,                         // count of matching rows (true count
//                                    //   even when aggregateExceedsCap)
//     active,                        // count where isActive=true
//     archived,                      // count where isActive=false
//     byCurriculum: { [curriculum]: { count, active } },
//     byGrade:      { [grade]:      { count } },
//     bySubject:    { [subject]:    { count } },
//     lastUpdatedAt,                 // ISO string of max(updatedAt) or null
//     aggregateExceedsCap,           // true when total > CAP (bounded fetch)
//   }
//
// Safety cap: process at most 2000 mappings per call; if matching total >
// 2000, return counts but mark aggregateExceedsCap=true. (Per-tenant
// authoring volume is realistically <500 rows for V1 — the 2000 cap is
// future-proofing for Phase-2 rule-based scoring expansion.)
//
// Tenant scoping: req.user.tenantId on every WHERE — no sub-brand narrowing
// because curriculum authoring is tenant-wide-ADMIN (route file header
// L13-15). Authoring is NOT split per sub-brand.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would 400 INVALID_ID before reaching this
// handler.
// ============================================================================
const CURRICULUM_STATS_CAP = 2000;

router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on createdAt.
    const where = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    // Bounded fetch to keep in-process aggregation safe.
    const mappings = await prisma.travelCurriculumMapping.findMany({
      where,
      select: {
        id: true,
        curriculum: true,
        grade: true,
        subject: true,
        isActive: true,
        updatedAt: true,
      },
      orderBy: [{ id: "asc" }],
      take: CURRICULUM_STATS_CAP,
    });

    // True total so callers know if aggregation is bounded.
    const totalMatching = await prisma.travelCurriculumMapping.count({ where });
    const aggregateExceedsCap = totalMatching > CURRICULUM_STATS_CAP;

    // Empty short-circuit — return zeroed envelope (bucket maps are {}, NOT
    // undefined; lastUpdatedAt is null, NOT missing).
    if (mappings.length === 0) {
      return res.json({
        total: 0,
        active: 0,
        archived: 0,
        byCurriculum: {},
        byGrade: {},
        bySubject: {},
        lastUpdatedAt: null,
        aggregateExceedsCap: false,
      });
    }

    let active = 0;
    let archived = 0;
    let lastUpdatedAt = null;
    const byCurriculum = {};
    const byGrade = {};
    const bySubject = {};

    for (const m of mappings) {
      if (m.isActive) active += 1;
      else archived += 1;

      const ts = m.updatedAt instanceof Date ? m.updatedAt : new Date(m.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }

      // Coalesce falsy curriculum/grade/subject defensively (schema says
      // non-nullable but a future migration could relax — forward-compat).
      const cKey = m.curriculum && String(m.curriculum).trim() ? m.curriculum : "_unknown";
      const gKey = m.grade && String(m.grade).trim() ? m.grade : "_unknown";
      const sKey = m.subject && String(m.subject).trim() ? m.subject : "_unknown";

      if (!byCurriculum[cKey]) byCurriculum[cKey] = { count: 0, active: 0 };
      byCurriculum[cKey].count += 1;
      if (m.isActive) byCurriculum[cKey].active += 1;

      if (!byGrade[gKey]) byGrade[gKey] = { count: 0 };
      byGrade[gKey].count += 1;

      if (!bySubject[sKey]) bySubject[sKey] = { count: 0 };
      bySubject[sKey].count += 1;
    }

    res.json({
      total: totalMatching,
      active,
      archived,
      byCurriculum,
      byGrade,
      bySubject,
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
      aggregateExceedsCap,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-curriculum] stats error:", e.message);
    res.status(500).json({ error: "Failed to compute curriculum stats" });
  }
});

// ============================================================================
// GET /api/travel-curriculum/by-month — tenant-wide curriculum-mapping
// monthly rollup (PRD_TRAVEL_TMC §3, Arc 2 Travel Gap).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket for
// the tenant-scoped TravelCurriculumMapping population, with a count of
// rows authored that month. Powers the per-month creation trend chart on
// the Curriculum admin dashboard alongside the /stats KPI strip.
//
// Sibling pattern: mirrors /api/travel/suppliers/by-month (#903 slice 24)
// + /flyer-templates/by-month (#908 slice 21) + /quotes/by-month (#900
// slice 16). Same UTC YYYY-MM bucketing template, same defensive math
// (null/invalid createdAt → "unknown" bucket; excluded when ?from / ?to
// is set, kept otherwise so count surface stays accurate), same orderBy
// semantics, same pagination-after-aggregation posture.
//
// Distinct from /stats (sibling slice): /stats is a single point-in-time
// KPI surface (totals + per-curriculum / per-grade / per-subject buckets);
// /by-month is the per-month time series across the same population.
//
// Why no sub-brand bucket
// -----------------------
// Per the route file's header (L11-15) and the existing /stats handler:
// curriculum authoring is tenant-wide ADMIN, not sub-brand-scoped. The
// route mounts at /api/travel-curriculum (sibling-flat with
// /api/embassy-rules) rather than under /api/travel/*, and there is no
// requireTravelTenant / getSubBrandAccessSet machinery in this route
// file. The /by-month endpoint follows the same posture — no bySubBrand
// surface, no MANAGER narrowing, no sub-brand gate. The TravelCurriculum
// Mapping model has no subBrand column.
//
// Query params (all optional):
//   - ?from / ?to       — inclusive YYYY-MM bounds; invalid →
//                         400 INVALID_MONTH_FORMAT
//   - ?orderBy          — default month:asc; accepts month:{asc|desc},
//                         count:{asc|desc}; unknown tokens degrade silently
//   - ?limit / ?offset  — default 12 / 0; limit caps at 60
//
// Response envelope:
//   {
//     total: <pre-pagination bucket count>,
//     rows: [{ month: "2026-05", count: 3 }, ...]
//   }
//
// No audit row written — read-only meta surface; matches /stats posture.
// USER-readable: anodyne (counts + month-string tokens).
//
// Express route ordering: literal-path /by-month MUST be declared BEFORE
// the /:id family or `:id="by-month"` would 400 INVALID_ID before
// reaching this handler. Same convention as /stats above.
// ============================================================================
router.get("/by-month", verifyToken, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    // YYYY-MM validation — mirrors slice 24 /suppliers/by-month.
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

    // Tenant-scoped where. No sub-brand narrowing — curriculum authoring
    // is tenant-wide ADMIN; the model has no subBrand column.
    const where = { tenantId: req.user.tenantId };

    // Light projection — createdAt is enough for the bucket totals.
    const rows = await prisma.travelCurriculumMapping.findMany({
      where,
      select: { createdAt: true },
    });

    // Aggregate per-UTC-month. Map "YYYY-MM" → { month, count }.
    // Null/invalid createdAt rows land in "unknown".
    const byMonth = new Map();
    for (const r of rows) {
      let monthKey = "unknown";
      if (r.createdAt) {
        const dt = r.createdAt instanceof Date
          ? r.createdAt
          : new Date(r.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
          monthKey = `${yyyy}-${mm}`;
        }
      }

      let bucket = byMonth.get(monthKey);
      if (!bucket) {
        bucket = { month: monthKey, count: 0 };
        byMonth.set(monthKey, bucket);
      }
      bucket.count += 1;
    }

    let months = [...byMonth.values()];

    // Apply ?from / ?to bucket filter. "unknown" excluded when either
    // bound is set (no comparable token); kept otherwise so the count
    // surface remains complete. Mirrors slice 24 /suppliers/by-month.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM (also chronological).
    // "unknown" sorts last in asc / first in desc (lexicographically >
    // "9999-12") — acceptable for a defensive fallback bucket.
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

    // Pagination AFTER aggregation + sort + filter, same as slice 24.
    const paged = months.slice(skip, skip + take);

    res.json({
      total,
      rows: paged,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-curriculum] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// ============================================================================
// GET /api/travel-curriculum/by-quarter — tenant-wide curriculum-mapping
// quarterly rollup (PRD_TRAVEL_TMC §3, Arc 2 Travel Gap).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-Q[1-4] bucket
// for the tenant-scoped TravelCurriculumMapping population, with a count of
// rows authored that quarter. Powers the per-quarter creation trend chart
// on the Curriculum admin dashboard alongside /stats + /by-month.
//
// Sibling pattern: mirrors /api/travel/itineraries/by-quarter (#907 slice
// 17) + /suppliers/by-quarter family. Same UTC YYYY-Q[1-4] bucketing
// template, same defensive math (null/invalid createdAt → "unknown"
// bucket; excluded when ?from / ?to is set, kept otherwise so count
// surface stays accurate), same orderBy semantics, same pagination-after-
// aggregation posture as /by-month above.
//
// Why no sub-brand bucket
// -----------------------
// Per the route file's header (L11-15) and the existing /stats + /by-month
// handlers: curriculum authoring is tenant-wide ADMIN, not sub-brand-
// scoped. The route mounts at /api/travel-curriculum (sibling-flat with
// /api/embassy-rules) rather than under /api/travel/*, and there is no
// requireTravelTenant / getSubBrandAccessSet machinery in this route
// file. The /by-quarter endpoint follows the same posture — no
// bySubBrand surface, no MANAGER narrowing, no sub-brand gate. The
// TravelCurriculumMapping model has no subBrand column.
//
// Bucket key shape: "YYYY-Qn" where n ∈ {1,2,3,4}. Calendar quarter via
// `Math.floor(month/3) + 1` where month is the 0-indexed UTC month:
//   Q1: Jan–Mar (months 0..2)
//   Q2: Apr–Jun (months 3..5)
//   Q3: Jul–Sep (months 6..8)
//   Q4: Oct–Dec (months 9..11)
// UTC chosen deliberately so bucket labels stay stable across operator
// timezones (matches /by-month posture).
//
// Query params (all optional):
//   - ?from / ?to       — inclusive YYYY-Q[1-4] bounds; invalid →
//                         400 INVALID_QUARTER_FORMAT
//   - ?orderBy          — default quarter:asc; accepts quarter:{asc|desc},
//                         count:{asc|desc}; unknown tokens degrade
//                         silently
//   - ?limit / ?offset  — default 8 / 0; limit caps at 40
//
// Response envelope:
//   {
//     total: <pre-pagination bucket count>,
//     rows: [{ quarter: "2026-Q2", count: 3 }, ...]
//   }
//
// No audit row written — read-only meta surface; matches /stats +
// /by-month posture. USER-readable: anodyne (counts + quarter-string
// tokens).
//
// Express route ordering: literal-path /by-quarter MUST be declared
// BEFORE the /:id family or `:id="by-quarter"` would 400 INVALID_ID
// before reaching this handler. Same convention as /stats + /by-month.
// ============================================================================
router.get("/by-quarter", verifyToken, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 8, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    // YYYY-Qn validation — quarter ∈ {1,2,3,4}, year is 4 digits.
    const QUARTER_RE = /^\d{4}-Q[1-4]$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }
    if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "quarter:asc",
      "quarter:desc",
      "count:asc",
      "count:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    // Tenant-scoped where. No sub-brand narrowing — curriculum authoring
    // is tenant-wide ADMIN; the model has no subBrand column.
    const where = { tenantId: req.user.tenantId };

    // Light projection — createdAt is enough for the bucket totals.
    const rows = await prisma.travelCurriculumMapping.findMany({
      where,
      select: { createdAt: true },
    });

    // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { quarter, count }.
    // Null/invalid createdAt rows land in "unknown".
    const byQuarter = new Map();
    for (const r of rows) {
      let quarterKey = "unknown";
      if (r.createdAt) {
        const dt = r.createdAt instanceof Date
          ? r.createdAt
          : new Date(r.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const q = Math.floor(dt.getUTCMonth() / 3) + 1;
          quarterKey = `${yyyy}-Q${q}`;
        }
      }

      let bucket = byQuarter.get(quarterKey);
      if (!bucket) {
        bucket = { quarter: quarterKey, count: 0 };
        byQuarter.set(quarterKey, bucket);
      }
      bucket.count += 1;
    }

    let quarters = [...byQuarter.values()];

    // Apply ?from / ?to bucket filter. "unknown" excluded when either
    // bound is set (no comparable token); kept otherwise so the count
    // surface remains complete. Mirrors /by-month posture.
    if (fromRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
    }
    if (toRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
    // chronological (Q1 < Q2 < Q3 < Q4 in ASCII, years naturally ordered).
    // "unknown" sorts last in asc / first in desc (lexicographically >
    // "9999-Q4") — acceptable for a defensive fallback bucket.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    quarters.sort((a, b) => {
      if (field === "quarter") {
        if (a.quarter < b.quarter) return -1 * mult;
        if (a.quarter > b.quarter) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const total = quarters.length;

    // Pagination AFTER aggregation + sort + filter, same as /by-month.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      total,
      rows: paged,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-curriculum] by-quarter error:", e.message);
    res.status(500).json({ error: "Failed to compute quarterly rollup" });
  }
});

// ============================================================================
// C6 (docs/TRAVEL_CODEABLE_BACKLOG.md) — CSV import/export + coverage report
// per docs/PRD_TMC_CURRICULUM_MAPPING.md FR-2 / FR-4 / FR-8.
//
// Three endpoints, all ADMIN+MANAGER role-gated, all tenant-scoped:
//
//   POST /api/travel-curriculum/import.csv  — upsert by composite key
//                                              (tenantId, curriculum, grade,
//                                              subject, learningOutcome).
//                                              Accepts multipart/form-data
//                                              "file" field OR raw text/csv
//                                              body. 5 MB cap.
//   GET  /api/travel-curriculum/export.csv  — round-trippable CSV. Optional
//                                              ?curriculum / ?grade /
//                                              ?subject filters narrow the
//                                              export. text/csv response with
//                                              Content-Disposition: attachment.
//   GET  /api/travel-curriculum/coverage    — coverage matrix per
//                                              (curriculum, grade) cross-
//                                              product against the 7 canonical
//                                              TMC skills (PRD_TMC_
//                                              DIAGNOSTIC_SALES_ROUTING_ENGINE
//                                              §3.3): which outcomes have ≥1
//                                              mapping, which are missing.
//
// Composite-key adaptation from the C6 slice spec
// -----------------------------------------------
// Slice spec described columns as board/gradeBand/outcome/topicCode/topicTitle
// — those are placeholders. The real TravelCurriculumMapping model
// (prisma/schema.prisma:6186) has the @@unique composite of (tenantId,
// curriculum, grade, subject, learningOutcome). The CSV column set + the
// upsert key here match the real model.
//
// Express route ordering: declared BEFORE the /:id family so the literal
// paths win over the :id matcher.
// ============================================================================

// POST /api/travel-curriculum/import.csv — ADMIN+MANAGER. Upsert by composite
// key. Returns { rowsProcessed, rowsCreated, rowsUpdated, errors }. On
// header-level or per-row validation errors, returns 400 with the error list
// and no rows persisted (atomic). Per AC-2 (PRD §6) — atomic on validation
// failure protects the academic team from partial-state surprises.
router.post(
  "/import.csv",
  verifyToken,
  requirePermission("curriculum", "write"),
  curriculumUpload.single("file"),
  async (req, res) => {
    try {
      const csvText = readCurriculumCsvBody(req);
      if (!csvText || csvText.trim() === "") {
        return res.status(400).json({
          error: "No CSV body or file uploaded",
          code: "NO_CSV",
        });
      }

      const { rows, errors, headerError } = parseCurriculumCsv(csvText);

      // Header-level rejection: no data could be loaded.
      if (headerError) {
        return res.status(400).json({
          error: headerError,
          code: "CSV_HEADER_INVALID",
          errors: [],
        });
      }

      // Per-row validation errors — atomic rejection per AC-2.
      if (errors.length > 0) {
        return res.status(400).json({
          error: `${errors.length} row(s) failed validation; no rows persisted`,
          code: "CSV_ROWS_INVALID",
          errors,
        });
      }

      // Header valid + zero data rows → still treat as success (idempotent
      // no-op so re-running a cleared CSV is safe).
      if (rows.length === 0) {
        return res.json({
          rowsProcessed: 0,
          rowsCreated: 0,
          rowsUpdated: 0,
          errors: [],
        });
      }

      let rowsCreated = 0;
      let rowsUpdated = 0;
      const tenantId = req.user.tenantId;

      for (const r of rows) {
        // Build the upsert payload — sanitise the free-text fields the
        // same way the POST handler does so the CSV path matches the
        // hand-create path.
        const dataCreate = {
          tenantId,
          curriculum: sanitizeText(r.curriculum),
          grade: sanitizeText(r.grade),
          subject: sanitizeText(r.subject),
          learningOutcome: sanitizeText(r.learningOutcome),
          destinationLabel: r.destinationLabel
            ? sanitizeText(r.destinationLabel)
            : null,
          destinationId: r.destinationId,
          fitScore: r.fitScore == null ? 50 : r.fitScore,
          fitRationale: r.fitRationale ? sanitizeText(r.fitRationale) : null,
          isActive: r.isActive == null ? true : r.isActive,
          createdById: req.user.userId,
        };
        const dataUpdate = {
          destinationLabel: r.destinationLabel
            ? sanitizeText(r.destinationLabel)
            : null,
          destinationId: r.destinationId,
          fitScore: r.fitScore == null ? 50 : r.fitScore,
          fitRationale: r.fitRationale ? sanitizeText(r.fitRationale) : null,
          isActive: r.isActive == null ? true : r.isActive,
        };

        // Lookup by the composite-key tuple. Prisma's upsert against a
        // multi-field @@unique key requires the full key tuple in `where`,
        // and learningOutcome is nullable in the schema so we use findFirst
        // + create/update for forward-compat (rather than the named
        // compound-unique index which would error if learningOutcome is
        // ever null on either side).
        const existing = await prisma.travelCurriculumMapping.findFirst({
          where: {
            tenantId,
            curriculum: dataCreate.curriculum,
            grade: dataCreate.grade,
            subject: dataCreate.subject,
            learningOutcome: dataCreate.learningOutcome,
          },
        });

        if (existing) {
          await prisma.travelCurriculumMapping.update({
            where: { id: existing.id },
            data: dataUpdate,
          });
          rowsUpdated += 1;
        } else {
          await prisma.travelCurriculumMapping.create({ data: dataCreate });
          rowsCreated += 1;
        }
      }

      res.json({
        rowsProcessed: rows.length,
        rowsCreated,
        rowsUpdated,
        errors: [],
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-curriculum] import.csv error:", e.message);
      res.status(500).json({ error: "Failed to import curriculum CSV" });
    }
  },
);

// GET /api/travel-curriculum/export.csv — ADMIN+MANAGER. Round-trip CSV with
// optional ?curriculum / ?grade / ?subject filters.
router.get(
  "/export.csv",
  verifyToken,
  requirePermission("curriculum", "read"),
  async (req, res) => {
    try {
      const where = { tenantId: req.user.tenantId };
      if (req.query.curriculum !== undefined) {
        where.curriculum = String(req.query.curriculum);
      }
      if (req.query.grade !== undefined) {
        where.grade = String(req.query.grade);
      }
      if (req.query.subject !== undefined) {
        where.subject = String(req.query.subject);
      }

      const mappings = await prisma.travelCurriculumMapping.findMany({
        where,
        orderBy: [
          { curriculum: "asc" },
          { grade: "asc" },
          { subject: "asc" },
          { id: "asc" },
        ],
      });

      // Shape rows to the CSV column contract — null → empty string is
      // handled by serializeCsv via renderCell.
      const rows = mappings.map((m) => ({
        curriculum: m.curriculum,
        grade: m.grade,
        subject: m.subject,
        learningOutcome: m.learningOutcome || "",
        destinationLabel: m.destinationLabel || "",
        destinationId: m.destinationId == null ? "" : m.destinationId,
        fitScore: m.fitScore == null ? "" : m.fitScore,
        fitRationale: m.fitRationale || "",
        isActive: typeof m.isActive === "boolean" ? m.isActive : "",
      }));

      const csv = serializeCurriculumCsv(rows);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="curriculum-export-${dateStr}.csv"`,
      );
      res.send(csv);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-curriculum] export.csv error:", e.message);
      res.status(500).json({ error: "Failed to export curriculum CSV" });
    }
  },
);

// GET /api/travel-curriculum/coverage — ADMIN+MANAGER. For each
// (curriculum, grade) cross-product present in this tenant's data, report
// which of the 7 canonical TMC skills are covered by ≥1 active mapping vs
// missing. Case-insensitive substring match — the learningOutcome free-text
// must MENTION the canonical skill name.
//
// Response shape (C6 slice spec, adapted to actual columns):
//   {
//     coverage: [{
//       curriculum, gradeBand,
//       mappingCount, outcomesCovered, outcomesMissing
//     }, ...],
//     totals: {
//       totalMappings, boardsCovered, fullCoverageBoards, gapCount
//     }
//   }
//
// (gradeBand in the response is the model's `grade` field — the C6 spec used
// "gradeBand" but the model column is "grade".)
router.get(
  "/coverage",
  verifyToken,
  requirePermission("curriculum", "read"),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;

      const mappings = await prisma.travelCurriculumMapping.findMany({
        where: { tenantId, isActive: true },
        select: {
          curriculum: true,
          grade: true,
          learningOutcome: true,
        },
      });

      // Group by (curriculum, grade) → set of covered canonical skills.
      const byKey = new Map();
      for (const m of mappings) {
        const cur = m.curriculum || "";
        const grd = m.grade || "";
        const key = `${cur} ${grd}`;
        let bucket = byKey.get(key);
        if (!bucket) {
          bucket = {
            curriculum: cur,
            gradeBand: grd,
            mappingCount: 0,
            outcomesCoveredSet: new Set(),
          };
          byKey.set(key, bucket);
        }
        bucket.mappingCount += 1;

        const outcomeText = String(m.learningOutcome || "").toLowerCase();
        if (outcomeText) {
          for (const skill of TMC_CANONICAL_SKILLS) {
            if (outcomeText.includes(skill.toLowerCase())) {
              bucket.outcomesCoveredSet.add(skill);
            }
          }
        }
      }

      const coverage = [];
      const fullCoverageBoardsSet = new Set();
      let gapCount = 0;
      const boardsSeen = new Set();

      for (const bucket of byKey.values()) {
        const covered = [...bucket.outcomesCoveredSet];
        const missing = TMC_CANONICAL_SKILLS.filter(
          (s) => !bucket.outcomesCoveredSet.has(s),
        );
        coverage.push({
          curriculum: bucket.curriculum,
          gradeBand: bucket.gradeBand,
          mappingCount: bucket.mappingCount,
          outcomesCovered: covered,
          outcomesMissing: missing,
        });
        boardsSeen.add(bucket.curriculum);
        if (missing.length === 0) {
          fullCoverageBoardsSet.add(bucket.curriculum);
        } else {
          gapCount += missing.length;
        }
      }

      // Sort coverage rows for deterministic output (curriculum asc, then
      // gradeBand asc).
      coverage.sort((a, b) => {
        if (a.curriculum !== b.curriculum) {
          return a.curriculum < b.curriculum ? -1 : 1;
        }
        if (a.gradeBand !== b.gradeBand) {
          return a.gradeBand < b.gradeBand ? -1 : 1;
        }
        return 0;
      });

      // Zero-mappings tenant: synthesise one envelope row per allowed
      // curriculum so the UI's coverage matrix has rows to render. Each
      // synthesised row has mappingCount 0 + all 7 skills missing.
      if (coverage.length === 0) {
        for (const cur of CURRICULUM_CSV_ALLOWED) {
          coverage.push({
            curriculum: cur,
            gradeBand: "",
            mappingCount: 0,
            outcomesCovered: [],
            outcomesMissing: [...TMC_CANONICAL_SKILLS],
          });
          gapCount += TMC_CANONICAL_SKILLS.length;
        }
      }

      const totals = {
        totalMappings: mappings.length,
        boardsCovered: boardsSeen.size,
        fullCoverageBoards: [...fullCoverageBoardsSet].sort((a, b) => a.localeCompare(b)),
        gapCount,
      };

      res.json({ coverage, totals });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-curriculum] coverage error:", e.message);
      res.status(500).json({ error: "Failed to compute curriculum coverage" });
    }
  },
);

// GET /api/travel-curriculum/:id — single mapping (tenant-scoped).
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const mapping = await prisma.travelCurriculumMapping.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!mapping) {
      return res.status(404).json({
        error: "Curriculum mapping not found",
        code: "CURRICULUM_NOT_FOUND",
      });
    }
    res.json(mapping);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-curriculum] get error:", e.message);
    res.status(500).json({ error: "Failed to get curriculum mapping" });
  }
});

// POST /api/travel-curriculum — ADMIN-only. Required: curriculum, grade,
// subject. Optional: learningOutcome, destinationId, destinationLabel,
// fitScore, fitRationale, isActive.
router.post(
  "/",
  verifyToken,
  requirePermission("curriculum", "write"),
  async (req, res) => {
    try {
      const {
        curriculum,
        grade,
        subject,
        learningOutcome,
        destinationId,
        destinationLabel,
        fitScore,
        fitRationale,
        isActive,
      } = req.body || {};

      if (!curriculum || !grade || !subject) {
        return res.status(400).json({
          error: "curriculum, grade, subject required",
          code: "MISSING_FIELDS",
        });
      }

      assertNonEmptyString(curriculum, "curriculum", "MISSING_FIELDS");
      assertNonEmptyString(grade, "grade", "MISSING_FIELDS");
      assertNonEmptyString(subject, "subject", "MISSING_FIELDS");
      assertValidFitScore(fitScore);
      assertValidDestinationId(destinationId);

      const data = {
        tenantId: req.user.tenantId,
        curriculum: sanitizeText(curriculum),
        grade: sanitizeText(grade),
        subject: sanitizeText(subject),
        learningOutcome:
          learningOutcome == null ? null : sanitizeText(String(learningOutcome)),
        destinationId: destinationId == null ? null : destinationId,
        destinationLabel:
          destinationLabel == null ? null : sanitizeText(String(destinationLabel)),
        fitScore: fitScore == null ? 50 : fitScore,
        fitRationale:
          fitRationale == null ? null : sanitizeText(String(fitRationale)),
        isActive: isActive === undefined ? true : Boolean(isActive),
        createdById: req.user.userId,
      };

      const created = await prisma.travelCurriculumMapping.create({ data });
      res.status(201).json(created);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "A curriculum mapping with that (curriculum, grade, subject, learningOutcome) already exists for this tenant.",
          code: "CURRICULUM_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-curriculum] create error:", e.message);
      res.status(500).json({ error: "Failed to create curriculum mapping" });
    }
  },
);

// PUT /api/travel-curriculum/:id — ADMIN-only. Cannot reassign tenantId or
// createdById (both are stripped by the global stripDangerous middleware AND
// not read here).
router.put(
  "/:id",
  verifyToken,
  requirePermission("curriculum", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const existing = await prisma.travelCurriculumMapping.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Curriculum mapping not found",
          code: "CURRICULUM_NOT_FOUND",
        });
      }

      const {
        curriculum,
        grade,
        subject,
        learningOutcome,
        destinationId,
        destinationLabel,
        fitScore,
        fitRationale,
        isActive,
      } = req.body || {};

      const data = {};
      if (curriculum !== undefined) {
        assertNonEmptyString(curriculum, "curriculum", "MISSING_FIELDS");
        data.curriculum = sanitizeText(curriculum);
      }
      if (grade !== undefined) {
        assertNonEmptyString(grade, "grade", "MISSING_FIELDS");
        data.grade = sanitizeText(grade);
      }
      if (subject !== undefined) {
        assertNonEmptyString(subject, "subject", "MISSING_FIELDS");
        data.subject = sanitizeText(subject);
      }
      if (learningOutcome !== undefined) {
        data.learningOutcome =
          learningOutcome == null ? null : sanitizeText(String(learningOutcome));
      }
      if (destinationId !== undefined) {
        if (destinationId !== null) assertValidDestinationId(destinationId);
        data.destinationId = destinationId;
      }
      if (destinationLabel !== undefined) {
        data.destinationLabel =
          destinationLabel == null ? null : sanitizeText(String(destinationLabel));
      }
      if (fitScore !== undefined) {
        if (fitScore !== null) assertValidFitScore(fitScore);
        data.fitScore = fitScore;
      }
      if (fitRationale !== undefined) {
        data.fitRationale =
          fitRationale == null ? null : sanitizeText(String(fitRationale));
      }
      if (isActive !== undefined) {
        data.isActive = Boolean(isActive);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelCurriculumMapping.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "A curriculum mapping with that (curriculum, grade, subject, learningOutcome) already exists for this tenant.",
          code: "CURRICULUM_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-curriculum] update error:", e.message);
      res.status(500).json({ error: "Failed to update curriculum mapping" });
    }
  },
);

// DELETE /api/travel-curriculum/:id — ADMIN-only. Soft-delete (sets
// isActive=false). The diagnostic engine references mapping rows by id when
// surfacing recommendations to advisors, so we never hard-delete — orphaned
// references would cause "missing rationale" gaps in the audit trail.
router.delete(
  "/:id",
  verifyToken,
  requirePermission("curriculum", "delete"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCurriculumMapping.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Curriculum mapping not found",
          code: "CURRICULUM_NOT_FOUND",
        });
      }
      const updated = await prisma.travelCurriculumMapping.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-curriculum] delete error:", e.message);
      res.status(500).json({ error: "Failed to deactivate curriculum mapping" });
    }
  },
);

module.exports = router;
