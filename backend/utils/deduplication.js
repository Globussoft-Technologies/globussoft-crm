const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * Normalize a phone number to digits-only for comparison.
 * Strips +, spaces, dashes, parens. Keeps leading country code.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  // Indian numbers: if 10 digits, prepend 91
  if (digits.length === 10) return "91" + digits;
  return digits || null;
}

/**
 * Find an existing contact by email or phone.
 * Returns the matching Contact or null.
 */
async function findDuplicateContact(email, phone) {
  // Try email match first (most reliable)
  if (email) {
    const byEmail = await prisma.contact.findUnique({ where: { email } });
    if (byEmail) return byEmail;
  }

  // Try phone match (normalized)
  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      // Check both raw and normalized forms
      const contacts = await prisma.contact.findMany({
        where: {
          phone: { not: null },
        },
      });
      for (const c of contacts) {
        if (normalizePhone(c.phone) === normalized) return c;
      }
    }
  }

  return null;
}

/**
 * Check if a marketplace lead with this provider+externalId already exists
 * for the given tenant.
 *
 * Schema note (#414): the unique constraint is `[tenantId, provider,
 * externalLeadId]` — cross-tenant duplicates are intentionally allowed. The
 * Prisma compound-unique finder name is therefore `tenantId_provider_externalLeadId`,
 * NOT the legacy `provider_externalLeadId`. Calling the legacy name throws
 * a runtime "Argument `where` of type ...UniqueInput needs at least one
 * argument" because the named alias no longer exists in the generated client
 * — that surfaced as a 500 on every webhook ingest after the #414 schema
 * change landed. Callers must pass tenantId; webhook routes hardcode 1, the
 * cron sync passes the per-tenant config's tenantId.
 */
async function findDuplicateMarketplaceLead(provider, externalLeadId, tenantId = 1) {
  if (!externalLeadId) return null;
  return prisma.marketplaceLead.findUnique({
    where: {
      tenantId_provider_externalLeadId: {
        tenantId: Number(tenantId),
        provider,
        externalLeadId: String(externalLeadId),
      },
    },
  });
}

/**
 * #592 — Compute a stable group key for a duplicate set.
 *
 * The Find Duplicates UI lets the operator dismiss a group ("not actually
 * duplicates"). For the dismiss to be sticky across re-runs of the detector,
 * the same group of contacts must always hash to the same key — regardless of
 * which contact the detector picked as `primary` on a given pass.
 *
 * Implementation: union the primary id with every duplicate id, sort
 * numerically ascending, comma-join, SHA-256 it, return the hex digest.
 *
 * Soft-deleting any member of a dismissed group naturally invalidates the
 * group (the detector no longer sees that contact, so the surviving members
 * may not even form a group anymore — and if they do, the new key differs
 * from the dismissed one). That's the desired UX.
 */
const crypto = require('crypto');
function computeDuplicateGroupKey(primaryId, duplicateIds) {
  // Reject null/undefined explicitly — Number(null) is 0 which would
  // otherwise produce a non-empty key for an empty group. Strings are coerced.
  const coerce = (v) => {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const ids = [coerce(primaryId), ...(duplicateIds || []).map(coerce)]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ids.length === 0) return null;
  return crypto.createHash('sha256').update(ids.join(',')).digest('hex');
}

module.exports = {
  normalizePhone,
  findDuplicateContact,
  findDuplicateMarketplaceLead,
  computeDuplicateGroupKey,
};
