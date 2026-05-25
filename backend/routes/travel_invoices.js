/**
 * /api/travel/invoices — TravelInvoice CRUD (PRD_TRAVEL_BILLING DD-5.1)
 *
 * Third in the Quote/Invoice/Supplier trio. Schema at commit fdb793e
 * (2026-05-24 tick #94). Mirrors backend/routes/travel_quotes.js (commit
 * b02c091, tick #96) — same auth + sub-brand + audit conventions.
 *
 * Future slices (not in this commit): multi-stage settlement schedules
 * (PRD §3.2), supplier-payable ledger reconciliation (PRD §3.3 cross-PRD
 * with Supplier Master), TCS Sec 206C (PRD §3.5), per-sub-brand PDF
 * templates (DD-5.7 pending Q22 Yasin brand handover), payment-collection
 * webhook (depends on #896 Stripe/Razorpay activation), reminder cadence
 * (DD-5.5 RESOLVED: hard-coded T-7/T-3/T-1 + all-channels with opt-out).
 *
 * invoiceNum format: TINV-YYYY-NNNN (tenant-scoped serial reset annually).
 * Race-safe via $transaction. The @@unique([tenantId, invoiceNum]) on the
 * schema is the backstop for any race that slips the transaction.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const pdfRenderer = require("../services/pdfRenderer");
const { invoicePrefixFor, fiscalYearStart } = require("../lib/travelFiscalYear");
const { computeTcs, isOverseasDestination } = require("../lib/tcsCalculation");
// Arc 2 #902 slice 7 — GST tax-preview pipeline (CGST/SGST/IGST math +
// state-code resolver + SAC codes + GSTR-1 HSN-summary grouping). The
// invoice tax-preview endpoint mirrors backend/routes/travel_quotes.js
// /quotes/:id/tax-preview (slice 6, commit b9833a0e) — same envelope,
// same library consumers, scoped to TravelInvoiceLine instead of
// TravelQuoteLine.
const {
  computeGstForLines,
  isInterstateSupply,
  gstRateForCategory,
} = require("../lib/gstCalculation");
const { resolveStateCodes } = require("../lib/gstStateCodeResolver");
const {
  sacForLineType,
  descriptionForSac,
  groupLinesBySac,
} = require("../lib/hsnSacMapper");

const VALID_INVOICE_STATUSES = ["Draft", "Issued", "Partial", "Paid", "Voided"];

// Arc 2 #901 slice 11 — PRD_TRAVEL_BILLING FR-3.x doc-type taxonomy.
// Travel verticals need to issue more than just a "TaxInvoice": Proforma
// (pre-payment quote-like bill), CreditNote / DebitNote (post-invoice
// adjustments), and TravelVoucher (supplier-passthrough receipt). The
// docType field on TravelInvoice persists which class a given row is;
// NULL is treated as "TaxInvoice" for back-compat with pre-slice-11 rows.
// Separate CreditNote/DebitNote routing (different sequence, different
// PDF template) lands in slice 12; this slice ships the field + filter.
const VALID_INVOICE_DOC_TYPES = [
  "Proforma",
  "TaxInvoice",
  "CreditNote",
  "DebitNote",
  "TravelVoucher",
];

function assertValidDocType(s) {
  if (s == null) return;
  if (!VALID_INVOICE_DOC_TYPES.includes(s)) {
    const err = new Error(
      `docType must be one of: ${VALID_INVOICE_DOC_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_DOC_TYPE";
    throw err;
  }
}

// PRD_TRAVEL_BILLING FR-3.1.a — line-type enum for invoice line items.
// Extends the TravelQuoteLine enum (hotel/flight/transport/visa/service/other)
// with billing-side classifications (tax/fee/addon/tcs/tds) needed for the
// per-line tax + withholding ledger surface.
const VALID_INVOICE_LINE_TYPES = [
  "per_pax",
  "per_room",
  "per_night",
  "per_trip",
  "tax",
  "fee",
  "addon",
  "tcs",
  "tds",
  "other",
];

function assertValidInvoiceLineType(t) {
  if (t == null) return;
  if (!VALID_INVOICE_LINE_TYPES.includes(t)) {
    const err = new Error(
      `lineType must be one of: ${VALID_INVOICE_LINE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_LINE_TYPE";
    throw err;
  }
}

// Duplicated from travel_quotes.js intentionally — the rule-of-3 promotion
// to a shared helper happens when a third caller lands (likely the upcoming
// #903 Supplier Master line variant). Keeping locally for now keeps the
// slice tight.
function parsePositiveDecimal(input, fieldName) {
  if (input == null || input === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${fieldName} must be a non-negative number`);
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return n;
}

function parsePositiveInt(input, fieldName, fallback) {
  if (input == null || input === "") return fallback;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.status = 400;
    err.code = "INVALID_QUANTITY";
    throw err;
  }
  return n;
}

// PRD_TRAVEL_BILLING FR-3.1.b helpers — PNR / bookingRef caps.
// Free-form strings; we cap lengths to avoid abuse but don't enforce a
// shape (vendors vary: airline 6-char alphanumeric vs hotel CRS strings).
// Empty string after trim returns null so the field stays clean.
const PNR_MAX_LEN = 20;
const BOOKING_REF_MAX_LEN = 50;

function parseBookingRefField(input, fieldName, maxLen, errCode) {
  if (input == null) return undefined;
  // Explicit null clears the field on PUT.
  if (input === null) return null;
  const s = String(input).trim();
  if (s === "") return null;
  if (s.length > maxLen) {
    const err = new Error(`${fieldName} must be <= ${maxLen} characters`);
    err.status = 400;
    err.code = errCode;
    throw err;
  }
  return s;
}

// PRD_TRAVEL_BILLING FR-3.1.d helper — service-date parser.
// Returns a Date instance or null (for explicit null). Returns undefined
// if the field is absent from the body (so PUT partial-updates leave the
// existing value alone). Throws 400 INVALID_SERVICE_DATE on unparseable
// input.
function parseServiceDate(input, fieldName) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`${fieldName} must be a valid date`);
    err.status = 400;
    err.code = "INVALID_SERVICE_DATE";
    throw err;
  }
  return d;
}

// Arc 2 #901 slice 12 — PRD_TRAVEL_BILLING UC-2.1 multi-currency helpers.
// fxRateToBase is the operator-captured conversion rate from the line's
// currency to the parent invoice's base currency at the time of entry.
// baseAmount = amount * fxRateToBase, computed + persisted (round-half-up
// at 2dp to match the existing Decimal(15,2) convention).
//
// Three semantic states across POST + PUT:
//   undefined → field absent from body; on POST persist null, on PUT
//               leave existing value alone.
//   null      → operator explicitly clearing the field; line becomes
//               single-currency, baseAmount cleared in lockstep.
//   number>0  → valid rate; baseAmount recomputed.
//
// Live FX-rate lookup against an external API is deferred (Q-blocker —
// pending exchange-rate-provider decision).
function parseFxRateToBase(input) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === "string" && input.trim() === "") return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error("fxRateToBase must be a positive number");
    err.status = 400;
    err.code = "INVALID_FX_RATE";
    throw err;
  }
  return n;
}

// Round to 2dp using half-up semantics (JavaScript's Math.round is
// half-to-even for negatives in some engines but half-up for positives,
// which is what we want for monetary values).
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Validate the service-date range when BOTH ends are present.
// Inclusive semantics — same-day single-night / single-day transfer is
// legal (start === end). Throws 400 INVALID_SERVICE_DATE_RANGE on
// inversion.
function assertServiceDateRange(start, end) {
  if (start == null || end == null) return;
  if (!(start instanceof Date) || !(end instanceof Date)) return;
  if (end.getTime() < start.getTime()) {
    const err = new Error("serviceEndDate must be on or after serviceStartDate");
    err.status = 400;
    err.code = "INVALID_SERVICE_DATE_RANGE";
    throw err;
  }
}

// Recompute the invoice's totalAmount as the sum of its lines and persist.
// Called from POST/PUT/DELETE /lines. Idempotent. Skipped if the lines
// table is empty (totalAmount stays at whatever the operator typed at
// invoice-create time — operators can author header-only invoices that
// don't need line-itemisation).
async function recomputeInvoiceTotal(invoiceId, tenantId) {
  const lines = await prisma.travelInvoiceLine.findMany({
    where: { invoiceId, tenantId },
    select: { amount: true },
  });
  if (lines.length === 0) return;
  const total = lines.reduce((acc, l) => acc + Number(l.amount || 0), 0);
  await prisma.travelInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: total },
  });
}

// Allowed forward-only status transitions (any status may also go to Voided).
// Reject backward transitions (e.g. Paid -> Issued) with 422.
const ALLOWED_TRANSITIONS = {
  Draft: new Set(["Issued", "Voided"]),
  Issued: new Set(["Partial", "Paid", "Voided"]),
  Partial: new Set(["Paid", "Voided"]),
  Paid: new Set(["Voided"]),
  Voided: new Set([]),
};

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_INVOICE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_INVOICE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

/**
 * Parse + validate a dueDate. Accepts ISO 8601 strings or anything Date
 * can swallow; rejects unparseable input. Past dates are allowed
 * (back-dated invoicing is a legitimate ops case — e.g. issuing an
 * invoice after the trip already departed).
 *
 * Returns the parsed Date (or null if input was nullish).
 */
function parseDueDate(input) {
  if (input == null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("dueDate must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

/**
 * Atomic per-tenant invoice-number generator. Format: TINV-YYYY-NNNN.
 * The serial resets each calendar year; lookup is scoped to (tenantId,
 * invoiceNum LIKE "TINV-YYYY-%") so cross-year reuse never collides.
 *
 * Race safety: wrapped in $transaction so two concurrent POSTs read the
 * same "latest" and assign distinct serials. The @@unique on the schema
 * is the second-line backstop if the transaction's isolation level
 * permits a phantom read on a particular MySQL config.
 */
async function nextInvoiceNum(tenantId) {
  const year = new Date().getFullYear();
  return await prisma.$transaction(async (tx) => {
    const latest = await tx.travelInvoice.findFirst({
      where: { tenantId, invoiceNum: { startsWith: `TINV-${year}-` } },
      orderBy: { invoiceNum: "desc" },
      select: { invoiceNum: true },
    });
    const latestSerial = latest
      ? parseInt(latest.invoiceNum.split("-")[2], 10)
      : 0;
    const next = String(latestSerial + 1).padStart(4, "0");
    return `TINV-${year}-${next}`;
  });
}

/**
 * #901 slice 5 — Per-sub-brand per-fiscal-year invoice serial helper.
 *
 * Coexists with nextInvoiceNum (which keeps the create-time TINV-YYYY-NNNN
 * scheme intact for back-compat with all existing tests and the frontend
 * InvoicesAdmin list view). This helper is invoked ONLY by the operator-
 * triggered Draft -> Issued transition at POST /:id/issue, where the
 * customer-facing invoice number is committed.
 *
 * Format: "<PREFIX>/<NNNN>" where <PREFIX> is produced by
 * invoicePrefixFor(subBrand, date) (e.g. "TMC/26-27", "RFU/26-27",
 * "TS/26-27", "VS/26-27"). Serial pads to 4 digits and resets per
 * (tenantId, subBrand, fiscal year).
 *
 * Race-safe via $transaction, same shape as nextInvoiceNum. The
 * @@unique([tenantId, invoiceNum]) on TravelInvoice is the second-line
 * backstop if the transaction's isolation level permits a phantom read.
 */
async function nextSubBrandInvoiceNum(tenantId, subBrand, date = new Date()) {
  const prefix = invoicePrefixFor(subBrand, date); // e.g. "TMC/26-27"
  return await prisma.$transaction(async (tx) => {
    const latest = await tx.travelInvoice.findFirst({
      where: { tenantId, invoiceNum: { startsWith: `${prefix}/` } },
      orderBy: { invoiceNum: "desc" },
      select: { invoiceNum: true },
    });
    const lastSerial = latest
      ? parseInt(latest.invoiceNum.split("/").pop(), 10) || 0
      : 0;
    return `${prefix}/${String(lastSerial + 1).padStart(4, "0")}`;
  });
}

// GET /api/travel/invoices
// Honors ?subBrand=tmc + ?status=Issued + ?contactId=N + ?quoteId=N.
router.get(
  "/invoices",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.status) {
        assertValidStatus(String(req.query.status));
        where.status = String(req.query.status);
      }
      if (req.query.contactId) {
        const cid = parseInt(req.query.contactId, 10);
        if (!Number.isFinite(cid)) {
          return res.status(400).json({
            error: "contactId must be a number",
            code: "INVALID_CONTACT_ID",
          });
        }
        where.contactId = cid;
      }
      if (req.query.quoteId) {
        const qid = parseInt(req.query.quoteId, 10);
        if (!Number.isFinite(qid)) {
          return res.status(400).json({
            error: "quoteId must be a number",
            code: "INVALID_QUOTE_ID",
          });
        }
        where.quoteId = qid;
      }
      if (req.query.docType) {
        assertValidDocType(String(req.query.docType));
        where.docType = String(req.query.docType);
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [invoices, total] = await Promise.all([
        prisma.travelInvoice.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          take,
          skip,
        }),
        prisma.travelInvoice.count({ where }),
      ]);
      res.json({ invoices, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] list error:", e.message);
      res.status(500).json({ error: "Failed to list invoices" });
    }
  },
);

// GET /api/travel/invoices/:id
//
// #901 slice 3 (PRD_TRAVEL_BILLING UC-2.5): supports ?include=lines to return
// the invoice's TravelInvoiceLine rows in the same response (single round-trip
// composite document read). Multiple includes can be comma-separated for
// forward compat (e.g. ?include=lines,payments), but only "lines" is honored
// in this slice; unknown tokens are silently skipped. Omitting the param
// preserves the original header-only response shape (no `lines` field added).
router.get(
  "/invoices/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Parse ?include=lines[,...]. Comma-separated, trimmed, case-sensitive.
      // Only the "lines" token is honored in this slice — unknown tokens are
      // silently skipped (forward-compat for future include=payments etc.).
      const includeTokens = req.query.include
        ? String(req.query.include)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const payload = { ...invoice };
      if (includeTokens.includes("lines")) {
        const lines = await prisma.travelInvoiceLine.findMany({
          where: { invoiceId: id, tenantId: req.travelTenant.id },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        });
        payload.lines = lines;
      }
      res.json(payload);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] get error:", e.message);
      res.status(500).json({ error: "Failed to get invoice" });
    }
  },
);

// POST /api/travel/invoices — ADMIN/MANAGER only.
// Required: contactId, totalAmount, currency, dueDate.
// Optional: subBrand (per Q25 — defaults to "tmc"), quoteId, status (default "Draft").
router.post(
  "/invoices",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        contactId,
        totalAmount,
        currency,
        dueDate,
        subBrand,
        quoteId,
        status,
        docType,
      } = req.body || {};

      if (
        contactId == null ||
        totalAmount == null ||
        !currency ||
        dueDate == null
      ) {
        return res.status(400).json({
          error: "contactId, totalAmount, currency, dueDate required",
          code: "MISSING_FIELDS",
        });
      }

      const contactIdInt = parseInt(contactId, 10);
      if (!Number.isFinite(contactIdInt)) {
        return res.status(400).json({
          error: "contactId must be a number",
          code: "INVALID_CONTACT_ID",
        });
      }

      let quoteIdInt = null;
      if (quoteId != null) {
        quoteIdInt = parseInt(quoteId, 10);
        if (!Number.isFinite(quoteIdInt)) {
          return res.status(400).json({
            error: "quoteId must be a number",
            code: "INVALID_QUOTE_ID",
          });
        }
      }

      assertValidStatus(status);
      if (subBrand) assertValidSubBrand(subBrand);
      // Slice 11 — explicit empty string is treated as "use default" (NULL on
      // create, so Prisma applies the column default "TaxInvoice"); a present
      // non-empty value is validated against the enum. Undefined means "field
      // not in body" — fall through to Prisma's default.
      if (docType !== undefined && docType !== "") {
        assertValidDocType(docType);
      }
      const parsedDueDate = parseDueDate(dueDate);

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_quotes POST.
      const targetSubBrand = subBrand || "tmc";
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const invoiceNum = await nextInvoiceNum(req.travelTenant.id);

      const createData = {
        tenantId: req.travelTenant.id,
        subBrand: targetSubBrand,
        contactId: contactIdInt,
        quoteId: quoteIdInt,
        invoiceNum,
        status: status || "Draft",
        totalAmount: totalAmount,
        currency: String(currency),
        dueDate: parsedDueDate,
      };
      // Only pass docType if the caller supplied a non-empty value — empty
      // string / undefined falls through to the schema default ("TaxInvoice").
      if (docType !== undefined && docType !== "") {
        createData.docType = docType;
      }
      const created = await prisma.travelInvoice.create({
        data: createData,
      });

      await writeAudit(
        "TravelInvoice",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          quoteId: created.quoteId,
          invoiceNum: created.invoiceNum,
          status: created.status,
          currency: created.currency,
          docType: created.docType,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] create error:", e.message);
      res.status(500).json({ error: "Failed to create invoice" });
    }
  },
);

// PUT /api/travel/invoices/:id — ADMIN/MANAGER only.
// invoiceNum is immutable; status transitions enforced forward-only
// (any status may also go to Voided).
router.put(
  "/invoices/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        contactId,
        totalAmount,
        currency,
        dueDate,
        subBrand,
        quoteId,
        status,
        paidAt,
        docType,
      } = req.body || {};

      if (contactId !== undefined) {
        const ci = parseInt(contactId, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({
            error: "contactId must be a number",
            code: "INVALID_CONTACT_ID",
          });
        }
        data.contactId = ci;
      }
      if (quoteId !== undefined) {
        if (quoteId === null) {
          data.quoteId = null;
        } else {
          const qi = parseInt(quoteId, 10);
          if (!Number.isFinite(qi)) {
            return res.status(400).json({
              error: "quoteId must be a number",
              code: "INVALID_QUOTE_ID",
            });
          }
          data.quoteId = qi;
        }
      }
      if (totalAmount !== undefined) data.totalAmount = totalAmount;
      if (currency !== undefined) data.currency = String(currency);
      if (status !== undefined) {
        assertValidStatus(status);
        // Enforce forward-only transitions (any -> Voided always allowed).
        if (status !== existing.status) {
          const allowedNext = ALLOWED_TRANSITIONS[existing.status] || new Set();
          if (!allowedNext.has(status)) {
            return res.status(422).json({
              error: `Cannot transition from ${existing.status} to ${status}`,
              code: "INVALID_INVOICE_TRANSITION",
            });
          }
        }
        data.status = status;
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
        data.subBrand = subBrand;
      }
      if (dueDate !== undefined) {
        data.dueDate = parseDueDate(dueDate);
      }
      if (paidAt !== undefined) {
        if (paidAt === null) {
          data.paidAt = null;
        } else {
          const p = new Date(paidAt);
          if (Number.isNaN(p.getTime())) {
            return res.status(400).json({
              error: "paidAt must be a parseable date",
              code: "INVALID_PAID_AT",
            });
          }
          data.paidAt = p;
        }
      }
      if (docType !== undefined) {
        // Empty string OR explicit null on PUT clears back to default
        // ("TaxInvoice" via schema default — Prisma write null then the
        // route layer treats null as "TaxInvoice" on read).
        if (docType === null || docType === "") {
          data.docType = null;
        } else {
          assertValidDocType(docType);
          data.docType = docType;
        }
      }

      if (Object.keys(data).length === 0) {
        return res
          .status(400)
          .json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelInvoice.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelInvoice",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] update error:", e.message);
      res.status(500).json({ error: "Failed to update invoice" });
    }
  },
);

// DELETE /api/travel/invoices/:id — ADMIN/MANAGER only.
// Only Draft invoices may be hard-deleted. Voided invoices stay for
// audit trail; any other status -> 422 INVOICE_DELETE_FORBIDDEN.
router.delete(
  "/invoices/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if (existing.status !== "Draft") {
        return res.status(422).json({
          error: `Only Draft invoices may be deleted (current status: ${existing.status})`,
          code: "INVOICE_DELETE_FORBIDDEN",
        });
      }

      // Audit BEFORE delete (same pattern as travel_quotes).
      await writeAudit(
        "TravelInvoice",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          contactId: existing.contactId,
          invoiceNum: existing.invoiceNum,
          status: existing.status,
        },
      );

      await prisma.travelInvoice.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete invoice" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/issue — Arc 2 #901 slice 5.
//
// Operator-action state transition: Draft -> Issued. Replaces the
// create-time TINV-YYYY-NNNN serial with a per-sub-brand per-fiscal-year
// customer-facing number (e.g. "TMC/26-27/0001"). PRD_TRAVEL_BILLING UC-2.5.
//
// Auth: ADMIN/MANAGER only.
// Pre-conditions: invoice exists, tenant-scoped, sub-brand-accessible,
//   status === 'Draft'.
// Side effects: invoiceNum reassigned via nextSubBrandInvoiceNum,
//   status -> 'Issued', audit row stamped action='TRAVEL_INVOICE_ISSUED'
//   with details { oldInvoiceNum, newInvoiceNum, subBrand }.
//
// Returns: 200 + updated invoice row (NOT 201 — this is a state
// transition, not a resource creation).
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404),
//   SUB_BRAND_DENIED (403), INVALID_STATE (400 — not in Draft).
//
// NOTE on schema: TravelInvoice has no issuedAt column today. The
// existing updatedAt @updatedAt timestamp captures the transition moment
// transparently; if Q-future surfaces a need for a dedicated issuedAt
// column for reporting, that's an additive schema change in a later
// slice (out of scope here per the slice-5 file budget).
// ============================================================================
router.post(
  "/invoices/:id/issue",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res.status(404).json({
          error: "Invoice not found",
          code: "INVOICE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      if (invoice.status !== "Draft") {
        return res.status(400).json({
          error: `Only Draft invoices may be issued (current status: ${invoice.status})`,
          code: "INVALID_STATE",
        });
      }

      const oldInvoiceNum = invoice.invoiceNum;
      const newInvoiceNum = await nextSubBrandInvoiceNum(
        req.travelTenant.id,
        invoice.subBrand,
      );

      const updated = await prisma.travelInvoice.update({
        where: { id },
        data: {
          invoiceNum: newInvoiceNum,
          status: "Issued",
        },
      });

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_ISSUED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          oldInvoiceNum,
          newInvoiceNum,
          subBrand: updated.subBrand,
        },
      );

      res.status(200).json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] issue error:", e.message);
      res.status(500).json({ error: "Failed to issue invoice" });
    }
  },
);

// ============================================================================
// /api/travel/invoices/:id/lines — line-item composition (PRD_TRAVEL_BILLING
// FR-3.1.a). Mirrors travel_quotes.js /quotes/:id/lines (commit f7203b8e) —
// same auth + sub-brand + audit conventions. Each write triggers an audit
// row + recomputeInvoiceTotal to keep the invoice header consistent with
// its composition. Lines inherit tenant + sub-brand scoping from their
// parent invoice (no separate sub-brand column on the line — looked up
// via the FK).
//
// Auth: read endpoints accept any verified token; write endpoints require
// ADMIN/MANAGER. Same shape as the parent invoice routes.
// ============================================================================

// Helper: load the parent invoice tenant-scoped + sub-brand-scoped.
// Returns the invoice on success or sends an HTTP response on failure
// (caller short-circuits if !invoice).
async function loadParentInvoice(req, res, invoiceId) {
  if (!Number.isFinite(invoiceId)) {
    res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    return null;
  }
  const invoice = await prisma.travelInvoice.findFirst({
    where: { id: invoiceId, tenantId: req.travelTenant.id },
  });
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found", code: "INVOICE_NOT_FOUND" });
    return null;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, invoice.subBrand)) {
    res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    return null;
  }
  return invoice;
}

// GET /api/travel/invoices/:id/lines — list lines for an invoice.
router.get(
  "/invoices/:id/lines",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      res.json({ lines, total: lines.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] list lines error:", e.message);
      res.status(500).json({ error: "Failed to list invoice lines" });
    }
  },
);

// POST /api/travel/invoices/:id/lines — ADMIN/MANAGER only.
// Required: description, unitPrice. Optional: lineType (default "other"),
// quantity (default 1), currency (default invoice currency), sortOrder, notes,
// pnr, bookingRef, serviceStartDate, serviceEndDate (PRD §3.1.b + §3.1.d).
router.post(
  "/invoices/:id/lines",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const {
        lineType, description, quantity, unitPrice,
        currency, sortOrder, notes,
        pnr, bookingRef, serviceStartDate, serviceEndDate,
        fxRateToBase,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({
          error: "description is required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidInvoiceLineType(lineType);
      const qty = parsePositiveInt(quantity, "quantity", 1);
      const unit = parsePositiveDecimal(unitPrice, "unitPrice");
      const amount = qty * unit;
      // PRD FR-3.1.b — PNR + bookingRef parsing (length-capped, empty→null).
      const parsedPnr = parseBookingRefField(pnr, "pnr", PNR_MAX_LEN, "INVALID_PNR");
      const parsedBookingRef = parseBookingRefField(
        bookingRef, "bookingRef", BOOKING_REF_MAX_LEN, "INVALID_BOOKING_REF",
      );
      // PRD FR-3.1.d — service-date parsing + inversion check.
      const parsedStart = parseServiceDate(serviceStartDate, "serviceStartDate");
      const parsedEnd = parseServiceDate(serviceEndDate, "serviceEndDate");
      assertServiceDateRange(parsedStart, parsedEnd);
      // Arc 2 #901 slice 12 — UC-2.1 FX-aware multi-currency line.
      // null / undefined → single-currency line (baseAmount stays null);
      // positive number → server computes baseAmount = round2(amount * fx).
      const parsedFx = parseFxRateToBase(fxRateToBase);
      const fxFields = parsedFx == null
        ? { fxRateToBase: null, baseAmount: null }
        : { fxRateToBase: parsedFx, baseAmount: round2(amount * parsedFx) };

      const created = await prisma.travelInvoiceLine.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          lineType: lineType || "other",
          description: description.trim(),
          quantity: qty,
          unitPrice: unit,
          amount,
          currency: currency ? String(currency) : invoice.currency,
          sortOrder: Number.isFinite(parseInt(sortOrder, 10))
            ? parseInt(sortOrder, 10) : 0,
          notes: notes ? String(notes) : null,
          // Only persist the new fields when the body provided them — keeps
          // the row null-friendly when operator doesn't supply them.
          ...(parsedPnr !== undefined ? { pnr: parsedPnr } : {}),
          ...(parsedBookingRef !== undefined ? { bookingRef: parsedBookingRef } : {}),
          ...(parsedStart !== undefined ? { serviceStartDate: parsedStart } : {}),
          ...(parsedEnd !== undefined ? { serviceEndDate: parsedEnd } : {}),
          // FX fields always written — null for single-currency, computed
          // baseAmount for multi-currency. No `parsedFx !== undefined` gate
          // because both null and a real number are valid persisted states.
          ...fxFields,
        },
      });

      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      await writeAudit(
        "TravelInvoiceLine",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          lineType: created.lineType,
          amount: String(created.amount),
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] create line error:", e.message);
      res.status(500).json({ error: "Failed to create line" });
    }
  },
);

// PUT /api/travel/invoices/:id/lines/:lineId — ADMIN/MANAGER only.
router.put(
  "/invoices/:id/lines/:lineId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const existing = await prisma.travelInvoiceLine.findFirst({
        where: { id: lineId, invoiceId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      const data = {};
      const {
        lineType, description, quantity, unitPrice,
        currency, sortOrder, notes,
        pnr, bookingRef, serviceStartDate, serviceEndDate,
        fxRateToBase,
      } = req.body || {};

      if (lineType !== undefined) {
        assertValidInvoiceLineType(lineType);
        data.lineType = lineType;
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          return res.status(400).json({
            error: "description must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.description = description.trim();
      }
      const nextQty = quantity !== undefined
        ? parsePositiveInt(quantity, "quantity", existing.quantity)
        : existing.quantity;
      const nextUnit = unitPrice !== undefined
        ? parsePositiveDecimal(unitPrice, "unitPrice")
        : Number(existing.unitPrice);
      if (quantity !== undefined) data.quantity = nextQty;
      if (unitPrice !== undefined) data.unitPrice = nextUnit;
      // Recompute amount whenever either qty or unitPrice changed.
      if (quantity !== undefined || unitPrice !== undefined) {
        data.amount = nextQty * nextUnit;
      }
      if (currency !== undefined) data.currency = String(currency);
      if (sortOrder !== undefined) {
        const so = parseInt(sortOrder, 10);
        if (!Number.isFinite(so)) {
          return res.status(400).json({
            error: "sortOrder must be a number",
            code: "INVALID_SORT_ORDER",
          });
        }
        data.sortOrder = so;
      }
      if (notes !== undefined) data.notes = notes === null ? null : String(notes);

      // PRD FR-3.1.b — PNR + bookingRef parsing on PUT.
      if (pnr !== undefined) {
        data.pnr = parseBookingRefField(pnr, "pnr", PNR_MAX_LEN, "INVALID_PNR");
      }
      if (bookingRef !== undefined) {
        data.bookingRef = parseBookingRefField(
          bookingRef, "bookingRef", BOOKING_REF_MAX_LEN, "INVALID_BOOKING_REF",
        );
      }
      // PRD FR-3.1.d — service-date partial-update + range check against the
      // existing DB row when only one end is being changed. We pull the
      // "effective" start/end (incoming body if present, otherwise existing
      // row's value) and validate; this catches the case where PUT sets only
      // serviceEndDate and the new end is < the existing start.
      let nextStart = existing.serviceStartDate || null;
      let nextEnd = existing.serviceEndDate || null;
      if (serviceStartDate !== undefined) {
        const parsedStart = parseServiceDate(serviceStartDate, "serviceStartDate");
        data.serviceStartDate = parsedStart;
        nextStart = parsedStart;
      }
      if (serviceEndDate !== undefined) {
        const parsedEnd = parseServiceDate(serviceEndDate, "serviceEndDate");
        data.serviceEndDate = parsedEnd;
        nextEnd = parsedEnd;
      }
      if (serviceStartDate !== undefined || serviceEndDate !== undefined) {
        assertServiceDateRange(nextStart, nextEnd);
      }

      // Arc 2 #901 slice 12 — UC-2.1 FX-aware PUT partial-update.
      // Three cases that touch the FX pair (fxRateToBase + baseAmount):
      //  (a) fxRateToBase explicit null → operator clears multi-currency;
      //      baseAmount cleared in lockstep regardless of amount.
      //  (b) fxRateToBase positive number → set rate + recompute baseAmount
      //      from the EFFECTIVE amount (incoming body if qty/unitPrice
      //      changed, otherwise the existing row's amount).
      //  (c) fxRateToBase undefined BUT amount changed (qty or unitPrice)
      //      AND existing row already had a non-null fxRateToBase →
      //      recompute baseAmount using the existing rate + new amount.
      // The effective-amount pattern mirrors the service-date partial-update
      // pattern above (incoming body if present, otherwise existing).
      const parsedFx = parseFxRateToBase(fxRateToBase);
      const effectiveAmount = (quantity !== undefined || unitPrice !== undefined)
        ? nextQty * nextUnit
        : Number(existing.amount);
      if (parsedFx === null) {
        // Case (a) — explicit clear.
        data.fxRateToBase = null;
        data.baseAmount = null;
      } else if (parsedFx !== undefined) {
        // Case (b) — explicit set.
        data.fxRateToBase = parsedFx;
        data.baseAmount = round2(effectiveAmount * parsedFx);
      } else if ((quantity !== undefined || unitPrice !== undefined)
                 && existing.fxRateToBase != null) {
        // Case (c) — amount changed, fxRateToBase unchanged but present.
        data.baseAmount = round2(effectiveAmount * Number(existing.fxRateToBase));
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelInvoiceLine.update({
        where: { id: lineId },
        data,
      });

      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      await writeAudit(
        "TravelInvoiceLine",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { invoiceId, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] update line error:", e.message);
      res.status(500).json({ error: "Failed to update line" });
    }
  },
);

// DELETE /api/travel/invoices/:id/lines/:lineId — ADMIN/MANAGER only.
router.delete(
  "/invoices/:id/lines/:lineId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const existing = await prisma.travelInvoiceLine.findFirst({
        where: { id: lineId, invoiceId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      // Audit BEFORE delete (same pattern as travel_quotes lines).
      await writeAudit(
        "TravelInvoiceLine",
        "DELETE",
        lineId,
        req.user.userId,
        req.travelTenant.id,
        { invoiceId, lineType: existing.lineType, amount: String(existing.amount) },
      );

      await prisma.travelInvoiceLine.delete({ where: { id: lineId } });
      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] delete line error:", e.message);
      res.status(500).json({ error: "Failed to delete line" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/pdf — ADMIN/MANAGER only (Arc 2 #901 slice 2).
//
// Loads the invoice tenant-scoped + sub-brand-scoped, fetches its lines,
// then hands {invoice, lines, tenant} to pdfRenderer.generateTravelInvoicePdf
// which returns a Promise<Buffer>. We stream the Buffer back with attachment
// headers so the operator browser triggers a download dialog.
//
// Audit row is stamped BEFORE the body is sent so the audit trail is
// durable even if the client aborts mid-download. Mirrors the quote
// /pdf handler's ordering at travel_quotes.js:840+.
//
// PDF render failures are wrapped as 500 PDF_RENDER_FAILED rather than
// the generic "Failed to..." catch — pdfkit can throw on bad font / asset
// resolution and the operator-facing surface needs an actionable code.
//
// NOTE: pdfRenderer.generateTravelInvoicePdf is referenced via the
// module-exports indirection (`pdfRenderer.generateTravelInvoicePdf(...)`)
// so unit tests can `vi.spyOn(pdfRenderer, 'generateTravelInvoicePdf')`
// and intercept render failures. Same CJS self-mocking seam pattern used
// by adsGptClient / ratehawkClient / callifiedClient (cron learning
// 2026-05-24 ~01:43 UTC).
// ============================================================================
router.get(
  "/invoices/:id/pdf",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "INVOICE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId: id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      // Tenant is optional input to the helper — load it for the footer
      // line. Failure to load (e.g. soft-deleted tenant) is non-fatal;
      // the helper handles a null tenant cleanly.
      let tenant = null;
      try {
        tenant = await prisma.tenant.findUnique({
          where: { id: req.travelTenant.id },
        });
      } catch (_) {
        // ignore — proceed with null tenant
      }

      let pdfBuffer;
      try {
        pdfBuffer = await pdfRenderer.generateTravelInvoicePdf({
          invoice,
          lines,
          tenant,
        });
      } catch (renderErr) {
        console.error(
          "[travel-invoices] PDF render error:",
          renderErr && renderErr.message,
        );
        return res.status(500).json({
          error: "Failed to render invoice PDF",
          code: "PDF_RENDER_FAILED",
        });
      }

      // Audit BEFORE sending the body so the row is durable even if the
      // client aborts mid-download. Mirrors the quote /pdf handler.
      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_PDF_DOWNLOADED",
        invoice.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId: invoice.id,
          subBrand: invoice.subBrand,
          lineCount: lines.length,
        },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="invoice-${invoice.id}.pdf"`,
      );
      res.status(200).end(pdfBuffer);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] pdf error:", e.message);
      res.status(500).json({ error: "Failed to generate invoice PDF" });
    }
  },
);

// ============================================================================
// /api/travel/invoices/:id/schedule — payment-schedule milestones (PRD §3.2.a).
//
// Arc 2 #901 slice 6 — TravelPaymentSchedule CRUD scaffold. Mirrors the
// supplier-payable ledger pattern in backend/routes/travel_suppliers.js
// (commit 59336ab7) — same auth + sub-brand + audit conventions.
//
// Staged settlement: an invoice can have multiple milestones (e.g. 25% advance,
// 50% pre-departure, 25% on-return per UC-2.1). Each row is one milestone
// row with its own dueDate + expectedAmount + status. Operator-driven for
// now — auto-create-on-issue (default 25/50/25 split, etc.) is slice 7.
//
// Status enum: pending | partial | paid | overdue | waived
//   - pending  : not yet received (default)
//   - partial  : some received but not full expectedAmount
//   - paid     : fully settled (paidAt auto-set when transitioning here)
//   - overdue  : dueDate past + not paid (cron will flip in slice 9)
//   - waived   : operator wrote off the milestone (e.g. complimentary)
//
// Auth: read endpoints accept any verified token; write endpoints require
// ADMIN/MANAGER. Sub-brand isolation flows through the parent invoice via
// loadParentInvoice() — payable scope is inherited via FK.
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, MILESTONE_NOT_FOUND,
//   SUB_BRAND_DENIED, MISSING_FIELDS, INVALID_MILESTONE_ORDER, INVALID_AMOUNT,
//   INVALID_DUE_DATE, INVALID_STATUS, INVALID_CURRENCY, EMPTY_BODY.
// ============================================================================

const VALID_SCHEDULE_STATUSES = [
  "pending",
  "partial",
  "paid",
  "overdue",
  "waived",
];

function assertValidScheduleStatus(s) {
  if (s == null) return;
  if (!VALID_SCHEDULE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_SCHEDULE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

function assertValidMilestoneOrder(n) {
  if (n == null || n === "") {
    const err = new Error("milestoneOrder is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("milestoneOrder must be a positive integer");
    err.status = 400;
    err.code = "INVALID_MILESTONE_ORDER";
    throw err;
  }
  return v;
}

function assertValidExpectedAmount(a) {
  if (a == null || a === "") {
    const err = new Error("expectedAmount is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const v = typeof a === "number" ? a : Number(a);
  if (!Number.isFinite(v) || v < 0) {
    const err = new Error("expectedAmount must be a non-negative number");
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return v;
}

// Parse + validate a dueDate on the milestone. Same shape as parseDueDate
// above but with a distinct error code for the schedule surface so
// frontend can render the right field's validation feedback.
function parseMilestoneDueDate(input) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("dueDate must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

// Parse + validate a paidAt timestamp. Same shape as dueDate but allows
// explicit null to clear a previously-set value.
function parsePaidAt(input) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("paidAt must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

// GET /api/travel/invoices/:id/schedule — list milestones for an invoice.
// Returns { schedule: [...], total }, ordered by milestoneOrder asc.
router.get(
  "/invoices/:id/schedule",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const schedule = await prisma.travelPaymentSchedule.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ milestoneOrder: "asc" }, { id: "asc" }],
      });
      res.json({ schedule, total: schedule.length });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] list schedule error:", e.message);
      res.status(500).json({ error: "Failed to list schedule" });
    }
  },
);

// POST /api/travel/invoices/:id/schedule — ADMIN/MANAGER only.
// Required: milestoneOrder, expectedAmount.
// Optional: dueDate, expectedCurrency (default parent invoice currency),
//   receivedAmount, notes, status, paidAt.
router.post(
  "/invoices/:id/schedule",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const {
        milestoneOrder,
        expectedAmount,
        dueDate,
        expectedCurrency,
        receivedAmount,
        notes,
        status,
        paidAt,
      } = req.body || {};

      const order = assertValidMilestoneOrder(milestoneOrder);
      const expected = assertValidExpectedAmount(expectedAmount);
      assertValidScheduleStatus(status);
      const parsedDueDate = parseMilestoneDueDate(dueDate);
      const parsedPaidAt = parsePaidAt(paidAt);

      // receivedAmount is optional on POST. Validate when supplied.
      let received = undefined;
      if (receivedAmount !== undefined && receivedAmount !== null) {
        const v = Number(receivedAmount);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({
            error: "receivedAmount must be a non-negative number",
            code: "INVALID_AMOUNT",
          });
        }
        received = v;
      }

      const created = await prisma.travelPaymentSchedule.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          milestoneOrder: order,
          expectedAmount: String(expected),
          expectedCurrency: expectedCurrency
            ? String(expectedCurrency)
            : invoice.currency,
          dueDate: parsedDueDate === undefined ? null : parsedDueDate,
          ...(received !== undefined ? { receivedAmount: String(received) } : {}),
          notes: notes ? String(notes) : null,
          status: status || undefined,
          ...(parsedPaidAt !== undefined ? { paidAt: parsedPaidAt } : {}),
        },
      });

      await writeAudit(
        "TravelPaymentSchedule",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          milestoneOrder: created.milestoneOrder,
          expectedAmount: String(created.expectedAmount),
          status: created.status,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] create schedule error:", e.message);
      res.status(500).json({ error: "Failed to create milestone" });
    }
  },
);

// PUT /api/travel/invoices/:id/schedule/:milestoneId — ADMIN/MANAGER only.
// Partial update. status='paid' auto-sets paidAt=now() if not already set.
router.put(
  "/invoices/:id/schedule/:milestoneId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const milestoneId = parseInt(req.params.milestoneId, 10);
      if (!Number.isFinite(milestoneId)) {
        return res.status(400).json({
          error: "milestoneId must be a number",
          code: "INVALID_ID",
        });
      }
      const existing = await prisma.travelPaymentSchedule.findFirst({
        where: {
          id: milestoneId,
          invoiceId,
          tenantId: req.travelTenant.id,
        },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Milestone not found",
          code: "MILESTONE_NOT_FOUND",
        });
      }

      const data = {};
      const {
        milestoneOrder,
        expectedAmount,
        dueDate,
        expectedCurrency,
        receivedAmount,
        notes,
        status,
        paidAt,
      } = req.body || {};

      if (milestoneOrder !== undefined) {
        data.milestoneOrder = assertValidMilestoneOrder(milestoneOrder);
      }
      if (expectedAmount !== undefined) {
        data.expectedAmount = String(assertValidExpectedAmount(expectedAmount));
      }
      if (expectedCurrency !== undefined) {
        if (expectedCurrency === null || expectedCurrency === "") {
          return res.status(400).json({
            error: "expectedCurrency must be a non-empty string",
            code: "INVALID_CURRENCY",
          });
        }
        data.expectedCurrency = String(expectedCurrency);
      }
      if (dueDate !== undefined) {
        data.dueDate = parseMilestoneDueDate(dueDate);
      }
      if (receivedAmount !== undefined) {
        if (receivedAmount === null) {
          data.receivedAmount = null;
        } else {
          const v = Number(receivedAmount);
          if (!Number.isFinite(v) || v < 0) {
            return res.status(400).json({
              error: "receivedAmount must be a non-negative number",
              code: "INVALID_AMOUNT",
            });
          }
          data.receivedAmount = String(v);
        }
      }
      if (notes !== undefined) {
        data.notes = notes === null ? null : String(notes);
      }
      if (status !== undefined) {
        assertValidScheduleStatus(status);
        data.status = status;
        // Auto-set paidAt when transitioning to 'paid' (caller didn't supply one).
        if (status === "paid" && paidAt === undefined && !existing.paidAt) {
          data.paidAt = new Date();
        }
      }
      if (paidAt !== undefined) {
        data.paidAt = parsePaidAt(paidAt);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.travelPaymentSchedule.update({
        where: { id: milestoneId },
        data,
      });

      await writeAudit(
        "TravelPaymentSchedule",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { invoiceId, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] update schedule error:", e.message);
      res.status(500).json({ error: "Failed to update milestone" });
    }
  },
);

// DELETE /api/travel/invoices/:id/schedule/:milestoneId — ADMIN/MANAGER only.
// Hard delete (waived status is the soft-decline path — operators choose
// status='waived' if they want the milestone to remain in history).
router.delete(
  "/invoices/:id/schedule/:milestoneId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const milestoneId = parseInt(req.params.milestoneId, 10);
      if (!Number.isFinite(milestoneId)) {
        return res.status(400).json({
          error: "milestoneId must be a number",
          code: "INVALID_ID",
        });
      }
      const existing = await prisma.travelPaymentSchedule.findFirst({
        where: {
          id: milestoneId,
          invoiceId,
          tenantId: req.travelTenant.id,
        },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Milestone not found",
          code: "MILESTONE_NOT_FOUND",
        });
      }

      // Audit BEFORE delete (same pattern as supplier-payable DELETE).
      await writeAudit(
        "TravelPaymentSchedule",
        "DELETE",
        milestoneId,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          milestoneOrder: existing.milestoneOrder,
          expectedAmount: String(existing.expectedAmount),
          status: existing.status,
        },
      );

      await prisma.travelPaymentSchedule.delete({ where: { id: milestoneId } });
      res.status(204).end();
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] delete schedule error:", e.message);
      res.status(500).json({ error: "Failed to delete milestone" });
    }
  },
);

// ============================================================================
// /api/travel/payment-schedules/upcoming — cross-invoice milestone summary
// (PRD_TRAVEL_BILLING UC-2.5 month-end-close + DD-5.5 reminders cadence).
//
// Arc 2 #901 slice 7 — aggregate read endpoint over TravelPaymentSchedule
// rows joined to their parent TravelInvoice (invoiceNum + subBrand + contactId).
// Operator-facing "all milestones due in the next N days" / "all overdue
// milestones across all customers" view. Slice 6 (commit af0c6709) shipped
// the per-invoice CRUD; this slice ships the cross-invoice rollup.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees milestones for invoices in their allowed sub-brands.
//
// Query params (all optional):
//   ?status=pending|partial|paid|overdue|waived  — filter (default: all)
//   ?within=7|14|30|60|90                        — dueDate within N days from
//                                                  now (default: 30). Accepts
//                                                  any positive integer; the
//                                                  documented presets are
//                                                  conveniences not constraints.
//   ?subBrand=tmc|rfu|travelstall|visasure       — filter to one sub-brand
//                                                  (within the caller's allowed
//                                                  set; outside-allowed → empty).
//   ?overdueOnly=true                            — dueDate < now (overrides
//                                                  ?within when truthy).
//   ?limit=N (default 100, clamped to [1, 500]).
//   ?offset=N (default 0).
//
// Response shape:
//   {
//     milestones: [
//       { id, invoiceId, invoiceNum, subBrand, contactId,
//         milestoneOrder, dueDate, expectedAmount, expectedCurrency,
//         status, receivedAmount, daysUntilDue, createdAt }
//     ],
//     total,
//     limit,
//     offset,
//     summary: {
//       byStatus: { pending: <int>, partial: <int>, ... },
//       totalExpected: "<decimal-string>",
//       totalReceived: "<decimal-string>",
//       currencyBreakdown: { INR: "<decimal-string>", USD: "..." }
//     }
//   }
//
// Decisions:
//   - daysUntilDue is JS-computed (Math.floor((due - now) / 86_400_000)).
//     Negative ⇒ overdue. NULL dueDate ⇒ daysUntilDue is null.
//   - summary is computed across the SAME page returned (post-limit/offset),
//     not the full unpaginated set — operator pagers want the current-page
//     totals. Callers wanting full-population totals should iterate pages
//     or pass limit=500.
//   - totalExpected/totalReceived/currencyBreakdown emit as decimal STRINGS
//     (toFixed(2)) for Prisma Decimal-string compatibility; JS Number
//     precision would round 60000.005 + 0.005 silently. Mirrors the
//     `expectedAmount` shape on the milestone rows themselves.
//   - Error codes: INVALID_STATUS, INVALID_WITHIN, INVALID_SUB_BRAND,
//     INVALID_LIMIT.
// ============================================================================

const DEFAULT_WITHIN_DAYS = 30;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function parseWithinDays(input) {
  if (input == null || input === "") return DEFAULT_WITHIN_DAYS;
  const v = Number(input);
  if (!Number.isInteger(v) || v <= 0) {
    const err = new Error("within must be a positive integer (days)");
    err.status = 400;
    err.code = "INVALID_WITHIN";
    throw err;
  }
  return v;
}

function parseLimitForSummary(input) {
  if (input == null || input === "") return DEFAULT_LIMIT;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("limit must be a positive integer");
    err.status = 400;
    err.code = "INVALID_LIMIT";
    throw err;
  }
  return Math.min(v, MAX_LIMIT);
}

function parseOffsetForSummary(input) {
  if (input == null || input === "") return 0;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 0) return 0;
  return v;
}

// Add two decimal strings safely. Both inputs are normalised to Number,
// summed, then toFixed(2)'d. For the scales we operate at (per-tenant
// monthly milestone totals — well below 1e15) Number precision is fine;
// the toFixed sidesteps the float-display artefact (60000 + 60000.01 →
// "120000.01" not "120000.0099999...").
function addDecimal(a, b) {
  const x = Number(a == null ? 0 : a);
  const y = Number(b == null ? 0 : b);
  return (x + y).toFixed(2);
}

router.get(
  "/payment-schedules/upcoming",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      if (status) assertValidScheduleStatus(status);

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const overdueOnly =
        req.query.overdueOnly === "true" || req.query.overdueOnly === true;

      const withinDays = parseWithinDays(req.query.within);
      const limit = parseLimitForSummary(req.query.limit);
      const offset = parseOffsetForSummary(req.query.offset);

      const now = new Date();
      const where = { tenantId: req.travelTenant.id };
      if (status) where.status = status;

      // Date window: overdueOnly overrides ?within.
      if (overdueOnly) {
        where.dueDate = { lt: now };
      } else {
        const upper = new Date(now.getTime() + withinDays * 86_400_000);
        where.dueDate = { lte: upper };
      }

      // Sub-brand filtering joins through the parent invoice. Prisma can't
      // filter on a related field's column inside a top-level findMany
      // where-clause without `is:` — use the nested filter shape.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const invoiceFilter = {};
      if (subBrand) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrand)) {
          // Filter requested a sub-brand the caller can't see — return
          // empty silently (consistent with the existing /invoices list
          // pattern: substitute a never-matching value instead of 403).
          invoiceFilter.subBrand = "__none__";
        } else {
          invoiceFilter.subBrand = subBrand;
        }
      } else if (allowed !== null) {
        // No explicit subBrand filter + restricted access ⇒ narrow to the
        // allowed set. Empty set ⇒ never-match.
        invoiceFilter.subBrand =
          allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }
      if (Object.keys(invoiceFilter).length > 0) {
        where.invoice = { is: invoiceFilter };
      }

      const [rows, total] = await Promise.all([
        prisma.travelPaymentSchedule.findMany({
          where,
          include: {
            invoice: {
              select: { invoiceNum: true, subBrand: true, contactId: true },
            },
          },
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.travelPaymentSchedule.count({ where }),
      ]);

      const nowMs = now.getTime();
      const milestones = rows.map((r) => {
        const dueMs =
          r.dueDate instanceof Date
            ? r.dueDate.getTime()
            : r.dueDate
              ? new Date(r.dueDate).getTime()
              : null;
        const daysUntilDue =
          dueMs == null ? null : Math.floor((dueMs - nowMs) / 86_400_000);
        return {
          id: r.id,
          invoiceId: r.invoiceId,
          invoiceNum: r.invoice ? r.invoice.invoiceNum : null,
          subBrand: r.invoice ? r.invoice.subBrand : null,
          contactId: r.invoice ? r.invoice.contactId : null,
          milestoneOrder: r.milestoneOrder,
          dueDate: r.dueDate,
          expectedAmount: r.expectedAmount,
          expectedCurrency: r.expectedCurrency,
          status: r.status,
          receivedAmount: r.receivedAmount,
          daysUntilDue,
          createdAt: r.createdAt,
        };
      });

      // Summary aggregates — computed over the returned page (see header note).
      const byStatus = {};
      const currencyBreakdown = {};
      let totalExpected = "0.00";
      let totalReceived = "0.00";
      for (const m of milestones) {
        byStatus[m.status] = (byStatus[m.status] || 0) + 1;
        totalExpected = addDecimal(totalExpected, m.expectedAmount);
        totalReceived = addDecimal(totalReceived, m.receivedAmount);
        const cur = m.expectedCurrency || "INR";
        currencyBreakdown[cur] = addDecimal(
          currencyBreakdown[cur] || "0.00",
          m.expectedAmount,
        );
      }

      res.json({
        milestones,
        total,
        limit,
        offset,
        summary: {
          byStatus,
          totalExpected,
          totalReceived,
          currencyBreakdown,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] schedule upcoming error:", e.message);
      res.status(500).json({ error: "Failed to list upcoming milestones" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/tcs-preview — Section 206C(1G) preview
// (Arc 2 #901 slice 9 — PRD_TRAVEL_BILLING UC-2.6 + FR-3.5).
//
// READ-ONLY endpoint. Returns the TCS that WOULD apply if this invoice were
// issued today, factoring in the customer's cumulative FY spend across all
// other TravelInvoice rows for the same contactId + tenant. Does NOT mutate
// the invoice or persist a TCS line — persistence on a TravelInvoiceLine
// row lands in slice 10 (needs a schema field for `tcsAmount` cache).
//
// Auth: any verified token, tenant + sub-brand scoped via loadParentInvoice.
//
// Query params (all optional):
//   ?isOverseasPackage=true|false   — default true (TCS-eligible by default
//                                     since travel is overseas-leaning)
//   ?isNonFiler=true|false          — default false (filer; 5% rate)
//   ?customerCountryCode=AE         — if provided, overrides isOverseasPackage
//                                     via the isOverseasDestination heuristic
//
// FY-window source: TravelInvoice has no dedicated issuedAt column today
// (see the slice-5 NOTE near the /issue handler). Falls back to `createdAt`
// for the priorFySpend filter — additive schema change to introduce a
// dedicated issue-timestamp column is deferred to a later slice.
//
// Response: {
//   invoiceId, contactId, invoiceAmount, priorFySpend,
//   isOverseasPackage, isNonFiler,
//   applies, exceedingAmount, rate, tcsAmount, newFyTotal
// }
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, SUB_BRAND_DENIED.
// ============================================================================
router.get(
  "/invoices/:id/tcs-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // ---- Resolve isOverseasPackage ----
      // If customerCountryCode is provided, the destination-heuristic
      // overrides the explicit boolean (a "IN" destination always wins,
      // even when isOverseasPackage=true was passed by mistake). If absent,
      // the boolean defaults to TRUE (TCS-eligible default for travel).
      const ccRaw = req.query.customerCountryCode;
      const hasCountryCode = typeof ccRaw === "string" && ccRaw.trim() !== "";
      const isOverseasPackage = hasCountryCode
        ? isOverseasDestination(ccRaw)
        : req.query.isOverseasPackage === "false"
          ? false
          : true;

      const isNonFiler = req.query.isNonFiler === "true";

      // ---- Compute priorFySpend ----
      // Sum totalAmount across all OTHER TravelInvoice rows belonging to
      // the same contactId + tenant whose createdAt falls within the
      // current FY window. Excludes the current invoice (so the preview
      // is "what would TCS be IF this invoice were the marginal one").
      const fyStart = fiscalYearStart(new Date());
      const priorInvoices = await prisma.travelInvoice.findMany({
        where: {
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          createdAt: { gte: fyStart },
          NOT: { id: invoice.id },
        },
        select: { totalAmount: true },
      });
      const priorFySpend = priorInvoices.reduce(
        (sum, inv) => sum + Number(inv.totalAmount || 0),
        0,
      );

      const invoiceAmount = Number(invoice.totalAmount || 0);
      const result = computeTcs({
        invoiceAmount,
        priorFySpend,
        isNonFiler,
        isOverseasPackage,
      });

      return res.status(200).json({
        invoiceId: invoice.id,
        contactId: invoice.contactId,
        invoiceAmount,
        priorFySpend,
        isOverseasPackage,
        isNonFiler,
        applies: result.applies,
        exceedingAmount: result.exceedingAmount,
        rate: result.rate,
        tcsAmount: result.tcsAmount,
        newFyTotal: result.newFyTotal,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tcs-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute TCS preview" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/apply-tcs — Section 206C(1G) PERSISTENCE
// (Arc 2 #901 slice 10 — PRD_TRAVEL_BILLING UC-2.6 + FR-3.5).
//
// Operator action: commits the TCS computed by /tcs-preview to the invoice
// itself by writing the 4 additive nullable fields (tcsAmount, tcsRate,
// tcsExceedingAmount, tcsAppliedAt). Mirrors the tcs-preview window-source
// (createdAt-based prior-FY-spend scan, current-invoice excluded via
// NOT: { id }) — pinning the same math at apply time guarantees the
// preview-vs-applied invariant.
//
// Why a SEPARATE endpoint from /issue (not extending it):
//   - /issue does the invoiceNum-reassignment + status flip (slice 5);
//     keeping TCS persistence as its own operator action lets the operator
//     issue an invoice and later "apply TCS" once filer-status is confirmed
//     (e.g. customer's PAN/non-filer flag arrives after issuance).
//   - Idempotency surface is local — tcsAppliedAt set → reject with 409
//     TCS_ALREADY_APPLIED. Mixing into /issue would force re-issuance to
//     undo, which is wrong (issuance is a one-way state transition).
//
// Auth: ADMIN/MANAGER only (writes).
// Pre-conditions: invoice exists, tenant-scoped, sub-brand-accessible,
//   tcsAppliedAt IS NULL (one-shot apply). Status is NOT checked — TCS can
//   be applied to Draft / Issued / Partial / Paid alike; the operator may
//   apply TCS after collection if the buyer's filer-status changed.
//
// Body (all optional):
//   applyTcs              — default true. If false, runs the math + returns
//                           the payload WITHOUT persisting (preview parity).
//   isNonFiler            — default false (filer rate 5%).
//   isOverseasPackage     — default true (TCS-eligible default for travel).
//   customerCountryCode   — if provided, overrides isOverseasPackage via
//                           isOverseasDestination heuristic.
//
// Side effects on applies===true + applyTcs===true:
//   - travelInvoice.update sets the 4 TCS fields.
//   - Audit row stamped action='TRAVEL_INVOICE_TCS_APPLIED' with details
//     { tcsAmount, tcsRate, exceedingAmount, applies:true }.
//
// On applies===false (domestic, below-threshold, zero-amount):
//   - NO update. 4 fields stay null.
//   - NO audit row. (The decision-not-to-apply isn't worth a row; operator
//     can re-call to recompute. Re-evaluate if Q-TCS-2 surfaces a need.)
//   - Returns 200 with the computed payload + applied:false.
//
// Returns: 200 + { invoiceId, contactId, applied, applies, exceedingAmount,
//   rate, tcsAmount, newFyTotal, tcsAppliedAt | null }.
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404), SUB_BRAND_DENIED
//   (403), TCS_ALREADY_APPLIED (409).
// ============================================================================
router.post(
  "/invoices/:id/apply-tcs",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Idempotency gate — once TCS has been persisted, the operator must
      // not silently re-apply (would clobber the original tcsAppliedAt
      // timestamp and rate, breaking the audit trail).
      if (invoice.tcsAppliedAt != null) {
        return res.status(409).json({
          error: "TCS has already been applied to this invoice",
          code: "TCS_ALREADY_APPLIED",
        });
      }

      const body = req.body || {};
      const applyTcs = body.applyTcs !== false; // default true
      const isNonFiler = body.isNonFiler === true;

      // Resolve isOverseasPackage — country-code heuristic wins when present,
      // otherwise the explicit boolean, default true.
      const ccRaw = body.customerCountryCode;
      const hasCountryCode = typeof ccRaw === "string" && ccRaw.trim() !== "";
      const isOverseasPackage = hasCountryCode
        ? isOverseasDestination(ccRaw)
        : body.isOverseasPackage === false
          ? false
          : true;

      // Mirror the tcs-preview FY-window math (createdAt-based, current
      // invoice excluded). Pinning the same math at apply time guarantees
      // preview === applied for the same inputs.
      const fyStart = fiscalYearStart(new Date());
      const priorInvoices = await prisma.travelInvoice.findMany({
        where: {
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          createdAt: { gte: fyStart },
          NOT: { id: invoice.id },
        },
        select: { totalAmount: true },
      });
      const priorFySpend = priorInvoices.reduce(
        (sum, inv) => sum + Number(inv.totalAmount || 0),
        0,
      );

      const invoiceAmount = Number(invoice.totalAmount || 0);
      const result = computeTcs({
        invoiceAmount,
        priorFySpend,
        isNonFiler,
        isOverseasPackage,
      });

      // Two branches: applies + applyTcs requested → persist; otherwise
      // return the math without touching the row.
      let applied = false;
      let tcsAppliedAt = null;
      if (result.applies && applyTcs) {
        const now = new Date();
        await prisma.travelInvoice.update({
          where: { id: invoice.id },
          data: {
            tcsAmount: result.tcsAmount,
            tcsRate: result.rate,
            tcsExceedingAmount: result.exceedingAmount,
            tcsAppliedAt: now,
          },
        });
        applied = true;
        tcsAppliedAt = now;

        await writeAudit(
          "TravelInvoice",
          "TRAVEL_INVOICE_TCS_APPLIED",
          invoice.id,
          req.user.userId,
          req.travelTenant.id,
          {
            tcsAmount: result.tcsAmount,
            tcsRate: result.rate,
            exceedingAmount: result.exceedingAmount,
            applies: true,
          },
        );
      }

      return res.status(200).json({
        invoiceId: invoice.id,
        contactId: invoice.contactId,
        invoiceAmount,
        priorFySpend,
        isOverseasPackage,
        isNonFiler,
        applies: result.applies,
        exceedingAmount: result.exceedingAmount,
        rate: result.rate,
        tcsAmount: result.tcsAmount,
        newFyTotal: result.newFyTotal,
        applied,
        tcsAppliedAt,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] apply-tcs error:", e.message);
      res.status(500).json({ error: "Failed to apply TCS" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/tax-preview — any verified token.
// ============================================================================
//
// Arc 2 #902 slice 7 (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3 / FR-3.4.3 /
// NFR-4.2). Invoice analog of /quotes/:id/tax-preview (slice 6, commit
// b9833a0e). Same response envelope, same library consumers — only the
// parent type + line query differ (TravelInvoiceLine instead of
// TravelQuoteLine).
//
// READ-ONLY surface: zero writes. Loads the parent invoice via
// loadParentInvoice (tenant + sub-brand scoped — same INVALID_ID /
// INVOICE_NOT_FOUND / SUB_BRAND_DENIED shape as every other invoice
// child endpoint), resolves the operator + customer state codes via
// lib/gstStateCodeResolver.js, decides intra-vs-inter-state via
// isInterstateSupply, derives each line's GST rate from lineType via
// gstRateForCategory, decorates each line with its SAC code +
// description via lib/hsnSacMapper.js, and aggregates per-line +
// per-rate-bucket + GSTR-1-style HSN-summary totals via
// computeGstForLines + groupLinesBySac.
//
// === Invoice-side lineType taxonomy ===
//
// TravelInvoiceLine extends TravelQuoteLine with billing-specific
// types: per_pax / per_room / per_night / per_trip / tax / fee / addon
// / tcs / tds / other. hsnSacMapper.sacForLineType handles all of
// these — per_room/per_night map to SAC 9963 (accommodation),
// per_pax/per_trip/addon map to SAC 9985 (travel-tourism support),
// tax/fee/tcs/tds return null SAC (groupLinesBySac skips them so
// they don't pollute the GSTR-1 HSN summary — withholding taxes are
// reported on Form 27EQ, not GSTR-1). gstRateForCategory does not
// know these invoice-specific types so they fall through to the 18%
// DEFAULT_RATE — operator-safe (highest common slab); when the
// TaxRateMaster slice (FR-3.1) lands it will override per-tenant.
//
// === Place-of-supply resolution ===
//
// Source-of-truth chain (FR-3.x):
//   1. Truthy override (query param ?operatorStateCode= /
//      ?customerStateCode=) wins.
//   2. DB column — Tenant.gstStateCode for operator,
//      Contact.stateCode for customer (slice 3 schema adds).
//   3. Hard-coded "IN-MH" fallback (slice 2 back-compat).
// Customer-side: when override + DB are both null, mirror operator
// (intra-state default) — handled inside resolveStateCodes.
//
// Empty-string for an explicit param is rejected with 400
// INVALID_STATE_CODE (defense-in-depth — prevents silent fall-through
// to defaults when caller sends `?operatorStateCode=`).
//
// === Envelope contract (mirrors slice 6 exactly) ===
//
// Per-line: { id, lineType, amount, gstPercent, sacCode,
//             sacDescription, cgst, sgst, igst, totalTax, amountWithTax }
// Top-level: { invoiceId, subtotal, isInterstate, operatorStateCode,
//              customerStateCode, lines[], totalCgst, totalSgst,
//              totalIgst, totalTax, grandTotal, buckets[], hsnSummary[] }
//
// Invariants (rounding-safe to 2 decimals — every step round2'd in
// gstCalculation.js):
//   totalTax === totalCgst + totalSgst + totalIgst    (split consistency)
//   subtotal + totalTax === grandTotal                 (gross consistency)
//
// Per-line vs bucket aggregation: per-line totals are computed inline
// (mirrors gstCalculation.computeGstSplit; inlined for one extra
// require avoidance). Bucket summary is computed via computeGstForLines
// which sums taxable into per-rate buckets FIRST then taxes the bucket
// (per FR-3.4.3 HSN-summary shape). Envelope-level totals come from
// the bucket summary so the spec-aligned numbers win the invariants;
// per-line drift (≤1 paise on multi-line invoices) stays contained in
// the lines[] array.
router.get(
  "/invoices/:id/tax-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Empty-string state-code validation BEFORE the resolver fires
      // (mirrors slice 6 — keeps the user-facing 400 contract even
      // though the resolver itself treats empty as no-override).
      const rawOp = req.query.operatorStateCode;
      const rawCu = req.query.customerStateCode;
      if (rawOp != null && String(rawOp).trim() === "") {
        return res.status(400).json({
          error: "operatorStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }
      if (rawCu != null && String(rawCu).trim() === "") {
        return res.status(400).json({
          error: "customerStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }

      const { operatorStateCode, customerStateCode } = await resolveStateCodes({
        prisma,
        tenantId: req.travelTenant.id,
        contactId: invoice.contactId,
        operatorOverride: rawOp != null ? String(rawOp).trim() : null,
        customerOverride: rawCu != null ? String(rawCu).trim() : null,
      });

      let isInterstate;
      try {
        isInterstate = isInterstateSupply(operatorStateCode, customerStateCode);
      } catch (e) {
        return res.status(400).json({
          error: e.message,
          code: "INVALID_STATE_CODE",
        });
      }

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      // Per-line decoration: each line gets its own gstPercent +
      // CGST/SGST/IGST split + SAC code/description. Composite-supply
      // per FR-3.2.4 — every line taxed at its own rate.
      const decoratedLines = [];
      const normalizedForBuckets = [];
      let subtotalAccum = 0;
      let totalCgstAccum = 0;
      let totalSgstAccum = 0;
      let totalIgstAccum = 0;
      let totalTaxAccum = 0;

      for (const l of lines) {
        const amt = Number(l.amount || 0);
        subtotalAccum = round2(subtotalAccum + amt);
        const gstPercent = gstRateForCategory(l.lineType);

        const totalTax = round2((amt * gstPercent) / 100);
        let cgst = 0;
        let sgst = 0;
        let igst = 0;
        if (isInterstate) {
          igst = totalTax;
        } else {
          const halfRate = gstPercent / 2;
          cgst = round2((amt * halfRate) / 100);
          sgst = round2((amt * halfRate) / 100);
        }
        const amountWithTax = round2(amt + totalTax);

        const sacCode = sacForLineType(l.lineType);
        const sacDescription = sacCode ? descriptionForSac(sacCode) : null;

        decoratedLines.push({
          id: l.id,
          lineType: l.lineType,
          amount: round2(amt),
          gstPercent,
          sacCode,
          sacDescription,
          cgst,
          sgst,
          igst,
          totalTax,
          amountWithTax,
        });
        normalizedForBuckets.push({ taxableAmount: amt, gstPercent });

        totalCgstAccum = round2(totalCgstAccum + cgst);
        totalSgstAccum = round2(totalSgstAccum + sgst);
        totalIgstAccum = round2(totalIgstAccum + igst);
        totalTaxAccum = round2(totalTaxAccum + totalTax);
      }

      // Bucket summary via lib helper — per-rate aggregation matches
      // GSTR-1 HSN-summary shape (FR-3.4.3). Use bucket totals as
      // envelope totals so the spec-aligned numbers win the consistency
      // invariants (per-line drift contained to lines[]).
      const bucketSummary = computeGstForLines(
        normalizedForBuckets,
        isInterstate,
      );

      // HSN/SAC summary grouping per FR-3.4.3 (GSTR-1 export-ready
      // shape: one row per (sacCode, gstPercent) pair with summed
      // taxableValue + line count). Sibling to buckets[] (which groups
      // by gstPercent only). tax/fee/tcs/tds lines have null SAC →
      // skipped by the helper (withholding taxes don't belong in
      // GSTR-1; they're Form 27EQ).
      const hsnSummary = groupLinesBySac(
        lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        })),
      );

      res.json({
        invoiceId: invoice.id,
        subtotal: bucketSummary.subtotal,
        isInterstate,
        operatorStateCode,
        customerStateCode,
        lines: decoratedLines,
        totalCgst: bucketSummary.totalCgst,
        totalSgst: bucketSummary.totalSgst,
        totalIgst: bucketSummary.totalIgst,
        totalTax: bucketSummary.totalTax,
        grandTotal: bucketSummary.grandTotal,
        buckets: bucketSummary.buckets,
        hsnSummary,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tax-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute tax preview" });
    }
  },
);

module.exports = router;
