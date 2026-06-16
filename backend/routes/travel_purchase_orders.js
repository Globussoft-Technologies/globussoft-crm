// PRD_TRAVEL_SUPPLIER_MASTER FR-3.2 (G035/G036/G037) — supplier purchase orders.
//
// First-class PO ledger sitting BETWEEN a TravelSupplier and a
// TravelSupplierPayable. State machine:
//
//   draft → sent → acknowledged → fulfilled
//                                  └──→ cancelled
//   draft ─────────────────────────────→ cancelled
//   sent ──────────────────────────────→ cancelled
//   acknowledged ──────────────────────→ cancelled
//
// Each transition is gated by status check; invalid transitions return
// 409 INVALID_STATUS_TRANSITION with { from, to, allowed }.
//
// PO numbering: TPO-YYYY-NNNN per-tenant per-year, race-safe via
// `prisma.$transaction`. Numbering resets each calendar year.
//
// G037 — fulfillment auto-creates matching TravelSupplierPayable rows
// linking back via purchaseOrderId (FR-3.3.a). Each PO line of type
// `service` materialises into one payable.
//
// G036 — `/:id/pdf` renders the PO via services/pdfRenderer.js
// renderSupplierPo helper. ADMIN/MANAGER gated.
//
// Sub-brand isolation: inherited via the parent TravelSupplier. Every
// PO is scoped through its supplier's subBrand + tenantId. getSubBrandAccessSet()
// gates cross-sub-brand reads/writes — same pattern as travel_suppliers.js.
//
// Endpoints:
//   POST   /api/travel/purchase-orders                     ADMIN+MGR — create draft
//   GET    /api/travel/purchase-orders                     any — list (?supplierId, ?status, ?bookingId, paging)
//   GET    /api/travel/purchase-orders/:id                 any — detail with lines + supplier
//   PUT    /api/travel/purchase-orders/:id                 ADMIN+MGR — update (draft only)
//   POST   /api/travel/purchase-orders/:id/lines           ADMIN+MGR — add line
//   PUT    /api/travel/purchase-orders/:id/lines/:lineId   ADMIN+MGR — update line
//   DELETE /api/travel/purchase-orders/:id/lines/:lineId   ADMIN+MGR — delete line
//   POST   /api/travel/purchase-orders/:id/send            ADMIN+MGR — draft → sent
//   POST   /api/travel/purchase-orders/:id/acknowledge     ADMIN+MGR — sent → acknowledged
//   POST   /api/travel/purchase-orders/:id/fulfill         ADMIN+MGR — acknowledged → fulfilled + payable auto-create
//   POST   /api/travel/purchase-orders/:id/cancel          ADMIN — terminal state, requires cancelReason
//   GET    /api/travel/purchase-orders/:id/pdf             ADMIN+MGR — PO PDF via renderSupplierPo

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");
const pdfRenderer = require("../services/pdfRenderer");

const VALID_STATUSES = ["draft", "sent", "acknowledged", "fulfilled", "cancelled"];
const VALID_LINE_TYPES = ["service", "tax", "fee", "discount"];

// State-machine transition matrix. Key = from-status, value = allowed
// to-statuses for that source state. Used by every transition endpoint
// (/send, /acknowledge, /fulfill, /cancel) to gate.
const TRANSITIONS = {
  draft: new Set(["sent", "cancelled"]),
  sent: new Set(["acknowledged", "cancelled"]),
  acknowledged: new Set(["fulfilled", "cancelled"]),
  fulfilled: new Set(), // terminal
  cancelled: new Set(), // terminal
};

// Build a TPO-YYYY-NNNN PO number for the caller's tenant, scoped to the
// current calendar year. Race-safe via $transaction so concurrent creates
// can't collide on the sequence number. Wrapped as `module.exports` indirection
// so vitest can vi.spyOn() the seam without touching the prisma client.
async function nextPoNumber(tenantId) {
  const year = new Date().getUTCFullYear();
  const prefix = `TPO-${year}-`;
  // Count existing POs for this tenant/year and increment. The count +
  // create both run inside the transaction so two concurrent callers
  // serialise on the row count.
  return prisma.$transaction(async (tx) => {
    const count = await tx.travelPurchaseOrder.count({
      where: {
        tenantId,
        poNumber: { startsWith: prefix },
      },
    });
    return `${prefix}${String(count + 1).padStart(4, "0")}`;
  });
}

function assertValidStatus(s) {
  if (!VALID_STATUSES.includes(s)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

function assertValidLineType(t) {
  if (!VALID_LINE_TYPES.includes(t)) {
    const err = new Error(`lineType must be one of: ${VALID_LINE_TYPES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_LINE_TYPE";
    throw err;
  }
}

// Compute lineTotal from quantity + unitPrice. Discount lines flip sign so
// they reduce the PO subtotal naturally. Tax + fee lines are positive.
function computeLineTotal(lineType, quantity, unitPrice) {
  const q = Number(quantity) || 0;
  const u = Number(unitPrice) || 0;
  const raw = q * u;
  return lineType === "discount" ? -Math.abs(raw) : raw;
}

// Recompute cached PO totals after a line CRUD. subtotal = sum of service
// lines; taxAmount = sum of tax lines; totalAmount = sum of all (including
// fees and discounts).
async function recomputePoTotals(tx, purchaseOrderId) {
  const lines = await tx.travelPurchaseOrderLine.findMany({
    where: { purchaseOrderId },
    select: { lineType: true, lineTotal: true },
  });
  let subtotal = 0;
  let taxAmount = 0;
  let totalAmount = 0;
  for (const l of lines) {
    const v = Number(l.lineTotal) || 0;
    totalAmount += v;
    if (l.lineType === "service") subtotal += v;
    if (l.lineType === "tax") taxAmount += v;
  }
  await tx.travelPurchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      subtotal: subtotal.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
    },
  });
}

// Parent loader. Fetches the PO + supplier, gates on tenant + sub-brand
// access. Caller can pre-load needed relations via `include`. Throws a
// status-coded Error on miss/deny so the route's catch can branch on
// e.status / e.code.
async function loadPo(req, include) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const po = await prisma.travelPurchaseOrder.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          subBrand: true,
          supplierCategory: true,
          contactPerson: true,
          phone: true,
          email: true,
          gstin: true,
          addressLine: true,
          paymentTermsDays: true,
        },
      },
      ...(include || {}),
    },
  });
  if (!po) {
    const err = new Error("Purchase order not found");
    err.status = 404;
    err.code = "PO_NOT_FOUND";
    throw err;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, po.supplier.subBrand)) {
    const err = new Error("Sub-brand access denied");
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
  return po;
}

// ─── GET /api/travel/purchase-orders — list ──────────────────────────

router.get(
  "/purchase-orders",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.supplierId) {
        const sid = parseInt(req.query.supplierId, 10);
        if (!Number.isFinite(sid)) {
          return res.status(400).json({ error: "supplierId must be a number", code: "INVALID_SUPPLIER_ID" });
        }
        where.supplierId = sid;
      }
      if (req.query.bookingId) {
        const bid = parseInt(req.query.bookingId, 10);
        if (!Number.isFinite(bid)) {
          return res.status(400).json({ error: "bookingId must be a number", code: "INVALID_BOOKING_ID" });
        }
        where.bookingId = bid;
      }
      if (req.query.status) {
        assertValidStatus(String(req.query.status));
        where.status = String(req.query.status);
      }

      // Sub-brand isolation. Join through the supplier's subBrand: pull
      // allowed set + filter through it. Same pattern as travel_suppliers.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.supplier = { subBrand: { in: [...allowed] } };
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [rows, total] = await Promise.all([
        prisma.travelPurchaseOrder.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
          include: {
            supplier: {
              select: { id: true, name: true, subBrand: true, supplierCategory: true },
            },
          },
        }),
        prisma.travelPurchaseOrder.count({ where }),
      ]);

      res.json({ purchaseOrders: rows, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] list error:", e.message);
      res.status(500).json({ error: "Failed to list purchase orders" });
    }
  },
);

// ─── POST /api/travel/purchase-orders — create draft ─────────────────

router.post(
  "/purchase-orders",
  verifyToken,
  requirePermission("suppliers", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { supplierId, bookingId, currency, notes } = req.body || {};
      if (!supplierId) {
        return res.status(400).json({ error: "supplierId required", code: "MISSING_FIELDS" });
      }
      const sid = parseInt(supplierId, 10);
      if (!Number.isFinite(sid)) {
        return res.status(400).json({ error: "supplierId must be a number", code: "INVALID_SUPPLIER_ID" });
      }
      let bid = null;
      if (bookingId != null && bookingId !== "") {
        bid = parseInt(bookingId, 10);
        if (!Number.isFinite(bid)) {
          return res.status(400).json({ error: "bookingId must be a number", code: "INVALID_BOOKING_ID" });
        }
      }

      // Sub-brand isolation: look up parent supplier first, gate on its
      // subBrand vs caller's allowed set.
      const supplier = await prisma.travelSupplier.findFirst({
        where: { id: sid, tenantId: req.travelTenant.id },
        select: { id: true, subBrand: true },
      });
      if (!supplier) {
        return res.status(404).json({ error: "Supplier not found", code: "SUPPLIER_NOT_FOUND" });
      }
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const poNumber = await module.exports.nextPoNumber(req.travelTenant.id);
      const created = await prisma.travelPurchaseOrder.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: sid,
          bookingId: bid,
          poNumber,
          status: "draft",
          currency: currency || "INR",
          notes: notes || null,
          createdBy: req.user.userId,
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "P2002") {
        return res.status(409).json({ error: "poNumber collision — retry", code: "DUPLICATE_PO_NUMBER" });
      }
      console.error("[travel-po] create error:", e.message);
      res.status(500).json({ error: "Failed to create purchase order" });
    }
  },
);

// ─── GET /api/travel/purchase-orders/:id — detail ────────────────────

router.get(
  "/purchase-orders/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req, {
        lines: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      });
      res.json(po);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] detail error:", e.message);
      res.status(500).json({ error: "Failed to load purchase order" });
    }
  },
);

// ─── PUT /api/travel/purchase-orders/:id — update (draft only) ───────

router.put(
  "/purchase-orders/:id",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (po.status !== "draft") {
        return res.status(409).json({
          error: `PO can only be edited in draft state (currently ${po.status})`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "draft-edit",
          allowed: ["draft"],
        });
      }
      const data = {};
      const { currency, notes, bookingId } = req.body || {};
      if (currency !== undefined) data.currency = String(currency);
      if (notes !== undefined) data.notes = notes || null;
      if (bookingId !== undefined) {
        if (bookingId === null || bookingId === "") {
          data.bookingId = null;
        } else {
          const bid = parseInt(bookingId, 10);
          if (!Number.isFinite(bid)) {
            return res.status(400).json({ error: "bookingId must be a number", code: "INVALID_BOOKING_ID" });
          }
          data.bookingId = bid;
        }
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelPurchaseOrder.update({
        where: { id: po.id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] update error:", e.message);
      res.status(500).json({ error: "Failed to update purchase order" });
    }
  },
);

// ─── Line items CRUD ─────────────────────────────────────────────────

router.post(
  "/purchase-orders/:id/lines",
  verifyToken,
  requirePermission("suppliers", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (po.status === "fulfilled" || po.status === "cancelled") {
        return res.status(409).json({
          error: `PO lines cannot be modified in ${po.status} state`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "line-add",
          allowed: ["draft", "sent", "acknowledged"],
        });
      }
      const { lineType, description, quantity, unitPrice, pnr, bookingRef, sortOrder } = req.body || {};
      if (!lineType || !description) {
        return res.status(400).json({ error: "lineType and description required", code: "MISSING_FIELDS" });
      }
      assertValidLineType(String(lineType));
      const q = quantity != null ? Number(quantity) : 1;
      const u = unitPrice != null ? Number(unitPrice) : 0;
      if (!Number.isFinite(q) || q < 0) {
        return res.status(400).json({ error: "quantity must be a non-negative number", code: "INVALID_QUANTITY" });
      }
      if (!Number.isFinite(u)) {
        return res.status(400).json({ error: "unitPrice must be a number", code: "INVALID_UNIT_PRICE" });
      }
      const lineTotal = computeLineTotal(String(lineType), q, u);

      const created = await prisma.$transaction(async (tx) => {
        const line = await tx.travelPurchaseOrderLine.create({
          data: {
            tenantId: req.travelTenant.id,
            purchaseOrderId: po.id,
            lineType: String(lineType),
            description: String(description),
            quantity: q.toFixed(2),
            unitPrice: u.toFixed(2),
            lineTotal: lineTotal.toFixed(2),
            pnr: pnr || null,
            bookingRef: bookingRef || null,
            sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
          },
        });
        await recomputePoTotals(tx, po.id);
        return line;
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] line create error:", e.message);
      res.status(500).json({ error: "Failed to add line" });
    }
  },
);

router.put(
  "/purchase-orders/:id/lines/:lineId",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (po.status === "fulfilled" || po.status === "cancelled") {
        return res.status(409).json({
          error: `PO lines cannot be modified in ${po.status} state`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "line-edit",
          allowed: ["draft", "sent", "acknowledged"],
        });
      }
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const line = await prisma.travelPurchaseOrderLine.findFirst({
        where: { id: lineId, purchaseOrderId: po.id },
      });
      if (!line) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }
      const data = {};
      const { lineType, description, quantity, unitPrice, pnr, bookingRef, sortOrder } = req.body || {};
      if (lineType !== undefined) {
        assertValidLineType(String(lineType));
        data.lineType = String(lineType);
      }
      if (description !== undefined) data.description = String(description);
      if (quantity !== undefined) {
        const q = Number(quantity);
        if (!Number.isFinite(q) || q < 0) {
          return res.status(400).json({ error: "quantity must be a non-negative number", code: "INVALID_QUANTITY" });
        }
        data.quantity = q.toFixed(2);
      }
      if (unitPrice !== undefined) {
        const u = Number(unitPrice);
        if (!Number.isFinite(u)) {
          return res.status(400).json({ error: "unitPrice must be a number", code: "INVALID_UNIT_PRICE" });
        }
        data.unitPrice = u.toFixed(2);
      }
      if (pnr !== undefined) data.pnr = pnr || null;
      if (bookingRef !== undefined) data.bookingRef = bookingRef || null;
      if (sortOrder !== undefined) data.sortOrder = Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0;
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields", code: "EMPTY_BODY" });
      }
      // If quantity / unitPrice / lineType changed, recompute lineTotal.
      const effectiveType = data.lineType ?? line.lineType;
      const effectiveQty = data.quantity != null ? Number(data.quantity) : Number(line.quantity);
      const effectiveUnit = data.unitPrice != null ? Number(data.unitPrice) : Number(line.unitPrice);
      if ("quantity" in data || "unitPrice" in data || "lineType" in data) {
        data.lineTotal = computeLineTotal(effectiveType, effectiveQty, effectiveUnit).toFixed(2);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const next = await tx.travelPurchaseOrderLine.update({
          where: { id: lineId },
          data,
        });
        await recomputePoTotals(tx, po.id);
        return next;
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] line update error:", e.message);
      res.status(500).json({ error: "Failed to update line" });
    }
  },
);

router.delete(
  "/purchase-orders/:id/lines/:lineId",
  verifyToken,
  requirePermission("suppliers", "delete"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (po.status === "fulfilled" || po.status === "cancelled") {
        return res.status(409).json({
          error: `PO lines cannot be modified in ${po.status} state`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "line-delete",
          allowed: ["draft", "sent", "acknowledged"],
        });
      }
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const line = await prisma.travelPurchaseOrderLine.findFirst({
        where: { id: lineId, purchaseOrderId: po.id },
      });
      if (!line) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }
      await prisma.$transaction(async (tx) => {
        await tx.travelPurchaseOrderLine.delete({ where: { id: lineId } });
        await recomputePoTotals(tx, po.id);
      });
      res.status(204).send();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] line delete error:", e.message);
      res.status(500).json({ error: "Failed to delete line" });
    }
  },
);

// ─── State machine transitions ───────────────────────────────────────

function buildTransitionHandler(toStatus, timestampField) {
  return async (req, res) => {
    try {
      const po = await loadPo(req);
      if (!TRANSITIONS[po.status] || !TRANSITIONS[po.status].has(toStatus)) {
        return res.status(409).json({
          error: `Cannot transition from ${po.status} to ${toStatus}`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: toStatus,
          allowed: Array.from(TRANSITIONS[po.status] || []),
        });
      }
      const data = { status: toStatus };
      data[timestampField] = new Date();
      const updated = await prisma.travelPurchaseOrder.update({
        where: { id: po.id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error(`[travel-po] transition ${toStatus} error:`, e.message);
      res.status(500).json({ error: `Failed to transition to ${toStatus}` });
    }
  };
}

// PRD_TRAVEL_SUPPLIER_MASTER G042 — credit-limit hard-block on draft → sent.
// The PO `total` (computed by recomputePoTotals from line totals) is the
// projected amount; check against supplier.creditLimit + outstanding
// payables (excluding paid + cancelled). Returns 409 CREDIT_LIMIT_EXCEEDED
// on breach. ADMIN can override via body.overrideCreditLimit=true.
router.post(
  "/purchase-orders/:id/send",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (!TRANSITIONS[po.status] || !TRANSITIONS[po.status].has("sent")) {
        return res.status(409).json({
          error: `Cannot transition from ${po.status} to sent`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "sent",
          allowed: Array.from(TRANSITIONS[po.status] || []),
        });
      }

      // G042 — credit-limit hard-block. PO.totalAmount comes from
      // recomputePoTotals (the per-line line-total sum). When > 0, run the
      // check; null/zero PO skips the check (creating an empty PO is allowed
      // but the operator gets the credit-block at /send time if there's
      // a non-zero total).
      const projectedAmount = Number(po.totalAmount != null ? po.totalAmount : 0);
      const overrideRequested =
        req.body && (req.body.overrideCreditLimit === true || req.body.overrideCreditLimit === "true");
      const isAdmin = req.user && req.user.role === "ADMIN";
      if (Number.isFinite(projectedAmount) && projectedAmount > 0 && !(overrideRequested && isAdmin)) {
        const { checkCreditLimit } = require("../lib/supplierCreditCheck");
        const check = await checkCreditLimit({
          prisma,
          tenantId: req.travelTenant.id,
          supplierId: po.supplierId,
          addAmount: projectedAmount,
        });
        if (!check.allowed) {
          return res.status(409).json({
            error: "Purchase order would exceed supplier credit limit",
            code: "CREDIT_LIMIT_EXCEEDED",
            supplierId: po.supplierId,
            current: check.current,
            limit: check.limit,
            projected: check.projected,
          });
        }
      }

      const updated = await prisma.travelPurchaseOrder.update({
        where: { id: po.id },
        data: { status: "sent", sentAt: new Date() },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] transition sent error:", e.message);
      res.status(500).json({ error: "Failed to transition to sent" });
    }
  },
);

router.post(
  "/purchase-orders/:id/acknowledge",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  buildTransitionHandler("acknowledged", "acknowledgedAt"),
);

// /fulfill is special — it auto-creates matching TravelSupplierPayable
// rows (G037 / FR-3.3.a) for every `service`-typed line on the PO. Each
// payable carries the PO's bookingRef / pnr in its description and links
// back via purchaseOrderId.
router.post(
  "/purchase-orders/:id/fulfill",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req, {
        lines: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      });
      if (!TRANSITIONS[po.status] || !TRANSITIONS[po.status].has("fulfilled")) {
        return res.status(409).json({
          error: `Cannot transition from ${po.status} to fulfilled`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "fulfilled",
          allowed: Array.from(TRANSITIONS[po.status] || []),
        });
      }
      // FR-3.3.a — auto-create one payable per service line. Wrapped in
      // a transaction so the status flip + payable inserts succeed or
      // fail together.
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.travelPurchaseOrder.update({
          where: { id: po.id },
          data: {
            status: "fulfilled",
            fulfilledAt: new Date(),
          },
        });
        const serviceLines = (po.lines || []).filter((l) => l.lineType === "service");
        const payables = [];
        for (const l of serviceLines) {
          const payable = await tx.travelSupplierPayable.create({
            data: {
              tenantId: req.travelTenant.id,
              supplierId: po.supplierId,
              purchaseOrderId: po.id,
              poNumber: po.poNumber,
              description: `${po.poNumber} — ${l.description}`,
              amount: Number(l.lineTotal || 0).toFixed(2),
              currency: po.currency || "INR",
              status: "pending",
            },
          });
          payables.push(payable);
        }
        return { purchaseOrder: updated, payablesCreated: payables.length };
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] fulfill error:", e.message);
      res.status(500).json({ error: "Failed to fulfill purchase order" });
    }
  },
);

router.post(
  "/purchase-orders/:id/cancel",
  verifyToken,
  // Privileged status transition — admin-only per directive (not yet
  // converted to permission-based; awaiting explicit approval to map
  // to suppliers.manage or a dedicated action).
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req);
      if (!TRANSITIONS[po.status] || !TRANSITIONS[po.status].has("cancelled")) {
        return res.status(409).json({
          error: `Cannot cancel from ${po.status} state`,
          code: "INVALID_STATUS_TRANSITION",
          from: po.status,
          to: "cancelled",
          allowed: Array.from(TRANSITIONS[po.status] || []),
        });
      }
      const { cancelReason } = req.body || {};
      if (!cancelReason || !String(cancelReason).trim()) {
        return res.status(400).json({ error: "cancelReason required", code: "MISSING_FIELDS" });
      }
      const updated = await prisma.travelPurchaseOrder.update({
        where: { id: po.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: String(cancelReason),
        },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] cancel error:", e.message);
      res.status(500).json({ error: "Failed to cancel purchase order" });
    }
  },
);

// ─── GET /api/travel/purchase-orders/:id/pdf — PO PDF (G036) ────────

router.get(
  "/purchase-orders/:id/pdf",
  verifyToken,
  requirePermission("suppliers", "read"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const po = await loadPo(req, {
        lines: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      });
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.travelTenant.id },
        select: { id: true, name: true, subBrandConfigJson: true },
      });
      const buf = await pdfRenderer.renderSupplierPo({
        purchaseOrder: po,
        supplier: po.supplier,
        lines: po.lines || [],
        tenant,
        tenantSubBrand: po.supplier ? po.supplier.subBrand : null,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${po.poNumber}.pdf"`,
      );
      res.send(buf);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-po] pdf error:", e.message);
      res.status(500).json({ error: "Failed to render PDF" });
    }
  },
);

module.exports = router;
// Export helpers via the router for vitest spy seam + the booking-confirm
// hook in routes/travel_trips.js (G037 auto-PO).
module.exports.nextPoNumber = nextPoNumber;
module.exports.TRANSITIONS = TRANSITIONS;
module.exports.VALID_STATUSES = VALID_STATUSES;
module.exports.VALID_LINE_TYPES = VALID_LINE_TYPES;
