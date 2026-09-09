const prisma = require("./prisma");

// Creates one reviewable Draft invoice for an approved TMC participant.
// The function accepts a transaction client so participant approval and
// billing remain atomic.
async function createDraftInvoiceForParticipant({ db = prisma, tenantId, tripId, participantId }) {
  const trip = await db.tmcTrip.findFirst({
    where: { id: tripId, tenantId },
    select: { id: true, tripCode: true, destination: true, schoolContactId: true, departDate: true },
  });
  if (!trip) return null;

  const participant = await db.tripParticipant.findFirst({
    where: { id: participantId, tripId },
    select: { id: true, fullName: true, parentName: true, parentEmail: true, parentPhone: true },
  });
  if (!participant) return null;

  const plan = await db.tripPaymentPlan.findUnique({ where: { tripId } });
  if (!plan) return null;

  let template;
  try { template = JSON.parse(plan.instalmentsJson || "[]"); } catch (_) { return null; }
  if (!Array.isArray(template) || template.length === 0) return null;

  const existing = await db.travelInvoice.findFirst({
    where: { tenantId, tripId, participantId, status: { not: "Voided" } },
    select: { id: true, invoiceNum: true, totalAmount: true },
  });
  if (existing) return existing;

  // Public registrations normally already have a parent Contact. For
  // manually-added participants, create/find one from the parent details;
  // otherwise bill the school contact so invoice creation never blocks.
  let contact = null;
  if (participant.parentEmail) {
    contact = await db.contact.findFirst({ where: { tenantId, email: participant.parentEmail, deletedAt: null }, select: { id: true } });
  }
  if (!contact && participant.parentPhone) {
    contact = await db.contact.findFirst({ where: { tenantId, phone: participant.parentPhone, deletedAt: null }, select: { id: true } });
  }
  if (!contact && (participant.parentEmail || participant.parentPhone)) {
    contact = await db.contact.create({
      data: {
        tenantId,
        name: participant.parentName || participant.fullName,
        email: participant.parentEmail || null,
        phone: participant.parentPhone || null,
        status: "Customer",
        source: "TMC participant",
        subBrand: "tmc",
      },
      select: { id: true },
    });
  }
  if (!contact) contact = { id: trip.schoolContactId };

  const validLines = template
    .map((row, index) => ({
      index,
      dueDate: new Date(row?.dueDate),
      amount: Number(row?.amount),
    }))
    .filter((row) => Number.isFinite(row.dueDate.getTime()) && Number.isFinite(row.amount) && row.amount > 0);
  if (validLines.length === 0) return null;

  const totalAmount = validLines.reduce((sum, row) => sum + row.amount, 0);
  const invoiceNum = `TINV-${new Date().getFullYear()}-T${trip.id}-P${participant.id}`;
  const invoice = await db.travelInvoice.create({
    data: {
      tenantId,
      tripId,
      participantId,
      subBrand: "tmc",
      contactId: contact.id,
      invoiceNum,
      status: "Draft",
      totalAmount,
      currency: "INR",
      dueDate: validLines[validLines.length - 1].dueDate,
      lines: {
        create: validLines.map((row) => ({
          tenantId,
          lineType: "per_pax",
          description: `${trip.tripCode} — ${participant.fullName} — Instalment ${row.index + 1}`,
          quantity: 1,
          unitPrice: row.amount,
          amount: row.amount,
          currency: "INR",
          sortOrder: row.index,
          serviceStartDate: trip.departDate,
          serviceEndDate: trip.departDate,
        })),
      },
    },
    select: { id: true, invoiceNum: true, totalAmount: true, status: true },
  });

  const instalments = await db.tripInstalmentPayment.findMany({
    where: { tripId, participantId },
    select: { id: true, instalmentIndex: true, invoiceId: true },
  });
  for (const instalment of instalments) {
    if (!instalment.invoiceId) {
      await db.tripInstalmentPayment.update({ where: { id: instalment.id }, data: { invoiceId: invoice.id } });
    }
  }
  return invoice;
}

module.exports = { createDraftInvoiceForParticipant };
