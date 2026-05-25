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
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");

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
  verifyRole(["ADMIN"]),
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
  verifyRole(["ADMIN"]),
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
  verifyRole(["ADMIN"]),
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
