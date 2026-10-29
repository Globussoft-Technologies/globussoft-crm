const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const prisma = require("../lib/prisma");
const { requirePermission } = require("../middleware/requirePermission");
const { verifyToken } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const { parseCsv, serializeRows, setCsvDownloadHeaders } = require("../lib/csvHelpers");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const MAX_LINE_ITEMS = 200;
const ALLOWED_STATUSES = new Set(["Draft", "Sent", "Accepted", "Rejected", "Expired"]);

const csvColumns = [
  { key: "quoteNumber", header: "Quote Number" },
  { key: "subject", header: "Subject" },
  { key: "status", header: "Status" },
  { key: "validUntil", header: "Valid Until" },
  { key: "currency", header: "Currency" },
  { key: "customerName", header: "Customer Name" },
  { key: "customerEmail", header: "Customer Email" },
  { key: "accountName", header: "Account Name" },
  { key: "dealName", header: "Deal Name" },
  { key: "billingAddress", header: "Billing Address" },
  { key: "shippingAddress", header: "Shipping Address" },
  { key: "productName", header: "Product Name" },
  { key: "description", header: "Description" },
  { key: "quantity", header: "Quantity" },
  { key: "cost", header: "Cost" },
  { key: "unitPrice", header: "Unit Price" },
  { key: "discountPercent", header: "Discount %" },
  { key: "gstRate", header: "GST %" },
  { key: "notes", header: "Notes" },
  { key: "terms", header: "Terms" },
];

const xlsxMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerValue(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function clean(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return sanitizeText(String(value));
}

function cleanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnlyValue(value) {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = cleanDate(value);
  if (!date) return null;
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDateOnly() {
  return dateOnlyValue(new Date());
}

function cleanAddress(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return sanitizeJsonForStringColumn(JSON.parse(value));
    } catch (_error) {
      return sanitizeText(value);
    }
  }
  return sanitizeJsonForStringColumn(value);
}

function addressText(value) {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && typeof parsed === "object") {
      return [parsed.line1, parsed.line2, parsed.city, parsed.state, parsed.postalCode, parsed.country]
        .filter(Boolean)
        .join(", ");
    }
  } catch (_error) {
    // The value may be a legacy plain-text address.
  }
  return String(value);
}

function lineTotals(item) {
  const quantity = Math.max(1, Math.min(999999, numberValue(item.quantity, 1)));
  const cost = Math.max(0, numberValue(item.cost, 0));
  const unitPrice = Math.max(0, numberValue(item.unitPrice, 0));
  const discountPercent = Math.max(0, Math.min(100, numberValue(item.discountPercent ?? item.discount, 0)));
  const gstRate = Math.max(0, Math.min(100, numberValue(item.gstRate, 0)));
  const amount = Number((quantity * unitPrice).toFixed(2));
  const discountAmount = Number((amount * discountPercent / 100).toFixed(2));
  const taxableAmount = Number((amount - discountAmount).toFixed(2));
  const gstAmount = Number((taxableAmount * gstRate / 100).toFixed(2));
  const total = Number((taxableAmount + gstAmount).toFixed(2));
  return {
    productName: clean(item.productName || item.description, "Untitled item").slice(0, 180),
    description: clean(item.description).slice(0, 4000) || null,
    quantity: Math.round(quantity),
    cost: Number(cost.toFixed(2)),
    unitPrice: Number(unitPrice.toFixed(2)),
    discountPercent: Number(discountPercent.toFixed(2)),
    discountAmount,
    gstRate: Number(gstRate.toFixed(2)),
    gstAmount,
    amount,
    total,
    // Generic quotes keep catalog suggestions as text. Do not attach an
    // unvalidated catalog relation from a client-supplied product id.
    productId: null,
    isRecurring: false,
  };
}

function normalizeLines(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_LINE_ITEMS)
    .filter((item) => item && (item.productName || item.description))
    .map(lineTotals);
}

function summarizeLines(lines, adjustment) {
  const subtotal = Number(lines.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const discountTotal = Number(lines.reduce((sum, item) => sum + item.discountAmount, 0).toFixed(2));
  const taxTotal = Number(lines.reduce((sum, item) => sum + item.gstAmount, 0).toFixed(2));
  const parsedAdjustment = Number(numberValue(adjustment, 0).toFixed(2));
  const totalAmount = Number((subtotal - discountTotal + taxTotal + parsedAdjustment).toFixed(2));
  return { subtotal, discountTotal, taxTotal, adjustment: parsedAdjustment, totalAmount };
}

async function validateRelationIds({ tenantId, contactId, dealId }) {
  let contact = null;
  let deal = null;
  if (contactId !== null) {
    contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return { error: "Contact not found", code: "CONTACT_NOT_FOUND" };
  }
  if (dealId !== null) {
    deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
    if (!deal) return { error: "Deal not found", code: "DEAL_NOT_FOUND" };
  }
  return { contact, deal };
}

async function prepareQuotePayload({ body, tenantId, existingQuote = null }) {
  const subject = clean(body.subject ?? body.title ?? existingQuote?.title);
  if (!subject) return { error: "subject is required", code: "SUBJECT_REQUIRED" };

  const sourceLines = body.lineItems === undefined ? existingQuote?.lineItems : body.lineItems;
  const lines = normalizeLines(sourceLines);
  if (!lines.length) return { error: "At least one line item is required", code: "LINE_ITEMS_REQUIRED" };
  if (Array.isArray(sourceLines) && sourceLines.length > MAX_LINE_ITEMS) {
    return { error: `lineItems cannot exceed ${MAX_LINE_ITEMS} entries`, code: "LINE_ITEMS_LIMIT_EXCEEDED" };
  }

  const status = clean(body.status, existingQuote?.status || "Draft");
  if (!ALLOWED_STATUSES.has(status)) return { error: "Invalid quote status", code: "INVALID_STATUS" };
  const validUntil = body.validUntil === undefined
    ? existingQuote?.validUntil || null
    : cleanDate(body.validUntil);
  if (body.validUntil && !validUntil) return { error: "validUntil is not a valid date", code: "INVALID_VALID_UNTIL" };
  if (body.validUntil !== undefined && validUntil && dateOnlyValue(body.validUntil) < todayDateOnly()) {
    return { error: "validUntil cannot be in the past", code: "VALID_UNTIL_IN_PAST" };
  }

  const contactId = body.contactId === undefined
    ? existingQuote?.contactId ?? null
    : integerValue(body.contactId);
  const dealId = body.dealId === undefined
    ? existingQuote?.dealId ?? null
    : integerValue(body.dealId);
  const relationResult = await validateRelationIds({ tenantId, contactId, dealId });
  if (relationResult.error) return relationResult;

  const currency = clean(body.currency, existingQuote?.currency || "USD").toUpperCase();
  const totals = summarizeLines(lines, body.adjustment === undefined ? existingQuote?.adjustment : body.adjustment);
  const quoteNumber = clean(body.quoteNumber) || existingQuote?.quoteNumber || `QUO-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const ownerName = clean(body.quoteOwnerName ?? body.ownerName, existingQuote?.quoteOwnerName || "Unassigned").slice(0, 160);
  const contact = relationResult.contact;

  return {
    lines,
    data: {
      quoteNumber: quoteNumber.slice(0, 80),
      title: subject.slice(0, 180),
      totalAmount: totals.totalAmount,
      status,
      quoteOwnerName: ownerName || null,
      validUntil,
      currency: currency.slice(0, 3),
      accountName: clean(body.accountName ?? existingQuote?.accountName).slice(0, 180) || null,
      customerName: clean(body.customerName ?? existingQuote?.customerName ?? contact?.name).slice(0, 180) || null,
      customerEmail: clean(body.customerEmail ?? existingQuote?.customerEmail ?? contact?.email).slice(0, 180) || null,
      billingAddress: cleanAddress(body.billingAddress ?? existingQuote?.billingAddress),
      shippingAddress: cleanAddress(body.shippingAddress ?? existingQuote?.shippingAddress),
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      adjustment: totals.adjustment,
      terms: clean(body.terms ?? existingQuote?.terms).slice(0, 12000) || null,
      notes: clean(body.notes ?? existingQuote?.notes).slice(0, 12000) || null,
      description: clean(body.description ?? existingQuote?.description).slice(0, 12000) || null,
      contactId,
      dealId,
    },
    totals,
  };
}

async function createQuoteRecord({ body, tenantId, userId }) {
  const prepared = await prepareQuotePayload({ body, tenantId });
  if (prepared.error) return prepared;

  const quote = await prisma.quote.create({
    data: {
      ...prepared.data,
      tenantId,
      lineItems: { create: prepared.lines },
    },
    include: { contact: true, deal: true, lineItems: true },
  });

  await writeAudit("Quote", "CREATE", quote.id, userId, tenantId, {
    quoteNumber: quote.quoteNumber,
    subject: quote.title,
    totalAmount: quote.totalAmount,
    lineItemCount: prepared.lines.length,
  });
  return quote;
}

function pdfMoney(value, currency) {
  return `${currency || "USD"} ${numberValue(value).toFixed(2)}`;
}

function pdfColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function pdfDate(value, locale = "en-GB") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return date.toLocaleDateString(locale || "en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch (_error) {
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }
}

function safePdfFilename(value) {
  return String(value || "quote").replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "quote";
}

function setXlsxDownloadHeaders(res, filename) {
  res.setHeader("Content-Type", xlsxMimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function xlsxBuffer(rows) {
  const sheetRows = rows.map((row) => Object.fromEntries(csvColumns.map(({ key, header }) => [header, row[key] ?? ""])));
  const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: csvColumns.map(({ header }) => header) });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Quotes");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function parseXlsxRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "", raw: false });
}

function exportRowsFromQuotes(quotes) {
  return quotes.flatMap((quote) => {
    const lines = quote.lineItems.length ? quote.lineItems : [{}];
    return lines.map((line) => ({
      quoteNumber: quote.quoteNumber || `#${quote.id}`,
      subject: quote.title,
      status: quote.status,
      validUntil: quote.validUntil ? new Date(quote.validUntil).toISOString().slice(0, 10) : "",
      currency: quote.currency,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      accountName: quote.accountName,
      dealName: quote.deal?.title || "",
      billingAddress: addressText(quote.billingAddress),
      shippingAddress: addressText(quote.shippingAddress),
      productName: line.productName,
      description: line.description,
      quantity: line.quantity,
      cost: line.cost,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent,
      gstRate: line.gstRate,
      notes: quote.notes,
      terms: quote.terms,
    }));
  });
}

async function loadExportRows(tenantId) {
  const quotes = await prisma.quote.findMany({
    where: { tenantId },
    include: { deal: true, lineItems: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return exportRowsFromQuotes(quotes);
}

function importGroupsFromRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const get = (name) => {
      const target = name.toLowerCase();
      const entry = Object.entries(row || {}).find(([key]) => key.trim().toLowerCase() === target);
      return entry ? entry[1] : "";
    };
    const key = clean(get("Quote Number")) || `row-${index + 2}`;
    if (!groups.has(key)) {
      groups.set(key, {
        quoteNumber: clean(get("Quote Number")),
        subject: clean(get("Subject")),
        status: clean(get("Status"), "Draft"),
        validUntil: clean(get("Valid Until")),
        currency: clean(get("Currency"), "USD"),
        customerName: clean(get("Customer Name")),
        customerEmail: clean(get("Customer Email")),
        accountName: clean(get("Account Name")),
        billingAddress: clean(get("Billing Address")),
        shippingAddress: clean(get("Shipping Address")),
        notes: clean(get("Notes")),
        terms: clean(get("Terms")),
        lineItems: [],
        rowNumber: index + 2,
      });
    }
    groups.get(key).lineItems.push({
      productName: clean(get("Product Name")),
      description: clean(get("Description")),
      quantity: get("Quantity"),
      cost: get("Cost"),
      unitPrice: get("Unit Price"),
      discountPercent: get("Discount %"),
      gstRate: get("GST %"),
    });
  });
  return groups;
}

async function importQuoteRows(rows, tenantId, userId) {
  const groups = importGroupsFromRows(rows);
  let imported = 0;
  const errors = [];
  for (const group of groups.values()) {
    try {
      const created = await createQuoteRecord({ body: group, tenantId, userId });
      if (created?.error) throw Object.assign(new Error(created.error), { code: created.code });
      imported += 1;
    } catch (error) {
      errors.push({ rowNumber: group.rowNumber, reason: error.message || "Unable to import row" });
    }
  }
  await writeAudit("Quote", "CSV_IMPORT", null, userId, tenantId, { imported, errors: errors.length, source: "spreadsheet" });
  return { imported, errors };
}

// Quote creation may use product names from the tenant catalog, but it should
// not require the retired CPQ module permission. Product suggestions are part
// of the Finance Quotes workspace; quote authors only need quotes.read.
router.get("/catalog", verifyToken, requirePermission("quotes", "read"), async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { tenantId: req.user.tenantId, isActive: true },
      select: {
        id: true,
        name: true,
        sku: true,
        description: true,
        price: true,
        discountedPrice: true,
        dealerPrice: true,
        purchasePrice: true,
        tax: true,
        isTaxIncluded: true,
        isRecurring: true,
      },
      orderBy: { name: "asc" },
      take: 200,
    });
    res.json(products);
  } catch (error) {
    console.error("[quotes] catalog lookup error:", error.message);
    res.status(500).json({ error: "Failed to load quote catalog", code: "QUOTE_CATALOG_FAILED" });
  }
});

router.get("/template.csv", verifyToken, requirePermission("quotes", "export"), (_req, res) => {
  const template = serializeRows(csvColumns, [{ status: "Draft", currency: "USD", quantity: 1, discountPercent: 0, gstRate: 0 }]);
  setCsvDownloadHeaders(res, "quotes-template.csv");
  res.send(template);
});

router.get("/template.xlsx", verifyToken, requirePermission("quotes", "export"), (_req, res) => {
  const template = xlsxBuffer([{ status: "Draft", currency: "USD", quantity: 1, discountPercent: 0, gstRate: 0 }]);
  setXlsxDownloadHeaders(res, "quotes-template.xlsx");
  res.send(template);
});

router.get("/export.csv", verifyToken, requirePermission("quotes", "export"), async (req, res) => {
  try {
    const quotes = await prisma.quote.findMany({
      where: { tenantId: req.user.tenantId },
      include: { deal: true, lineItems: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const rows = quotes.flatMap((quote) => {
      const lines = quote.lineItems.length ? quote.lineItems : [{}];
      return lines.map((line) => ({
        quoteNumber: quote.quoteNumber || `#${quote.id}`,
        subject: quote.title,
        status: quote.status,
        validUntil: quote.validUntil ? quote.validUntil.toISOString().slice(0, 10) : "",
        currency: quote.currency,
        customerName: quote.customerName,
        customerEmail: quote.customerEmail,
        accountName: quote.accountName,
        dealName: quote.deal?.title || "",
        billingAddress: addressText(quote.billingAddress),
        shippingAddress: addressText(quote.shippingAddress),
        productName: line.productName,
        description: line.description,
        quantity: line.quantity,
        cost: line.cost,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        gstRate: line.gstRate,
        notes: quote.notes,
        terms: quote.terms,
      }));
    });
    setCsvDownloadHeaders(res, "quotes.csv");
    res.send(serializeRows(csvColumns, rows));
  } catch (error) {
    console.error("[quotes] export error:", error.message);
    res.status(500).json({ error: "Failed to export quotes", code: "QUOTE_EXPORT_FAILED" });
  }
});

router.get("/export.xlsx", verifyToken, requirePermission("quotes", "export"), async (req, res) => {
  try {
    const rows = await loadExportRows(req.user.tenantId);
    setXlsxDownloadHeaders(res, "quotes.xlsx");
    res.send(xlsxBuffer(rows));
  } catch (error) {
    console.error("[quotes] xlsx export error:", error.message);
    res.status(500).json({ error: "Failed to export quotes", code: "QUOTE_EXPORT_FAILED" });
  }
});

router.post("/import.csv", verifyToken, requirePermission("quotes", "write"), upload.single("file"), async (req, res) => {
  try {
    const raw = req.file?.buffer?.toString("utf8") || (typeof req.body === "string" ? req.body : req.body?.csv);
    if (!raw) return res.status(400).json({ error: "CSV file is required", code: "CSV_REQUIRED" });
    const parsed = parseCsv(raw);
    if (!parsed.rows.length) return res.status(400).json({ error: "CSV contains no quote rows", code: "CSV_EMPTY" });

    const groups = new Map();
    parsed.rows.forEach((row, index) => {
      const get = (name) => row[name] ?? row[name.toLowerCase()] ?? "";
      const key = clean(get("Quote Number")) || `row-${index + 2}`;
      if (!groups.has(key)) {
        groups.set(key, {
          quoteNumber: clean(get("Quote Number")),
          subject: clean(get("Subject")),
          status: clean(get("Status"), "Draft"),
          validUntil: clean(get("Valid Until")),
          currency: clean(get("Currency"), "USD"),
          customerName: clean(get("Customer Name")),
          customerEmail: clean(get("Customer Email")),
          accountName: clean(get("Account Name")),
          billingAddress: clean(get("Billing Address")),
          shippingAddress: clean(get("Shipping Address")),
          notes: clean(get("Notes")),
          terms: clean(get("Terms")),
          lineItems: [],
          rowNumber: index + 2,
        });
      }
      groups.get(key).lineItems.push({
        productName: clean(get("Product Name")),
        description: clean(get("Description")),
        quantity: get("Quantity"),
        cost: get("Cost"),
        unitPrice: get("Unit Price"),
        discountPercent: get("Discount %"),
        gstRate: get("GST %"),
      });
    });

    let imported = 0;
    const errors = [];
    for (const group of groups.values()) {
      try {
        const created = await createQuoteRecord({ body: group, tenantId: req.user.tenantId, userId: req.user.userId });
        if (created?.error) throw Object.assign(new Error(created.error), { code: created.code });
        imported += 1;
      } catch (error) {
        errors.push({ rowNumber: group.rowNumber, reason: error.message || "Unable to import row" });
      }
    }
    await writeAudit("Quote", "CSV_IMPORT", null, req.user.userId, req.user.tenantId, { imported, errors: errors.length, source: "csv" });
    res.json({ imported, errors });
  } catch (error) {
    console.error("[quotes] import error:", error.message);
    res.status(400).json({ error: "Unable to parse quote CSV", code: "CSV_IMPORT_FAILED" });
  }
});

router.post("/import.xlsx", verifyToken, requirePermission("quotes", "write"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "XLSX file is required", code: "XLSX_REQUIRED" });
    const rows = parseXlsxRows(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "XLSX contains no quote rows", code: "XLSX_EMPTY" });
    const result = await importQuoteRows(rows, req.user.tenantId, req.user.userId);
    res.json(result);
  } catch (error) {
    console.error("[quotes] xlsx import error:", error.message);
    res.status(400).json({ error: "Unable to parse quote XLSX", code: "XLSX_IMPORT_FAILED" });
  }
});

router.get("/stats", verifyToken, requirePermission("quotes", "read"), async (req, res) => {
  try {
    const rows = await prisma.quote.findMany({
      where: { tenantId: req.user.tenantId },
      select: { status: true, totalAmount: true },
    });
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    res.json({ total: rows.length, byStatus, totalValue: rows.reduce((sum, row) => sum + (Number(row.totalAmount) || 0), 0) });
  } catch (error) {
    console.error("[quotes] stats error:", error.message);
    res.status(500).json({ error: "Failed to fetch quote stats", code: "QUOTE_STATS_FAILED" });
  }
});

router.get("/:id/pdf", verifyToken, requirePermission("quotes", "read"), async (req, res) => {
  try {
    const id = integerValue(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid quote ID", code: "INVALID_QUOTE_ID" });
    const quote = await prisma.quote.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true, lineItems: true },
    });
    if (!quote) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { name: true, locale: true, brandColor: true },
    });

    const filename = `${safePdfFilename(quote.quoteNumber || `quote-${quote.id}`)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    doc.pipe(res);

    const pageBottom = () => doc.page.height - 54;
    const currency = quote.currency || "USD";
    const colors = {
      navy: "#1e1b4b",
      accent: pdfColor(tenant?.brandColor, "#4f46e5"),
      accentLight: "#eef2ff",
      text: "#172033",
      muted: "#64748b",
      border: "#dbe3ef",
      tableHeader: "#f1f5f9",
      rowAlt: "#fafbff",
      white: "#ffffff",
      success: "#047857",
      warning: "#b45309",
      danger: "#b91c1c",
    };
    const left = 40;
    const contentWidth = 515;
    const right = left + contentWidth;
    const pdfTextValue = (value, fallback = "-") => {
      const text = value === undefined || value === null ? "" : String(value).trim();
      return text || fallback;
    };
    const tenantName = pdfTextValue(tenant?.name, "Globussoft CRM");
    const quoteTitle = pdfTextValue(quote.title, "Customer quote");
    const quoteNumber = pdfTextValue(quote.quoteNumber, `QUO-${quote.id}`);
    const validUntilDisplay = pdfDate(quote.validUntil, tenant?.locale);
    const customerName = pdfTextValue(quote.customerName || quote.contact?.name, "Customer");
    const customerEmail = pdfTextValue(quote.customerEmail || quote.contact?.email);
    const billing = addressText(quote.billingAddress);
    const shipping = addressText(quote.shippingAddress);
    const statusColor = {
      Draft: colors.muted,
      Sent: colors.accent,
      Accepted: colors.success,
      Rejected: colors.danger,
      Expired: colors.warning,
    }[quote.status] || colors.muted;

    const drawContinuationHeader = () => {
      doc.save();
      doc.rect(0, 0, doc.page.width, 30).fill(colors.navy);
      doc.fillColor(colors.white).font("Helvetica-Bold").fontSize(8)
        .text(`${tenantName}  /  QUOTE ${quoteNumber}`, left, 11, { width: contentWidth });
      doc.restore();
      doc.y = 48;
    };
    doc.on("pageAdded", drawContinuationHeader);
    const addPage = () => {
      doc.addPage();
      doc.y = 48;
    };
    const ensureSpace = (height = 60) => {
      if (doc.y + height > pageBottom()) addPage();
    };

    const drawFirstHeader = () => {
      doc.save();
      doc.rect(0, 0, doc.page.width, 134).fill(colors.navy);
      doc.fillColor("#c7d2fe").font("Helvetica-Bold").fontSize(9)
        .text("FINANCE / QUOTES", left, 28, { characterSpacing: 0.6 });
      doc.fillColor(colors.white).font("Helvetica-Bold").fontSize(25)
        .text(quoteTitle, left, 49, { width: 325, height: 32, ellipsis: true });
      doc.fillColor("#c7d2fe").font("Helvetica").fontSize(9)
        .text("A clear, customer-ready quote from your CRM", left, 91, { width: 325 });
      doc.fillColor(colors.white).font("Helvetica-Bold").fontSize(11)
        .text(tenantName, 370, 29, { width: 185, align: "right", ellipsis: true });
      doc.fillColor("#c7d2fe").font("Helvetica").fontSize(8)
        .text(`Quote ${quoteNumber}`, 370, 51, { width: 185, align: "right" })
        .text(`Issued ${pdfDate(quote.createdAt, tenant?.locale)}`, 370, 66, { width: 185, align: "right" });
      doc.roundedRect(452, 91, 103, 23, 11).fill(statusColor);
      doc.fillColor(colors.white).font("Helvetica-Bold").fontSize(8)
        .text(String(quote.status || "Draft").toUpperCase(), 452, 99, { width: 103, align: "center" });
      doc.restore();
      doc.y = 150;
    };

    const drawCard = (x, y, width, height, title, rows) => {
      doc.save();
      doc.roundedRect(x, y, width, height, 9).fill(colors.white).strokeColor(colors.border).stroke();
      doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(8)
        .text(title.toUpperCase(), x + 14, y + 13, { width: width - 28, characterSpacing: 0.5 });
      let rowY = y + 34;
      for (const [label, value] of rows) {
        doc.fillColor(colors.muted).font("Helvetica").fontSize(7.5)
          .text(label, x + 14, rowY, { width: 82 });
        doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(8.5)
          .text(pdfTextValue(value), x + 98, rowY - 1, { width: width - 112, height: 14, ellipsis: true });
        rowY += 18;
      }
      doc.restore();
    };

    const drawAddressCard = (x, y, width, title, address) => {
      doc.save();
      doc.roundedRect(x, y, width, 94, 9).fill(colors.white).strokeColor(colors.border).stroke();
      doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(8)
        .text(title.toUpperCase(), x + 14, y + 13, { width: width - 28, characterSpacing: 0.5 });
      doc.fillColor(colors.text).font("Helvetica").fontSize(9)
        .text(pdfTextValue(address, "Address not provided"), x + 14, y + 35, {
          width: width - 28,
          height: 55,
          lineGap: 2,
          ellipsis: true,
        });
      doc.restore();
    };

    drawFirstHeader();
    const overviewTop = 150;
    drawCard(left, overviewTop, 249, 96, "Quote details", [
      ["Quote number", quoteNumber],
      ["Issued", pdfDate(quote.createdAt, tenant?.locale)],
      ["Valid until", validUntilDisplay],
    ]);
    drawCard(306, overviewTop, 249, 96, "Customer", [
      ["Name", customerName],
      ["Email", customerEmail],
      ["Account", quote.accountName || "Direct customer"],
    ]);
    const addressTop = overviewTop + 110;

    drawAddressCard(left, addressTop, 249, "Bill to", billing);
    drawAddressCard(306, addressTop, 249, "Ship to", shipping);
    const itemsTop = addressTop + 110;
    doc.y = itemsTop;

    const drawItemsHeader = (y) => {
      doc.save();
      doc.roundedRect(left, y, contentWidth, 29, 6).fill(colors.tableHeader);
      doc.fillColor(colors.muted).font("Helvetica-Bold").fontSize(7.5)
        .text("ITEM", 52, y + 10, { width: 215 })
        .text("QTY", 282, y + 10, { width: 42, align: "right" })
        .text("UNIT PRICE", 334, y + 10, { width: 88, align: "right" })
        .text("GST", 430, y + 10, { width: 52, align: "right" })
        .text("TOTAL", 492, y + 10, { width: 63, align: "right" });
      doc.restore();
      return y + 29;
    };

    doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(13).text("Quoted items", left, itemsTop);
    let itemsY = drawItemsHeader(itemsTop + 20);
    const lines = quote.lineItems || [];
    if (!lines.length) {
      doc.fillColor(colors.muted).font("Helvetica").fontSize(9)
        .text("No line items were added to this quote.", 52, itemsY + 16, { width: contentWidth - 24 });
      itemsY += 45;
    }
    lines.forEach((line, index) => {
      doc.font("Helvetica").fontSize(8);
      const description = pdfTextValue(line.description, "");
      const descriptionHeight = description
        ? Math.min(28, doc.heightOfString(description, { width: 215, lineGap: 1 }))
        : 0;
      const rowHeight = Math.max(45, 23 + descriptionHeight);
      if (itemsY + rowHeight > pageBottom()) {
        addPage();
        itemsY = drawItemsHeader(doc.y);
      }
      if (index % 2 === 1) doc.rect(left, itemsY, contentWidth, rowHeight).fill(colors.rowAlt);
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(9)
        .text(pdfTextValue(line.productName, "Item"), 52, itemsY + 10, { width: 215, height: 13, ellipsis: true });
      if (description) {
        doc.fillColor(colors.muted).font("Helvetica").fontSize(8)
          .text(description, 52, itemsY + 24, { width: 215, height: 27, lineGap: 1, ellipsis: true });
      }
      doc.fillColor(colors.text).font("Helvetica").fontSize(8.5)
        .text(String(line.quantity ?? 0), 282, itemsY + 12, { width: 42, align: "right" })
        .text(pdfMoney(line.unitPrice, currency), 334, itemsY + 12, { width: 88, align: "right" })
        .text(`${numberValue(line.gstRate).toFixed(2)}%`, 430, itemsY + 12, { width: 52, align: "right" })
        .text(pdfMoney(line.total, currency), 492, itemsY + 12, { width: 63, align: "right" });
      doc.moveTo(left, itemsY + rowHeight).lineTo(right, itemsY + rowHeight).strokeColor(colors.border).stroke();
      itemsY += rowHeight;
    });
    doc.y = itemsY + 18;

    const drawTotals = (y) => {
      const boxX = 296;
      const boxWidth = right - boxX;
      const boxHeight = 132;
      doc.save();
      doc.fillColor(colors.muted).font("Helvetica").fontSize(9.5);
      const rows = [
        ["Subtotal", pdfMoney((quote.lineItems || []).reduce((sum, line) => sum + numberValue(line.amount), 0), currency)],
        ["Discount", numberValue(quote.discountTotal) ? `-${pdfMoney(quote.discountTotal, currency)}` : pdfMoney(0, currency)],
        ["GST", pdfMoney(quote.taxTotal, currency)],
        ["Adjustment", pdfMoney(quote.adjustment, currency)],
      ];
      rows.forEach(([label, value], index) => {
        const rowY = y + 10 + index * 20;
        doc.text(label, boxX + 16, rowY, { width: 90 });
        doc.text(value, boxX + 112, rowY, { width: boxWidth - 128, align: "right" });
      });
      doc.moveTo(boxX + 16, y + 88).lineTo(right - 16, y + 88).strokeColor(colors.border).stroke();
      doc.roundedRect(boxX + 1, y + 99, boxWidth - 2, 33, 8).fill(colors.accentLight);
      doc.fillColor(colors.text).font("Helvetica-Bold").fontSize(10)
        .text("GRAND TOTAL", boxX + 16, y + 110, { width: 105 });
      doc.fillColor(colors.accent).fontSize(14)
        .text(pdfMoney(quote.totalAmount, currency), boxX + 112, y + 107, { width: boxWidth - 128, align: "right" });
      doc.restore();
      return y + boxHeight;
    };

    const drawTextSection = (title, value) => {
      if (!value) return;
      doc.font("Helvetica").fontSize(9.5);
      const textHeight = doc.heightOfString(String(value), { width: contentWidth, lineGap: 3 });
      ensureSpace(textHeight + 60);
      const sectionTop = doc.y;
      doc.fillColor(colors.accent).font("Helvetica-Bold").fontSize(8)
        .text(title.toUpperCase(), left, sectionTop, { width: contentWidth, characterSpacing: 0.6 });
      doc.moveTo(left, sectionTop + 18).lineTo(right, sectionTop + 18).strokeColor(colors.border).stroke();
      doc.fillColor(colors.text).font("Helvetica").fontSize(9.5)
        .text(value, left, sectionTop + 29, { width: contentWidth, lineGap: 3 });
      doc.y = sectionTop + 29 + textHeight + 22;
    };

    ensureSpace(185);
    const totalsBottom = drawTotals(doc.y);
    doc.y = totalsBottom + 12;
    drawTextSection("Description", quote.description);
    drawTextSection("Terms and conditions", quote.terms);
    drawTextSection("Notes", quote.notes);

    const pageRange = doc.bufferedPageRange();
    for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      doc.save();
      const footerLineY = doc.page.height - 54;
      const footerTextY = doc.page.height - 49;
      doc.moveTo(left, footerLineY).lineTo(right, footerLineY).strokeColor(colors.border).stroke();
      doc.fillColor(colors.muted).font("Helvetica").fontSize(7.5)
        .text(`${tenantName}  •  ${quoteNumber}`, left, footerTextY, { width: 300, lineBreak: false })
        .text(`Page ${pageIndex - pageRange.start + 1} of ${pageRange.count}`, 420, footerTextY, { width: 135, align: "right", lineBreak: false });
      doc.restore();
    }
    doc.end();
  } catch (error) {
    console.error("[quotes] pdf error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate quote PDF", code: "QUOTE_PDF_FAILED" });
  }
});

router.get("/", verifyToken, requirePermission("quotes", "read"), async (req, res) => {
  try {
    const page = Math.max(1, integerValue(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, integerValue(req.query.limit, 10)));
    const status = clean(req.query.status);
    const search = clean(req.query.search);
    const where = { tenantId: req.user.tenantId };
    if (ALLOWED_STATUSES.has(status)) where.status = status;
    if (search) {
      where.OR = [
        { quoteNumber: { contains: search } },
        { title: { contains: search } },
        { customerName: { contains: search } },
        { accountName: { contains: search } },
      ];
    }
    const [data, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        include: { contact: true, deal: true, lineItems: { select: { id: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.quote.count({ where }),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 } });
  } catch (error) {
    console.error("[quotes] list error:", error.message);
    res.status(500).json({ error: "Failed to fetch quotes", code: "QUOTE_LIST_FAILED" });
  }
});

router.get("/:id", verifyToken, requirePermission("quotes", "read"), async (req, res) => {
  try {
    const id = integerValue(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid quote ID", code: "INVALID_QUOTE_ID" });
    const quote = await prisma.quote.findFirst({ where: { id, tenantId: req.user.tenantId }, include: { contact: true, deal: true, lineItems: true } });
    if (!quote) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    res.json(quote);
  } catch (error) {
    console.error("[quotes] detail error:", error.message);
    res.status(500).json({ error: "Failed to fetch quote", code: "QUOTE_DETAIL_FAILED" });
  }
});

router.post("/", verifyToken, requirePermission("quotes", "write"), async (req, res) => {
  try {
    const result = await createQuoteRecord({ body: req.body || {}, tenantId: req.user.tenantId, userId: req.user.userId });
    if (result?.error) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) {
    console.error("[quotes] create error:", error.message);
    if (error.code === "P2002") return res.status(409).json({ error: "Quote number already exists", code: "QUOTE_NUMBER_EXISTS" });
    res.status(500).json({ error: "Failed to create quote", code: "QUOTE_CREATE_FAILED" });
  }
});

router.patch("/:id", verifyToken, requirePermission("quotes", "update"), async (req, res) => {
  try {
    const id = integerValue(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid quote ID", code: "INVALID_QUOTE_ID" });
    const existing = await prisma.quote.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { lineItems: true },
    });
    if (!existing) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });

    const prepared = await prepareQuotePayload({ body: req.body || {}, tenantId: req.user.tenantId, existingQuote: existing });
    if (prepared.error) return res.status(400).json(prepared);

    const quote = await prisma.$transaction((tx) => tx.quote.update({
      where: { id },
      data: {
        ...prepared.data,
        lineItems: { deleteMany: {}, create: prepared.lines },
      },
      include: { contact: true, deal: true, lineItems: true },
    }));
    await writeAudit("Quote", "UPDATE", id, req.user.userId, req.user.tenantId, {
      quoteNumber: quote.quoteNumber,
      subject: quote.title,
      totalAmount: quote.totalAmount,
      lineItemCount: prepared.lines.length,
    });
    res.json(quote);
  } catch (error) {
    console.error("[quotes] update error:", error.message);
    if (error.code === "P2002") return res.status(409).json({ error: "Quote number already exists", code: "QUOTE_NUMBER_EXISTS" });
    res.status(500).json({ error: "Failed to update quote", code: "QUOTE_UPDATE_FAILED" });
  }
});

router.patch("/:id/status", verifyToken, requirePermission("quotes", "update"), async (req, res) => {
  try {
    const id = integerValue(req.params.id);
    const status = clean(req.body?.status);
    if (!id) return res.status(400).json({ error: "Invalid quote ID", code: "INVALID_QUOTE_ID" });
    if (!ALLOWED_STATUSES.has(status)) return res.status(400).json({ error: "Invalid quote status", code: "INVALID_STATUS" });
    const existing = await prisma.quote.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    const quote = await prisma.quote.update({ where: { id }, data: { status }, include: { contact: true, deal: true, lineItems: true } });
    await writeAudit("Quote", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: { status: { from: existing.status, to: status } } });
    res.json(quote);
  } catch (error) {
    console.error("[quotes] status error:", error.message);
    res.status(500).json({ error: "Failed to update quote status", code: "QUOTE_STATUS_FAILED" });
  }
});

router.delete("/:id", verifyToken, requirePermission("quotes", "delete"), async (req, res) => {
  try {
    const id = integerValue(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid quote ID", code: "INVALID_QUOTE_ID" });
    const existing = await prisma.quote.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    await prisma.quote.delete({ where: { id } });
    await writeAudit("Quote", "DELETE", id, req.user.userId, req.user.tenantId, { quoteNumber: existing.quoteNumber, subject: existing.title });
    res.json({ ok: true });
  } catch (error) {
    console.error("[quotes] delete error:", error.message);
    res.status(500).json({ error: "Failed to delete quote", code: "QUOTE_DELETE_FAILED" });
  }
});

module.exports = router;
