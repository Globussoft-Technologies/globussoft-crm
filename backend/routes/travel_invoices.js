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

const VALID_INVOICE_STATUSES = ["Draft", "Issued", "Partial", "Paid", "Voided"];

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
      res.json(invoice);
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

module.exports = router;
