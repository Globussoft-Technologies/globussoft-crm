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
 * Check if a marketplace lead with this provider+externalId already exists.
 */
async function findDuplicateMarketplaceLead(provider, externalLeadId) {
  if (!externalLeadId) return null;
  return prisma.marketplaceLead.findUnique({
    where: { provider_externalLeadId: { provider, externalLeadId: String(externalLeadId) } },
  });
}

module.exports = { normalizePhone, findDuplicateContact, findDuplicateMarketplaceLead };
