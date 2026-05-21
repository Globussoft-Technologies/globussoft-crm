// Travel CRM — latest-diagnostic lookup.
//
// PRD §6.4 — at Itinerary creation time we want to capture the recommended
// tier the diagnostic produced, so reports can compare tier-vs-actual
// against the final itinerary. This module is the canonical query that
// turns (tenant, contact, sub-brand) into the latest TravelDiagnostic row.
//
// Pure-ish: takes a Prisma client + the keys, returns the row or null.
// No side effects beyond the read; deterministic for a frozen DB state.
// Returns a narrow projection (just the analytics-relevant columns) so
// callers can't accidentally leak large bank-snapshot Text columns.

/**
 * Return the most-recently-created TravelDiagnostic for the given
 * tenant + contact + sub-brand combination, or null if none exists.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} tenantId
 * @param {number} contactId
 * @param {string} subBrand
 * @returns {Promise<{id:number, score:any, classification:string|null,
 *                    classificationLabel:string|null, recommendedTier:string|null,
 *                    createdAt:Date} | null>}
 */
async function findLatestDiagnostic(prisma, tenantId, contactId, subBrand) {
  if (
    !prisma ||
    !Number.isFinite(tenantId) ||
    !Number.isFinite(contactId) ||
    !subBrand ||
    typeof subBrand !== "string"
  ) {
    return null;
  }
  const row = await prisma.travelDiagnostic.findFirst({
    where: { tenantId, contactId, subBrand },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      score: true,
      classification: true,
      classificationLabel: true,
      recommendedTier: true,
      createdAt: true,
    },
  });
  return row || null;
}

module.exports = { findLatestDiagnostic };
