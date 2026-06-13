/**
 * /api/travel/engine-weights — EngineWeights single-row-per-tenant CRUD.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T15 (depends on T1 schema
 * shipped commit e43788e1). The EngineWeights model is the tunable config
 * row that drives the §3.3 deterministic 6-signal scorer. Each tenant has
 * 0 or 1 EngineWeights row (`@@unique([tenantId])` on the model); the
 * version label is captured on every TravelDiagnostic at scoring time so
 * §3.3.7 weight-tuning disagreement triage can replay the exact weights a
 * given submission was scored under.
 *
 * Endpoints
 * ---------
 *   GET /api/travel/engine-weights
 *       Returns the tenant's row if it exists, otherwise returns the PRD
 *       §3.3.3 defaults with `isDefault: true` so the UI knows to render
 *       defaults without flagging an error. ADMIN+MANAGER gate.
 *
 *   PUT /api/travel/engine-weights
 *       Upserts the tenant's row. ADMIN+MANAGER gate. Body validation:
 *         - Each weight ≥ 0 (negative rejected → 400 INVALID_WEIGHT)
 *         - scoresWellThreshold ∈ [0, 100] (out-of-range rejected → 400
 *           INVALID_THRESHOLD)
 *         - All 6 weights + threshold REQUIRED on every PUT (the row is
 *           tiny and the UI always submits the full surface; partial PUTs
 *           are blocked at the validation layer so a stale half-form
 *           can't truncate the row's other knobs to zero). 400 MISSING_FIELDS
 *           if any of the 6 weights or threshold is absent.
 *         - version is free-text; omitted is fine (auto-bump applies).
 *
 *       Auto-version-bump semantics (mirrors the DiagnosticBuilder client
 *       defensively so non-UI consumers still get the same audit hygiene):
 *         - If body weights differ from the existing row AND body version
 *           is omitted OR equals the existing row's version → bump
 *           (vN → v(N+1); anything not matching /^v(\d+)$/i gets
 *           "${prev}-revised" appended).
 *         - If body explicitly sets a NEW version string → honor verbatim.
 *         - If body weights match existing AND version matches → idempotent
 *           no-op (returns 200 + existing row untouched).
 *
 * Auth + tenant scoping
 * ---------------------
 *   verifyToken → verifyRole(['ADMIN','MANAGER']). Every read + write
 *   scopes WHERE tenantId: req.user.tenantId. Body cannot supply tenantId
 *   (stripDangerous middleware drops it; handler never reads body tenantId
 *   per CLAUDE.md ESLint rule).
 *
 * Error envelope
 * --------------
 *   400 MISSING_FIELDS    — any of 6 weights or threshold absent on PUT
 *   400 INVALID_WEIGHT    — weight not an integer ≥ 0
 *   400 INVALID_THRESHOLD — scoresWellThreshold not an integer in [0,100]
 *   400 INVALID_VERSION   — version provided but not a non-empty string
 *   403 RBAC_DENIED       — verifyRole gate
 *
 * Test surface
 * ------------
 *   backend/test/routes/travel-engine-weights.test.js pins the contract
 *   with ≥12 vitest cases. Test pattern mirrors travel-tmc-catalogue.test.js
 *   (T5) — patch the prisma singleton before requiring the router; mint
 *   JWTs with the dev fallback secret; full guard chain runs end-to-end.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");

// PRD §3.3.3 defaults — duplicated here so a GET on an empty tenant
// returns the canonical baseline without needing a DB row first.
// (Backend stays authoritative; the frontend's DEFAULT_TMC_WEIGHTS
// constant is a mirror for offline UX, not a contract source.)
const DEFAULT_WEIGHTS = Object.freeze({
  version: "v1",
  weightPrimaryOutcome: 50,
  weightSecondarySkill: 20,
  weightGrowthArea: 15,
  weightCurriculumHook: 10,
  weightGradeBandCenter: 10,
  weightTierValueLean: 8,
  scoresWellThreshold: 70,
});

const WEIGHT_KEYS = [
  "weightPrimaryOutcome",
  "weightSecondarySkill",
  "weightGrowthArea",
  "weightCurriculumHook",
  "weightGradeBandCenter",
  "weightTierValueLean",
];

// Throw 400-shaped errors with a `code` so the handler's catch can route
// them to the right response shape without per-error string matching.
function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  throw err;
}

function validateAndCoercePutBody(body) {
  if (!body || typeof body !== "object") {
    badRequest("Request body required", "MISSING_FIELDS");
  }

  // Required: all 6 weights + threshold. Version is optional (auto-bump).
  for (const key of WEIGHT_KEYS) {
    if (body[key] === undefined || body[key] === null) {
      badRequest(`${key} required`, "MISSING_FIELDS");
    }
  }
  if (body.scoresWellThreshold === undefined || body.scoresWellThreshold === null) {
    badRequest("scoresWellThreshold required", "MISSING_FIELDS");
  }

  const coerced = {};
  for (const key of WEIGHT_KEYS) {
    const raw = body[key];
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(num) || num < 0) {
      badRequest(`${key} must be an integer >= 0`, "INVALID_WEIGHT");
    }
    coerced[key] = num;
  }

  const tRaw = body.scoresWellThreshold;
  const tNum = typeof tRaw === "number" ? tRaw : Number(tRaw);
  if (!Number.isInteger(tNum) || tNum < 0 || tNum > 100) {
    badRequest(
      "scoresWellThreshold must be an integer in [0, 100]",
      "INVALID_THRESHOLD",
    );
  }
  coerced.scoresWellThreshold = tNum;

  if (body.version !== undefined && body.version !== null) {
    if (typeof body.version !== "string" || body.version.trim() === "") {
      badRequest("version must be a non-empty string", "INVALID_VERSION");
    }
    coerced.version = body.version.trim();
  }

  // G103 — §3.5.5 standing-facts: assuranceFactsJson + trustFactsJson.
  // Both optional. Accept either a raw JSON string OR an object/array (we
  // stringify on save per CLAUDE.md JSON-string-column convention).
  // Empty string + null both clear the override (renderer falls back to
  // DEFAULT_STANDING_FACTS).
  for (const factsKey of ["assuranceFactsJson", "trustFactsJson"]) {
    if (body[factsKey] !== undefined) {
      const raw = body[factsKey];
      if (raw === null || raw === "") {
        coerced[factsKey] = null;
      } else if (typeof raw === "string") {
        // Validate it's parseable JSON (don't store malformed JSON in the row).
        try {
          JSON.parse(raw);
        } catch (_e) {
          badRequest(`${factsKey} must be a valid JSON string`, "INVALID_FACTS_JSON");
        }
        coerced[factsKey] = raw;
      } else if (typeof raw === "object") {
        coerced[factsKey] = JSON.stringify(raw);
      } else {
        badRequest(`${factsKey} must be JSON string or object`, "INVALID_FACTS_JSON");
      }
    }
  }

  return coerced;
}

// Auto-bump semantics matching the frontend's autoBumpVersion (mirrored
// defensively so non-UI clients get audit-replayable versioning too).
function autoBumpVersion(prev) {
  const m = /^v(\d+)$/i.exec(String(prev || "").trim());
  if (m) return `v${Number(m[1]) + 1}`;
  return `${prev || "v1"}-revised`;
}

function weightsNumericallyEqual(a, b) {
  for (const key of WEIGHT_KEYS) {
    if (Number(a[key]) !== Number(b[key])) return false;
  }
  return Number(a.scoresWellThreshold) === Number(b.scoresWellThreshold);
}

// ────────────────────────────────────────────────────────────────────
// GET /api/travel/engine-weights — current row OR PRD §3.3.3 defaults
// ────────────────────────────────────────────────────────────────────
router.get(
  "/",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const row = await prisma.engineWeights.findFirst({
        where: { tenantId: req.user.tenantId },
      });
      if (!row) {
        return res.json({ ...DEFAULT_WEIGHTS, isDefault: true });
      }
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-engine-weights] get error:", e.message);
      res.status(500).json({ error: "Failed to load engine weights" });
    }
  },
);

// ────────────────────────────────────────────────────────────────────
// PUT /api/travel/engine-weights — upsert with auto-version-bump
//
// One row per tenant (@@unique([tenantId])). Validates the full surface
// (all 6 weights + threshold required) so a stale half-form can't truncate
// silent zeros into the row. Auto-bumps version when weights changed AND
// caller didn't supply a different version string.
// ────────────────────────────────────────────────────────────────────
router.put(
  "/",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const coerced = validateAndCoercePutBody(req.body);
      const tenantId = req.user.tenantId;

      const existing = await prisma.engineWeights.findFirst({
        where: { tenantId },
      });

      // Decide the version to persist.
      //   - No existing row → use body.version OR "v1".
      //   - Existing row, weights unchanged → keep existing version
      //     (idempotent re-PUT returns the row unchanged).
      //   - Existing row, weights changed, caller omitted version OR
      //     supplied the same version as existing → auto-bump.
      //   - Existing row, weights changed, caller supplied a DIFFERENT
      //     version string → honor caller verbatim.
      let finalVersion;
      if (!existing) {
        finalVersion = coerced.version || "v1";
      } else {
        const weightsChanged = !weightsNumericallyEqual(coerced, existing);
        if (!weightsChanged) {
          // Idempotent path: caller may have re-PUT same data with same
          // (or omitted) version. Keep existing untouched.
          if (coerced.version && coerced.version !== existing.version) {
            // Caller is renaming the version label without changing
            // weights — honor it.
            finalVersion = coerced.version;
          } else {
            finalVersion = existing.version;
          }
        } else {
          // Weights changed.
          if (coerced.version && coerced.version !== existing.version) {
            finalVersion = coerced.version;
          } else {
            finalVersion = autoBumpVersion(existing.version);
          }
        }
      }

      // True no-op short-circuit — return existing row without writing.
      if (
        existing &&
        weightsNumericallyEqual(coerced, existing) &&
        finalVersion === existing.version
      ) {
        return res.json(existing);
      }

      const data = {
        tenantId,
        weightPrimaryOutcome: coerced.weightPrimaryOutcome,
        weightSecondarySkill: coerced.weightSecondarySkill,
        weightGrowthArea: coerced.weightGrowthArea,
        weightCurriculumHook: coerced.weightCurriculumHook,
        weightGradeBandCenter: coerced.weightGradeBandCenter,
        weightTierValueLean: coerced.weightTierValueLean,
        scoresWellThreshold: coerced.scoresWellThreshold,
        version: finalVersion,
      };
      // G103 standing-facts JSON overrides — only attach when the caller
      // explicitly provided them so a PUT that doesn't include them does
      // NOT clobber an existing override.
      if (Object.prototype.hasOwnProperty.call(coerced, "assuranceFactsJson")) {
        data.assuranceFactsJson = coerced.assuranceFactsJson;
      }
      if (Object.prototype.hasOwnProperty.call(coerced, "trustFactsJson")) {
        data.trustFactsJson = coerced.trustFactsJson;
      }

      // Use the upsert primitive against the @@unique([tenantId]) index so
      // concurrent PUTs to the same tenant don't race into duplicate-row
      // territory. We pass create + update payloads identically (single
      // canonical row per tenant).
      const upserted = await prisma.engineWeights.upsert({
        where: { tenantId },
        create: data,
        update: data,
      });
      res.json(upserted);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-engine-weights] put error:", e.message);
      res.status(500).json({ error: "Failed to save engine weights" });
    }
  },
);

// Re-export the defaults + helpers for tests that want to assert the
// exact shape without re-deriving from PRD prose.
router.DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
router.WEIGHT_KEYS = WEIGHT_KEYS;
router.autoBumpVersion = autoBumpVersion;
router.weightsNumericallyEqual = weightsNumericallyEqual;

module.exports = router;
