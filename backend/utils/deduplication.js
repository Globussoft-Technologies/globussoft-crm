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

module.exports = { normalizePhone, findDuplicateContact, findDuplicateMarketplaceLead };
