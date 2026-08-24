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
 * keep its name/email/phone in sync; otherwise create a contact from the
 * patient's details and back-link it. Failures are thrown so the caller can
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
    const existing = await prisma.contact.findUnique({
      where: { id: patient.contactId },
    });
    if (existing) {
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
    status: 'lead',
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
