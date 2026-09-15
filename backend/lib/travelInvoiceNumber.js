function serialFromInvoiceNum(invoiceNum, year) {
  const match = new RegExp(`^TINV-${year}-(\\d+)$`).exec(String(invoiceNum || ""));
  if (!match) return null;
  const serial = Number(match[1]);
  return Number.isSafeInteger(serial) ? serial : null;
}

async function nextTravelInvoiceNum(prisma, tenantId, date = new Date()) {
  const year = date.getFullYear();
  const prefix = `TINV-${year}-`;
  const rows = await prisma.travelInvoice.findMany({
    where: { tenantId, invoiceNum: { startsWith: prefix } },
    select: { invoiceNum: true },
  });
  const highestSerial = rows.reduce((highest, row) => {
    const serial = serialFromInvoiceNum(row.invoiceNum, year);
    return serial == null ? highest : Math.max(highest, serial);
  }, 0);
  return `${prefix}${String(highestSerial + 1).padStart(4, "0")}`;
}

function isInvoiceNumberConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target || error?.message || "");
  return target.includes("invoiceNum") || target.includes("TravelInvoice_tenantId_invoiceNum_key");
}

async function createTravelInvoiceWithNumber(prisma, tenantId, data, options = {}) {
  const maxAttempts = options.maxAttempts || 5;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const invoiceNum = await nextTravelInvoiceNum(prisma, tenantId, options.date);
    try {
      return await prisma.travelInvoice.create({
        data: { ...data, tenantId, invoiceNum },
      });
    } catch (error) {
      if (!isInvoiceNumberConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = {
  createTravelInvoiceWithNumber,
  nextTravelInvoiceNum,
  serialFromInvoiceNum,
};
