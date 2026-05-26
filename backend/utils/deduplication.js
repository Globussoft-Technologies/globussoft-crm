const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * Normalize a phone number to digits-only for comparison.
 * Strips +, spaces, dashes, parens. Keeps leading country code.
 *
 * NOTE: returns the digits-only form (`919876543210`), used as the
 * canonical *dedup key* (Patient.normalizedPhone, contact phone-match).
 * For the user-facing E.164 display form (`+919876543210`) use toE164().
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  // Indian numbers: if 10 digits, prepend 91
  if (digits.length === 10) return "91" + digits;
  return digits || null;
}

/**
 * #595 — Format a phone number to E.164 (`+919876543210`).
 *
 * Returns `null` if the input cannot be formatted (empty, too short, or
 * doesn't match a recognised IN/intl shape). Used to canonicalise the
 * stored `Patient.phone` display value so downstream auto-dialer / SMS /
 * WhatsApp keys see a consistent prefix.
 *
 * Rules (Indian-only deployments — clinics are India-only per
 * product-anchored constants):
 *   - 10 digits starting 6-9 → `+91` + the 10 digits
 *   - 12 digits starting `91` followed by 6-9 → `+` + the 12 digits
 *   - already E.164 (starts with `+` and rest is 10-15 digits) → returned
 *     as-is after stripping spaces/dashes/parens
 *   - anything else → null (caller should reject the input upstream;
 *     route persistence falls back to the raw value if null is returned)
 */
function toE164(phone) {
  if (!phone || typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  // Already plus-prefixed: keep as-is after stripping the cosmetic chars.
  if (trimmed.startsWith("+")) {
    const rest = trimmed.slice(1).replace(/[^0-9]/g, "");
    if (rest.length >= 10 && rest.length <= 15) return "+" + rest;
    return null;
  }
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) return null;
  // 10 digits, Indian mobile (6-9 prefix).
  if (digits.length === 10 && /^[6-9]/.test(digits)) return "+91" + digits;
  // 12 digits starting 91 followed by an Indian mobile prefix.
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) {
    return "+" + digits;
  }
  return null;
}

/**
 * Find an existing contact by email or phone — tenant-scoped.
 *
 * Returns the matching Contact or null. Soft-deleted contacts (`deletedAt`
 * set) are skipped.
 *
 * Schema-correctness note: Contact's unique constraint is the COMPOUND
 * `@@unique([email, tenantId])` (since commit 7d84a75, 2026-04-16). The
 * email path uses the `email_tenantId` compound finder; a bare
 * `findUnique({ where: { email } })` is invalid Prisma input against the
 * current schema and throws PrismaClientValidationError at runtime. The
 * old signature `findDuplicateContact(email, phone)` masked this — its
 * sole caller (`routes/marketplace_leads.js`) post-filtered the result
 * by `existing.tenantId === req.user.tenantId`, which inadvertently
 * compensated for the cross-tenant bleed but never surfaced the
 * validation error in production because the email path is rarely hit
 * (operator-triggered marketplace imports).
 *
 * @param {string|null} email
 * @param {string|null} phone
 * @param {number} tenantId  — REQUIRED. Throws if missing.
 * @returns {Promise<Object|null>}
 */
async function findDuplicateContact(email, phone, tenantId) {
  if (!tenantId) {
    throw new Error("findDuplicateContact requires tenantId");
  }

  if (email) {
    const byEmail = await prisma.contact.findUnique({
      where: { email_tenantId: { email, tenantId } },
    });
    if (byEmail && !byEmail.deletedAt) return byEmail;
  }

  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      const contacts = await prisma.contact.findMany({
        where: { tenantId, phone: { not: null }, deletedAt: null },
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

/**
 * PRD §4.5 (Travel — RFU sub-brand) — duplicate detection by passport number.
 *
 * RFU pilgrim profiles store passport on `RfuLeadProfile.passportNumber`
 * (1:1 with Contact via contactId), NOT directly on Contact. So the lookup
 * joins through the profile and resolves the matching Contact.
 *
 * Scoped per-tenant: a passport that appears in multiple tenants must NOT
 * cross-match (each tenant runs an independent CRM book). Passport itself
 * is not @unique on RfuLeadProfile — multiple profile rows with the same
 * passport in the same tenant ARE the duplicate we're detecting; findFirst
 * returns the earliest row, which the caller can treat as the canonical
 * parent. Soft-deleted Contacts (deletedAt set) are filtered out.
 *
 * @param {string} passportNumber  Raw passport string (no canonicalization
 *   here — callers normalize to upper-case if their UX requires it).
 * @param {number} tenantId
 * @returns {Promise<Object|null>} matching Contact row or null
 */
async function findDuplicateContactByPassport(passportNumber, tenantId) {
  if (!passportNumber || !tenantId) return null;
  const profile = await prisma.rfuLeadProfile.findFirst({
    where: { tenantId, passportNumber },
    select: { contactId: true },
  });
  if (!profile?.contactId) return null;
  const contact = await prisma.contact.findUnique({
    where: { id: profile.contactId },
  });
  if (!contact || contact.deletedAt) return null;
  return contact;
}

/**
 * PRD §4.5 — Customer-duplicate detection — Phase 2 unified helper.
 *
 * Tries the three dedup keys in order of signal strength and returns the
 * first match along with which key matched (so the caller can surface
 * the right message — "this passport is already on file" beats "we found
 * a contact with a similar phone number").
 *
 * Order: passport → email → phone. Passport wins because for RFU pilgrims
 * it's near-canonical (no two travellers share a passport); email is
 * tenant-unique by schema; phone is fuzzy (re-used family numbers, shared
 * SIMs) so it's the weakest signal.
 *
 * All three checks are tenant-scoped. Soft-deleted contacts are skipped.
 *
 * @param {Object} opts
 * @param {string} [opts.email]
 * @param {string} [opts.phone]
 * @param {string} [opts.passportNumber]
 * @param {number} opts.tenantId
 * @returns {Promise<{ contact: Object, matchedBy: 'passport'|'email'|'phone' }|null>}
 */
async function findDuplicateContactFull({ email, phone, passportNumber, tenantId } = {}) {
  if (!tenantId) throw new Error("findDuplicateContactFull requires tenantId");

  if (passportNumber) {
    const c = await findDuplicateContactByPassport(passportNumber, tenantId);
    if (c) return { contact: c, matchedBy: "passport" };
  }

  if (email) {
    // Contact uses `@@unique([email, tenantId])` — must use the compound
    // finder name. (Bare `findUnique({ where: { email } })` is the legacy
    // shape used by `findDuplicateContact` above; kept untouched for back-
    // compat but unsafe against the current schema.)
    const byEmail = await prisma.contact.findUnique({
      where: { email_tenantId: { email, tenantId } },
    });
    if (byEmail && !byEmail.deletedAt) {
      return { contact: byEmail, matchedBy: "email" };
    }
  }

  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      const candidates = await prisma.contact.findMany({
        where: { tenantId, phone: { not: null }, deletedAt: null },
      });
      for (const c of candidates) {
        if (normalizePhone(c.phone) === normalized) {
          return { contact: c, matchedBy: "phone" };
        }
      }
    }
  }

  return null;
}

module.exports = {
  normalizePhone,
  toE164,
  findDuplicateContact,
  findDuplicateContactByPassport,
  findDuplicateContactFull,
  findDuplicateMarketplaceLead,
  computeDuplicateGroupKey,
};
