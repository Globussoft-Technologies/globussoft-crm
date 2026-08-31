/**
 * Storage for a school's "chosen itinerary interests" — the trips they
 * checked off on the public diagnostic report page after seeing their RAG
 * recommendations (2026-08-27).
 *
 * Deliberately does NOT use a dedicated Prisma column — TravelDiagnostic has
 * no free catch-all JSON field for this. Reuses the generic TenantSetting
 * key-value store instead (same mechanism as
 * backend/lib/curriculumDocuments.js and diagnosticRecommendationSettings.js),
 * keeping this fully additive with zero schema migrations.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.diagnostic.interests.<diagnosticId>`,
 * category: "travel-diagnostic-chosen-interests",
 * value: JSON.stringify({ interests: [{name, driveLink}], submittedAt }) }.
 */

const prisma = require("./prisma");
const { sanitizeText } = require("./sanitizeJson");

const CATEGORY = "travel-diagnostic-chosen-interests";
const KEY_PREFIX = "travel.diagnostic.interests.";

// Same ceiling as diagnosticRecommendationSettings.MAX_TOP_K — a chosen
// selection can never legitimately exceed however many recommendations were
// ever shown, and this caps abuse from a directly-called endpoint.
const MAX_INTERESTS = 20;

function keyFor(diagnosticId) {
  return `${KEY_PREFIX}${diagnosticId}`;
}

function normalizeInterests(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      name: sanitizeText(String(item?.name || "").trim()).slice(0, 200),
      driveLink: sanitizeText(String(item?.driveLink || "").trim()).slice(0, 500),
    }))
    .filter((item) => item.name)
    .slice(0, MAX_INTERESTS);
}

/**
 * Fetch the previously-submitted chosen interests for a diagnostic, if any.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.diagnosticId
 * @returns {Promise<{interests: object[], submittedAt: string}|null>}
 */
async function getChosenInterests({ tenantId, diagnosticId }) {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: keyFor(diagnosticId) } },
    });
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    const interests = normalizeInterests(parsed?.interests);
    if (!interests.length) return null;
    return { interests, submittedAt: parsed?.submittedAt || null };
  } catch {
    return null;
  }
}

/**
 * Save (overwrite) the chosen interests for a diagnostic — resubmitting
 * simply replaces the prior selection, no history is kept.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.diagnosticId
 * @param {object[]} opts.interests - [{name, driveLink}]
 * @returns {Promise<{interests: object[], submittedAt: string}>}
 * @throws if interests normalizes to an empty list
 */
async function saveChosenInterests({ tenantId, diagnosticId, interests }) {
  const clean = normalizeInterests(interests);
  if (!clean.length) {
    const err = new Error("At least one interest with a name is required");
    err.status = 400;
    err.code = "MISSING_INTERESTS";
    throw err;
  }
  const submittedAt = new Date().toISOString();
  const value = JSON.stringify({ interests: clean, submittedAt });
  const key = keyFor(diagnosticId);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  return { interests: clean, submittedAt };
}

module.exports = {
  getChosenInterests,
  saveChosenInterests,
  MAX_INTERESTS,
  CATEGORY,
};
