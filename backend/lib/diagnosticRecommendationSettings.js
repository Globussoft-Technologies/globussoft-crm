/**
 * Admin-configurable "how many recommendations to show" setting for TMC
 * diagnostics (2026-08-27).
 *
 * Deliberately does NOT use a dedicated Prisma column — the existing
 * "Recommendation Settings" backing model (EngineWeights) has no spare JSON
 * blob (every field is a typed column), and TravelDiagnostic has no free
 * catch-all field either. Reuses the generic TenantSetting key-value store
 * instead (same mechanism as backend/lib/curriculumDocuments.js), keeping
 * this fully additive with zero schema migrations.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.diagnostics.topK.<subBrand>`,
 * category: "travel-diagnostic-recommendation-settings", value: JSON.stringify({ topK }) }.
 *
 * Consumed internally by the three recommendation engines that already
 * receive tenantId + subBrand at every call site (buildCurriculumFitForDiagnostic,
 * curriculumRag.matchCurriculumForDiagnostic, travelRag.runRagForDiagnostic) —
 * they each resolve their own topK via getRecommendationTopK() rather than
 * having it threaded through as a new parameter.
 */

const prisma = require("./prisma");

const CATEGORY = "travel-diagnostic-recommendation-settings";
const KEY_PREFIX = "travel.diagnostics.topK.";

const DEFAULT_TOP_K = 10;
const MIN_TOP_K = 3;
const MAX_TOP_K = 20;

function keyFor(subBrand) {
  return `${KEY_PREFIX}${String(subBrand || "").toLowerCase()}`;
}

function clampTopK(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, n));
}

/**
 * Resolve the configured top-K for a tenant/subBrand, falling back to
 * DEFAULT_TOP_K when unset or the stored value is somehow invalid. Never
 * throws — callers are recommendation engines that must keep working even
 * if this lookup has a problem.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @returns {Promise<number>}
 */
async function getRecommendationTopK({ tenantId, subBrand }) {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: keyFor(subBrand) } },
    });
    if (!row) return DEFAULT_TOP_K;
    const parsed = JSON.parse(row.value);
    const clamped = clampTopK(parsed?.topK);
    return clamped ?? DEFAULT_TOP_K;
  } catch {
    return DEFAULT_TOP_K;
  }
}

/**
 * Persist a new top-K for a tenant/subBrand.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {number} opts.topK
 * @returns {Promise<number>} the clamped value actually saved
 * @throws if topK is not a finite number
 */
async function setRecommendationTopK({ tenantId, subBrand, topK }) {
  const clamped = clampTopK(topK);
  if (clamped == null) {
    const err = new Error(`topK must be a number between ${MIN_TOP_K} and ${MAX_TOP_K}`);
    err.status = 400;
    err.code = "INVALID_TOP_K";
    throw err;
  }
  const value = JSON.stringify({ topK: clamped });
  const key = keyFor(subBrand);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  return clamped;
}

module.exports = {
  getRecommendationTopK,
  setRecommendationTopK,
  DEFAULT_TOP_K,
  MIN_TOP_K,
  MAX_TOP_K,
  CATEGORY,
};
