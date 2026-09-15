function serialFromInvoiceNum(invoiceNum, year) {
  const match = new RegExp(`^TINV-${year}-(\\d+)$`).exec(String(invoiceNum || ""));
  if (!match) return null;
  const serial = Number(match[1]);
  return Number.isSafeInteger(serial) ? serial : null;
}

async function highestCanonicalSerial(prisma, tenantId, year) {
  const rows = await prisma.travelInvoice.findMany({
    where: { tenantId, invoiceNum: { startsWith: `TINV-${year}-` } },
    select: { invoiceNum: true },
  });
  return rows.reduce((highest, row) => {
    const serial = serialFromInvoiceNum(row.invoiceNum, year);
    return serial == null ? highest : Math.max(highest, serial);
  }, 0);
}

async function nextTravelInvoiceNum(prisma, tenantId, date = new Date()) {
  const year = date.getUTCFullYear();
  const prefix = `TINV-${year}-`;
  const sequence = await prisma.travelInvoiceSequence.findUnique({
    where: { tenantId_year: { tenantId, year } },
    select: { lastSerial: true },
  });
  const lastSerial = sequence?.lastSerial ?? await highestCanonicalSerial(prisma, tenantId, year);
  return `${prefix}${String(lastSerial + 1).padStart(4, "0")}`;
}

async function createTravelInvoiceWithNumber(prisma, tenantId, data, options = {}) {
  const year = (options.date || new Date()).getUTCFullYear();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.travelInvoiceSequence.findUnique({
      where: { tenantId_year: { tenantId, year } },
      select: { lastSerial: true },
    });
    // Production currently applies additive schema changes with `prisma db
    // push`, which creates the sequence table but does not execute migration
    // seed SQL. Bootstrap once from canonical legacy numbers when needed.
    const legacySerial = existing
      ? 0
      : await highestCanonicalSerial(tx, tenantId, year);
    const sequence = await tx.travelInvoiceSequence.upsert({
      where: { tenantId_year: { tenantId, year } },
      create: { tenantId, year, lastSerial: legacySerial + 1 },
      update: { lastSerial: { increment: 1 } },
      select: { lastSerial: true },
    });
    const invoiceNum = `TINV-${year}-${String(sequence.lastSerial).padStart(4, "0")}`;
    return tx.travelInvoice.create({
      data: { ...data, tenantId, invoiceNum },
    });
  });
}

module.exports = {
  createTravelInvoiceWithNumber,
  highestCanonicalSerial,
  nextTravelInvoiceNum,
  serialFromInvoiceNum,
};
