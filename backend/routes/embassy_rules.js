/**
 * /api/embassy-rules — EmbassyRule CRUD (Visa Sure Phase 3, PC-3 + PC-7 resolved 2026-05-24).
 *
 * The EmbassyRule model (prisma/schema.prisma:4581, shipped tick #173 commit
 * 6f82e9a7) is the structured backing store for the Visa Sure risk-flag
 * engine. Per PC-3 resolution: Phase 3 ships *structured* rules (not
 * free-text PDF advisories); per PC-7 resolution: the advisor-head + an
 * admin UI maintainer own authorship and curation.
 *
 * Endpoints
 * ---------
 *   GET    /api/embassy-rules                — list, filterable by
 *                                              ?destinationCountry / ?applicationType /
 *                                              ?ruleType / ?severity / ?isActive
 *   GET    /api/embassy-rules/:id            — single rule
 *   POST   /api/embassy-rules                — create (ADMIN-only)
 *   PUT    /api/embassy-rules/:id            — update (ADMIN-only)
 *   DELETE /api/embassy-rules/:id            — soft-delete via isActive=false
 *                                              (ADMIN-only; NO hard delete)
 *
 * Validation
 * ----------
 *   - destinationCountry: 2 uppercase A-Z chars (ISO-3166-1 alpha-2)
 *   - severity: info | warning | blocker
 *   - ruleType: non-empty string
 *   - conditionJson: routed through sanitizeJsonForStringColumn per CLAUDE.md
 *
 * Error envelope
 * --------------
 *   400 INVALID_DESTINATION_COUNTRY  — country not 2-char uppercase
 *   400 INVALID_SEVERITY             — severity not in {info, warning, blocker}
 *   400 INVALID_RULE_TYPE            — empty/missing ruleType
 *   400 MISSING_FIELDS               — required field absent on create
 *   400 INVALID_ID                   — non-numeric path id
 *   400 EMPTY_BODY                   — PUT with no updatable fields
 *   403 RBAC_DENIED                  — verifyRole gate
 *   404 EMBASSY_RULE_NOT_FOUND       — id absent or cross-tenant
 *   409 EMBASSY_RULE_DUPLICATE       — @@unique([tenantId, destinationCountry,
 *                                       applicationType, ruleType]) violation
 *
 * Tenant scoping: every read uses `req.user.tenantId`; every write stamps
 * `tenantId` from the same source. The body cannot override (stripDangerous
 * middleware drops req.body.tenantId before this handler sees it, AND the
 * handler never reads it anyway).
 *
 * createdById is stamped from `req.user.userId` on POST and cannot be
 * reassigned via PUT.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");

const VALID_SEVERITIES = ["info", "warning", "blocker"];
const ISO_ALPHA2_RE = /^[A-Z]{2}$/;

function assertValidDestinationCountry(input) {
  if (typeof input !== "string" || !ISO_ALPHA2_RE.test(input)) {
    const err = new Error(
      "destinationCountry must be a 2-character uppercase ISO-3166-1 alpha-2 code",
    );
    err.status = 400;
    err.code = "INVALID_DESTINATION_COUNTRY";
    throw err;
  }
}

function assertValidSeverity(input) {
  if (!VALID_SEVERITIES.includes(input)) {
    const err = new Error(
      `severity must be one of: ${VALID_SEVERITIES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_SEVERITY";
    throw err;
  }
}

function assertValidRuleType(input) {
  if (typeof input !== "string" || input.trim() === "") {
    const err = new Error("ruleType must be a non-empty string");
    err.status = 400;
    err.code = "INVALID_RULE_TYPE";
    throw err;
  }
}

// Translate Prisma's P2002 (unique constraint violation) to a 409 with a
// stable code so the SPA / specs can distinguish it from generic 500s.
function isPrismaUniqueViolation(e) {
  return e && (e.code === "P2002" || /Unique constraint/i.test(e.message || ""));
}

// GET /api/embassy-rules — list with optional filters.
router.get("/", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    if (req.query.destinationCountry !== undefined) {
      const dc = String(req.query.destinationCountry).toUpperCase();
      assertValidDestinationCountry(dc);
      where.destinationCountry = dc;
    }
    if (req.query.applicationType !== undefined) {
      where.applicationType = String(req.query.applicationType);
    }
    if (req.query.ruleType !== undefined) {
      where.ruleType = String(req.query.ruleType);
    }
    if (req.query.severity !== undefined) {
      assertValidSeverity(String(req.query.severity));
      where.severity = String(req.query.severity);
    }
    if (req.query.isActive !== undefined) {
      // Accept 'true' / 'false' / '1' / '0'; anything else falls through
      // to the truthiness check (so ?isActive=yes works too).
      const v = String(req.query.isActive).toLowerCase();
      where.isActive = !(v === "false" || v === "0");
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [rules, total] = await Promise.all([
      prisma.embassyRule.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        skip,
      }),
      prisma.embassyRule.count({ where }),
    ]);
    res.json({ rules, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[embassy-rules] list error:", e.message);
    res.status(500).json({ error: "Failed to list embassy rules" });
  }
});

// GET /api/embassy-rules/:id — single rule (tenant-scoped).
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const rule = await prisma.embassyRule.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!rule) {
      return res.status(404).json({
        error: "Embassy rule not found",
        code: "EMBASSY_RULE_NOT_FOUND",
      });
    }
    res.json(rule);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[embassy-rules] get error:", e.message);
    res.status(500).json({ error: "Failed to get embassy rule" });
  }
});

// POST /api/embassy-rules — ADMIN-only. Required: ruleType, destinationCountry,
// severity, actionLabel. Optional: applicationType, conditionJson, isActive.
router.post(
  "/",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const {
        ruleType,
        destinationCountry,
        applicationType,
        conditionJson,
        actionLabel,
        severity,
        isActive,
      } = req.body || {};

      if (!ruleType || !destinationCountry || !severity || !actionLabel) {
        return res.status(400).json({
          error: "ruleType, destinationCountry, severity, actionLabel required",
          code: "MISSING_FIELDS",
        });
      }

      assertValidRuleType(ruleType);
      const dc = String(destinationCountry).toUpperCase();
      assertValidDestinationCountry(dc);
      assertValidSeverity(severity);

      const data = {
        tenantId: req.user.tenantId,
        ruleType: sanitizeText(ruleType),
        destinationCountry: dc,
        applicationType: applicationType == null ? null : sanitizeText(String(applicationType)),
        conditionJson: conditionJson == null ? null : sanitizeJsonForStringColumn(conditionJson),
        actionLabel: sanitizeText(actionLabel),
        severity,
        isActive: isActive === undefined ? true : Boolean(isActive),
        createdById: req.user.userId,
      };

      const created = await prisma.embassyRule.create({ data });
      res.status(201).json(created);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "An embassy rule with that (destinationCountry, applicationType, ruleType) already exists for this tenant.",
          code: "EMBASSY_RULE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] create error:", e.message);
      res.status(500).json({ error: "Failed to create embassy rule" });
    }
  },
);

// PUT /api/embassy-rules/:id — ADMIN-only. Cannot reassign tenantId or
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

      const existing = await prisma.embassyRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Embassy rule not found",
          code: "EMBASSY_RULE_NOT_FOUND",
        });
      }

      const {
        ruleType,
        destinationCountry,
        applicationType,
        conditionJson,
        actionLabel,
        severity,
        isActive,
      } = req.body || {};

      const data = {};
      if (ruleType !== undefined) {
        assertValidRuleType(ruleType);
        data.ruleType = sanitizeText(ruleType);
      }
      if (destinationCountry !== undefined) {
        const dc = String(destinationCountry).toUpperCase();
        assertValidDestinationCountry(dc);
        data.destinationCountry = dc;
      }
      if (applicationType !== undefined) {
        data.applicationType = applicationType == null ? null : sanitizeText(String(applicationType));
      }
      if (conditionJson !== undefined) {
        data.conditionJson = conditionJson == null ? null : sanitizeJsonForStringColumn(conditionJson);
      }
      if (actionLabel !== undefined) {
        if (typeof actionLabel !== "string" || actionLabel.trim() === "") {
          return res.status(400).json({
            error: "actionLabel must be a non-empty string",
            code: "MISSING_FIELDS",
          });
        }
        data.actionLabel = sanitizeText(actionLabel);
      }
      if (severity !== undefined) {
        assertValidSeverity(severity);
        data.severity = severity;
      }
      if (isActive !== undefined) {
        data.isActive = Boolean(isActive);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.embassyRule.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "An embassy rule with that (destinationCountry, applicationType, ruleType) already exists for this tenant.",
          code: "EMBASSY_RULE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] update error:", e.message);
      res.status(500).json({ error: "Failed to update embassy rule" });
    }
  },
);

// DELETE /api/embassy-rules/:id — ADMIN-only. Soft-delete (sets isActive=false);
// rule rows are referenced indirectly by the risk-flag engine's audit trail
// so we never hard-delete. Returns the updated (now-inactive) row.
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
      const existing = await prisma.embassyRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Embassy rule not found",
          code: "EMBASSY_RULE_NOT_FOUND",
        });
      }
      const updated = await prisma.embassyRule.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] delete error:", e.message);
      res.status(500).json({ error: "Failed to deactivate embassy rule" });
    }
  },
);

module.exports = router;
