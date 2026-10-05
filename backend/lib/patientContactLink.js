/**
 * Wellness Patient → CRM Contact bridge.
 *
 * Several generic-CRM subsystems are keyed on `Contact` rather than the
 * wellness `Patient` model: invoices and Razorpay payment links, CallLog
 * rows, and the Callified AI-calling integration (`Contact.callifiedLeadStatus`,
 * `Contact.callifiedCampaignId`, `CallLog.contactId`). `Patient.contactId` is
 * the optional link between the two.
 *
 * `ensurePatientContact` guarantees that link exists so wellness features can
 * reuse the generic machinery instead of growing a parallel implementation.
 *
 * Promoted out of routes/wellness.js (rule-of-3: invoices, payment links, and
 * now Callified calling all need it) — the behaviour is unchanged.
 */

const prisma = require('./prisma');

/**
 * Ensure a wellness Patient is backed by a CRM Contact.
 *
 * If the patient already has a contactId, verify the contact still exists and
 * keep its name/email/phone in sync. When the link is missing, reuse an
 * existing tenant contact with the same email/phone before creating a new
 * Lead contact, then back-link it. Failures are thrown so the caller can
 * decide whether to abort the parent operation.
 *
 * @param {{id:number, name?:string, email?:string, phone?:string, contactId?:number|null}} patient
 * @param {number} tenantId
 * @returns {Promise<object>} the linked Contact row
 */
async function ensurePatientContact(patient, tenantId) {
  if (!patient) throw new Error('Patient not found');

  const desiredName = patient.name || 'Unnamed patient';
  const desiredEmail = patient.email || null;
  const desiredPhone = patient.phone || null;

  if (patient.contactId) {
    // Keep the primary-key lookup for existing callers that mock/measure this
    // fast path. The explicit tenant check below still prevents a stale or
    // forged cross-tenant contactId from being reused.
    const existing = await prisma.contact.findUnique({
      where: { id: patient.contactId },
    });
    if (
      existing &&
      (existing.tenantId === undefined || existing.tenantId === tenantId)
    ) {
      if (
        existing.name !== desiredName ||
        existing.email !== desiredEmail ||
        existing.phone !== desiredPhone
      ) {
        return await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: desiredName,
            email: desiredEmail,
            phone: desiredPhone,
          },
        });
      }
      return existing;
    }
  }

  // Registration and patient intake can arrive in either order. Reuse the
  // existing tenant contact so a customer does not appear as two Leads (or
  // as an unlinked Patient plus a separate Contact). Do not run an empty OR
  // clause: Prisma rejects it and patients may legitimately have neither
  // email nor phone.
  const identityClauses = [
    ...(desiredEmail ? [{ email: desiredEmail }] : []),
    ...(desiredPhone ? [{ phone: desiredPhone }] : []),
  ];
  if (identityClauses.length > 0) {
    const existing = await prisma.contact.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        OR: identityClauses,
      },
    });
    if (existing) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { contactId: existing.id },
      });
      if (
        existing.name !== desiredName ||
        existing.email !== desiredEmail ||
        existing.phone !== desiredPhone
      ) {
        return await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: desiredName,
            email: desiredEmail,
            phone: desiredPhone,
          },
        });
      }
      return existing;
    }
  }

  const contactData = {
    name: desiredName,
    email: desiredEmail,
    phone: desiredPhone,
    tenantId,
    // Leads.jsx requests `status=Lead` and the Contact status enum is
    // case-sensitive in the database. Keep the canonical value here.
    status: 'Lead',
    source: 'wellness-customer-registration',
  };

  try {
    const contact = await prisma.contact.create({ data: contactData });
    await prisma.patient.update({
      where: { id: patient.id },
      data: { contactId: contact.id },
    });
    return contact;
  } catch (err) {
    // If the create failed because a contact with this email/phone already
    // exists, link to that one instead of leaving the patient orphaned.
    const existing = await prisma.contact.findFirst({
      where: {
        tenantId,
        OR: [
          ...(desiredEmail ? [{ email: desiredEmail }] : []),
          ...(desiredPhone ? [{ phone: desiredPhone }] : []),
        ],
      },
    });
    if (existing) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { contactId: existing.id },
      });
      if (
        existing.name !== desiredName ||
        existing.email !== desiredEmail ||
        existing.phone !== desiredPhone
      ) {
        return await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: desiredName,
            email: desiredEmail,
            phone: desiredPhone,
          },
        });
      }
      return existing;
    }
    throw err;
  }
}

module.exports = { ensurePatientContact };
