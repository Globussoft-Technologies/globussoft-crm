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

const VALID_INVOICE_STATUSES = ["Draft", "Issued", "Partial", "Paid", "Voided"];

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

      const created = await prisma.travelInvoice.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: contactIdInt,
          quoteId: quoteIdInt,
          invoiceNum,
          status: status || "Draft",
          totalAmount: totalAmount,
          currency: String(currency),
          dueDate: parsedDueDate,
        },
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
// quantity (default 1), currency (default invoice currency), sortOrder, notes.
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

module.exports = router;
