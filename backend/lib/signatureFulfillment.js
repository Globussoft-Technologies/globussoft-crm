// Fulfillment for a signed Estimate: auto-convert it to an Invoice, then mint
// a hosted payment link the customer can pay from their email.
//
// Called best-effort from routes/signatures.js POST /sign/:token. Returns a
// result describing what happened so the caller can email the customer + the
// owner appropriately:
//   { status: 'converted', invoice, payLink, payError, contact, currency }
//   { status: 'already_converted' | 'no_contact' | 'not_found', estimate? }
//
// The convert step mirrors routes/estimates.js PUT /:id/convert (same invoice
// shape: UNPAID, due +30d, copies contact/deal/amount) but takes explicit
// tenant/actor ids since the signer is unauthenticated.

const crypto = require("crypto");
const prisma = require("./prisma");
const { writeAudit } = require("./audit");
const { createInvoicePaymentLink } = require("./paymentLink");

const TERMINAL_OR_DONE = new Set(["Converted"]);

async function resolveGatewayPref(tenantId) {
  try {
    const row = await prisma.tenantSetting.findFirst({
      where: { tenantId, key: "signature.payGateway" },
      select: { value: true },
    });
    const v = (row?.value || "auto").trim().toLowerCase();
    return ["auto", "razorpay", "stripe"].includes(v) ? v : "auto";
  } catch (_e) {
    return "auto";
  }
}

/**
 * @param {Object} opts
 * @param {number} opts.documentId  - the Estimate id
 * @param {number} opts.tenantId
 * @param {string} [opts.signerName]  - who signed (preferred over contact)
 * @param {string} [opts.signerEmail] - the address the owner sent this to
 * @param {number|null} [opts.actorUserId] - for the audit trail (null = signer)
 */
async function fulfillSignedEstimate({ documentId, tenantId, signerName, signerEmail, actorUserId = null }) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: documentId, tenantId },
    include: { contact: true, lineItems: true },
  });
  if (!estimate) return { status: "not_found" };
  if (TERMINAL_OR_DONE.has(estimate.status)) {
    return { status: "already_converted", estimate };
  }
  if (!estimate.contactId) {
    // Can't bill without a customer to invoice. Caller notifies the owner.
    return { status: "no_contact", estimate };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultCurrency: true },
  });
  const currency = tenant?.defaultCurrency || "USD";

  // 1. Convert: create the invoice + flip the estimate to Converted atomically.
  const invoiceNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const { invoice } = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        invoiceNum,
        amount: estimate.totalAmount,
        status: "UNPAID",
        dueDate,
        contactId: estimate.contactId,
        dealId: estimate.dealId || null,
        tenantId,
      },
    });
    await tx.estimate.update({ where: { id: estimate.id }, data: { status: "Converted" } });
    return { invoice: created };
  });

  // Audit both sides (best-effort — never block fulfillment on the trail).
  try {
    await writeAudit("Estimate", "CONVERT_TO_INVOICE", estimate.id, actorUserId, tenantId, {
      invoiceId: invoice.id, invoiceNum, amount: invoice.amount, via: "signature-auto",
    });
    await writeAudit("Invoice", "CREATE", invoice.id, actorUserId, tenantId, {
      invoiceNum, amount: invoice.amount, sourceEstimateId: estimate.id, via: "signature-auto",
    });
  } catch (_e) { /* audit is non-critical */ }

  // The address the owner typed for this signature request is the canonical
  // recipient (the contact's stored email may be a synthetic placeholder, e.g.
  // a WhatsApp-synced "…@whatsapp.local"). Prefer the signer, fall back to the
  // contact record.
  const customerEmail = signerEmail || estimate.contact?.email || null;
  const customerName = signerName || estimate.contact?.name || null;

  // 2. Mint a hosted payment link for the new invoice.
  const gatewayPref = await resolveGatewayPref(tenantId);
  const payResult = await createInvoicePaymentLink({
    tenantId,
    invoice,
    contact: { name: customerName, email: customerEmail, phone: estimate.contact?.phone },
    currency,
    gatewayPref,
  });

  const payLink = payResult && payResult.url
    ? { url: payResult.url, gateway: payResult.gateway, paymentId: payResult.paymentId }
    : null;

  return {
    status: "converted",
    invoice,
    contact: estimate.contact || null,
    customerEmail,
    customerName,
    currency,
    payLink,
    payError: payLink ? null : (payResult?.error || "Payment link unavailable"),
  };
}

module.exports = { fulfillSignedEstimate, resolveGatewayPref };
