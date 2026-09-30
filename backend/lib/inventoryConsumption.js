const prisma = require("./prisma");
const { dispenseUnitsFor, normalizeName } = require("./drugStock");

const SOURCE_TYPES = Object.freeze({
  MANUAL: "MANUAL",
  PRESCRIPTION: "PRESCRIPTION",
  AUTO_RULE: "AUTO_RULE",
});

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

/**
 * Keep package sizes out of the displayed quantity. Some older drug rows use
 * the `unit` column for a numeric pack size (for example, "100"). That is
 * metadata about the catalogue item, not the unit in which the visit used it,
 * so rendering it beside qty creates misleading values such as "1 100".
 * A missing/invalid unit returns null; callers that need a human-readable
 * inventory label can apply their own fallback without changing the billable
 * quantity.
 */
function normalizeInventoryUnit(...values) {
  for (const value of values) {
    const unit = String(value ?? "").trim();
    if (!unit || /^\d+(?:\.\d+)?$/.test(unit) || unit.toLowerCase() === "other") {
      continue;
    }
    return unit;
  }
  return null;
}

/**
 * Product price is the price for the complete catalogue unit. Usage value is
 * the consumed quantity multiplied by that unit's price, matching the clinic
 * spreadsheet (for example, 1 ml of a 50 ml serum bottle).
 */
function usagePricing({ qty, salePrice, volume, fallbackUnitCost = 0 }) {
  const quantity = Number(qty);
  const price = Number(salePrice);
  const size = Number(volume);
  const safeQty = Number.isFinite(quantity) ? quantity : 0;
  const safePrice = Number.isFinite(price) ? price : 0;
  const unitCost =
    safePrice > 0 && Number.isFinite(size) && size > 0
      ? safePrice / size
      : Number(fallbackUnitCost) > 0
        ? Number(fallbackUnitCost)
        : safePrice;
  return {
    unitCost: roundMoney(unitCost),
    usageValue: roundMoney(safeQty * unitCost),
  };
}

function normaliseDrugName(value) {
  return normalizeName(value).replace(/\s+\d+(\.\d+)?\s*(mg|ml|mcg|g|iu|%)$/i, "").trim();
}

async function loadDrugsForLines(client, tenantId, lines) {
  const ids = [...new Set(lines
    .map((line) => Number(line?.drugId))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const names = [...new Set(lines
    .map((line) => normaliseDrugName(line?.name || line?.drugName))
    .filter(Boolean))];
  if (!client?.drug?.findMany || (!ids.length && !names.length)) return [];

  const where = { tenantId };
  if (ids.length && names.length) {
    where.OR = [
      { id: { in: ids } },
      ...names.map((name) => ({ name: { contains: name } })),
    ];
  } else if (ids.length) {
    where.id = { in: ids };
  } else {
    where.OR = names.map((name) => ({ name: { contains: name } }));
  }
  return client.drug.findMany({
    where,
    select: {
      id: true,
      name: true,
      productCode: true,
      salePrice: true,
      unit: true,
      dosageForm: true,
    },
  });
}

function resolveDrug(line, rows) {
  const explicitId = Number(line?.drugId);
  if (Number.isInteger(explicitId) && explicitId > 0) {
    const exact = rows.find((row) => row.id === explicitId);
    if (exact) return exact;
  }
  const wanted = normaliseDrugName(line?.name || line?.drugName);
  if (!wanted) return null;
  return rows.find((row) => normaliseDrugName(row.name) === wanted) || null;
}

function buildPrescriptionConsumptionData({ prescription, line, lineIndex, drug }) {
  const qty = dispenseUnitsFor(line);
  const salePrice = Number(drug?.salePrice) || 0;
  const pricing = usagePricing({ qty, salePrice });
  return {
    visitId: Number(prescription.visitId),
    tenantId: Number(prescription.tenantId),
    productName: String(line?.name || line?.drugName || drug?.name || "Drug").trim(),
    qty,
    unitCost: pricing.unitCost,
    usageValue: pricing.usageValue,
    salePrice,
    sourceType: SOURCE_TYPES.PRESCRIPTION,
    transactionType: "Sale",
    unit: normalizeInventoryUnit(drug?.unit, drug?.dosageForm),
    productCode: drug?.productCode || null,
    drugId: drug?.id || null,
    prescriptionId: Number(prescription.id),
    prescriptionLine: lineIndex,
  };
}

/**
 * Mirror the current prescription lines into the visit inventory ledger.
 * Existing source rows are updated in place on an Rx amendment; missing rows
 * are created. No source row is deleted, preserving the clinical audit trail.
 */
async function syncPrescriptionConsumption({ prescription, drugs, client = prisma }) {
  const lines = Array.isArray(drugs)
    ? drugs.filter((line) => line?.name || line?.drugName)
    : [];
  if (
    !prescription?.id ||
    !prescription?.visitId ||
    !prescription?.tenantId ||
    !client?.serviceConsumption
  ) {
    return { created: 0, updated: 0, skipped: lines.length };
  }

  const results = await Promise.allSettled([
    Promise.resolve().then(() => loadDrugsForLines(client, prescription.tenantId, lines)),
    Promise.resolve().then(() => client.serviceConsumption.findMany({
      where: {
        tenantId: prescription.tenantId,
        prescriptionId: Number(prescription.id),
      },
      select: { id: true, prescriptionLine: true },
    })),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    return {
      created: 0,
      updated: 0,
      skipped: lines.length,
      error: "SYNC_UNAVAILABLE",
    };
  }
  const [drugRows, existingRows] = results.map((result) => result.value);
  let created = 0;
  let updated = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const data = buildPrescriptionConsumptionData({
      prescription,
      line,
      lineIndex,
      drug: resolveDrug(line, drugRows),
    });
    const existing = existingRows.find((row) => row.prescriptionLine === lineIndex);
    if (existing) {
      await client.serviceConsumption.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await client.serviceConsumption.create({ data });
      created += 1;
    }
  }
  return { created, updated, skipped: 0 };
}

function enrichConsumptionRow(row, { visit, product, drug } = {}) {
  const qty = Number(row.qty) || 0;
  const storedSalePrice = Number(row.salePrice);
  const salePrice = storedSalePrice > 0
    ? storedSalePrice
    : Number(product?.price ?? drug?.salePrice) || 0;
  const pricing = usagePricing({
    qty,
    salePrice,
    volume: product?.volume,
    fallbackUnitCost: row.unitCost,
  });
  const usageValue = Number(row.usageValue) > 0
    ? Number(row.usageValue)
    : pricing.usageValue;
  const unit = normalizeInventoryUnit(
    row.unit,
    product?.unit,
    drug?.unit,
    drug?.dosageForm,
  ) || "unit";
  return {
    ...row,
    transactionDate: visit?.visitDate || row.createdAt,
    bookingId: visit?.id || row.visitId,
    customerName: visit?.patient?.name || null,
    staff: visit?.doctor?.name || null,
    serviceName: visit?.service?.name || null,
    transactionType: row.transactionType || "Sale",
    productCode: row.productCode || product?.productCode || drug?.productCode || null,
    quantity: `${qty} ${unit}`.trim(),
    unit,
    salePrice,
    unitCost: Number(row.unitCost) || pricing.unitCost,
    usageValue,
    sourceType: row.sourceType || SOURCE_TYPES.MANUAL,
  };
}

/**
 * Calculate the inventory portion of a visit bill from the same ledger that
 * powers the patient inventory tab. Legacy rows are enriched from their
 * linked catalogue Product/Drug before the total is calculated.
 */
async function getVisitInventoryTotal({ visitId, tenantId, client = prisma }) {
  if (!client?.serviceConsumption?.findMany) return 0;
  const rows = await client.serviceConsumption.findMany({
    where: { visitId: Number(visitId), tenantId: Number(tenantId) },
    select: {
      id: true,
      productName: true,
      qty: true,
      unitCost: true,
      usageValue: true,
      salePrice: true,
      productId: true,
      drugId: true,
      unit: true,
      productCode: true,
      transactionType: true,
      sourceType: true,
      createdAt: true,
    },
  });
  const productIds = [...new Set(rows.map((row) => row.productId).filter(Boolean))];
  const drugIds = [...new Set(rows.map((row) => row.drugId).filter(Boolean))];
  const [products, drugs] = await Promise.all([
    productIds.length && client.product?.findMany
      ? client.product.findMany({
          where: { tenantId: Number(tenantId), id: { in: productIds } },
          select: { id: true, productCode: true, price: true, volume: true, unit: true },
        })
      : Promise.resolve([]),
    drugIds.length && client.drug?.findMany
      ? client.drug.findMany({
          where: { tenantId: Number(tenantId), id: { in: drugIds } },
          select: { id: true, productCode: true, salePrice: true, unit: true, dosageForm: true },
        })
      : Promise.resolve([]),
  ]);
  const productMap = new Map(products.map((product) => [product.id, product]));
  const drugMap = new Map(drugs.map((drug) => [drug.id, drug]));
  return roundMoney(rows.reduce((sum, row) => sum + enrichConsumptionRow(row, {
    visit: { id: Number(visitId) },
    product: productMap.get(row.productId),
    drug: drugMap.get(row.drugId),
  }).usageValue, 0));
}

function parseBillingMetadata(visit) {
  if (!visit?.couponBreakdown) return null;
  if (typeof visit.couponBreakdown === "object") return visit.couponBreakdown;
  try {
    const parsed = JSON.parse(visit.couponBreakdown);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function resolveServiceAmount({ visit, servicePrice, inventoryTotal, storedAmount }) {
  const metadata = parseBillingMetadata(visit);
  const recordedServiceAmount = Number(metadata?.serviceAmount);
  if (Number.isFinite(recordedServiceAmount) && recordedServiceAmount >= 0) {
    return roundMoney(recordedServiceAmount);
  }

  if (inventoryTotal > 0 && servicePrice > 0) {
    // Log Visit may already have stored service + inventory as the visit
    // charge. Keep that total intact instead of adding the same inventory a
    // second time. Otherwise the stored charge is the clinician's service
    // amount and the inventory ledger is added to it.
    const storedIncludesInventory = Math.abs(
      storedAmount - (servicePrice + inventoryTotal),
    ) < 0.005;
    if (storedIncludesInventory) return roundMoney(storedAmount - inventoryTotal);
  }

  return roundMoney(Math.max(storedAmount, servicePrice));
}

/**
 * Turn one completed visit into the line-item shape used by wellness
 * invoices. ServiceConsumption is the source of truth for products and
 * prescribed drugs; the visit's service is the first line. Keeping this
 * mapping here makes payment-link invoices, the invoice ledger and reports
 * agree on names, quantities and usage amounts.
 */
function buildVisitInvoiceLineItems({
  visit,
  service,
  consumptions = [],
  serviceAmount,
}) {
  const items = [];
  const resolvedService = service || visit?.service;
  if (resolvedService?.name) {
    const amount = roundMoney(
      serviceAmount != null
        ? serviceAmount
        : resolvedService.basePrice,
    );
    items.push({
      type: "service",
      itemId: resolvedService.id || visit?.serviceId || null,
      name: String(resolvedService.name),
      quantity: 1,
      unitPrice: amount,
      amount,
    });
  }

  for (const row of consumptions) {
    const quantity = Number(row?.qty);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const amount = roundMoney(
      Number(row?.usageValue) > 0
        ? row.usageValue
        : quantity * (Number(row?.unitCost) || Number(row?.salePrice) || 0),
    );
    const unitPrice = roundMoney(amount / quantity);
    items.push({
      type: row.drugId ? "drug" : "product",
      itemId: row.drugId || row.productId || null,
      name: String(row.productName || "Unnamed inventory item"),
      quantity,
      unitPrice,
      amount,
      unit: normalizeInventoryUnit(row.unit),
      productCode: row.productCode || null,
      salePrice: Number(row.salePrice) || 0,
      usageValue: amount,
      transactionType: row.transactionType || "Sale",
      sourceType: row.sourceType || SOURCE_TYPES.MANUAL,
      prescriptionId: row.prescriptionId || null,
      prescriptionLine: row.prescriptionLine ?? null,
    });
  }
  return items;
}

/** Load all billable details for a visit. This is intentionally additive to
 * the existing schema: invoices store the resulting JSON snapshot, while
 * older invoices can be hydrated on read from these same rows. */
async function getVisitInvoiceLineItems({
  visit,
  tenantId,
  serviceAmount,
  client = prisma,
}) {
  if (!visit?.id || !client?.serviceConsumption?.findMany) return [];

  let service = visit.service || null;
  if (!service && visit.serviceId && client.service?.findFirst) {
    service = await client.service.findFirst({
      where: { id: Number(visit.serviceId), tenantId: Number(tenantId) },
      select: { id: true, name: true, basePrice: true },
    });
  }
  const consumptions = await client.serviceConsumption.findMany({
    where: { visitId: Number(visit.id), tenantId: Number(tenantId) },
    select: {
      productName: true,
      qty: true,
      unitCost: true,
      usageValue: true,
      salePrice: true,
      productId: true,
      drugId: true,
      unit: true,
      productCode: true,
      transactionType: true,
      sourceType: true,
      prescriptionId: true,
      prescriptionLine: true,
    },
    orderBy: { id: "asc" },
  });
  return buildVisitInvoiceLineItems({
    visit,
    service,
    consumptions,
    serviceAmount,
  });
}

/**
 * Resolve the minimum bill that must be collected for a visit. The stored
 * amount remains the floor so staff-entered charges are not reduced, while
 * service price plus current inventory usage prevents consumables from being
 * omitted when a payment link is generated later.
 */
async function getVisitTotalAmount({ visit, tenantId, client = prisma }) {
  let servicePrice = Number(visit?.service?.basePrice) || 0;
  if (!servicePrice && visit?.serviceId && client?.service?.findFirst) {
    const service = await client.service.findFirst({
      where: { id: Number(visit.serviceId), tenantId: Number(tenantId) },
      select: { basePrice: true },
    });
    servicePrice = Number(service?.basePrice) || 0;
  }
  const inventoryTotal = await getVisitInventoryTotal({
    visitId: visit?.id,
    tenantId,
    client,
  });
  const storedAmount = Number(visit?.amountCharged) || 0;
  const baseAmount = resolveServiceAmount({
    visit,
    servicePrice,
    inventoryTotal,
    storedAmount,
  });
  return {
    total: roundMoney(Math.max(storedAmount, baseAmount + inventoryTotal)),
    baseAmount,
    servicePrice: roundMoney(servicePrice),
    inventoryTotal,
  };
}

module.exports = {
  SOURCE_TYPES,
  roundMoney,
  normalizeInventoryUnit,
  usagePricing,
  buildPrescriptionConsumptionData,
  syncPrescriptionConsumption,
  enrichConsumptionRow,
  resolveServiceAmount,
  buildVisitInvoiceLineItems,
  getVisitInvoiceLineItems,
  getVisitInventoryTotal,
  getVisitTotalAmount,
};
