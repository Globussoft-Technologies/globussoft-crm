// Persistent Tally master records for the travel vertical.
// This phase prepares accounting masters locally; live Tally connectivity is
// intentionally deferred to a later phase.

const prisma = require("./prisma");

const DEFAULT_LEDGER_GROUPS = {
  CUSTOMER: "Sundry Debtors",
  SUPPLIER: "Sundry Creditors",
  SALES: "Sales Accounts",
  PURCHASE: "Purchase Accounts",
  EXPENSE: "Indirect Expenses",
  BANK: "Bank Accounts",
  CASH: "Cash-in-Hand",
  GST: "Duties & Taxes",
  TCS: "Duties & Taxes",
  TRIP: "Current Assets",
};

// These ledgers are shown in the Tally UI as built-in ledgers, but mappings
// are persisted against TravelTallyLedger.id. Keep one database record for
// each built-in ledger so every mapping screen uses the same master list.
const SYSTEM_LEDGER_DEFINITIONS = [
  { key: "sales", name: "Sales Ledger", category: "SALES", group: "Sales Accounts" },
  { key: "purchase", name: "Purchase Ledger", category: "PURCHASE", group: "Purchase Accounts" },
  { key: "outputGst", name: "GST/TCS Ledger", category: "GST", group: "Duties & Taxes" },
  { key: "bank", name: "Bank Ledger", category: "BANK", group: "Bank Accounts" },
  { key: "cash", name: "Cash Ledger", category: "CASH", group: "Cash-in-hand" },
  { key: "officeExpenses", name: "Office Expenses Ledger", category: "EXPENSE", group: "Indirect Expenses" },
  { key: "tripwise", name: "Trip-wise Ledger", category: "TRIP", group: "Current Assets" },
];

const clean = (value, fallback = "") => String(value ?? fallback).trim();

function sourceKey(sourceType, sourceId) {
  return `${clean(sourceType).toUpperCase()}:${clean(sourceId)}`;
}

async function ensureLedger({
  prismaClient = prisma,
  tenantId,
  subBrand = null,
  sourceType,
  sourceId,
  ledgerName,
  ledgerCategory,
  ledgerGroup,
  description = null,
}) {
  const normalizedType = clean(sourceType).toUpperCase();
  const normalizedSourceId = clean(sourceId);
  const normalizedName = clean(ledgerName);
  if (!tenantId || !normalizedType || !normalizedSourceId || !normalizedName) {
    throw new Error("tenantId, sourceType, sourceId, and ledgerName are required");
  }

  const key = sourceKey(normalizedType, normalizedSourceId);
  if (!prismaClient.travelTallyLedger) return null;
  const existing = await prismaClient.travelTallyLedger.findUnique({
    where: { tenantId_subBrand_sourceKey: { tenantId, subBrand, sourceKey: key } },
  });
  if (existing) return existing;

  return prismaClient.travelTallyLedger.create({
    data: {
      tenantId,
      subBrand,
      sourceType: normalizedType,
      sourceKey: key,
      ledgerName: normalizedName,
      ledgerCategory: clean(ledgerCategory, "OTHER").toUpperCase(),
      ledgerGroup: clean(ledgerGroup, DEFAULT_LEDGER_GROUPS[normalizedType] || "Current Liabilities"),
      description: description ? clean(description) : null,
      status: "ACTIVE",
      syncStatus: "NOT_CONNECTED",
    },
  });
}

async function ensureMapping({ prismaClient = prisma, tenantId, subBrand, sourceType, sourceKey: rawSourceKey, transactionType, tallyLedgerId }) {
  if (!prismaClient.travelTallyMapping || !tallyLedgerId) return null;
  const mappingData = {
    tenantId,
    subBrand: subBrand || null,
    sourceType: clean(sourceType).toUpperCase(),
    sourceKey: clean(rawSourceKey),
    transactionType: clean(transactionType).toUpperCase(),
  };
  // Prisma cannot use nullable fields in a compound unique `upsert` selector.
  // A null sub-brand means "all sub-brands", so resolve it with findFirst and
  // update/create instead of passing null into the generated unique input.
  const existing = await prismaClient.travelTallyMapping.findFirst({ where: mappingData });
  if (existing) {
    return prismaClient.travelTallyMapping.update({
      where: { id: existing.id },
      data: { tallyLedgerId, status: "ACTIVE" },
    });
  }
  return prismaClient.travelTallyMapping.create({
    data: { ...mappingData, tallyLedgerId, status: "ACTIVE" },
  });
}

async function ensureDefaultMapping(options) {
  const { prismaClient = prisma, tenantId, subBrand, sourceType, sourceKey: rawSourceKey, transactionType, tallyLedgerId } = options;
  if (!prismaClient.travelTallyMapping || !tallyLedgerId) return null;
  const existing = await prismaClient.travelTallyMapping.findFirst({
    where: {
      tenantId,
      subBrand: subBrand || null,
      sourceType: clean(sourceType).toUpperCase(),
      sourceKey: clean(rawSourceKey),
      transactionType: clean(transactionType).toUpperCase(),
    },
  });
  if (existing) return existing;
  return ensureMapping(options);
}

async function ensureSystemLedgers({ prismaClient = prisma, tenantId }) {
  const ledgers = await Promise.all(SYSTEM_LEDGER_DEFINITIONS.map((definition) => ensureLedger({
    prismaClient,
    tenantId,
    subBrand: null,
    sourceType: "SYSTEM",
    sourceId: definition.key,
    ledgerName: definition.name,
    ledgerCategory: definition.category,
    ledgerGroup: definition.group,
    description: "Built-in Tally ledger",
  })));

  // Seed the safe default voucher mappings for existing and new tenants.
  // Existing operator overrides are preserved, while an unmapped voucher
  // receives its standard system ledger.
  const byKey = Object.fromEntries(ledgers.map((ledger) => [
    SYSTEM_LEDGER_DEFINITIONS.find((definition) => definition.name === ledger.ledgerName)?.key,
    ledger,
  ]));
  const voucherDefaults = {
    SALES: "sales",
    PURCHASE: "purchase",
    RECEIPT: "bank",
    PAYMENT: "bank",
    JOURNAL: "tripwise",
    "CREDIT NOTE": "sales",
    "DEBIT NOTE": "sales",
  };
  await Promise.all(Object.entries(voucherDefaults).map(([voucher, ledgerKey]) =>
    ensureDefaultMapping({
      prismaClient,
      tenantId,
      subBrand: null,
      sourceType: "VOUCHER",
      sourceKey: sourceKey("VOUCHER", voucher),
      transactionType: voucher,
      tallyLedgerId: byKey[ledgerKey]?.id,
    }),
  ));
  const paymentDefaults = {
    CASH: "cash",
    BANK: "bank",
    UPI: "bank",
    NEFT: "bank",
    RTGS: "bank",
    IMPS: "bank",
    CARD: "bank",
    "PAYMENT GATEWAY": "bank",
    RAZORPAY: "bank",
    STRIPE: "bank",
    MANUAL: "bank",
  };
  await Promise.all(Object.entries(paymentDefaults).map(([method, ledgerKey]) =>
    ensureDefaultMapping({
      prismaClient,
      tenantId,
      subBrand: null,
      sourceType: "PAYMENT",
      sourceKey: sourceKey("PAYMENT", method),
      transactionType: "PAYMENT",
      tallyLedgerId: byKey[ledgerKey]?.id,
    }),
  ));
  return ledgers;
}

async function ensurePartyLedger({ prismaClient = prisma, tenantId, subBrand, partyType, partyId, name }) {
  const category = clean(partyType).toUpperCase();
  const ledger = await ensureLedger({
    prismaClient,
    tenantId,
    subBrand,
    sourceType: category,
    sourceId: partyId,
    ledgerName: name,
    ledgerCategory: category,
    ledgerGroup: DEFAULT_LEDGER_GROUPS[category],
    description: `${category} ledger created from the website master`,
  });
  if (ledger) {
    const key = sourceKey(category, partyId);
    await ensureMapping({ prismaClient, tenantId, subBrand, sourceType: category, sourceKey: key, transactionType: category === "CUSTOMER" ? "SALES" : "PURCHASE", tallyLedgerId: ledger.id });
  }
  return ledger;
}

async function ensureServiceLedgers({ prismaClient = prisma, tenantId, subBrand, serviceType }) {
  const normalized = clean(serviceType, "other");
  const slug = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
  const label = normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
  const [sales, purchase] = await Promise.all([
    ensureLedger({
      prismaClient, tenantId, subBrand, sourceType: "SERVICE_SALES", sourceId: slug,
      ledgerName: `${label} Sales`, ledgerCategory: "SALES", ledgerGroup: DEFAULT_LEDGER_GROUPS.SALES,
    }),
    ensureLedger({
      prismaClient, tenantId, subBrand, sourceType: "SERVICE_PURCHASE", sourceId: slug,
      ledgerName: `${label} Purchase`, ledgerCategory: "PURCHASE", ledgerGroup: DEFAULT_LEDGER_GROUPS.PURCHASE,
    }),
  ]);
  await ensureMapping({ prismaClient, tenantId, subBrand, sourceType: "SERVICE", sourceKey: sourceKey("SERVICE", slug), transactionType: "SALES", tallyLedgerId: sales?.id });
  await ensureMapping({ prismaClient, tenantId, subBrand, sourceType: "SERVICE", sourceKey: sourceKey("SERVICE", slug), transactionType: "PURCHASE", tallyLedgerId: purchase?.id });
  return { sales, purchase };
}

async function ensureTripMasters({ prismaClient = prisma, tenantId, subBrand, itinerary, contactName }) {
  const customer = itinerary.contactId && contactName
    ? await ensurePartyLedger({
      prismaClient, tenantId, subBrand, partyType: "CUSTOMER",
      partyId: itinerary.contactId, name: contactName,
    })
    : null;

  const serviceTypes = new Set((itinerary.items || []).map((item) => item.itemType).filter(Boolean));
  const services = [];
  for (const serviceType of serviceTypes) {
    services.push(await ensureServiceLedgers({ prismaClient, tenantId, subBrand, serviceType }));
  }
  return { customer, services };
}

async function ensureCostCentre({ prismaClient = prisma, tenantId, itineraryId, tripCode, destination }) {
  if (!prismaClient.travelTallyCostCentre) return null;
  const code = `TRIP-${itineraryId}`;
  return prismaClient.travelTallyCostCentre.upsert({
    where: { itineraryId },
    update: { name: `${tripCode || code} - ${destination || "Trip"}`, status: "ACTIVE" },
    create: { tenantId, itineraryId, code, name: `${tripCode || code} - ${destination || "Trip"}`, status: "ACTIVE", syncStatus: "NOT_CONNECTED" },
  });
}

async function enqueueTransaction({
  prismaClient = prisma,
  tenantId,
  subBrand = null,
  sourceType,
  sourceId,
  reference,
  transactionType,
  tripId = null,
  partyName = null,
  amount = 0,
  voucherType,
  payload = {},
  mappingStatus = "READY",
}) {
  if (!prismaClient.travelTallySyncQueue) return null;
  return prismaClient.travelTallySyncQueue.upsert({
    where: {
      tenantId_sourceType_sourceId_transactionType: {
        tenantId,
        sourceType: clean(sourceType).toUpperCase(),
        sourceId: Number(sourceId),
        transactionType: clean(transactionType).toUpperCase(),
      },
    },
    update: {
      reference: clean(reference),
      tripId: tripId == null ? null : Number(tripId),
      partyName: partyName ? clean(partyName) : null,
      amount: Number(amount) || 0,
      voucherType: clean(voucherType, transactionType),
      mappingStatus: clean(mappingStatus, "READY").toUpperCase(),
      payloadJson: JSON.stringify(payload || {}),
      status: "PENDING",
      lastError: null,
    },
    create: {
      tenantId,
      subBrand,
      sourceType: clean(sourceType).toUpperCase(),
      sourceId: Number(sourceId),
      reference: clean(reference),
      transactionType: clean(transactionType).toUpperCase(),
      tripId: tripId == null ? null : Number(tripId),
      partyName: partyName ? clean(partyName) : null,
      amount: Number(amount) || 0,
      voucherType: clean(voucherType, transactionType),
      mappingStatus: clean(mappingStatus, "READY").toUpperCase(),
      status: "PENDING",
      payloadJson: JSON.stringify(payload || {}),
    },
  });
}

function buildVoucherLines({ transactionType, partyName, amount, debitLedger, creditLedger }) {
  const value = Number(amount) || 0;
  const party = partyName || "Party Ledger";
  const type = clean(transactionType).toUpperCase();
  if (type === "SALES") return [{ ledger: party, debit: value, credit: 0 }, { ledger: creditLedger || "Sales Ledger", debit: 0, credit: value }];
  if (type === "PURCHASE") return [{ ledger: debitLedger || "Purchase Ledger", debit: value, credit: 0 }, { ledger: party, debit: 0, credit: value }];
  if (type === "RECEIPT") return [{ ledger: debitLedger || "Bank / Cash Ledger", debit: value, credit: 0 }, { ledger: party, debit: 0, credit: value }];
  return [{ ledger: party, debit: value, credit: 0 }, { ledger: creditLedger || "Bank / Cash Ledger", debit: 0, credit: value }];
}

/**
 * Resolve the bill-wise leg for a receipt/payment.  The source transaction
 * owns the relationship (invoiceId/invoiceNum or payableId/poNumber); this
 * helper deliberately does not infer a bill from party name or amount.
 *
 * `billExists` is supplied by the route after a tenant-scoped database lookup.
 * When no reference was supplied, On Account remains the valid fallback.
 */
function resolveBillAllocation({ transactionType, billReference, billExists = false, amount = 0 }) {
  const type = clean(transactionType).toUpperCase();
  if (!["RECEIPT", "PAYMENT"].includes(type)) return null;
  const reference = clean(billReference);
  if (!reference) return { name: "On Account", billType: "On Account", amount: Number(amount) || 0, onAccount: true };
  if (!billExists) {
    const error = new Error(`Referenced ${type === "RECEIPT" ? "sales" : "purchase"} bill not found: ${reference}`);
    error.code = "TALLY_BILL_NOT_FOUND";
    throw error;
  }
  return { name: reference, billType: "Agst Ref", amount: Number(amount) || 0, onAccount: false };
}

module.exports = {
  DEFAULT_LEDGER_GROUPS,
  sourceKey,
  ensureLedger,
  ensureSystemLedgers,
  ensureMapping,
  ensurePartyLedger,
  ensureServiceLedgers,
  ensureTripMasters,
  ensureCostCentre,
  enqueueTransaction,
  buildVoucherLines,
  resolveBillAllocation,
};
