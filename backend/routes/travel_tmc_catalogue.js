/**
 * /api/travel-tmc-catalogue — TmcTripCatalogue CRUD + promote-to-active gate.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T5 (depends on T1 schema
 * shipped in commit e43788e1). Sibling-flat URL (mirrors /api/travel-curriculum)
 * because the catalogue is a tenant-wide admin surface, not sub-brand-scoped.
 *
 * Endpoints
 * ---------
 *   GET    /api/travel-tmc-catalogue                — list, tenant-scoped, supports
 *                                                     ?status=active|archived|all
 *                                                     (default "active" — only
 *                                                     human-verified rows the engine
 *                                                     would recommend from)
 *   GET    /api/travel-tmc-catalogue/:id            — single fetch, tenant-scoped,
 *                                                     404 on missing or cross-tenant
 *   POST   /api/travel-tmc-catalogue                — create, tenant-scoped.
 *                                                     **ALWAYS sets status="archived"
 *                                                     regardless of body** — the
 *                                                     human-verify gate per PRD §3.2
 *                                                     tagging rules ("Every
 *                                                     curriculum_hooks entry and every
 *                                                     price_band is human-verified
 *                                                     before a trip goes active").
 *                                                     Promote via /promote-to-active.
 *   PATCH  /api/travel-tmc-catalogue/:id            — partial update, tenant-scoped.
 *                                                     Cannot change status (use
 *                                                     POST /:id/promote-to-active OR
 *                                                     DELETE /:id for soft-archive).
 *   DELETE /api/travel-tmc-catalogue/:id            — soft delete (sets status="archived").
 *                                                     Row stays queryable for audit.
 *   POST   /api/travel-tmc-catalogue/:id/promote-to-active
 *                                                   — flips status="active". Senior
 *                                                     role per PRD §3.2 human-verify
 *                                                     gate (ADMIN-only).
 *
 * Auth model
 * ----------
 *   verifyToken + verifyRole(["ADMIN","MANAGER"]) on every endpoint (catalogue
 *   admin is staff-only). promote-to-active narrows to ADMIN-only per the
 *   "human-verify gate" senior-role language in PRD §3.2 tagging rules — a
 *   manager can prepare a row but only an admin can promote it into the
 *   engine's matching pool. NO sub-brand narrowing because the catalogue
 *   exists once per tenant (it's the engine's recommendation set, not a
 *   sub-brand surface).
 *
 * Tenant scoping
 * --------------
 *   Every WHERE clause includes tenantId: req.user.tenantId. Every POST stamps
 *   tenantId from the same source. Body-supplied tenantId is impossible
 *   (stripDangerous middleware drops it; handler never reads it anyway per
 *   the CLAUDE.md ESLint rule).
 *
 * JSON-string columns
 * -------------------
 *   Several catalogue fields are typed `String @db.Text` storing JSON arrays
 *   (boardsSupportedJson, primaryOutcomesJson, skillsDevelopedJson,
 *   subjectsTouchedJson, anchorExperiencesJson, curriculumHooksJson). The
 *   route normalises body input: if the caller submits an array, we
 *   JSON.stringify it before storing. If they submit a string, we accept it
 *   verbatim (caller already stringified). Empty/null is allowed where the
 *   schema permits.
 *
 * Error envelope
 * --------------
 *   400 INVALID_ID                 — non-numeric path id
 *   400 MISSING_FIELDS             — required field missing on create
 *   400 INVALID_DURATION           — durationDays/durationNights non-int or <0
 *   400 INVALID_GROUP_SIZE         — minGroupSize non-int or <1
 *   400 INVALID_PRICE              — indicativePricePerStudent non-int when set
 *   400 INVALID_JSON_FIELD         — a *Json field is non-array AND non-string
 *   400 EMPTY_BODY                 — PATCH with no updatable fields
 *   400 STATUS_NOT_PATCHABLE       — PATCH attempted to mutate status (use
 *                                    /promote-to-active or DELETE)
 *   403 RBAC_DENIED                — verifyRole gate
 *   404 CATALOGUE_NOT_FOUND        — id absent or cross-tenant
 *   409 CATALOGUE_DUPLICATE        — @@unique([tenantId, tripId]) violation
 *
 * Test surface
 * ------------
 *   backend/test/routes/travel-tmc-catalogue.test.js pins the contract with
 *   ≥15 vitest cases. Test pattern mirrors travel_curriculum.test.js —
 *   patch the prisma singleton before requiring the router, mint JWTs with
 *   the dev fallback secret, exercise the full verifyToken+verifyRole chain.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { sanitizeText } = require("../lib/sanitizeJson");

// PRD §3.2 + schema default — every catalogue row is created archived; only
// /promote-to-active (senior-role) flips it to active.
const STATUS_ACTIVE = "active";
const STATUS_ARCHIVED = "archived";
const VALID_STATUSES = new Set([STATUS_ACTIVE, STATUS_ARCHIVED]);
const VALID_STATUS_FILTERS = new Set([STATUS_ACTIVE, STATUS_ARCHIVED, "all"]);

// JSON-string columns (Prisma `String @db.Text` storing JSON arrays).
const JSON_ARRAY_FIELDS = [
  "boardsSupportedJson",
  "primaryOutcomesJson",
  "skillsDevelopedJson",
  "subjectsTouchedJson",
  "anchorExperiencesJson",
  "curriculumHooksJson",
];

function normaliseJsonField(value, fieldName) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    // Permit object shapes (the schema docs an array of objects for
    // anchor_experiences + curriculum_hooks, but a single object would
    // round-trip cleanly too).
    return JSON.stringify(value);
  }
  const err = new Error(`${fieldName} must be a JSON array, object, or pre-stringified JSON`);
  err.status = 400;
  err.code = "INVALID_JSON_FIELD";
  throw err;
}

function assertPositiveInt(value, fieldName, errorCode, { allowZero = false } = {}) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    const err = new Error(`${fieldName} must be a ${allowZero ? "non-negative" : "positive"} integer`);
    err.status = 400;
    err.code = errorCode;
    throw err;
  }
}

function isPrismaUniqueViolation(e) {
  return e && (e.code === "P2002" || /Unique constraint/i.test(e.message || ""));
}

// Convert an arbitrary user-supplied string field to a sanitised string; null
// passes through (some columns are nullable per schema — tagline, region,
// imageUrl, indicativePricePerStudent).
function coerceOptionalString(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return sanitizeText(String(v));
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/travel-tmc-catalogue — list (tenant-scoped, ?status filter)
// ──────────────────────────────────────────────────────────────────────
router.get(
  "/",
  verifyToken,
  requirePermission("tmc_catalogue", "read"),
  async (req, res) => {
    try {
      const statusFilter = req.query.status ? String(req.query.status) : STATUS_ACTIVE;
      if (!VALID_STATUS_FILTERS.has(statusFilter)) {
        return res.status(400).json({
          error: "status must be one of: active, archived, all",
          code: "INVALID_STATUS",
        });
      }

      const where = { tenantId: req.user.tenantId };
      if (statusFilter !== "all") {
        where.status = statusFilter;
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [rows, total] = await Promise.all([
        prisma.tmcTripCatalogue.findMany({
          where,
          orderBy: [{ tier: "asc" }, { tripId: "asc" }],
          take,
          skip,
        }),
        prisma.tmcTripCatalogue.count({ where }),
      ]);
      res.json({ catalogue: rows, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] list error:", e.message);
      res.status(500).json({ error: "Failed to list catalogue" });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /api/travel-tmc-catalogue/:id — single fetch (tenant-scoped, 404 on miss)
// ──────────────────────────────────────────────────────────────────────
router.get(
  "/:id",
  verifyToken,
  requirePermission("tmc_catalogue", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.tmcTripCatalogue.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!row) {
        return res.status(404).json({
          error: "Catalogue entry not found",
          code: "CATALOGUE_NOT_FOUND",
        });
      }
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] get error:", e.message);
      res.status(500).json({ error: "Failed to get catalogue entry" });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /api/travel-tmc-catalogue — create (ALWAYS lands status=archived)
//
// PRD §3.2 tagging rules — "Every curriculum_hooks entry and every
// price_band is human-verified before a trip goes active." The route
// enforces this structurally: the create handler ignores any caller-supplied
// status value and always writes "archived". A subsequent
// /promote-to-active call (senior-role-gated) is the only way to flip a
// new row into the engine's matching pool.
// ──────────────────────────────────────────────────────────────────────
router.post(
  "/",
  verifyToken,
  requirePermission("tmc_catalogue", "write"),
  async (req, res) => {
    try {
      const {
        tripId,
        title,
        tagline,
        tier,
        region,
        durationDays,
        durationNights,
        minGradeBand,
        maxGradeBand,
        boardsSupportedJson,
        minGroupSize,
        priceBand,
        indicativePricePerStudent,
        primaryOutcomesJson,
        skillsDevelopedJson,
        subjectsTouchedJson,
        anchorExperiencesJson,
        curriculumHooksJson,
        reportSkillBlurb,
        summaryForBrief,
        imageUrl,
      } = req.body || {};

      // Required fields per the schema's NOT NULL columns.
      if (
        !tripId ||
        !title ||
        !tier ||
        durationDays === undefined ||
        !minGradeBand ||
        !maxGradeBand ||
        boardsSupportedJson === undefined ||
        minGroupSize === undefined ||
        !priceBand ||
        primaryOutcomesJson === undefined ||
        skillsDevelopedJson === undefined ||
        subjectsTouchedJson === undefined ||
        anchorExperiencesJson === undefined ||
        curriculumHooksJson === undefined ||
        !reportSkillBlurb ||
        !summaryForBrief
      ) {
        return res.status(400).json({
          error:
            "tripId, title, tier, durationDays, minGradeBand, maxGradeBand, " +
            "boardsSupportedJson, minGroupSize, priceBand, primaryOutcomesJson, " +
            "skillsDevelopedJson, subjectsTouchedJson, anchorExperiencesJson, " +
            "curriculumHooksJson, reportSkillBlurb, summaryForBrief required",
          code: "MISSING_FIELDS",
        });
      }

      assertPositiveInt(durationDays, "durationDays", "INVALID_DURATION", { allowZero: true });
      if (durationNights !== undefined && durationNights !== null) {
        assertPositiveInt(durationNights, "durationNights", "INVALID_DURATION", { allowZero: true });
      }
      assertPositiveInt(minGroupSize, "minGroupSize", "INVALID_GROUP_SIZE");
      if (indicativePricePerStudent !== undefined && indicativePricePerStudent !== null) {
        assertPositiveInt(indicativePricePerStudent, "indicativePricePerStudent", "INVALID_PRICE", { allowZero: true });
      }

      const data = {
        tenantId: req.user.tenantId,
        tripId: sanitizeText(String(tripId)),
        title: sanitizeText(String(title)),
        tagline: coerceOptionalString(tagline) ?? null,
        tier: sanitizeText(String(tier)),
        region: coerceOptionalString(region) ?? null,
        durationDays: Number(durationDays),
        durationNights: durationNights == null ? 0 : Number(durationNights),
        minGradeBand: sanitizeText(String(minGradeBand)),
        maxGradeBand: sanitizeText(String(maxGradeBand)),
        boardsSupportedJson: normaliseJsonField(boardsSupportedJson, "boardsSupportedJson"),
        minGroupSize: Number(minGroupSize),
        priceBand: sanitizeText(String(priceBand)),
        indicativePricePerStudent:
          indicativePricePerStudent == null ? null : Number(indicativePricePerStudent),
        primaryOutcomesJson: normaliseJsonField(primaryOutcomesJson, "primaryOutcomesJson"),
        skillsDevelopedJson: normaliseJsonField(skillsDevelopedJson, "skillsDevelopedJson"),
        subjectsTouchedJson: normaliseJsonField(subjectsTouchedJson, "subjectsTouchedJson"),
        anchorExperiencesJson: normaliseJsonField(anchorExperiencesJson, "anchorExperiencesJson"),
        curriculumHooksJson: normaliseJsonField(curriculumHooksJson, "curriculumHooksJson"),
        reportSkillBlurb: sanitizeText(String(reportSkillBlurb)),
        summaryForBrief: sanitizeText(String(summaryForBrief)),
        imageUrl: coerceOptionalString(imageUrl) ?? null,
        // ALWAYS archived on create — PRD §3.2 human-verify gate. Caller
        // cannot bypass via body.status (deliberately ignored).
        status: STATUS_ARCHIVED,
      };

      const created = await prisma.tmcTripCatalogue.create({ data });
      res.status(201).json(created);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error: "A catalogue entry with that tripId already exists for this tenant.",
          code: "CATALOGUE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] create error:", e.message);
      res.status(500).json({ error: "Failed to create catalogue entry" });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/travel-tmc-catalogue/:id — partial update (no status mutation)
//
// status is deliberately NOT patchable here. Two flip paths exist:
//   - DELETE /:id              → soft-archive (active → archived)
//   - POST /:id/promote-to-active → senior-role promote (archived → active)
// Rejecting status in PATCH keeps the human-verify gate auditable: every
// flip into the engine's pool is an explicit promote call, never a silent
// PATCH side effect.
// ──────────────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  verifyToken,
  requirePermission("tmc_catalogue", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const existing = await prisma.tmcTripCatalogue.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Catalogue entry not found",
          code: "CATALOGUE_NOT_FOUND",
        });
      }

      // Status mutation via PATCH is rejected; see header comment.
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "status")) {
        return res.status(400).json({
          error:
            "status cannot be changed via PATCH — use POST /:id/promote-to-active or DELETE /:id",
          code: "STATUS_NOT_PATCHABLE",
        });
      }

      const {
        tripId,
        title,
        tagline,
        tier,
        region,
        durationDays,
        durationNights,
        minGradeBand,
        maxGradeBand,
        boardsSupportedJson,
        minGroupSize,
        priceBand,
        indicativePricePerStudent,
        primaryOutcomesJson,
        skillsDevelopedJson,
        subjectsTouchedJson,
        anchorExperiencesJson,
        curriculumHooksJson,
        reportSkillBlurb,
        summaryForBrief,
        imageUrl,
      } = req.body || {};

      const data = {};

      if (tripId !== undefined) data.tripId = sanitizeText(String(tripId));
      if (title !== undefined) data.title = sanitizeText(String(title));
      if (tagline !== undefined) data.tagline = coerceOptionalString(tagline);
      if (tier !== undefined) data.tier = sanitizeText(String(tier));
      if (region !== undefined) data.region = coerceOptionalString(region);
      if (durationDays !== undefined) {
        assertPositiveInt(durationDays, "durationDays", "INVALID_DURATION", { allowZero: true });
        data.durationDays = Number(durationDays);
      }
      if (durationNights !== undefined) {
        assertPositiveInt(durationNights, "durationNights", "INVALID_DURATION", { allowZero: true });
        data.durationNights = Number(durationNights);
      }
      if (minGradeBand !== undefined) data.minGradeBand = sanitizeText(String(minGradeBand));
      if (maxGradeBand !== undefined) data.maxGradeBand = sanitizeText(String(maxGradeBand));
      if (boardsSupportedJson !== undefined) {
        data.boardsSupportedJson = normaliseJsonField(boardsSupportedJson, "boardsSupportedJson");
      }
      if (minGroupSize !== undefined) {
        assertPositiveInt(minGroupSize, "minGroupSize", "INVALID_GROUP_SIZE");
        data.minGroupSize = Number(minGroupSize);
      }
      if (priceBand !== undefined) data.priceBand = sanitizeText(String(priceBand));
      if (indicativePricePerStudent !== undefined) {
        if (indicativePricePerStudent !== null) {
          assertPositiveInt(indicativePricePerStudent, "indicativePricePerStudent", "INVALID_PRICE", { allowZero: true });
        }
        data.indicativePricePerStudent =
          indicativePricePerStudent == null ? null : Number(indicativePricePerStudent);
      }
      for (const field of [
        "primaryOutcomesJson",
        "skillsDevelopedJson",
        "subjectsTouchedJson",
        "anchorExperiencesJson",
        "curriculumHooksJson",
      ]) {
        const v = req.body ? req.body[field] : undefined;
        if (v !== undefined) {
          data[field] = normaliseJsonField(v, field);
        }
      }
      if (reportSkillBlurb !== undefined) data.reportSkillBlurb = sanitizeText(String(reportSkillBlurb));
      if (summaryForBrief !== undefined) data.summaryForBrief = sanitizeText(String(summaryForBrief));
      if (imageUrl !== undefined) data.imageUrl = coerceOptionalString(imageUrl);

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.tmcTripCatalogue.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error: "A catalogue entry with that tripId already exists for this tenant.",
          code: "CATALOGUE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] patch error:", e.message);
      res.status(500).json({ error: "Failed to update catalogue entry" });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/travel-tmc-catalogue/:id — soft archive (status → archived)
//
// We never hard-delete: catalogue rows are referenced by TravelDiagnostic
// rows (recommendedTripId / alternativeTripId / engineScoresJson) for
// audit / replay (PRD §3.3.7 weight-tuning triage). Hard delete would
// leave dangling FK references and break the replay path.
// ──────────────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  verifyToken,
  requirePermission("tmc_catalogue", "delete"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.tmcTripCatalogue.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Catalogue entry not found",
          code: "CATALOGUE_NOT_FOUND",
        });
      }
      const updated = await prisma.tmcTripCatalogue.update({
        where: { id },
        data: { status: STATUS_ARCHIVED },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] delete error:", e.message);
      res.status(500).json({ error: "Failed to archive catalogue entry" });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /api/travel-tmc-catalogue/:id/promote-to-active
//
// The human-verify gate. PRD §3.2 tagging rules require curriculum_hooks +
// price_band to be human-verified before a trip enters the engine's
// recommendation pool. POST creates land archived; this is the ONLY path
// to active. Senior-role-gated (ADMIN-only) so a MANAGER preparing rows
// can't self-promote without a second pair of eyes.
// ──────────────────────────────────────────────────────────────────────
router.post(
  "/:id/promote-to-active",
  verifyToken,
  requirePermission("tmc_catalogue", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.tmcTripCatalogue.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Catalogue entry not found",
          code: "CATALOGUE_NOT_FOUND",
        });
      }
      const updated = await prisma.tmcTripCatalogue.update({
        where: { id },
        data: { status: STATUS_ACTIVE },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-tmc-catalogue] promote error:", e.message);
      res.status(500).json({ error: "Failed to promote catalogue entry" });
    }
  },
);

// Re-export status constants for tests that want to compare without
// re-deriving them from PRD prose.
router.STATUS_ACTIVE = STATUS_ACTIVE;
router.STATUS_ARCHIVED = STATUS_ARCHIVED;
router.JSON_ARRAY_FIELDS = JSON_ARRAY_FIELDS;

module.exports = router;
