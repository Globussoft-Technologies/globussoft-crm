/**
 * /api/travel/quotes — TravelQuote CRUD (PRD_TRAVEL_QUOTE_BUILDER DD-5.1)
 *
 * Sibling to /api/travel/suppliers (commit 192b8c1) and the upcoming
 * /api/travel/invoices. The TravelQuote model landed at commit fdb793e
 * (2026-05-24 tick #94) as the fork-side of the symmetric Quote/Billing/
 * Supplier decision. This module ships the operator-facing CRUD scaffold.
 *
 * Future slices (not in this commit): pricing engine + line items (PRD §3.2),
 * tax calculation per sub-brand default (DD-5.3 pending product call),
 * PDF render via pdfRenderer.js (DD-5.6 RESOLVED: extend existing),
 * counter-offer flow (DD-5.5 simple-delta v1 / rich-line-edit v2),
 * send-via-WA/email flow (depends on Q9 cred-chase).
 *
 * Sub-brand isolation: every quote carries .subBrand. External API keys
 * scoped to a sub-brand cannot create/edit quotes under a different
 * sub-brand. Operator auth allows cross-sub-brand if multi-grant.
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
const { generateTravelQuotePdf } = require("../services/pdfRenderer");
const { pickMarkup, mapCategoryToScope } = require("../lib/travelPricing");
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

const VALID_QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Rejected"];
const VALID_LINE_TYPES = ["hotel", "flight", "transport", "visa", "service", "other"];

function assertValidLineType(t) {
  if (t == null) return;
  if (!VALID_LINE_TYPES.includes(t)) {
    const err = new Error(
      `lineType must be one of: ${VALID_LINE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_LINE_TYPE";
    throw err;
  }
}

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

// Recompute the quote's totalAmount as the sum of its lines and persist.
// Called from POST/PUT/DELETE /lines. Idempotent. Skipped if the lines
// table is empty (totalAmount stays at whatever the operator typed).
async function recomputeQuoteTotal(quoteId, tenantId) {
  const lines = await prisma.travelQuoteLine.findMany({
    where: { quoteId, tenantId },
    select: { amount: true },
  });
  if (lines.length === 0) return;
  const total = lines.reduce(
    (acc, l) => acc + Number(l.amount || 0),
    0,
  );
  await prisma.travelQuote.update({
    where: { id: quoteId },
    data: { totalAmount: total },
  });
}

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_QUOTE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_QUOTE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

/**
 * Parse + validate a validUntil date. Accepts ISO 8601 strings or
 * anything Date can swallow; rejects unparseable input and any date
 * earlier than today (midnight comparison so "today" is still valid).
 *
 * Returns the parsed Date (or null if input was nullish).
 */
function parseValidUntil(input) {
  if (input == null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("validUntil must be a parseable date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  // Compare against today's midnight so a "today" validUntil is allowed.
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (d.getTime() < todayMidnight.getTime()) {
    const err = new Error("validUntil must be today or a future date");
    err.status = 400;
    err.code = "INVALID_VALID_UNTIL";
    throw err;
  }
  return d;
}

// GET /api/travel/quotes
// Honors ?subBrand=tmc (filter to that sub-brand) and ?status=Draft.
router.get("/quotes", verifyToken, requireTravelTenant, async (req, res) => {
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

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [quotes, total] = await Promise.all([
      prisma.travelQuote.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        skip,
      }),
      prisma.travelQuote.count({ where }),
    ]);
    res.json({ quotes, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] list error:", e.message);
    res.status(500).json({ error: "Failed to list quotes" });
  }
});

// GET /api/travel/quotes/:id
router.get("/quotes/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const quote = await prisma.travelQuote.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!quote) {
      return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, quote.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(quote);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-quotes] get error:", e.message);
    res.status(500).json({ error: "Failed to get quote" });
  }
});

// POST /api/travel/quotes — ADMIN/MANAGER only.
// Required: contactId, totalAmount, currency.
// Optional: subBrand (per Q25 — defaults to "tmc"), status (default "Draft"),
// validUntil (parseable date, today-or-future).
router.post(
  "/quotes",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil,
      } = req.body || {};

      if (contactId == null || totalAmount == null || !currency) {
        return res.status(400).json({
          error: "contactId, totalAmount, currency required",
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

      assertValidStatus(status);
      if (subBrand) assertValidSubBrand(subBrand);
      const parsedValidUntil = parseValidUntil(validUntil);

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_suppliers POST.
      const targetSubBrand = subBrand || "tmc";
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const created = await prisma.travelQuote.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: contactIdInt,
          status: status || "Draft",
          totalAmount: totalAmount,
          currency: String(currency),
          validUntil: parsedValidUntil,
        },
      });

      await writeAudit(
        "TravelQuote",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          status: created.status,
          currency: created.currency,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] create error:", e.message);
      res.status(500).json({ error: "Failed to create quote" });
    }
  },
);

// PUT /api/travel/quotes/:id — ADMIN/MANAGER only.
router.put(
  "/quotes/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        contactId, totalAmount, currency,
        subBrand, status, validUntil,
      } = req.body || {};

      if (contactId !== undefined) {
        const ci = parseInt(contactId, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
        }
        data.contactId = ci;
      }
      if (totalAmount !== undefined) data.totalAmount = totalAmount;
      if (currency !== undefined) data.currency = String(currency);
      if (status !== undefined) {
        assertValidStatus(status);
        data.status = status;
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        data.subBrand = subBrand;
      }
      if (validUntil !== undefined) {
        data.validUntil = parseValidUntil(validUntil);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelQuote.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelQuote",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] update error:", e.message);
      res.status(500).json({ error: "Failed to update quote" });
    }
  },
);

// DELETE /api/travel/quotes/:id — ADMIN/MANAGER only.
// Hard-delete via prisma.delete (Quote rows are draft-shaped business
// artifacts; hard-delete is fine unlike Supplier which uses soft-delete
// for referential integrity).
router.delete(
  "/quotes/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Quote not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Audit BEFORE delete so the entityId still resolves cleanly and
      // the audit row records the intent regardless of whether the
      // delete subsequently succeeds.
      await writeAudit(
        "TravelQuote",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          contactId: existing.contactId,
          status: existing.status,
        },
      );

      await prisma.travelQuote.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete quote" });
    }
  },
);

// ── Line-item endpoints (PRD_TRAVEL_QUOTE_BUILDER §3.2) ────────────────
//
// Lines are the composition under a TravelQuote (hotel rooms, flight
// segments, transport, visa fees, services). Every line CRUD recomputes
// the parent quote's totalAmount as the sum of all surviving lines so
// the quote header stays consistent with its composition. Lines inherit
// tenant + sub-brand scoping from their parent quote (no separate
// sub-brand column on the line — looked up via the FK).
//
// Auth: read endpoints accept any verified token; write endpoints
// require ADMIN/MANAGER. Same shape as the parent quote routes.

// Helper: load the parent quote tenant-scoped + sub-brand-scoped.
// Returns { quote } on success or sends an HTTP response on failure
// (caller short-circuits if !quote).
async function loadParentQuote(req, res, quoteId) {
  if (!Number.isFinite(quoteId)) {
    res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    return null;
  }
  const quote = await prisma.travelQuote.findFirst({
    where: { id: quoteId, tenantId: req.travelTenant.id },
  });
  if (!quote) {
    res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
    return null;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, quote.subBrand)) {
    res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    return null;
  }
  return quote;
}

// GET /api/travel/quotes/:id/lines — list lines for a quote.
router.get(
  "/quotes/:id/lines",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      res.json({ lines, total: lines.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] list lines error:", e.message);
      res.status(500).json({ error: "Failed to list quote lines" });
    }
  },
);

// POST /api/travel/quotes/:id/lines — ADMIN/MANAGER only.
// Required: description, unitPrice. Optional: lineType (default "other"),
// quantity (default 1), currency (default quote currency), supplierId,
// sortOrder, notes.
router.post(
  "/quotes/:id/lines",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const {
        lineType, description, quantity, unitPrice,
        currency, supplierId, sortOrder, notes,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({
          error: "description is required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidLineType(lineType);
      const qty = parsePositiveInt(quantity, "quantity", 1);
      const unit = parsePositiveDecimal(unitPrice, "unitPrice");
      const amount = qty * unit;

      let supplierIdInt = null;
      if (supplierId != null && supplierId !== "") {
        supplierIdInt = parseInt(supplierId, 10);
        if (!Number.isFinite(supplierIdInt)) {
          return res.status(400).json({
            error: "supplierId must be a number",
            code: "INVALID_SUPPLIER_ID",
          });
        }
      }

      const created = await prisma.travelQuoteLine.create({
        data: {
          tenantId: req.travelTenant.id,
          quoteId,
          lineType: lineType || "other",
          description: description.trim(),
          quantity: qty,
          unitPrice: unit,
          amount,
          currency: currency ? String(currency) : quote.currency,
          supplierId: supplierIdInt,
          sortOrder: Number.isFinite(parseInt(sortOrder, 10))
            ? parseInt(sortOrder, 10) : 0,
          notes: notes ? String(notes) : null,
        },
      });

      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      await writeAudit(
        "TravelQuoteLine",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId,
          lineType: created.lineType,
          amount: String(created.amount),
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] create line error:", e.message);
      res.status(500).json({ error: "Failed to create line" });
    }
  },
);

// PUT /api/travel/quotes/:id/lines/:lineId — ADMIN/MANAGER only.
router.put(
  "/quotes/:id/lines/:lineId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const existing = await prisma.travelQuoteLine.findFirst({
        where: { id: lineId, quoteId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      const data = {};
      const {
        lineType, description, quantity, unitPrice,
        currency, supplierId, sortOrder, notes,
      } = req.body || {};

      if (lineType !== undefined) {
        assertValidLineType(lineType);
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
      if (supplierId !== undefined) {
        if (supplierId === null || supplierId === "") {
          data.supplierId = null;
        } else {
          const sid = parseInt(supplierId, 10);
          if (!Number.isFinite(sid)) {
            return res.status(400).json({
              error: "supplierId must be a number",
              code: "INVALID_SUPPLIER_ID",
            });
          }
          data.supplierId = sid;
        }
      }
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

      const updated = await prisma.travelQuoteLine.update({
        where: { id: lineId },
        data,
      });

      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      await writeAudit(
        "TravelQuoteLine",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { quoteId, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] update line error:", e.message);
      res.status(500).json({ error: "Failed to update line" });
    }
  },
);

// DELETE /api/travel/quotes/:id/lines/:lineId — ADMIN/MANAGER only.
router.delete(
  "/quotes/:id/lines/:lineId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const existing = await prisma.travelQuoteLine.findFirst({
        where: { id: lineId, quoteId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      await writeAudit(
        "TravelQuoteLine",
        "DELETE",
        lineId,
        req.user.userId,
        req.travelTenant.id,
        { quoteId, lineType: existing.lineType, amount: String(existing.amount) },
      );

      await prisma.travelQuoteLine.delete({ where: { id: lineId } });
      await recomputeQuoteTotal(quoteId, req.travelTenant.id);

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] delete line error:", e.message);
      res.status(500).json({ error: "Failed to delete line" });
    }
  },
);

// POST /api/travel/quotes/:id/duplicate — ADMIN/MANAGER only.
//
// Copies an existing TravelQuote row into a fresh DRAFT row under the
// same tenant. Optional body fields { subBrand, contactId } let the
// operator re-target the duplicate (e.g. cloning a TMC quote across
// to RFU, or assigning to a different contact).
//
// Source row is looked up tenant-scoped + sub-brand-scoped (the same
// guard as GET/PUT/DELETE), so cross-tenant or cross-sub-brand reads
// yield 404 / 403 respectively. The duplicate inherits totalAmount /
// currency / validUntil from the source; status is always reset to
// "Draft" so the new row enters the operator queue cleanly.
router.post(
  "/quotes/:id/duplicate",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, source.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const { subBrand: subBrandOverride, contactId: contactIdOverride } = req.body || {};

      let targetSubBrand = source.subBrand;
      if (subBrandOverride !== undefined && subBrandOverride !== null && subBrandOverride !== "") {
        assertValidSubBrand(subBrandOverride);
        if (!canAccessSubBrand(allowed, subBrandOverride)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        targetSubBrand = subBrandOverride;
      }

      let targetContactId = source.contactId;
      if (contactIdOverride !== undefined && contactIdOverride !== null && contactIdOverride !== "") {
        const ci = parseInt(contactIdOverride, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
        }
        targetContactId = ci;
      }

      const created = await prisma.travelQuote.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          contactId: targetContactId,
          status: "Draft",
          totalAmount: source.totalAmount,
          currency: source.currency,
          validUntil: source.validUntil,
        },
      });

      // Clone line items from source quote into the duplicate. Composite
      // quotes (with line items) are duplicated as a complete unit —
      // operators copying a TMC trip package across to RFU expect the
      // hotel/flight/visa breakdown to come with it.
      const sourceLines = await prisma.travelQuoteLine.findMany({
        where: { quoteId: source.id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      if (sourceLines.length > 0) {
        await prisma.travelQuoteLine.createMany({
          data: sourceLines.map((l) => ({
            tenantId: req.travelTenant.id,
            quoteId: created.id,
            lineType: l.lineType,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: l.amount,
            currency: l.currency,
            supplierId: l.supplierId,
            sortOrder: l.sortOrder,
            notes: l.notes,
          })),
        });
      }

      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_DUPLICATED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          newId: created.id,
          subBrand: created.subBrand,
          contactId: created.contactId,
          linesCloned: sourceLines.length,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate quote" });
    }
  },
);

// GET /api/travel/quotes/:id/pdf — ADMIN/MANAGER only.
//
// Looks up the TravelQuote tenant-scoped + sub-brand-scoped, then hands
// the row to pdfRenderer.generateTravelQuotePdf which returns a
// Promise<Buffer>. We stream the Buffer back with attachment headers so
// the operator browser triggers a download dialog.
//
// PDF render failures are wrapped as 500 PDF_RENDER_FAILED rather than
// the generic "Failed to..." catch — pdfkit can throw on bad font/asset
// resolution and the operator-facing surface needs an actionable code.
router.get(
  "/quotes/:id/pdf",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const quote = await prisma.travelQuote.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!quote) {
        return res.status(404).json({ error: "Quote not found", code: "QUOTE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, quote.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      let pdfBuffer;
      try {
        pdfBuffer = await generateTravelQuotePdf(quote);
      } catch (renderErr) {
        console.error("[travel-quotes] PDF render error:", renderErr && renderErr.message);
        return res.status(500).json({
          error: "Failed to render quote PDF",
          code: "PDF_RENDER_FAILED",
        });
      }

      // Audit BEFORE sending the body so the row is durable even if the
      // client aborts mid-download. Mirrors the DELETE handler's ordering.
      await writeAudit(
        "TravelQuote",
        "TRAVEL_QUOTE_PDF_DOWNLOADED",
        quote.id,
        req.user.userId,
        req.travelTenant.id,
        {
          quoteId: quote.id,
          subBrand: quote.subBrand,
        },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="quote-${quote.id}.pdf"`,
      );
      res.status(200).end(pdfBuffer);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] pdf error:", e.message);
      res.status(500).json({ error: "Failed to generate quote PDF" });
    }
  },
);

// GET /api/travel/quotes/:id/pricing-preview — any verified token.
//
// READ-ONLY composition surface (PRD_TRAVEL_QUOTE_BUILDER FR-3.3.2 / FR-3.3.4).
// Loads the parent quote + its lines, fetches active TravelMarkupRule rows
// for the quote's sub-brand, and applies per-line markup using the pure
// lib/travelPricing.js helpers (pickMarkup + mapCategoryToScope).
//
// Per-line strategy: each line carries a `lineType` ∈
// {hotel, flight, transport, visa, service, other}. We map that to the
// markup-rule `scope` via mapCategoryToScope (visa/service/other collapse
// to "package"), then call pickMarkup to find the highest-priority active
// rule whose scope matches. Per-line markup is the rule's % or flat
// applied against the line's pre-markup amount. Aggregate markupApplied
// dedupes by ruleId (a single rule that covered both hotel + package
// lines surfaces as one entry with summed amount).
//
// Why not extend lib/travelPricing.js with a multi-line composer: the
// existing pure quote() is per-cost-row (single baseRate * seasonMul +
// markup). A multi-line aggregator with per-line season-date awareness +
// per-line markup is a bigger contract decision (DD-5.x pending) that
// belongs in its own slice. This endpoint composes the per-line shape
// inline using the existing pickMarkup helper so the math stays
// auditable and we don't fork the lib/ surface prematurely.
// TODO(travel-quotes-pricing-aggregator): when the multi-line composer
// lands in lib/travelPricing.js, replace the inline reduction below.
router.get(
  "/quotes/:id/pricing-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const rules = await prisma.travelMarkupRule.findMany({
        where: {
          tenantId: req.travelTenant.id,
          subBrand: quote.subBrand,
          isActive: true,
        },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });

      // Per-line markup composition. For each line:
      //   1. Map lineType → markup scope.
      //   2. pickMarkup against the line's pre-markup amount.
      //   3. Capture the matched rule (if any) into the dedupe map.
      // Round to 2 decimals at every step so subtotal+lineMarkups always
      // == total to the cent (no floating-point drift in the envelope).
      const round2 = (n) => Math.round(n * 100) / 100;
      const decoratedLines = [];
      const ruleAggregateById = new Map();
      let subtotalAccum = 0;

      for (const l of lines) {
        const lineAmount = Number(l.amount || 0);
        subtotalAccum += lineAmount;

        const scope = mapCategoryToScope(l.lineType);
        const { rule, markupAmount } = pickMarkup(
          rules,
          quote.subBrand,
          scope,
          lineAmount,
        );

        const amountWithMarkup = round2(lineAmount + markupAmount);
        decoratedLines.push({
          id: l.id,
          lineType: l.lineType,
          description: l.description,
          amount: round2(lineAmount),
          amountWithMarkup,
        });

        if (rule && markupAmount > 0) {
          const prior = ruleAggregateById.get(rule.id);
          if (prior) {
            prior.amount = round2(prior.amount + markupAmount);
          } else {
            ruleAggregateById.set(rule.id, {
              ruleId: rule.id,
              ruleName: rule.matchKeyJson || `rule-${rule.id}`,
              percent: rule.markupPct != null ? Number(rule.markupPct) : null,
              amount: round2(markupAmount),
            });
          }
        }
      }

      const subtotal = round2(subtotalAccum);
      const markupApplied = Array.from(ruleAggregateById.values());
      const totalMarkup = markupApplied.reduce((acc, r) => acc + r.amount, 0);
      const total = round2(subtotal + totalMarkup);

      res.json({
        subtotal,
        markupApplied,
        total,
        currency: quote.currency,
        lines: decoratedLines,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] pricing-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute pricing preview" });
    }
  },
);

// GET /api/travel/quotes/:id/tax-preview — any verified token.
//
// Slice 2 of #902 (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3). Consumes
// lib/gstCalculation.js (commit ced09867) — the pure CGST/SGST/IGST
// math + place-of-supply decision + per-category rate lookup.
//
// READ-ONLY tax-composition surface paralleling the markup
// pricing-preview endpoint above. Loads the parent quote + its lines,
// derives each line's GST rate from its lineType via
// gstRateForCategory, decides intra-vs-inter-state via
// isInterstateSupply, and aggregates per-line + per-rate-bucket totals
// via computeGstForLines.
//
// Place-of-supply (slice-2 SIMPLE rule):
//   - operatorStateCode from ?operatorStateCode= (default "IN-MH")
//   - customerStateCode from ?customerStateCode= (default same as
//     operatorStateCode → intra-state)
// FUTURE (slice 3): pull operator state from Tenant.gstStateCode +
// customer state from Contact.stateCode (FR-3.5.1 tenant master + Q-GST-2
// resolves contact state-code surface). Slice 2 stays decoupled from
// schema additions so the math + envelope can land while the master
// tables are being designed.
//
// Envelope contract: per-line {id, lineType, amount, gstPercent, cgst,
// sgst, igst, totalTax, amountWithTax} + envelope totals {subtotal,
// isInterstate, operatorStateCode, customerStateCode, totalCgst,
// totalSgst, totalIgst, totalTax, grandTotal, buckets[]}. Invariants:
// totalTax === totalCgst + totalSgst + totalIgst (split-consistency)
// and subtotal + totalTax === grandTotal (rounding-safe to 2 decimals
// because every step is round2'd in the lib helper).
//
// Per-line vs bucket aggregation: per-line totals are computed via
// computeGstSplit (one call per line, line-level rounding). Bucket
// summary is computed via computeGstForLines which sums taxable into
// per-rate buckets FIRST then taxes the bucket (per FR-3.4.3 HSN-summary
// shape). The two views can differ by ≤1 paise on multi-line quotes
// where individual lines round up vs bucket totals round once — that
// rounding drift is operator-visible by design; the GSTR-1 spec is the
// bucket view, the on-quote PDF is the per-line view. Both surfaces
// here so callers can pick.
router.get(
  "/quotes/:id/tax-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id, 10);
      const quote = await loadParentQuote(req, res, quoteId);
      if (!quote) return;

      // Place-of-supply state-code resolution (slice 4 — consumes
      // lib/gstStateCodeResolver.js, commit ef7573e7). Source-of-truth
      // chain per FR-3.x:
      //   1. Truthy override (query param) wins.
      //   2. DB column — Tenant.gstStateCode for operator,
      //      Contact.stateCode for customer (slice 3 schema adds).
      //   3. Hard-coded "IN-MH" — preserves slice 2 back-compat
      //      when both override + DB are absent.
      // Customer-side fallback when both override + DB are null:
      // mirror the operator (intra-state default) — handled inside
      // the helper, see lib/gstStateCodeResolver.js docs.
      //
      // Empty-string for an explicitly-provided param is still a 400
      // INVALID_STATE_CODE (defense-in-depth — keeps slice 2's spec
      // contract, prevents silent fall-through to defaults by sending
      // a blank value). The resolver's "empty-string == no override"
      // semantics handle the resolver-internal layer; this 400 is the
      // user-facing API-shape guarantee that explicit-blank is rejected.
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
        contactId: quote.contactId,
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

      const lines = await prisma.travelQuoteLine.findMany({
        where: { quoteId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      // Per-line decoration: each line gets its own gstPercent +
      // CGST/SGST/IGST split. Composite-supply per FR-3.2.4 — every
      // line is taxed at its own rate, no dominant-rate winner.
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

        // Per-line split via local computation (mirrors lib's
        // computeGstSplit; inlined to avoid an extra require for a
        // 5-line helper).
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

        // Slice 6 of #902 — surface per-line SAC code + description from
        // lib/hsnSacMapper.js (commit 6aca2361). Additive fields; the
        // existing per-line shape stays back-compat.
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

      // Bucket summary via lib helper (per-rate aggregation matches
      // GSTR-1 HSN-summary shape per FR-3.4.3 / NFR-4.2). Use the
      // bucket totals as the envelope-level totals so the spec-aligned
      // numbers win the consistency check (per-line drift is contained
      // to the lines[] array, never leaks into envelope totals).
      const bucketSummary = computeGstForLines(
        normalizedForBuckets,
        isInterstate,
      );

      // Slice 6 of #902 — HSN/SAC summary grouping per FR-3.4.3 (GSTR-1
      // export-ready shape: one row per (sacCode, gstPercent) pair with
      // summed taxableValue + line count). Sibling shape to buckets[]
      // (which groups by gstPercent only). Lines whose lineType has no
      // SAC of its own (tax/fee/tcs/tds) are skipped by the helper.
      const hsnSummary = groupLinesBySac(
        lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        })),
      );

      res.json({
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
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-quotes] tax-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute tax preview" });
    }
  },
);

module.exports = router;
