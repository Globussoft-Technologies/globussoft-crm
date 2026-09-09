// Travel CRM — Tally ledger data and tax preview.
//
// Endpoint:
//   GET /api/travel/tally/ledger
//
// The endpoint reads existing invoices, expenses, supplier payables, contacts,
// itineraries, and tax fields from Prisma. It applies the requested sub-brand,
// trip, and date filters, then returns accounting details for the Tally wizard.
// No invoice, expense, or tax record is created or modified by this route.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { computeTcs } = require("../lib/tcsCalculation");
const { fiscalYearStart } = require("../lib/travelFiscalYear");
const { getTenantSetting, setSetting } = require("../lib/tenantSettings");
const { requirePermission } = require("../middleware/requirePermission");
const { enqueueTransaction, ensureLedger, ensureSystemLedgers, ensureMapping, sourceKey, buildVoucherLines, resolveBillAllocation, ensureCostCentre } = require("../lib/travelTallyMasters");
const { writeAudit } = require("../lib/audit");

// Supported Travel CRM sub-brand identifiers.
const VALID_BRANDS = new Set(["tmc", "rfu", "travelstall", "visasure"]);
const VALID_LEDGER_PAYMENT_MODES = new Set([
  "cash",
  "upi",
  "neft",
  "manual",
]);
const BUILT_IN_LEDGER_GROUPS = [
  ["Sales Accounts", "INCOME"],
  ["Purchase Accounts", "EXPENSE"],
  ["Duties & Taxes", "LIABILITY"],
  ["Bank Accounts", "ASSET"],
  ["Cash-in-hand", "ASSET"],
  ["Indirect Expenses", "EXPENSE"],
  ["Current Assets", "ASSET"],
  ["Sundry Creditors", "LIABILITY"],
];
const BUILT_IN_GROUP_MEMBERS = {
  "Sales Accounts": ["Sales Ledger"],
  "Purchase Accounts": ["Purchase Ledger"],
  "Duties & Taxes": ["GST/TCS Ledger"],
  "Bank Accounts": ["Bank Ledger"],
  "Cash-in-hand": ["Cash Ledger"],
  "Indirect Expenses": ["Office Expenses Ledger"],
  "Current Assets": ["Trip-wise Ledger"],
};
const TALLY_BANK_DETAILS_KEY = "travel.tally.bank_details";
const TALLY_MASTER_DETAILS_KEY = "travel.tally.master_details";
const auditTally = (req, action, entityId, metadata = {}) =>
  writeAudit("TravelTally", action, entityId || 0, req.user.userId, req.travelTenant.id, metadata)
    .catch((error) => console.warn("[travel-tally] audit write failed:", error.message));

const emptyBankDetails = {
  bankName: "",
  accountName: "",
  accountNumber: "",
  ifscCode: "",
  branchName: "",
  upiId: "",
};

const normalizeBankDetails = (value) => ({
  ...emptyBankDetails,
  ...Object.fromEntries(
    Object.entries(value || {}).map(([key, entryValue]) => [
      key,
      entryValue == null ? "" : String(entryValue),
    ]),
  ),
});

const normalizeMasterDetails = (value) => ({
  companyName: String(value?.companyName || ""),
  mailingName: String(value?.mailingName || ""),
  gstin: String(value?.gstin || ""),
  pan: String(value?.pan || ""),
  state: String(value?.state || ""),
  address: String(value?.address || ""),
  country: String(value?.country || "India"),
  pinCode: String(value?.pinCode || ""),
  contactNumber: String(value?.contactNumber || ""),
  email: String(value?.email || ""),
  financialYear: String(value?.financialYear || ""),
  financialYearTo: String(value?.financialYearTo || ""),
  booksBeginningFrom: String(value?.booksBeginningFrom || ""),
  voucherNumbering: String(value?.voucherNumbering || "auto"),
  baseCurrency: String(value?.baseCurrency || "INR"),
  openingBalanceMode: String(value?.openingBalanceMode || "adjusted"),
  bankDetails: normalizeBankDetails(value?.bankDetails),
});

const tallyMasterWhere = (tenantId, subBrand) => ({
  tenantId,
  ...(subBrand && subBrand !== "all" ? { subBrand } : {}),
});

// Parse an inclusive date-range boundary for the ledger query.
const parseDate = (value, end = false) => {
  if (!value) return null;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Safely read JSON metadata stored on expense records.
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value || "");
  } catch (_) {
    return fallback;
  }
};

const quoteIdFromPayableNotes = (notes) => {
  const match = String(notes || "").match(/^QUOTE_ID:(\d+)(?:\r?\n|$)/);
  return match ? Number(match[1]) : null;
};

// Quote-sourced invoices do not always have an itineraryId. Derive the same
// human-readable trip label used by the quote flow from the quote's line items
// so every Tally ledger can still show the quote as its trip.
const quoteTripName = (quote) => {
  if (!quote?.id) return null;
  const lines = Array.isArray(quote.lines) ? quote.lines : [];
  const cities = [];
  for (const line of lines) {
    if (!["hotel", "accommodation"].includes(String(line.lineType || "").toLowerCase())) continue;
    const match = /,\s*([^—–-]+?)\s*(?:—|–|-|$)/.exec(String(line.description || ""));
    const city = match?.[1]?.trim();
    if (city && !cities.includes(city)) cities.push(city);
  }
  if (!cities.length) {
    for (const line of lines) {
      const match = /(?:→|->|â†’|->)\s*([A-Za-z .]+?)(?:\s*\(|\s*\[|$)/.exec(String(line.description || ""));
      const city = match?.[1]?.trim();
      if (city) { cities.push(city); break; }
    }
  }
  return cities.length ? cities.join(" · ") : `Quote #${quote.id}`;
};

// Only supplier purchases explicitly paid in physical cash belong to the Cash
// Ledger. Every other supported payment mode, including an unknown/missing
// legacy mode, belongs to the Bank Ledger.
const ledgerForPaymentMode = (paymentMode) =>
  String(paymentMode || "").trim().toLowerCase() === "cash"
    ? "cash"
    : "bank";

// Payments received uses successful Payment rows first, then scheduled
// milestone receipts. Paid legacy invoices without either source fall back to
// their total amount.
const receivedAmount = (invoice, paymentTotal = 0) => {
  const scheduled = (invoice.schedule || []).reduce(
    (sum, payment) => sum + Number(payment.receivedAmount || 0),
    0,
  );
  const total = Number(invoice.totalAmount || 0);
  const reconciled = Math.max(Number(paymentTotal || 0), scheduled);
  if (reconciled > 0) return total > 0 ? Math.min(reconciled, total) : reconciled;
  return invoice.status === "Paid" ? total : 0;
};

const receivedSource = (invoice, paymentTotal = 0) => {
  const scheduled = (invoice.schedule || []).reduce(
    (sum, payment) => sum + Number(payment.receivedAmount || 0),
    0,
  );
  if (paymentTotal > 0 || scheduled > 0) {
    return Number(paymentTotal || 0) >= scheduled ? "payment" : "scheduled";
  }
  return invoice.status === "Paid" ? "legacy-paid" : "none";
};

// Identify overseas trips for the automatic TCS preview. The destination is
// supplied by the existing itinerary record; this route does not create trips.
const isInternationalDestination = (destination) =>
  Boolean(
    destination &&
    !/\b(india|goa|delhi|mumbai|kerala|rajasthan|jaipur|hyderabad|chennai|bengaluru|bangalore|kolkata)\b/i.test(
      destination,
    ),
  );

router.get(
  "/tally/master-bank-details",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const raw = await getTenantSetting(
        prisma,
        req.travelTenant.id,
        TALLY_BANK_DETAILS_KEY,
        null,
      );
      let bankDetails = emptyBankDetails;
      if (raw) {
        try {
          bankDetails = normalizeBankDetails(JSON.parse(raw));
        } catch (_) {
          bankDetails = emptyBankDetails;
        }
      }
      res.json({ bankDetails });
    } catch (error) {
      console.error("[travel-tally] master bank details read failed:", error.message);
      res.status(500).json({
        error: "Failed to load master bank details",
        code: "TALLY_MASTER_BANK_ERROR",
      });
    }
  },
);

router.put(
  "/tally/master-bank-details",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const bankDetails = normalizeBankDetails(
        req.body?.bankDetails || req.body || {},
      );
      await setSetting(
        req.travelTenant.id,
        TALLY_BANK_DETAILS_KEY,
        JSON.stringify(bankDetails),
        { category: "travel" },
      );
      await auditTally(req, "UPDATE_BANK_DETAILS", 0, { fields: Object.keys(bankDetails) });
      res.json({ bankDetails });
    } catch (error) {
      console.error("[travel-tally] master bank details save failed:", error.message);
      res.status(500).json({
        error: "Failed to save master bank details",
        code: "TALLY_MASTER_BANK_ERROR",
      });
    }
  },
);

router.get(
  "/tally/master-details",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const raw = await getTenantSetting(
        prisma,
        req.travelTenant.id,
        TALLY_MASTER_DETAILS_KEY,
        null,
      );
      const masterDetails = raw ? normalizeMasterDetails(parseJson(raw, {})) : normalizeMasterDetails({});
      res.json({ masterDetails });
    } catch (error) {
      console.error("[travel-tally] master details read failed:", error.message);
      res.status(500).json({
        error: "Failed to load master details",
        code: "TALLY_MASTER_ERROR",
      });
    }
  },
);

router.put(
  "/tally/master-details",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const masterDetails = normalizeMasterDetails(req.body?.masterDetails || req.body || {});
      await setSetting(
        req.travelTenant.id,
        TALLY_MASTER_DETAILS_KEY,
        JSON.stringify(masterDetails),
        { category: "travel" },
      );
      await auditTally(req, "UPDATE_COMPANY_SETUP", 0, { fields: Object.keys(masterDetails) });
      res.json({ masterDetails });
    } catch (error) {
      console.error("[travel-tally] master details save failed:", error.message);
      res.status(500).json({
        error: "Failed to save master details",
        code: "TALLY_MASTER_ERROR",
      });
    }
  },
);

// Persistent local Tally masters. Live Tally sync is intentionally deferred.
router.get(
  "/tally/masters",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const subBrand = String(req.query.subBrand || "").trim();
      const where = { tenantId: req.travelTenant.id };
      if (subBrand && subBrand !== "all") where.subBrand = subBrand;
      const ledgers = await prisma.travelTallyLedger.findMany({
        where,
        include: { mappings: true },
        orderBy: [{ ledgerCategory: "asc" }, { ledgerName: "asc" }],
      });
      res.json({ ledgers });
    } catch (error) {
      console.error("[travel-tally] masters read failed:", error.message);
      res.status(500).json({ error: "Failed to load Tally masters", code: "TALLY_MASTERS_ERROR" });
    }
  },
);

router.post(
  "/tally/ledgers",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const body = req.body || {};
      const required = ["ledgerName", "ledgerCategory", "ledgerGroup", "sourceType", "sourceKey"];
      if (required.some((field) => !String(body[field] || "").trim())) {
        return res.status(400).json({ error: "ledgerName, ledgerCategory, ledgerGroup, sourceType, and sourceKey are required", code: "MISSING_FIELDS" });
      }
      const subBrand = body.subBrand ? String(body.subBrand).trim() : null;
      const ledgerName = String(body.ledgerName).trim();
      const openingBalance = body.openingBalance == null || body.openingBalance === "" ? 0 : Number(body.openingBalance);
      if (!Number.isFinite(openingBalance) || openingBalance < 0) return res.status(400).json({ error: "Opening balance must be a non-negative number", code: "INVALID_OPENING_BALANCE" });
      const openingBalanceType = String(body.openingBalanceType || "DEBIT").trim().toUpperCase();
      if (!["DEBIT", "CREDIT"].includes(openingBalanceType)) return res.status(400).json({ error: "Opening balance type must be DEBIT or CREDIT", code: "INVALID_OPENING_BALANCE_TYPE" });
      const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
      if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return res.status(400).json({ error: "effectiveFrom must be a valid date", code: "INVALID_EFFECTIVE_DATE" });
      const existingByName = await prisma.travelTallyLedger.findFirst({
        where: { tenantId: req.travelTenant.id, subBrand, ledgerName },
      });
      if (existingByName) {
        return res.status(409).json({
          error: `Ledger "${ledgerName}" already exists`,
          code: "DUPLICATE_TALLY_LEDGER",
          existingLedger: existingByName,
          useExisting: true,
        });
      }
      const created = await prisma.travelTallyLedger.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          sourceType: String(body.sourceType).trim().toUpperCase(),
          sourceKey: String(body.sourceKey).trim(),
          ledgerName,
          ledgerCode: body.ledgerCode ? String(body.ledgerCode).trim() : null,
          ledgerCategory: String(body.ledgerCategory).trim().toUpperCase(),
          ledgerGroup: String(body.ledgerGroup).trim(),
          description: body.description ? String(body.description).trim() : null,
          openingBalance,
          openingBalanceType,
          gstApplicable: Boolean(body.gstApplicable),
          tcsApplicable: Boolean(body.tcsApplicable),
          tdsApplicable: Boolean(body.tdsApplicable),
          effectiveFrom,
        },
      });
      await auditTally(req, "CREATE_LEDGER", created.id, { ledgerName: created.ledgerName, ledgerCategory: created.ledgerCategory });
      res.status(201).json({ ledger: created });
    } catch (error) {
      if (error.code === "P2002") return res.status(409).json({ error: "This Tally ledger already exists", code: "DUPLICATE_TALLY_LEDGER" });
      console.error("[travel-tally] ledger create failed:", error.message);
      res.status(500).json({ error: "Failed to create Tally ledger", code: "TALLY_LEDGER_CREATE_ERROR" });
    }
  },
);

router.get("/tally/accounting-masters", verifyToken, requireTravelTenant, requirePermission("tally", "read"), async (req, res) => {
  try {
    // Mapping pages depend on the built-in ledgers being present in the
    // database. Create them lazily for existing tenants as well as new ones.
    await ensureSystemLedgers({ tenantId: req.travelTenant.id });
    const where = tallyMasterWhere(req.travelTenant.id, String(req.query.subBrand || "").trim());
    const [voucherTypes, paymentAccounts, taxMasters, ledgers] = await Promise.all([
      prisma.travelTallyVoucherType.findMany({ where, orderBy: { name: "asc" } }),
      prisma.travelTallyPaymentAccount.findMany({ where, include: { ledger: true }, orderBy: [{ mode: "asc" }, { accountName: "asc" }] }),
      prisma.travelTallyTaxMaster.findMany({ where, include: { ledger: true }, orderBy: [{ taxType: "asc" }, { taxName: "asc" }] }),
      prisma.travelTallyLedger.findMany({ where: { ...where, status: "ACTIVE" }, orderBy: { ledgerName: "asc" } }),
    ]);
    res.json({ voucherTypes, paymentAccounts, taxMasters, ledgers });
  } catch (error) {
    console.error("[travel-tally] accounting masters read failed:", error.message);
    res.status(500).json({ error: "Failed to load accounting masters", code: "TALLY_ACCOUNTING_MASTERS_ERROR" });
  }
});

router.get("/tally/ledger-groups", verifyToken, requireTravelTenant, requirePermission("tally", "read"), async (req, res) => {
  try {
    const where = tallyMasterWhere(req.travelTenant.id, String(req.query.subBrand || "").trim());
    const [groups, ledgers] = await Promise.all([
      prisma.travelTallyLedgerGroup.findMany({ where, orderBy: [{ nature: "asc" }, { groupName: "asc" }] }),
      prisma.travelTallyLedger.findMany({ where: { tenantId: req.travelTenant.id, ...(where.subBrand ? { subBrand: where.subBrand } : {}) }, select: { ledgerName: true, ledgerGroup: true } }),
    ]);
    const membersByGroup = new Map();
    ledgers.forEach((ledger) => {
      const members = membersByGroup.get(ledger.ledgerGroup) || [];
      members.push(ledger.ledgerName);
      membersByGroup.set(ledger.ledgerGroup, members);
    });
    const savedNames = new Set(groups.map((group) => group.groupName));
    const builtInGroups = BUILT_IN_LEDGER_GROUPS
      .filter(([groupName]) => !savedNames.has(groupName))
      .map(([groupName, nature]) => ({
        id: `system-${groupName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        tenantId: req.travelTenant.id,
        subBrand: null,
        groupName,
        parentGroup: null,
        nature,
        source: "SYSTEM",
        status: "ACTIVE",
        syncStatus: "NOT_CONNECTED",
        members: [...(BUILT_IN_GROUP_MEMBERS[groupName] || []), ...(membersByGroup.get(groupName) || [])],
      }));
    res.json({ groups: [...groups.map((group) => ({ ...group, members: [...(BUILT_IN_GROUP_MEMBERS[group.groupName] || []), ...(membersByGroup.get(group.groupName) || [])] })), ...builtInGroups] });
  } catch (error) {
    console.error("[travel-tally] ledger groups read failed:", error.message);
    res.status(500).json({ error: "Failed to load ledger groups", code: "TALLY_LEDGER_GROUPS_ERROR" });
  }
});

router.post("/tally/ledger-groups", verifyToken, requireTravelTenant, requirePermission("tally", "update"), async (req, res) => {
  try {
    const body = req.body || {};
    const groupName = String(body.groupName || "").trim();
    if (!groupName) return res.status(400).json({ error: "groupName is required", code: "MISSING_FIELDS" });
    const subBrand = body.subBrand ? String(body.subBrand).trim() : null;
    const groupData = {
      parentGroup: body.parentGroup ? String(body.parentGroup).trim() : null,
      nature: String(body.nature || "OTHER").trim().toUpperCase(),
      status: String(body.status || "ACTIVE").trim().toUpperCase(),
    };
    const existing = await prisma.travelTallyLedgerGroup.findFirst({ where: { tenantId: req.travelTenant.id, subBrand, groupName } });
    const row = existing
      ? await prisma.travelTallyLedgerGroup.update({ where: { id: existing.id }, data: groupData })
      : await prisma.travelTallyLedgerGroup.create({ data: { tenantId: req.travelTenant.id, subBrand, groupName, ...groupData, source: String(body.source || "USER").trim().toUpperCase() } });
    await auditTally(req, "UPSERT_LEDGER_GROUP", row.id, { groupName: row.groupName, nature: row.nature });
    res.status(201).json({ group: row });
  } catch (error) {
    console.error("[travel-tally] ledger group save failed:", error.message);
    res.status(500).json({ error: "Failed to save ledger group", code: "TALLY_LEDGER_GROUP_ERROR" });
  }
});

router.get("/tally/cost-centres", verifyToken, requireTravelTenant, requirePermission("tally", "read"), async (req, res) => {
  try {
    const rows = await prisma.travelTallyCostCentre.findMany({ where: { tenantId: req.travelTenant.id }, include: { itinerary: { select: { id: true, destination: true, subBrand: true } } }, orderBy: { createdAt: "desc" } });
    res.json({ costCentres: rows });
  } catch (error) {
    console.error("[travel-tally] cost centres read failed:", error.message);
    res.status(500).json({ error: "Failed to load cost centres", code: "TALLY_COST_CENTRES_ERROR" });
  }
});

router.post("/tally/cost-centres", verifyToken, requireTravelTenant, requirePermission("tally", "update"), async (req, res) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    if (!Number.isInteger(itineraryId) || itineraryId <= 0) return res.status(400).json({ error: "Valid itineraryId is required", code: "INVALID_ID" });
    const itinerary = await prisma.itinerary.findFirst({ where: { id: itineraryId, tenantId: req.travelTenant.id }, select: { id: true, destination: true, subBrand: true } });
    if (!itinerary) return res.status(404).json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
    const row = await ensureCostCentre({ tenantId: req.travelTenant.id, itineraryId, tripCode: `TRIP-${itinerary.id}`, destination: itinerary.destination });
    await auditTally(req, "UPSERT_COST_CENTRE", row.id, { itineraryId, destination: itinerary.destination });
    res.status(201).json({ costCentre: row });
  } catch (error) {
    console.error("[travel-tally] cost centre save failed:", error.message);
    res.status(500).json({ error: "Failed to save cost centre", code: "TALLY_COST_CENTRE_ERROR" });
  }
});

router.post("/tally/voucher-types", verifyToken, requireTravelTenant, requirePermission("tally", "update"), async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required", code: "MISSING_FIELDS" });
    const subBrand = body.subBrand ? String(body.subBrand).trim() : null;
    const values = { numberingMode: String(body.numberingMode || "AUTO"), prefix: body.prefix ? String(body.prefix).trim() : null, status: String(body.status || "ACTIVE") };
    let row;
    if (Number.isInteger(Number(body.id)) && Number(body.id) > 0) {
      const updated = await prisma.travelTallyVoucherType.updateMany({ where: { id: Number(body.id), tenantId: req.travelTenant.id }, data: { name, ...values } });
      if (!updated.count) return res.status(404).json({ error: "Voucher type not found", code: "NOT_FOUND" });
      row = await prisma.travelTallyVoucherType.findUnique({ where: { id: Number(body.id) } });
    } else {
      const existing = await prisma.travelTallyVoucherType.findFirst({ where: { tenantId: req.travelTenant.id, subBrand, name } });
      row = existing ? await prisma.travelTallyVoucherType.update({ where: { id: existing.id }, data: values }) : await prisma.travelTallyVoucherType.create({ data: { tenantId: req.travelTenant.id, subBrand, name, ...values } });
    }
    await auditTally(req, "UPSERT_VOUCHER_TYPE", row.id, { name: row.name });
    res.status(201).json(row);
  } catch (error) {
    console.error("[travel-tally] voucher type save failed:", error.message);
    res.status(500).json({ error: "Failed to save voucher type", code: "TALLY_VOUCHER_TYPE_ERROR" });
  }
});

router.post("/tally/payment-accounts", verifyToken, requireTravelTenant, requirePermission("tally", "update"), async (req, res) => {
  try {
    const body = req.body || {};
    const mode = String(body.mode || "").trim();
    const accountName = String(body.accountName || "").trim();
    if (!mode || !accountName) return res.status(400).json({ error: "mode and accountName are required", code: "MISSING_FIELDS" });
    const ledgerId = body.ledgerId == null || body.ledgerId === "" ? null : Number(body.ledgerId);
    const row = await prisma.travelTallyPaymentAccount.upsert({
      where: { tenantId_subBrand_mode_accountName: { tenantId: req.travelTenant.id, subBrand: body.subBrand || null, mode, accountName } },
      update: { ledgerId, status: String(body.status || "ACTIVE") },
      create: { tenantId: req.travelTenant.id, subBrand: body.subBrand || null, mode, accountName, ledgerId, status: String(body.status || "ACTIVE") },
      include: { ledger: true },
    });
    await auditTally(req, "UPSERT_PAYMENT_ACCOUNT", row.id, { mode: row.mode, accountName: row.accountName });
    res.status(201).json(row);
  } catch (error) {
    console.error("[travel-tally] payment account save failed:", error.message);
    res.status(500).json({ error: "Failed to save payment account", code: "TALLY_PAYMENT_ACCOUNT_ERROR" });
  }
});

router.post("/tally/tax-masters", verifyToken, requireTravelTenant, requirePermission("tally", "update"), async (req, res) => {
  try {
    const body = req.body || {};
    const taxName = String(body.taxName || "").trim();
    const taxType = String(body.taxType || "").trim().toUpperCase();
    const rate = Number(body.rate);
    if (!taxName || !taxType || !Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "taxName, taxType, and a valid rate are required", code: "MISSING_FIELDS" });
    const ledgerId = body.ledgerId == null || body.ledgerId === "" ? null : Number(body.ledgerId);
    const row = await prisma.travelTallyTaxMaster.upsert({
      where: { tenantId_subBrand_taxName_taxType: { tenantId: req.travelTenant.id, subBrand: body.subBrand || null, taxName, taxType } },
      update: { ledgerId, rate, calculationBasis: String(body.calculationBasis || "TAXABLE_VALUE"), applicability: body.applicability ? String(body.applicability) : null, status: String(body.status || "ACTIVE") },
      create: { tenantId: req.travelTenant.id, subBrand: body.subBrand || null, taxName, taxType, ledgerId, rate, calculationBasis: String(body.calculationBasis || "TAXABLE_VALUE"), applicability: body.applicability ? String(body.applicability) : null, status: String(body.status || "ACTIVE") },
      include: { ledger: true },
    });
    await auditTally(req, "UPSERT_TAX_MASTER", row.id, { taxName: row.taxName, taxType: row.taxType });
    res.status(201).json(row);
  } catch (error) {
    console.error("[travel-tally] tax master save failed:", error.message);
    res.status(500).json({ error: "Failed to save tax master", code: "TALLY_TAX_MASTER_ERROR" });
  }
});

router.put(
  "/tally/ledgers/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid ledger id", code: "INVALID_ID" });
      const existing = await prisma.travelTallyLedger.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      if (!existing) return res.status(404).json({ error: "Tally ledger not found", code: "NOT_FOUND" });
      const body = req.body || {};
      const data = {};
      ["ledgerName", "ledgerCode", "ledgerCategory", "ledgerGroup", "description", "status", "syncStatus", "openingBalanceType"].forEach((field) => {
        if (body[field] !== undefined) data[field] = body[field] == null ? null : String(body[field]).trim();
      });
      if (body.openingBalance !== undefined) {
        const openingBalance = body.openingBalance === "" || body.openingBalance == null ? 0 : Number(body.openingBalance);
        if (!Number.isFinite(openingBalance) || openingBalance < 0) return res.status(400).json({ error: "Opening balance must be a non-negative number", code: "INVALID_OPENING_BALANCE" });
        data.openingBalance = openingBalance;
      }
      if (body.effectiveFrom !== undefined) {
        const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
        if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) return res.status(400).json({ error: "effectiveFrom must be a valid date", code: "INVALID_EFFECTIVE_DATE" });
        data.effectiveFrom = effectiveFrom;
      }
      if (body.gstApplicable !== undefined) data.gstApplicable = Boolean(body.gstApplicable);
      if (body.tcsApplicable !== undefined) data.tcsApplicable = Boolean(body.tcsApplicable);
      if (body.tdsApplicable !== undefined) data.tdsApplicable = Boolean(body.tdsApplicable);
      const updated = await prisma.travelTallyLedger.update({ where: { id }, data });
      await auditTally(req, "UPDATE_LEDGER", updated.id, { fields: Object.keys(data) });
      res.json({ ledger: updated });
    } catch (error) {
      console.error("[travel-tally] ledger update failed:", error.message);
      res.status(500).json({ error: "Failed to update Tally ledger", code: "TALLY_LEDGER_UPDATE_ERROR" });
    }
  },
);

router.delete(
  "/tally/ledgers/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid ledger id", code: "INVALID_ID" });
      const existing = await prisma.travelTallyLedger.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      if (!existing) return res.status(404).json({ error: "Tally ledger not found", code: "NOT_FOUND" });
      await prisma.$transaction([
        prisma.travelTallyMapping.deleteMany({ where: { tenantId: req.travelTenant.id, tallyLedgerId: id } }),
        prisma.travelTallyPaymentAccount.updateMany({ where: { tenantId: req.travelTenant.id, ledgerId: id }, data: { ledgerId: null } }),
        prisma.travelTallyTaxMaster.updateMany({ where: { tenantId: req.travelTenant.id, ledgerId: id }, data: { ledgerId: null } }),
        prisma.travelTallyLedger.delete({ where: { id } }),
      ]);
      await auditTally(req, "DELETE_LEDGER", id, { ledgerName: existing.ledgerName });
      res.json({ deleted: true, id });
    } catch (error) {
      console.error("[travel-tally] ledger delete failed:", error.message);
      res.status(500).json({ error: "Failed to delete Tally ledger", code: "TALLY_LEDGER_DELETE_ERROR" });
    }
  },
);

router.get(
  "/tally/mappings",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      const subBrand = String(req.query.subBrand || "").trim();
      if (subBrand && subBrand !== "all") where.subBrand = subBrand;
      const mappings = await prisma.travelTallyMapping.findMany({
        where,
        include: { tallyLedger: true },
        orderBy: { sourceKey: "asc" },
      });
      res.json({ mappings });
    } catch (error) {
      console.error("[travel-tally] mappings read failed:", error.message);
      res.status(500).json({ error: "Failed to load Tally mappings", code: "TALLY_MAPPINGS_ERROR" });
    }
  },
);

router.post(
  "/tally/mappings",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const body = req.body || {};
      const sourceType = String(body.sourceType || "").trim().toUpperCase();
      const sourceKey = String(body.sourceKey || "").trim();
      const transactionType = String(body.transactionType || "").trim().toUpperCase();
      const tallyLedgerId = Number(body.tallyLedgerId);
      if (!sourceType || !sourceKey || !transactionType || !Number.isInteger(tallyLedgerId) || tallyLedgerId <= 0) {
        return res.status(400).json({ error: "sourceType, sourceKey, transactionType, and a valid ledger are required", code: "MISSING_FIELDS" });
      }
      const ledger = await prisma.travelTallyLedger.findFirst({ where: { id: tallyLedgerId, tenantId: req.travelTenant.id } });
      if (!ledger) return res.status(404).json({ error: "Tally ledger not found", code: "LEDGER_NOT_FOUND" });
      const subBrand = body.subBrand ? String(body.subBrand).trim() : null;
      const mappingKey = { tenantId: req.travelTenant.id, subBrand, sourceType, sourceKey, transactionType };
      // `subBrand` is nullable for mappings shared by all sub-brands. Prisma
      // rejects null in the generated compound-unique upsert input, so use a
      // null-safe lookup before updating or creating the mapping.
      const existing = await prisma.travelTallyMapping.findFirst({ where: mappingKey });
      const mapping = existing
        ? await prisma.travelTallyMapping.update({
          where: { id: existing.id },
          data: { tallyLedgerId, status: "ACTIVE" },
          include: { tallyLedger: true },
        })
        : await prisma.travelTallyMapping.create({
          data: { ...mappingKey, tallyLedgerId, status: "ACTIVE" },
          include: { tallyLedger: true },
        });
      await auditTally(req, "UPSERT_MAPPING", mapping.id, { sourceType, sourceKey, transactionType, tallyLedgerId });
      res.status(201).json({ mapping });
    } catch (error) {
      console.error("[travel-tally] mapping create failed:", error.message);
      res.status(500).json({ error: "Failed to save Tally mapping", code: "TALLY_MAPPING_CREATE_ERROR" });
    }
  },
);

// Service sources come from itinerary data, so new service types require no code change.
router.get("/tally/mapping-sources", verifyToken, requireTravelTenant, requirePermission("tally", "read"), async (req, res) => {
  try {
    const rows = await prisma.itineraryItem.findMany({
      where: { itinerary: { tenantId: req.travelTenant.id } },
      select: { itemType: true },
      distinct: ["itemType"],
      orderBy: { itemType: "asc" },
    });
    res.json({ services: rows.map((row) => row.itemType).filter(Boolean) });
  } catch (error) {
    console.error("[travel-tally] mapping sources read failed:", error.message);
    res.status(500).json({ error: "Failed to load mapping sources", code: "TALLY_MAPPING_SOURCES_ERROR" });
  }
});

router.put(
  "/tally/mappings/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const ledgerId = Number(req.body?.tallyLedgerId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(ledgerId) || ledgerId <= 0) {
        return res.status(400).json({ error: "Valid mapping and ledger ids are required", code: "INVALID_ID" });
      }
      const mapping = await prisma.travelTallyMapping.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      const ledger = await prisma.travelTallyLedger.findFirst({ where: { id: ledgerId, tenantId: req.travelTenant.id } });
      if (!mapping || !ledger) return res.status(404).json({ error: "Mapping or ledger not found", code: "NOT_FOUND" });
      const updated = await prisma.travelTallyMapping.update({ where: { id }, data: { tallyLedgerId: ledgerId, status: "ACTIVE" }, include: { tallyLedger: true } });
      await auditTally(req, "UPDATE_MAPPING", updated.id, { tallyLedgerId: ledgerId });
      res.json({ mapping: updated });
    } catch (error) {
      console.error("[travel-tally] mapping update failed:", error.message);
      res.status(500).json({ error: "Failed to update Tally mapping", code: "TALLY_MAPPING_UPDATE_ERROR" });
    }
  },
);

// Prepare website transactions for accounting review. This creates or
// refreshes durable queue rows; it never contacts Tally.
router.post(
  "/tally/sync-queue/prepare",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const subBrand = String(req.body?.subBrand || "").trim();
      const invoiceWhere = { tenantId: req.travelTenant.id, status: { not: "Voided" } };
      if (subBrand && subBrand !== "all") invoiceWhere.subBrand = subBrand;
      const invoices = await prisma.travelInvoice.findMany({
        where: invoiceWhere,
        select: { id: true, invoiceNum: true, subBrand: true, contactId: true, itineraryId: true, totalAmount: true, currency: true, status: true, createdAt: true, cgstAmount: true, sgstAmount: true, igstAmount: true, tcsAmount: true },
        orderBy: { createdAt: "asc" },
      });
      const payableWhere = { tenantId: req.travelTenant.id, status: { not: "cancelled" } };
      if (subBrand && subBrand !== "all") payableWhere.supplier = { subBrand };
      const payables = await prisma.travelSupplierPayable.findMany({
        where: payableWhere,
        include: { supplier: { select: { name: true, subBrand: true } } },
        orderBy: { createdAt: "asc" },
      });
      const salaryRows = await prisma.commissionData.findMany({
        where: { tenantId: req.travelTenant.id },
        select: { id: true, employeeName: true, periodStart: true, periodEnd: true, commission: true, totalSales: true },
        orderBy: { periodStart: "asc" },
      });
      const genericPayments = await prisma.payment.findMany({
        where: { tenantId: req.travelTenant.id, status: "SUCCESS", metadata: { contains: "travel" } },
        select: { id: true, amount: true, currency: true, gateway: true, gatewayId: true, paidAt: true, metadata: true },
        orderBy: { paidAt: "asc" },
      });
      const prepared = [];
      for (const invoice of invoices) {
        prepared.push(await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: invoice.subBrand,
          sourceType: "TRAVEL_INVOICE",
          sourceId: invoice.id,
          reference: invoice.invoiceNum,
          transactionType: "SALES",
          tripId: invoice.itineraryId,
          partyName: `Customer #${invoice.contactId}`,
          amount: invoice.totalAmount,
          voucherType: "SALES",
          payload: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNum, contactId: invoice.contactId, totalAmount: Number(invoice.totalAmount || 0), taxableAmount: Number(invoice.totalAmount || 0) - Number(invoice.cgstAmount || 0) - Number(invoice.sgstAmount || 0) - Number(invoice.igstAmount || 0) - Number(invoice.tcsAmount || 0), cgstAmount: Number(invoice.cgstAmount || 0), sgstAmount: Number(invoice.sgstAmount || 0), igstAmount: Number(invoice.igstAmount || 0), tcsAmount: Number(invoice.tcsAmount || 0), currency: invoice.currency, status: invoice.status },
        }));
      }
      for (const payable of payables) {
        prepared.push(await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: payable.supplier?.subBrand || null,
          sourceType: "SUPPLIER_PAYABLE",
          sourceId: payable.id,
          reference: payable.poNumber || `PAYABLE-${payable.id}`,
          transactionType: "PURCHASE",
          tripId: payable.itineraryId,
          partyName: payable.supplier?.name || `Supplier #${payable.supplierId}`,
          amount: payable.amount,
          voucherType: "PURCHASE",
          payload: { payableId: payable.id, supplierId: payable.supplierId, description: payable.description, amount: Number(payable.amount || 0), currency: payable.currency, status: payable.status },
        }));
      }
      for (const salary of salaryRows) {
        prepared.push(await enqueueTransaction({
          tenantId: req.travelTenant.id,
          sourceType: "SALARY_INCENTIVE",
          sourceId: salary.id,
          reference: `SAL-${salary.id}`,
          transactionType: "SALARY",
          partyName: salary.employeeName,
          amount: salary.commission,
          voucherType: "PAYMENT",
          payload: { commissionId: salary.id, employeeName: salary.employeeName, periodStart: salary.periodStart, periodEnd: salary.periodEnd, incentive: Number(salary.commission || 0), totalSales: Number(salary.totalSales || 0) },
        }));
      }
      for (const payment of genericPayments) {
        prepared.push(await enqueueTransaction({
          tenantId: req.travelTenant.id,
          sourceType: "TRAVEL_PAYMENT",
          sourceId: payment.id,
          reference: payment.gatewayId || `PAY-${payment.id}`,
          transactionType: "RECEIPT",
          partyName: "Travel customer",
          amount: payment.amount,
          voucherType: "RECEIPT",
          payload: { paymentId: payment.id, amount: Number(payment.amount || 0), currency: payment.currency, method: payment.gateway, reference: payment.gatewayId, paidAt: payment.paidAt },
        }));
      }
      await auditTally(req, "PREPARE_SYNC_QUEUE", 0, { prepared: prepared.filter(Boolean).length, invoices: invoices.length, payables: payables.length, salaryRows: salaryRows.length, genericPayments: genericPayments.length });
      res.json({ prepared: prepared.filter(Boolean).length, invoices: invoices.length, payables: payables.length, salaryRows: salaryRows.length, genericPayments: genericPayments.length, connection: "DEFERRED" });
    } catch (error) {
      console.error("[travel-tally] queue preparation failed:", error.message);
      res.status(500).json({ error: "Failed to prepare Tally transactions", code: "TALLY_QUEUE_PREPARE_ERROR" });
    }
  },
);

router.post(
  "/tally/sync-queue/validate",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const rows = await prisma.travelTallySyncQueue.findMany({ where: { tenantId: req.travelTenant.id, status: { notIn: ["SYNCED", "CANCELLED"] } }, take: 500 });
      let ready = 0;
      let mappingRequired = 0;
      for (const row of rows) {
        let payload = {};
        try { payload = JSON.parse(row.payloadJson || "{}"); } catch (_) { payload = {}; }
        const isCustomer = row.sourceType === "TRAVEL_INVOICE" || row.sourceType === "TRAVEL_INVOICE_PAYMENT";
        const isSupplier = row.sourceType === "SUPPLIER_PAYABLE" || row.sourceType === "SUPPLIER_PAYABLE_PAYMENT";
        const sourceType = isCustomer ? "CUSTOMER" : isSupplier ? "SUPPLIER" : ["OFFICE_EXPENSE", "TRIP_EXPENSE"].includes(row.sourceType) ? "EXPENSE" : row.sourceType === "SALARY_INCENTIVE" ? "SALARY" : "PAYMENT";
        const sourceId = isCustomer ? payload.contactId || payload.invoiceId : isSupplier ? payload.supplierId || payload.payableId : sourceType === "EXPENSE" ? payload.category || row.partyName : row.sourceId;
        const requiredMappings = [];
        if (sourceType !== "PAYMENT") requiredMappings.push({ sourceType, sourceKey: sourceKey(sourceType, sourceId), transactionType: row.sourceType === "TRAVEL_INVOICE_PAYMENT" ? "SALES" : row.sourceType === "SUPPLIER_PAYABLE_PAYMENT" ? "PURCHASE" : row.transactionType });
        if (["RECEIPT", "PAYMENT"].includes(row.transactionType)) {
          const paymentKey = payload.paymentMode || payload.method || "BANK";
          requiredMappings.push({ sourceType: "PAYMENT", sourceKey: sourceKey("PAYMENT", paymentKey), transactionType: "PAYMENT" });
        }
        const mappings = await Promise.all(requiredMappings.map(async (candidate) => {
          const exact = await prisma.travelTallyMapping.findFirst({ where: { tenantId: req.travelTenant.id, subBrand: row.subBrand, ...candidate } });
          if (exact) return exact;
          // A party-specific ledger is optional when the transaction type has
          // a configured default voucher mapping. This makes validation agree
          // with the default mappings shown in Voucher Mapping.
          const voucherKey = String(row.voucherType || row.transactionType || "").trim().toUpperCase();
          if (["CUSTOMER", "SUPPLIER", "EXPENSE"].includes(candidate.sourceType) && voucherKey) {
            return prisma.travelTallyMapping.findFirst({
              where: { tenantId: req.travelTenant.id, subBrand: null, sourceType: "VOUCHER", sourceKey: sourceKey("VOUCHER", voucherKey), transactionType: voucherKey },
            });
          }
          if (candidate.sourceType === "PAYMENT") {
            return prisma.travelTallyMapping.findFirst({
              where: { tenantId: req.travelTenant.id, subBrand: null, sourceType: "PAYMENT", sourceKey: candidate.sourceKey, transactionType: "PAYMENT" },
            });
          }
          return null;
        }));
        const mapping = requiredMappings.length > 0 && mappings.every(Boolean);
        await prisma.travelTallySyncQueue.update({ where: { id: row.id }, data: { mappingStatus: mapping ? "READY" : "MAPPING_REQUIRED" } });
        if (mapping) ready += 1; else mappingRequired += 1;
      }
      await auditTally(req, "VALIDATE_SYNC_QUEUE", 0, { total: rows.length, ready, mappingRequired });
      res.json({ total: rows.length, ready, mappingRequired });
    } catch (error) {
      console.error("[travel-tally] queue validation failed:", error.message);
      res.status(500).json({ error: "Failed to validate Tally mappings", code: "TALLY_QUEUE_VALIDATE_ERROR" });
    }
  },
);

router.get(
  "/tally/sync-queue",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.status) where.status = String(req.query.status).toUpperCase();
      if (req.query.mappingStatus) where.mappingStatus = String(req.query.mappingStatus).toUpperCase();
      const rows = await prisma.travelTallySyncQueue.findMany({
        where,
        include: { errors: { where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      res.json({ queue: rows });
    } catch (error) {
      console.error("[travel-tally] queue read failed:", error.message);
      res.status(500).json({ error: "Failed to load Tally sync queue", code: "TALLY_QUEUE_ERROR" });
    }
  },
);

router.get(
  "/tally/sync-history",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const logs = await prisma.travelTallySyncLog.findMany({
        where: { tenantId: req.travelTenant.id },
        include: { queue: { select: { reference: true, partyName: true, amount: true, transactionType: true } } },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      res.json({ history: logs });
    } catch (error) {
      console.error("[travel-tally] history read failed:", error.message);
      res.status(500).json({ error: "Failed to load Tally sync history", code: "TALLY_HISTORY_ERROR" });
    }
  },
);

router.get(
  "/tally/sync-errors",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const errors = await prisma.travelTallySyncError.findMany({
        where: { tenantId: req.travelTenant.id },
        include: { queue: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      res.json({ errors });
    } catch (error) {
      console.error("[travel-tally] errors read failed:", error.message);
      res.status(500).json({ error: "Failed to load Tally sync errors", code: "TALLY_ERRORS_ERROR" });
    }
  },
);

router.get(
  "/tally/sync-queue/:id/preview",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = await prisma.travelTallySyncQueue.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      if (!row) return res.status(404).json({ error: "Queued transaction not found", code: "NOT_FOUND" });
      let payload = {};
      try { payload = JSON.parse(row.payloadJson || "{}"); } catch (_) { payload = { raw: row.payloadJson }; }
      const mappingCandidates = [];
      if (row.transactionType === "SALES" && payload.contactId) mappingCandidates.push({ sourceType: "CUSTOMER", sourceKey: sourceKey("CUSTOMER", payload.contactId), transactionType: "SALES" });
      if (row.transactionType === "PURCHASE" && payload.supplierId) mappingCandidates.push({ sourceType: "SUPPLIER", sourceKey: sourceKey("SUPPLIER", payload.supplierId), transactionType: "PURCHASE" });
      if (row.sourceType === "TRAVEL_INVOICE_PAYMENT" && payload.contactId) mappingCandidates.push({ sourceType: "CUSTOMER", sourceKey: sourceKey("CUSTOMER", payload.contactId), transactionType: row.transactionType === "RECEIPT" ? "SALES" : "PAYMENT" });
      if (row.sourceType === "SUPPLIER_PAYABLE_PAYMENT" && payload.supplierId) mappingCandidates.push({ sourceType: "SUPPLIER", sourceKey: sourceKey("SUPPLIER", payload.supplierId), transactionType: "PURCHASE" });
      if (row.sourceType === "OFFICE_EXPENSE" || row.sourceType === "TRIP_EXPENSE") mappingCandidates.push({ sourceType: "EXPENSE", sourceKey: sourceKey("EXPENSE", payload.category || row.partyName), transactionType: "PAYMENT" });
      if (row.sourceType === "SALARY_INCENTIVE" || row.transactionType === "SALARY") mappingCandidates.push({ sourceType: "SALARY", sourceKey: sourceKey("SALARY", payload.commissionId || row.sourceId), transactionType: "SALARY" });
      if (row.transactionType === "RECEIPT" || row.transactionType === "PAYMENT") {
        const paymentKey = payload.method || "BANK";
        mappingCandidates.push({ sourceType: "PAYMENT", sourceKey: sourceKey("PAYMENT", paymentKey), transactionType: "PAYMENT" });
      }
      const resolvedMapping = mappingCandidates.length
        ? await prisma.travelTallyMapping.findFirst({ where: { tenantId: req.travelTenant.id, subBrand: row.subBrand, OR: mappingCandidates } , include: { tallyLedger: true } })
        : null;
      const paymentMapping = row.transactionType === "PAYMENT"
        ? await prisma.travelTallyMapping.findFirst({ where: { tenantId: req.travelTenant.id, subBrand: row.subBrand, sourceType: "PAYMENT", transactionType: "PAYMENT", sourceKey: sourceKey("PAYMENT", payload.paymentMode || payload.method || "BANK") }, include: { tallyLedger: true } })
        : null;
      const partyTransactionType = row.sourceType === "TRAVEL_INVOICE_PAYMENT" ? (row.transactionType === "RECEIPT" ? "SALES" : "PAYMENT") : row.sourceType === "SUPPLIER_PAYABLE_PAYMENT" ? "PURCHASE" : "PAYMENT";
      const partyMapping = (row.transactionType === "PAYMENT" || row.transactionType === "RECEIPT") && (payload.contactId || payload.supplierId)
        ? await prisma.travelTallyMapping.findFirst({ where: { tenantId: req.travelTenant.id, subBrand: row.subBrand, sourceType: payload.contactId ? "CUSTOMER" : "SUPPLIER", sourceKey: sourceKey(payload.contactId ? "CUSTOMER" : "SUPPLIER", payload.contactId || payload.supplierId), transactionType: partyTransactionType }, include: { tallyLedger: true } })
        : null;
      const partyLedgerName = partyMapping?.tallyLedger?.ledgerName || (resolvedMapping?.sourceType === "CUSTOMER" || resolvedMapping?.sourceType === "SUPPLIER" || resolvedMapping?.sourceType === "SALARY"
        ? resolvedMapping.tallyLedger?.ledgerName
        : null);
      // Resolve bill-wise settlement from the source record, never by party
      // name/amount heuristics.  This keeps partial and duplicate amounts
      // safe and leaves genuinely unlinked receipts/payments On Account.
      let billAllocation = null;
      if (row.transactionType === "RECEIPT" || row.transactionType === "PAYMENT") {
        let billExists = false;
        if (row.sourceType === "TRAVEL_INVOICE_PAYMENT" && payload.invoiceId) {
          const invoice = await prisma.travelInvoice.findFirst({
            where: { id: Number(payload.invoiceId), tenantId: req.travelTenant.id, status: { not: "Voided" } },
            select: { invoiceNum: true },
          });
          billExists = Boolean(invoice && invoice.invoiceNum === (payload.billReference || payload.invoiceNum));
        } else if (row.sourceType === "SUPPLIER_PAYABLE_PAYMENT" && payload.payableId) {
          const payable = await prisma.travelSupplierPayable.findFirst({
            where: { id: Number(payload.payableId), tenantId: req.travelTenant.id, status: { not: "cancelled" } },
            select: { poNumber: true },
          });
          billExists = Boolean(payable && (payable.poNumber || `PAYABLE-${payload.payableId}`) === (payload.billReference || payable.poNumber || `PAYABLE-${payload.payableId}`));
        }
        try {
          billAllocation = resolveBillAllocation({
            transactionType: row.transactionType,
            billReference: payload.billReference,
            billExists,
            amount: row.transactionType === "PAYMENT" ? -Math.abs(Number(row.amount || 0)) : Math.abs(Number(row.amount || 0)),
          });
        } catch (error) {
          return res.status(422).json({ error: error.message, code: error.code || "TALLY_BILL_NOT_FOUND" });
        }
        if (billAllocation && !billAllocation.onAccount) payload.billAllocation = billAllocation;
      }
      if (!payload.accountingLines && row.transactionType === "SALES" && [payload.cgstAmount, payload.sgstAmount, payload.igstAmount, payload.tcsAmount].some((value) => Number(value || 0) > 0)) {
        const taxKeys = ["CGST", "SGST", "IGST", "TCS"];
        const taxMappings = await prisma.travelTallyMapping.findMany({ where: { tenantId: req.travelTenant.id, subBrand: row.subBrand, sourceType: "TAX", transactionType: "TAX", sourceKey: { in: taxKeys.map((key) => sourceKey("TAX", key)) } }, include: { tallyLedger: true } });
        const taxLedger = Object.fromEntries(taxMappings.map((mapping) => [mapping.sourceKey.split(":").pop(), mapping.tallyLedger?.ledgerName]));
        const total = Number(row.amount || 0);
        const taxTotal = Number(payload.cgstAmount || 0) + Number(payload.sgstAmount || 0) + Number(payload.igstAmount || 0) + Number(payload.tcsAmount || 0);
        const taxable = Math.max(0, Number(payload.taxableAmount ?? (total - taxTotal)));
        payload.accountingLines = [{ ledger: partyLedgerName || row.partyName || "Party Ledger", debit: total, credit: 0 }, { ledger: "Sales Ledger", debit: 0, credit: taxable }];
        [["CGST", payload.cgstAmount, "Output CGST"], ["SGST", payload.sgstAmount, "Output SGST"], ["IGST", payload.igstAmount, "Output IGST"], ["TCS", payload.tcsAmount, "TCS Payable"]].forEach(([key, value, fallback]) => { if (Number(value || 0) > 0) payload.accountingLines.push({ ledger: taxLedger[key] || fallback, debit: 0, credit: Number(value) }); });
      }
      payload.accountingLines = payload.accountingLines || buildVoucherLines({ transactionType: row.transactionType, partyName: partyLedgerName || row.partyName, amount: row.amount, debitLedger: row.transactionType === "PAYMENT" ? ["OFFICE_EXPENSE", "TRIP_EXPENSE"].includes(row.sourceType) ? resolvedMapping?.tallyLedger?.ledgerName : partyLedgerName : row.transactionType === "RECEIPT" ? paymentMapping?.tallyLedger?.ledgerName : resolvedMapping?.sourceType === "PAYMENT" || resolvedMapping?.sourceType === "EXPENSE" || resolvedMapping?.sourceType === "SALARY" ? resolvedMapping.tallyLedger?.ledgerName : null, creditLedger: paymentMapping?.tallyLedger?.ledgerName || (row.transactionType === "PAYMENT" && resolvedMapping?.sourceType === "PAYMENT" ? resolvedMapping.tallyLedger?.ledgerName : null) });
      payload.totalDebit = payload.accountingLines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      payload.totalCredit = payload.accountingLines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
      res.json({ queue: row, payload, billAllocation, liveConnection: "DEFERRED" });
    } catch (error) {
      res.status(500).json({ error: "Failed to preview queued transaction", code: "TALLY_PREVIEW_ERROR" });
    }
  },
);

router.post(
  "/tally/sync-queue/:id/create-ledger",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const queue = await prisma.travelTallySyncQueue.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      if (!queue) return res.status(404).json({ error: "Queued transaction not found", code: "NOT_FOUND" });
      let payload = {};
      try { payload = JSON.parse(queue.payloadJson || "{}"); } catch (_) { payload = {}; }
      const isCustomer = queue.sourceType === "TRAVEL_INVOICE" || queue.sourceType === "TRAVEL_INVOICE_PAYMENT";
      const isSupplier = queue.sourceType === "SUPPLIER_PAYABLE" || queue.sourceType === "SUPPLIER_PAYABLE_PAYMENT";
      const isSalary = queue.sourceType === "SALARY_INCENTIVE" || queue.transactionType === "SALARY";
      const partyType = isCustomer ? "CUSTOMER" : isSupplier ? "SUPPLIER" : isSalary ? "SALARY" : "EXPENSE";
      const partyId = payload.contactId || payload.supplierId || queue.sourceId;
      const ledger = await ensureLedger({
        tenantId: req.travelTenant.id,
        subBrand: queue.subBrand,
        sourceType: partyType,
        sourceId: partyId,
        ledgerName: queue.partyName || queue.reference,
        ledgerCategory: partyType === "SALARY" ? "EXPENSE" : partyType,
        ledgerGroup: partyType === "CUSTOMER" ? "Sundry Debtors" : partyType === "SUPPLIER" ? "Sundry Creditors" : "Indirect Expenses",
        description: `Created from failed Tally transaction ${queue.reference}`,
      });
      await ensureMapping({
        tenantId: req.travelTenant.id,
        subBrand: queue.subBrand,
        sourceType: partyType,
        sourceKey: sourceKey(partyType, partyId),
        transactionType: isCustomer ? "SALES" : isSupplier ? (queue.transactionType === "PAYMENT" ? "PAYMENT" : "PURCHASE") : queue.transactionType,
        tallyLedgerId: ledger.id,
      });
      const updated = await prisma.travelTallySyncQueue.update({ where: { id }, data: { mappingStatus: "READY", status: "PENDING", lastError: null }, include: { errors: true } });
      await prisma.travelTallySyncError.updateMany({ where: { queueId: id, resolvedAt: null }, data: { resolvedAt: new Date() } });
      await prisma.travelTallySyncLog.create({ data: { tenantId: req.travelTenant.id, queueId: id, sourceType: queue.sourceType, sourceId: queue.sourceId, voucherType: queue.voucherType, status: "LEDGER_CREATED", triggeredByUserId: req.user.userId, requestPayload: queue.payloadJson } });
      await auditTally(req, "CREATE_LEDGER_FROM_FAILURE", ledger.id, { queueId: id, reference: queue.reference });
      res.json({ queue: updated, ledger, retryReady: true, connection: "DEFERRED" });
    } catch (error) {
      console.error("[travel-tally] failed-sync ledger creation failed:", error.message);
      res.status(500).json({ error: "Failed to create ledger for queued transaction", code: "TALLY_FAILED_LEDGER_ERROR" });
    }
  },
);

router.post(
  "/tally/sync-queue/:id/retry",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "update"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = await prisma.travelTallySyncQueue.findFirst({ where: { id, tenantId: req.travelTenant.id } });
      if (!row) return res.status(404).json({ error: "Queued transaction not found", code: "NOT_FOUND" });
      const updated = await prisma.travelTallySyncQueue.update({
        where: { id },
        data: { status: "PENDING", retryCount: { increment: 1 }, lastError: null },
      });
      await prisma.travelTallySyncLog.create({
        data: { tenantId: req.travelTenant.id, queueId: id, sourceType: row.sourceType, sourceId: row.sourceId, voucherType: row.voucherType, status: "RETRY_QUEUED", triggeredByUserId: req.user.userId, requestPayload: row.payloadJson },
      });
      await auditTally(req, "RETRY_SYNC_QUEUE", id, { sourceType: row.sourceType, sourceId: row.sourceId });
      res.json({ queue: updated, connection: "DEFERRED" });
    } catch (error) {
      res.status(500).json({ error: "Failed to retry queued transaction", code: "TALLY_RETRY_ERROR" });
    }
  },
);

router.get(
  "/tally/ledger",
  verifyToken,
  requireTravelTenant,
  requirePermission("tally", "read"),
  async (req, res) => {
    try {
      // Validate the requested filters before querying tenant data.
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to, true);
      const rawSubBrand = String(req.query.subBrand || "").trim().toLowerCase();
      const subBrand = rawSubBrand === "all" ? "" : rawSubBrand;
      const paymentMode = String(req.query.paymentMode || "").trim().toLowerCase();
      const quoteId = req.query.quoteId ? Number(req.query.quoteId) : null;
      const rawItineraryId = String(req.query.itineraryId || "");
      const isTmcTripFilter = rawItineraryId.startsWith("tmc-");
      const tmcTripId = isTmcTripFilter ? Number(rawItineraryId.replace(/^tmc-/, "")) : null;
      const itineraryId = req.query.itineraryId && !isTmcTripFilter
        ? Number(req.query.itineraryId)
        : null;
      const isQuoteAccounting = Boolean(subBrand && subBrand !== "tmc");
      if (req.query.quoteId && (!Number.isInteger(quoteId) || quoteId <= 0))
        return res.status(400).json({ error: "Invalid quote", code: "INVALID_QUOTE" });
      if (
        req.query.itineraryId &&
        ((isTmcTripFilter && (!Number.isInteger(tmcTripId) || tmcTripId <= 0)) || (!isTmcTripFilter && (!Number.isInteger(itineraryId) || itineraryId <= 0)))
      )
        return res
          .status(400)
          .json({ error: "Invalid trip", code: "INVALID_TRIP" });
      if ((req.query.from && !from) || (req.query.to && !to))
        return res
          .status(400)
          .json({ error: "Invalid date range", code: "INVALID_DATE_RANGE" });
      if (from && to && to <= from)
        return res
          .status(400)
          .json({
            error: "To date must be after the From date",
            code: "INVALID_DATE_RANGE",
          });
      if (!rawSubBrand)
        return res
          .status(400)
          .json({ error: "Sub-brand is required", code: "SUB_BRAND_REQUIRED" });
      if (subBrand && !VALID_BRANDS.has(subBrand))
        return res
          .status(400)
          .json({ error: "Invalid sub-brand", code: "INVALID_SUB_BRAND" });
      if (paymentMode && !VALID_LEDGER_PAYMENT_MODES.has(paymentMode))
        return res
          .status(400)
          .json({ error: "Invalid payment mode", code: "INVALID_PAYMENT_MODE" });
      const dateWhere =
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {};

      // Fetch filtered accounting records together with date-range metadata
      // and the selected itinerary used by the TCS preview.
      let [
        invoices,
        expenses,
        payables,
        rangeInvoices,
        rangeExpenses,
        selectedTrip,
        salaryRows,
        trips,
      ] = await Promise.all([
          prisma.travelInvoice.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: { in: ["Issued", "Partial", "Paid"] },
              ...(subBrand ? { subBrand } : {}),
              ...(quoteId ? { quoteId } : {}),
              ...(itineraryId ? { itineraryId } : {}),
              ...(tmcTripId ? { tripId: tmcTripId } : {}),
              ...dateWhere,
            },
            select: {
              id: true,
              invoiceNum: true,
              status: true,
              createdAt: true,
              itineraryId: true,
              tripId: true,
              totalAmount: true,
              currency: true,
              contactId: true,
              participantId: true,
              quoteId: true,
              tcsAmount: true,
              tcsRate: true,
              totalTaxAmount: true,
              cgstAmount: true,
              sgstAmount: true,
              igstAmount: true,
              cgstPercent: true,
              sgstPercent: true,
              igstPercent: true,
              quote: {
                select: {
                  id: true,
                  gstTcsPercent: true,
                  gstTcsAmount: true,
                  lines: { select: { lineType: true, description: true }, orderBy: { sortOrder: "asc" } },
                },
              },
              schedule: { select: { receivedAmount: true } },
            },
          }),
          prisma.expense.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: "Approved",
              ...dateWhere,
            },
            select: {
              id: true,
              title: true,
              amount: true,
              expenseDate: true,
              createdAt: true,
              notes: true,
              category: true,
              status: true,
            },
          }),
          prisma.travelSupplierPayable.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: { in: ["pending", "scheduled", "paid"] },
              ...(paymentMode ? { paymentMode } : {}),
              ...(subBrand
                ? { supplier: { is: { subBrand } } }
                : {}),
              ...dateWhere,
            },
            select: {
              id: true,
              poNumber: true,
              description: true,
              amount: true,
              currency: true,
              dueDate: true,
              status: true,
              paidAt: true,
              paymentMode: true,
              paymentReference: true,
              createdAt: true,
              itineraryId: true,
              notes: true,
              supplier: {
                select: {
                  name: true,
                  supplierCategory: true,
                  subBrand: true,
                },
              },
              invoiceLine: {
                select: {
                  invoice: { select: { itineraryId: true } },
                },
              },
              purchaseOrder: {
                select: {
                  trip: { select: { destination: true } },
                  booking: { select: { itineraryId: true } },
                },
              },
            },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          }),
          prisma.travelInvoice.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: { not: "Voided" },
              ...(subBrand ? { subBrand } : {}),
            },
            select: { createdAt: true },
          }),
          prisma.expense.findMany({
            where: { tenantId: req.travelTenant.id },
            select: { createdAt: true, notes: true },
          }),
          itineraryId
            ? prisma.itinerary.findFirst({
                where: { id: itineraryId, tenantId: req.travelTenant.id },
                select: {
                  id: true,
                  destination: true,
                  currency: true,
                  totalAmount: true,
                },
              })
          : null,
          prisma.commissionData.findMany({
            where: { tenantId: req.travelTenant.id },
            select: { id: true, employeeName: true, periodStart: true, periodEnd: true, commission: true },
            orderBy: { periodStart: "desc" },
          }),
          prisma.itinerary.findMany({
            where: {
              tenantId: req.travelTenant.id,
              ...(subBrand ? { subBrand } : {}),
              ...(itineraryId ? { id: itineraryId } : {}),
              ...dateWhere,
            },
            select: {
              id: true,
              destination: true,
              status: true,
              totalAmount: true,
              currency: true,
            },
            orderBy: { createdAt: "desc" },
          }),
        ]);

      // TMC bookings live in TmcTrip rather than Itinerary. Include them in
      // the shared trip list used by the Trip-wise ledger; the prefix keeps a
      // TMC trip ID distinct from an itinerary ID with the same number.
      if (!subBrand || subBrand === "tmc") {
        const tmcLedgerTrips = await prisma.tmcTrip.findMany({
          where: {
            tenantId: req.travelTenant.id,
            ...(tmcTripId ? { id: tmcTripId } : {}),
            ...dateWhere,
          },
          select: {
            id: true,
            tripCode: true,
            destination: true,
            status: true,
          },
          orderBy: { id: "desc" },
        });
        trips = [
          ...trips,
          ...tmcLedgerTrips.map((trip) => ({
            ...trip,
            id: `tmc-${trip.id}`,
          })),
        ];
      }

      // Manual cash/UPI/NEFT and gateway collections are stored as Payment
      // rows. Aggregate them by travel invoice so partial receipts update the
      // Sales Ledger immediately instead of waiting for the invoice to become
      // fully Paid.
      const paymentTotalsByInvoice = {};
      const installmentTotalsByInvoice = {};
      const successfulPayments = [];
      if (invoices.length > 0) {
        const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
        const installmentRows = await prisma.tripInstalmentPayment.findMany({
          where: { invoiceId: { in: [...invoiceIds] } },
          select: { invoiceId: true, paidAmount: true },
        });
        for (const row of installmentRows) {
          if (!row.invoiceId) continue;
          installmentTotalsByInvoice[row.invoiceId] =
            (installmentTotalsByInvoice[row.invoiceId] || 0) + Number(row.paidAmount || 0);
        }
        const paymentCandidates = await prisma.payment.findMany({
          where: {
            tenantId: req.travelTenant.id,
            OR: [
              { invoiceId: { in: [...invoiceIds] } },
              ...[...invoiceIds].map((id) => ({
                metadata: { contains: `\"travelInvoiceId\":${id}` },
              })),
              // Landing-page payments are created before/alongside the
              // participant invoice and historically may contain only the
              // TMC trip + participant identifiers.
              ...invoices
                .filter((invoice) => invoice.tripId && invoice.participantId)
                .map((invoice) => ({
                  metadata: { contains: `\"tripId\":${invoice.tripId}` },
                })),
              ...invoices.map((invoice) => ({
                metadata: { contains: `\"invoiceNum\":\"${invoice.invoiceNum}\"` },
              })),
            ],
          },
          select: {
            id: true,
            invoiceId: true,
            amount: true,
            currency: true,
            gateway: true,
            gatewayId: true,
            status: true,
            paidAt: true,
            createdAt: true,
            metadata: true,
          },
        });
        paymentCandidates.forEach((payment) => {
          if (!['SUCCESS', 'PAID', 'CAPTURED'].includes(String(payment.status || '').toUpperCase())) return;
          const metadata = parseJson(payment.metadata, {});
          const metadataInvoiceId = Number(metadata.travelInvoiceId);
          const metadataParticipantId = Number(metadata.participantId);
          const matchedInvoiceNumber = invoices.find((invoice) =>
            metadata.invoiceNum && String(metadata.invoiceNum) === String(invoice.invoiceNum),
          );
          const matchedParticipantInvoice = invoices.find((invoice) =>
            invoice.tripId && invoice.participantId &&
            Number(metadata.tripId) === Number(invoice.tripId) &&
            metadataParticipantId === Number(invoice.participantId),
          );
          const matchedTripInvoice = invoices.find((invoice) =>
            invoice.tripId && Number(metadata.tripId) === Number(invoice.tripId),
          );
          const travelInvoiceId = invoiceIds.has(metadataInvoiceId)
            ? metadataInvoiceId
            : invoiceIds.has(payment.invoiceId)
              ? payment.invoiceId
              : matchedParticipantInvoice?.id || matchedInvoiceNumber?.id || null;
          // A valid trip-level payment may predate participant invoice
          // creation. Keep it in Bank/Cash even when it cannot be allocated
          // to one invoice; only linked payments affect invoice receipts.
          if (travelInvoiceId == null && !matchedTripInvoice) return;
          successfulPayments.push({
            ...payment,
            travelInvoiceId,
            metadataTripId: Number(metadata.tripId) || matchedTripInvoice?.tripId || null,
          });
          if (travelInvoiceId != null) {
            paymentTotalsByInvoice[travelInvoiceId] =
              (paymentTotalsByInvoice[travelInvoiceId] || 0) +
              Number(payment.amount || 0);
          }
        });
      }

      // Expenses keep sub-brand and itinerary references in their JSON notes;
      // narrow those records after the Prisma query and resolve trip labels.
      const rangeExpenseDates = rangeExpenses
        .filter((expense) => !subBrand || parseJson(expense.notes, {}).subBrand === subBrand)
        .map((expense) => expense.createdAt);
      const allRangeDates = [
        ...rangeInvoices.map((invoice) => invoice.createdAt),
        ...rangeExpenseDates,
      ]
        .filter(Boolean)
        .sort((a, b) => a - b);
      const matchingExpenses = expenses.filter((expense) => {
        const notes = parseJson(expense.notes, {});
        return (
          (!subBrand || notes.subBrand === subBrand) &&
          (!itineraryId || Number(notes.itineraryId) === itineraryId) &&
          (!tmcTripId || Number(notes.tmcTripId) === tmcTripId)
        );
      });
      const matchingOfficeExpenses = matchingExpenses.filter((expense) => {
        const notes = parseJson(expense.notes, {});
        return notes.expenseType !== "TRIP" && !String(expense.title || "").startsWith("Supplier payment:");
      });
      const matchingTripExpenses = matchingExpenses.filter((expense) => parseJson(expense.notes, {}).expenseType === "TRIP");
      const matchingPayables = payables.filter((payable) => {
        if (isQuoteAccounting && quoteId && quoteIdFromPayableNotes(payable.notes) !== quoteId) return false;
        const payableTripId =
          payable.itineraryId ||
          payable.invoiceLine?.invoice?.itineraryId ||
          payable.purchaseOrder?.booking?.itineraryId ||
          null;
        return !itineraryId || Number(payableTripId) === itineraryId;
      });
      const expenseItineraryIds = matchingOfficeExpenses
        .map((expense) => Number(parseJson(expense.notes, {}).itineraryId))
        .filter((id) => Number.isInteger(id) && id > 0);
      const itineraryIds = [
        ...new Set(
          [
            ...invoices.map((invoice) => invoice.itineraryId),
            ...expenseItineraryIds,
            ...matchingPayables.map(
              (payable) =>
                payable.itineraryId ||
                payable.invoiceLine?.invoice?.itineraryId ||
                payable.purchaseOrder?.booking?.itineraryId,
            ),
          ].filter(Boolean),
        ),
      ];
      const itineraryRows = itineraryIds.length
        ? await prisma.itinerary.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: itineraryIds } },
            select: { id: true, destination: true },
          })
        : [];
      const itineraryMap = Object.fromEntries(
        itineraryRows.map((itinerary) => [itinerary.id, itinerary]),
      );
      const tmcTripIds = [
        ...new Set([
          ...invoices.map((invoice) => invoice.tripId),
          ...matchingTripExpenses.map((expense) => Number(parseJson(expense.notes, {}).tmcTripId)),
        ].filter(Boolean)),
      ];
      const tmcTrips = tmcTripIds.length
        ? await prisma.tmcTrip.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: tmcTripIds } },
            select: { id: true, tripCode: true, destination: true },
          })
        : [];
      const tmcTripMap = Object.fromEntries(tmcTrips.map((trip) => [trip.id, trip]));
      const quoteIds = [
        ...invoices.map((invoice) => invoice.quoteId),
        ...matchingTripExpenses.map((expense) => parseJson(expense.notes, {}).quoteId),
        ...matchingPayables.map((payable) => quoteIdFromPayableNotes(payable.notes)),
      ].map(Number).filter((id) => Number.isInteger(id) && id > 0);
      const quoteRows = quoteIds.length
        ? await prisma.travelQuote.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: [...new Set(quoteIds)] } },
            select: { id: true, lines: { select: { lineType: true, description: true }, orderBy: { sortOrder: "asc" } } },
          })
        : [];
      const quoteMap = Object.fromEntries(quoteRows.map((quote) => [quote.id, quote]));
      const tripForInvoice = (invoice) =>
        invoice
          ? itineraryMap[invoice.itineraryId] || tmcTripMap[invoice.tripId] || null
          : null;
      const tripNameForInvoice = (invoice) =>
        tripForInvoice(invoice)?.destination || quoteTripName(quoteMap[invoice?.quoteId] || invoice?.quote) || "Unassigned";
      const participantIds = [
        ...new Set(invoices.map((invoice) => invoice.participantId).filter(Boolean)),
      ];
      const participants = participantIds.length
        ? await prisma.tripParticipant.findMany({
            where: { id: { in: participantIds } },
            select: { id: true, fullName: true },
          })
        : [];
      const participantMap = Object.fromEntries(participants.map((participant) => [participant.id, participant]));
      const contactIds = [
        ...new Set(
          invoices.map((invoice) => invoice.contactId).filter(Boolean),
        ),
      ];
      const contacts = contactIds.length
        ? await prisma.contact.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: contactIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const contactMap = Object.fromEntries(
        contacts.map((contact) => [contact.id, contact]),
      );

      // Return each successful customer payment separately for the Bank and
      // Cash Ledger views. Statement imports remain available through their
      // own workflow, but are not customer receipt rows.
      const paymentDetails = successfulPayments.sort(
        (a, b) =>
          new Date(b.paidAt || b.createdAt).getTime() -
            new Date(a.paidAt || a.createdAt).getTime() ||
          b.id - a.id,
      );
      const invoiceMap = Object.fromEntries(
        invoices.map((invoice) => [invoice.id, invoice]),
      );
      const paymentRows = paymentDetails.map((payment) => {
        const invoice = invoiceMap[payment.travelInvoiceId];
        const metadata = parseJson(payment.metadata, {});
        // Cash is the only cash ledger method. Razorpay, Stripe, UPI, NEFT,
        // card, manual bank entries, and any future non-cash method belong to
        // the Bank Ledger. Older manual rows stored the real method in
        // metadata rather than in Payment.gateway.
        const method = String(
          metadata.paymentMethod || metadata.method || payment.gateway || "manual",
        ).trim().toLowerCase();
        const isCash = method === "cash";
        const contact = invoice ? contactMap[invoice.contactId] : null;
        const paymentTrip = invoice
          ? tripForInvoice(invoice)
          : tmcTripMap[Number(payment.metadataTripId || metadata.tripId)] || null;
        return {
          paymentId: payment.id,
          customer: contact?.name || metadata.customerName || "Travel customer",
          customerEmail: contact?.email || null,
          invoice: invoice?.invoiceNum || metadata.invoiceNum || `Payment #${payment.id}`,
          invoiceId: payment.travelInvoiceId,
          amount: Number(payment.amount || 0),
          currency: payment.currency || invoice?.currency || "INR",
          paymentMethod: method,
          paidAt: payment.paidAt || payment.createdAt,
          reference: payment.gatewayId || null,
          subBrand: invoice?.subBrand || null,
          quoteId: invoice?.quoteId || null,
          itineraryId: invoice?.itineraryId || null,
          tripId: invoice?.tripId || payment.metadataTripId || null,
          tripName: paymentTrip?.destination || tripNameForInvoice(invoice),
          status: payment.status,
          ledger: isCash ? "cash" : "bank",
        };
      });

      // Purchase A/c contains only settled supplier payables. Office costs
      // remain separate so a supplier payment is never counted twice.
      const calculated = {
        sales: invoices.reduce(
          (sum, invoice) =>
            sum + receivedAmount(
              invoice,
              paymentTotalsByInvoice[invoice.id] || installmentTotalsByInvoice[invoice.id] || 0,
            ),
          0,
        ),
        purchase: matchingPayables
          .filter((payable) => payable.status === "paid")
          .reduce(
            (sum, payable) => sum + Number(payable.amount || 0),
            0,
          ) + matchingTripExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
        officeExpenses: matchingOfficeExpenses.reduce(
          (sum, expense) => sum + Number(expense.amount || 0),
          0,
        ),
        tcs: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.tcsAmount || 0),
          0,
        ),
      };
      let automaticTcs = {
        taxableAmount: 0,
        tcsAmount: 0,
        rate: 0,
        finalInvoiceTotal: calculated.sales,
        international: false,
        requiresReview: false,
      };
      if (selectedTrip) {
        // For a selected trip, compare customer financial-year spend with the
        // TCS threshold and preview the applicable overseas-package amount.
        const contactIdsForTcs = [
          ...new Set(
            invoices.map((invoice) => invoice.contactId).filter(Boolean),
          ),
        ];
        const prior = contactIdsForTcs.length
          ? await prisma.travelInvoice.findMany({
              where: {
                tenantId: req.travelTenant.id,
                contactId: { in: contactIdsForTcs },
                createdAt: { gte: fiscalYearStart(new Date()) },
                NOT: { id: { in: invoices.map((invoice) => invoice.id) } },
              },
              select: { contactId: true, totalAmount: true },
            })
          : [];
        const priorByContact = prior.reduce(
          (map, invoice) => ({
            ...map,
            [invoice.contactId]:
              (map[invoice.contactId] || 0) + Number(invoice.totalAmount || 0),
          }),
          {},
        );
        const international = isInternationalDestination(
          selectedTrip.destination,
        );
        const preview = invoices.map((invoice) =>
          computeTcs({
            invoiceAmount: Number(invoice.totalAmount || 0),
            priorFySpend: priorByContact[invoice.contactId] || 0,
            isOverseasPackage: international,
          }),
        );
        automaticTcs = {
          taxableAmount: preview.reduce(
            (sum, result) => sum + result.exceedingAmount,
            0,
          ),
          tcsAmount: invoices.reduce(
            (sum, invoice, index) =>
              sum +
              (invoice.tcsAmount == null
                ? preview[index].tcsAmount
                : Number(invoice.tcsAmount)),
            0,
          ),
          rate: preview.find((result) => result.applies)?.rate || 0,
          finalInvoiceTotal:
            calculated.sales +
            preview.reduce(
              (sum, result, index) =>
                sum +
                (invoices[index].tcsAmount == null
                  ? result.tcsAmount
                  : Number(invoices[index].tcsAmount)),
              0,
            ),
          international,
          requiresReview:
            international &&
            invoices.some(
              (invoice) =>
                invoice.tcsAmount == null &&
                preview[invoices.indexOf(invoice)].applies,
            ),
        };
      }

      // Shape invoice rows for Payments received, including GST/TCS values
      // and the itinerary used by the frontend report tables.
      const customerDetails = invoices.map((invoice) => {
        const hasPersistedGst =
          invoice.totalTaxAmount != null ||
          invoice.cgstAmount != null ||
          invoice.sgstAmount != null ||
          invoice.igstAmount != null;
        const gstAmount =
          invoice.totalTaxAmount != null
            ? Number(invoice.totalTaxAmount)
            : Number(invoice.cgstAmount || 0) +
              Number(invoice.sgstAmount || 0) +
              Number(invoice.igstAmount || 0);
        const gstRate =
          invoice.igstPercent != null
            ? Number(invoice.igstPercent)
            : Number(invoice.cgstPercent || 0) +
              Number(invoice.sgstPercent || 0);
        const quoteTaxAmount = Number(invoice.quote?.gstTcsAmount || 0);
        const quoteTaxRate = Number(invoice.quote?.gstTcsPercent || 0);
        const invoiceTotal = Number(invoice.totalAmount || 0);
        const received = receivedAmount(
          invoice,
          paymentTotalsByInvoice[invoice.id] || installmentTotalsByInvoice[invoice.id] || 0,
        );
        const receivedType = receivedSource(
          invoice,
          paymentTotalsByInvoice[invoice.id] || installmentTotalsByInvoice[invoice.id] || 0,
        );
        return {
          reference: invoice.invoiceNum,
          paymentReference: paymentDetails.find((payment) => payment.travelInvoiceId === invoice.id)?.gatewayId || null,
          name: contactMap[invoice.contactId]?.name || "Customer",
          participantName: participantMap[invoice.participantId]?.fullName || null,
          email: contactMap[invoice.contactId]?.email || null,
          amount: received,
          receivedSource: receivedType,
          paymentRecordMissing:
            invoice.status === "Paid" && receivedType === "legacy-paid",
          transactionDate: invoice.createdAt,
          invoiceTotal,
          taxableAmount: Math.max(0, invoiceTotal - gstAmount - Number(invoice.tcsAmount || 0)),
          outstandingAmount: Math.max(0, invoiceTotal - received),
          status: invoice.status,
          gstAmount,
          gstRate: hasPersistedGst ? gstRate : quoteTaxRate,
          gstRetrieved: hasPersistedGst || invoice.quote?.gstTcsAmount != null,
          tcsAmount: Number(invoice.tcsAmount || 0),
          tcsRate: invoice.tcsRate == null ? null : Number(invoice.tcsRate),
          gstTcsAmount: hasPersistedGst
            ? gstAmount + Number(invoice.tcsAmount || 0)
            : quoteTaxAmount,
          gstTcsRate: hasPersistedGst
            ? gstRate + Number(invoice.tcsRate || 0)
            : quoteTaxRate,
          itineraryId: invoice.itineraryId,
          tripId: invoice.tripId,
          quoteId: invoice.quoteId,
          tripName: tripNameForInvoice(invoice),
          international: isInternationalDestination(tripNameForInvoice(invoice)),
          currency: invoice.currency,
        };
      });

      // Shape filtered office expenses using their stored metadata.
      const supplierDetails = matchingOfficeExpenses.map((expense) => {
        const notes = parseJson(expense.notes, {});
        const expenseTripId = Number(notes.itineraryId);
        return {
          reference: `EXP-${expense.id}`,
          name: expense.title,
          category: expense.category,
          amount: Number(expense.amount || 0),
          transactionDate: expense.expenseDate || expense.createdAt,
          itineraryId:
            Number.isInteger(expenseTripId) && expenseTripId > 0
              ? expenseTripId
              : null,
          quoteId: Number(notes.quoteId) || null,
          tripName: itineraryMap[expenseTripId]?.destination || quoteTripName(quoteMap[Number(notes.quoteId)]) || "Unassigned",
        };
      });

      const tripExpenseDetails = matchingTripExpenses.map((expense) => {
        const notes = parseJson(expense.notes, {});
        const expenseTmcTripId = Number(notes.tmcTripId);
        const expenseItineraryId = Number(notes.itineraryId);
        return {
          id: `expense-${expense.id}`,
          reference: `EXP-${expense.id}`,
          name: expense.title,
          category: expense.category || "Trip Expenses",
          description: expense.description || "Trip expense",
          amount: Number(expense.amount || 0),
          currency: expense.currency || "INR",
          status: "approved",
          paidAt: expense.expenseDate || expense.createdAt,
          transactionDate: expense.expenseDate || expense.createdAt,
          paymentMode: "expense",
          paymentReference: null,
          subBrand: notes.subBrand || null,
          quoteId: notes.quoteId || null,
          itineraryId: Number.isInteger(expenseItineraryId) && expenseItineraryId > 0 ? expenseItineraryId : null,
          tripId: Number.isInteger(expenseTmcTripId) && expenseTmcTripId > 0 ? expenseTmcTripId : null,
          tripName: tmcTripMap[expenseTmcTripId]
            ? `${tmcTripMap[expenseTmcTripId].tripCode} — ${tmcTripMap[expenseTmcTripId].destination}`
            : itineraryMap[expenseItineraryId]?.destination || quoteTripName(quoteMap[Number(notes.quoteId)]) || "Unassigned",
          isTripExpense: true,
        };
      });
      // Approved trip expenses are purchases, but their actual settlement
      // must also appear as a debit in Bank/Cash. Expenses can be split
      // across methods, so emit one ledger row for each stored portion.
      const tripExpensePaymentRows = matchingTripExpenses.flatMap((expense) => {
        const notes = parseJson(expense.notes, {});
        const payment = notes.payment && typeof notes.payment === "object"
          ? notes.payment
          : {};
        const methods = ["cash", "card", "online", "upi"]
          .map((method) => ({ method, amount: Number(payment[method] || 0) }))
          .filter((row) => Number.isFinite(row.amount) && row.amount > 0);
        // Legacy expenses without a payment split are treated as bank
        // transactions because only an explicitly recorded cash portion is
        // allowed into the Cash Ledger.
        if (methods.length === 0) methods.push({ method: "manual", amount: Number(expense.amount || 0) });
        return methods.map(({ method, amount }) => ({
          paymentId: `trip-expense-${expense.id}-${method}`,
          transactionType: "PAYMENT",
          customer: expense.title,
          invoice: `EXP-${expense.id}`,
          description: expense.description || "Trip expense",
          amount,
          currency: "INR",
          paymentMethod: method,
          paymentMode: method,
          paidAt: expense.expenseDate || expense.createdAt,
          transactionDate: expense.expenseDate || expense.createdAt,
          reference: `EXP-${expense.id}`,
          subBrand: notes.subBrand || null,
          itineraryId: Number(notes.itineraryId) || null,
          tripId: Number(notes.tmcTripId) || null,
          tripName: tmcTripMap[Number(notes.tmcTripId)]?.destination || itineraryMap[Number(notes.itineraryId)]?.destination || quoteTripName(quoteMap[Number(notes.quoteId)]) || "Unassigned",
          status: "APPROVED",
          direction: "DEBIT",
          ledger: method === "cash" ? "cash" : "bank",
        }));
      });

      // Return only settled supplier payments because Pending and Scheduled
      // records remain on the dedicated Payables page and are not purchases.
      const supplierPayableDetails = matchingPayables
          .filter((payable) => payable.status === "paid")
          .map((payable) => {
            const payableTripId =
              payable.itineraryId ||
              payable.invoiceLine?.invoice?.itineraryId ||
              payable.purchaseOrder?.booking?.itineraryId ||
              null;
          return {
            id: payable.id,
            reference: payable.poNumber || `PAY-${payable.id}`,
            name: payable.supplier?.name || "Supplier",
            category: payable.supplier?.supplierCategory || "other",
            description: payable.description,
            amount: Number(payable.amount || 0),
            currency: payable.currency || "INR",
            dueDate: payable.dueDate,
            status: payable.status,
            paidAt: payable.paidAt,
            paymentMode: payable.paymentMode,
            paymentReference: payable.paymentReference,
            transactionDate: payable.createdAt,
            subBrand: payable.supplier?.subBrand || null,
            quoteId: quoteIdFromPayableNotes(payable.notes),
            itineraryId: payableTripId,
            tripName:
              itineraryMap[payableTripId]?.destination ||
              payable.purchaseOrder?.trip?.destination ||
              quoteTripName(quoteMap[quoteIdFromPayableNotes(payable.notes)]) ||
              "Unassigned",
          };
        });
      const payableDetails = [...supplierPayableDetails, ...tripExpenseDetails];
      const supplierLedgerDetails = matchingPayables.map((payable) => {
        const payableTripId = payable.itineraryId || payable.invoiceLine?.invoice?.itineraryId || payable.purchaseOrder?.booking?.itineraryId || null;
        return {
          id: payable.id,
          reference: payable.poNumber || `PAY-${payable.id}`,
          name: payable.supplier?.name || "Supplier",
          category: payable.supplier?.supplierCategory || "other",
          description: payable.description,
          amount: Number(payable.amount || 0),
          currency: payable.currency || "INR",
          dueDate: payable.dueDate,
          status: payable.status,
          paidAt: payable.paidAt,
          paymentMode: payable.paymentMode,
          paymentReference: payable.paymentReference,
          transactionDate: payable.createdAt,
          quoteId: quoteIdFromPayableNotes(payable.notes),
          itineraryId: payableTripId,
          tripName:
            itineraryMap[payableTripId]?.destination ||
            payable.purchaseOrder?.trip?.destination ||
            quoteTripName(quoteMap[quoteIdFromPayableNotes(payable.notes)]) ||
            "Unassigned",
        };
      });

      const supplierPaymentRows = supplierPayableDetails.map((payable) => ({
        paymentId: `supplier-payable-${payable.id}`,
        transactionType: "purchase",
        customer: payable.name,
        invoice: payable.reference,
        description: payable.description,
        amount: payable.amount,
        currency: payable.currency,
        paymentMethod: payable.paymentMode || "cash",
        paidAt: payable.paidAt || payable.transactionDate,
        reference: payable.paymentReference || payable.reference,
        subBrand: payable.subBrand,
        itineraryId: payable.itineraryId,
        tripName: payable.tripName,
        status: "PAID",
        direction: "DEBIT",
        ledger: ledgerForPaymentMode(payable.paymentMode),
      }));
      const salaryDetails = salaryRows.map((salary) => ({
        id: salary.id,
        reference: `SAL-${salary.id}`,
        name: salary.employeeName || "Employee",
        category: "salary / incentive",
        amount: Number(salary.commission || 0),
        transactionDate: salary.periodEnd || salary.periodStart,
        description: salary.periodStart && salary.periodEnd
          ? `${new Date(salary.periodStart).toLocaleDateString("en-IN")} - ${new Date(salary.periodEnd).toLocaleDateString("en-IN")}`
          : "Commission or incentive",
      }));
      const bankAndCashTransactions = [
        ...paymentRows,
        ...supplierPaymentRows,
        ...tripExpensePaymentRows,
      ].sort(
        (a, b) =>
          new Date(b.paidAt || 0).getTime() -
          new Date(a.paidAt || 0).getTime(),
      );

      const tripFinancialSummary = {
        sales: customerDetails.reduce((sum, row) => sum + Number(row.invoiceTotal || 0), 0),
        gst: customerDetails.reduce((sum, row) => sum + Number(row.gstAmount || 0), 0),
        tcs: customerDetails.reduce((sum, row) => sum + Number(row.tcsAmount || 0), 0),
        purchases: calculated.purchase,
        tripExpenses: matchingTripExpenses.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        received: customerDetails.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        customerOutstanding: customerDetails.reduce((sum, row) => sum + Number(row.outstandingAmount || 0), 0),
        supplierOutstanding: matchingPayables.reduce((sum, row) => sum + (row.status === "paid" ? 0 : Number(row.amount || 0)), 0),
      };
      const selectedQuote = isQuoteAccounting && quoteId
        ? await prisma.travelQuote.findFirst({
            where: { id: quoteId, tenantId: req.travelTenant.id, ...(subBrand ? { subBrand } : {}) },
            select: {
              id: true,
              subBrand: true,
              status: true,
              totalAmount: true,
              currency: true,
              tripDate: true,
              contact: { select: { name: true } },
            },
          })
        : null;

      // Return the complete in-memory ledger payload consumed by Master,
      // Ledger, and Reports steps in the frontend wizard.
      res.json({
        filters: {
          from: req.query.from || null,
          to: req.query.to || null,
          subBrand: subBrand || null,
          itineraryId,
          quoteId: isQuoteAccounting ? quoteId : null,
        },
        trip: selectedTrip
          ? {
              ...selectedTrip,
              tcs: automaticTcs.tcsAmount || calculated.tcs,
              tcsPreview: automaticTcs,
            }
          : null,
        quote: selectedQuote
          ? { ...selectedQuote, totalAmount: selectedQuote.totalAmount == null ? null : Number(selectedQuote.totalAmount) }
          : null,
        trips: trips.map((trip) => ({
          ...trip,
          totalAmount: trip.totalAmount == null ? null : Number(trip.totalAmount),
        })),
        dateRange: {
          first: allRangeDates[0]?.toISOString().slice(0, 10) || null,
          last:
            allRangeDates[allRangeDates.length - 1]
              ?.toISOString()
              .slice(0, 10) || null,
        },
        accounts: [
          {
            id: "sales",
            name: "Sales A/c",
            type: "Sales",
            calculatedAmount: calculated.sales,
            amount: calculated.sales,
          },
          {
            id: "purchase",
            name: "Purchase A/c",
            type: "Purchase",
            calculatedAmount: calculated.purchase,
            amount: calculated.purchase,
          },
          {
            id: "officeExpenses",
            name: "Office Expenses A/c",
            type: "Expense",
            calculatedAmount: calculated.officeExpenses,
            amount: calculated.officeExpenses,
          },
          {
            id: "inputGst",
            name: "GST %",
            type: "Tax",
            calculatedAmount: 0,
            amount: 0,
            manual: true,
          },
          {
            id: "tcsRate",
            name: "TCS %",
            type: "Tax / TCS",
            calculatedAmount: 0,
            amount: 0,
            manual: true,
          },
        ],
        customerDetails,
        paymentDetails: bankAndCashTransactions,
        supplierDetails,
        payableDetails,
        supplierLedgerDetails,
        salaryDetails,
        tripFinancialSummary,
      });
    } catch (error) {
      console.error("[travel-tally] ledger read failed:", error.message);
      res
        .status(500)
        .json({
          error: "Failed to calculate ledger totals",
          code: "TALLY_LEDGER_ERROR",
        });
    }
  },
);

module.exports = router;
