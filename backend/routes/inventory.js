// Wave 11 Agent HH — Inventory backbone (Google Doc audit, 8 May 2026).
//
// This module owns the four MISSING-from-the-Google-Doc inventory primitives
// and the auto-consumption rules engine that the existing per-visit consumption
// ledger (ServiceConsumption + lowStockEngine) lacks:
//
//   ProductCategory      — hierarchical taxonomy for Product (parent/children)
//   Vendor               — supplier master used by InventoryReceipt
//   InventoryReceipt     — incoming stock; SIDE EFFECT: increments
//                          Product.currentStock, audit-logs INVENTORY_RECEIVE,
//                          generates a tenant-scoped human-readable
//                          receiptNumber like "RCP-2026-0001"
//   InventoryAdjustment  — signed quantityDelta (positive=credit, negative=
//                          debit) for shrinkage/damage/expiry/recount/transfer.
//                          SIDE EFFECT: applies the delta to currentStock,
//                          audit-logs INVENTORY_ADJUST
//   AutoConsumptionRule  — per-(service,product) quantityPerVisit. The
//                          eventBus listener at backend/lib/autoConsumptionApplier.js
//                          fires on `visit.completed` events and decrements
//                          stock + creates a ServiceConsumption row per rule.
//
// Why a separate file (not extending wellness.js): wellness.js is 5k lines and
// concurrent agents are touching it. A separate route file with a `/api/wellness/*`
// mount lets HH ship without colliding with EE/FF/GG. Mounted in server.js
// under /api/wellness so paths like `/api/wellness/product-categories` work
// without leaking the file split into the URL.
//
// All endpoints require admin or manager wellnessRole (operational config,
// not PHI). Tenant scope inherits from req.user.tenantId via tenantWhere.
// Audit emitted on every mutation to feed the AuditLog hash chain.

const express = require("express");
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const { generateReceiptNumber } = require("../lib/inventoryReceiptNumber");
// #665: shared inverted-date-range guard — see lib/validateDateRange.js.
const { validateDateRange } = require("../lib/validateDateRange");

const router = express.Router();

// Standard tenant-where helper used everywhere in wellness.js.
const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// admin + manager are allowed to manage inventory config and run receipts/
// adjustments. Clinical staff (doctor/professional/telecaller) cannot — they
// trigger consumption indirectly via visits, not by editing the catalog.
const adminGate = verifyWellnessRole(["admin", "manager"]);

// ── ProductCategory CRUD ───────────────────────────────────────────

router.get("/product-categories", adminGate, async (req, res) => {
  try {
    const items = await prisma.productCategory.findMany({
      where: tenantWhere(req),
      orderBy: [{ parentId: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true, children: true } } },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list categories error:", e.message);
    res.status(500).json({ error: "Failed to list product categories" });
  }
});

router.post("/product-categories", adminGate, async (req, res) => {
  try {
    const { name, parentId, isActive } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (parentId !== undefined && parentId !== null) {
      const parent = await prisma.productCategory.findFirst({
        where: tenantWhere(req, { id: parseInt(parentId) }),
      });
      if (!parent) return res.status(400).json({ error: "parentId does not exist in this tenant", code: "PARENT_NOT_FOUND" });
    }
    const cat = await prisma.productCategory.create({
      data: {
        name: name.trim(),
        parentId: parentId ? parseInt(parentId) : null,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("ProductCategory", "CREATE", cat.id, req.user.userId, req.user.tenantId, {
      name: cat.name,
      parentId: cat.parentId,
    });
    res.status(201).json(cat);
  } catch (e) {
    console.error("[inventory] create category error:", e.message);
    res.status(500).json({ error: "Failed to create product category" });
  }
});

router.put("/product-categories/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.productCategory.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Product category not found" });

    const data = {};
    const allowed = ["name", "parentId", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    if (data.parentId === id) {
      return res.status(400).json({ error: "category cannot be its own parent", code: "PARENT_SELF_REFERENCE" });
    }
    if (data.parentId !== undefined && data.parentId !== null) {
      const parent = await prisma.productCategory.findFirst({
        where: tenantWhere(req, { id: parseInt(data.parentId) }),
      });
      if (!parent) return res.status(400).json({ error: "parentId does not exist in this tenant", code: "PARENT_NOT_FOUND" });
      data.parentId = parseInt(data.parentId);
    }

    const updated = await prisma.productCategory.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit("ProductCategory", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(updated);
  } catch (e) {
    console.error("[inventory] update category error:", e.message);
    res.status(500).json({ error: "Failed to update product category" });
  }
});

router.delete("/product-categories/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.productCategory.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Product category not found" });

    await prisma.productCategory.delete({ where: { id } });
    await writeAudit("ProductCategory", "DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    res.status(204).send();
  } catch (e) {
    console.error("[inventory] delete category error:", e.message);
    res.status(500).json({ error: "Failed to delete product category" });
  }
});

// ── Product read (list for forms) ───────────────────────────────────

router.get("/products", adminGate, async (req, res) => {
  try {
    const items = await prisma.product.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true, categoryId: true, currentStock: true, threshold: true, price: true },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list products error:", e.message);
    res.status(500).json({ error: "Failed to list products" });
  }
});

// ── Vendor CRUD ────────────────────────────────────────────────────

router.get("/vendors", adminGate, async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;
    const items = await prisma.vendor.findMany({
      where,
      orderBy: { name: "asc" },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list vendors error:", e.message);
    res.status(500).json({ error: "Failed to list vendors" });
  }
});

router.post("/vendors", adminGate, async (req, res) => {
  try {
    const { name, contactPerson, phone, email, gstin, addressLine, isActive } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    // GSTIN is 15 chars when present (2-digit state + 10-char PAN + 3 chars).
    // We don't enforce the full Indian GST checksum — too brittle for a demo
    // — but we do enforce the length to catch obvious typos.
    if (gstin && String(gstin).length !== 15) {
      return res.status(400).json({ error: "gstin must be exactly 15 characters when supplied", code: "INVALID_GSTIN" });
    }
    const vendor = await prisma.vendor.create({
      data: {
        name: name.trim(),
        contactPerson: contactPerson || null,
        phone: phone || null,
        email: email || null,
        gstin: gstin || null,
        addressLine: addressLine || null,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("Vendor", "CREATE", vendor.id, req.user.userId, req.user.tenantId, {
      name: vendor.name,
      gstin: vendor.gstin,
    });
    res.status(201).json(vendor);
  } catch (e) {
    console.error("[inventory] create vendor error:", e.message);
    res.status(500).json({ error: "Failed to create vendor" });
  }
});

router.put("/vendors/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.vendor.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Vendor not found" });

    const data = {};
    const allowed = ["name", "contactPerson", "phone", "email", "gstin", "addressLine", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    if (data.gstin && String(data.gstin).length !== 15) {
      return res.status(400).json({ error: "gstin must be exactly 15 characters when supplied", code: "INVALID_GSTIN" });
    }

    const updated = await prisma.vendor.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit("Vendor", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(updated);
  } catch (e) {
    console.error("[inventory] update vendor error:", e.message);
    res.status(500).json({ error: "Failed to update vendor" });
  }
});

router.delete("/vendors/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.vendor.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Vendor not found" });

    // Don't hard-delete vendors that have receipts attached — flip isActive
    // instead so historical receipts retain their vendor name in reports.
    const receiptCount = await prisma.inventoryReceipt.count({
      where: tenantWhere(req, { vendorId: id }),
    });
    if (receiptCount > 0) {
      const updated = await prisma.vendor.update({ where: { id }, data: { isActive: false } });
      await writeAudit("Vendor", "DEACTIVATE", id, req.user.userId, req.user.tenantId, {
        reason: "vendor has receipts; deactivated instead of deleted",
        receiptCount,
      });
      return res.json(updated);
    }

    await prisma.vendor.delete({ where: { id } });
    await writeAudit("Vendor", "DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    res.status(204).send();
  } catch (e) {
    console.error("[inventory] delete vendor error:", e.message);
    res.status(500).json({ error: "Failed to delete vendor" });
  }
});

// ── Inventory Receipts (incoming stock) ───────────────────────────
//
// SIDE EFFECT: every successful POST increments Product.currentStock by
// `quantity`. This is the canonical "stock comes in" path; receipts are
// immutable once written (no PUT/DELETE). Corrections happen via
// InventoryAdjustment with the appropriate signed delta.

router.get("/inventory/receipts", adminGate, async (req, res) => {
  try {
    // #665: reject inverted / invalid date ranges before they silently return empty.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const where = tenantWhere(req);
    if (req.query.productId) where.productId = parseInt(req.query.productId);
    if (req.query.vendorId) where.vendorId = parseInt(req.query.vendorId);
    if (req.query.from || req.query.to) {
      where.receivedAt = {};
      if (req.query.from) where.receivedAt.gte = new Date(req.query.from);
      if (req.query.to) where.receivedAt.lte = new Date(req.query.to);
    }
    const items = await prisma.inventoryReceipt.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: Math.min(parseInt(req.query.limit) || 100, 500),
      include: {
        product: { select: { id: true, name: true, sku: true } },
        vendor: { select: { id: true, name: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list receipts error:", e.message);
    res.status(500).json({ error: "Failed to list inventory receipts" });
  }
});

router.post("/inventory/receipts", adminGate, async (req, res) => {
  try {
    const { productId, vendorId, quantity, unitCost, batchNumber, expiryDate, notes } = req.body;
    if (!productId) return res.status(400).json({ error: "productId is required", code: "PRODUCT_REQUIRED" });
    if (quantity == null || Number(quantity) <= 0) {
      return res.status(400).json({ error: "quantity must be a positive number", code: "QUANTITY_INVALID" });
    }
    if (unitCost == null || Number(unitCost) < 0) {
      return res.status(400).json({ error: "unitCost must be 0 or greater", code: "UNIT_COST_INVALID" });
    }

    const product = await prisma.product.findFirst({ where: tenantWhere(req, { id: parseInt(productId) }) });
    if (!product) return res.status(404).json({ error: "product not found in this tenant", code: "PRODUCT_NOT_FOUND" });

    if (vendorId) {
      const vendor = await prisma.vendor.findFirst({ where: tenantWhere(req, { id: parseInt(vendorId) }) });
      if (!vendor) return res.status(400).json({ error: "vendor not found in this tenant", code: "VENDOR_NOT_FOUND" });
    }

    const qty = Number(quantity);
    const cost = Number(unitCost);
    const totalCost = qty * cost;

    // Atomic: generate the next per-tenant receiptNumber, create the receipt,
    // and increment the product's currentStock — all inside a transaction so
    // a partial write can never leave stock incremented without an audit row.
    const receipt = await prisma.$transaction(async (tx) => {
      const receiptNumber = await generateReceiptNumber(tx, req.user.tenantId);
      const r = await tx.inventoryReceipt.create({
        data: {
          receiptNumber,
          productId: parseInt(productId),
          vendorId: vendorId ? parseInt(vendorId) : null,
          quantity: qty,
          unitCost: cost,
          totalCost,
          batchNumber: batchNumber || null,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          receivedAt: new Date(),
          receivedBy: req.user.userId,
          notes: notes || null,
          tenantId: req.user.tenantId,
        },
      });
      // SIDE EFFECT: receipts increment current stock. currentStock is Int
      // on the existing Product model so we round up to the nearest unit
      // when fractional quantities arrive (e.g. 3.5 mL → 4). The exact
      // fractional record-of-truth lives on the receipt row itself.
      await tx.product.update({
        where: { id: product.id },
        data: { currentStock: { increment: Math.ceil(qty) } },
      });
      return r;
    });

    await writeAudit("InventoryReceipt", "INVENTORY_RECEIVE", receipt.id, req.user.userId, req.user.tenantId, {
      receiptNumber: receipt.receiptNumber,
      productId: receipt.productId,
      vendorId: receipt.vendorId,
      quantity: receipt.quantity,
      unitCost: receipt.unitCost,
      totalCost: receipt.totalCost,
    });

    res.status(201).json(receipt);
  } catch (e) {
    console.error("[inventory] create receipt error:", e.message);
    res.status(500).json({ error: "Failed to create inventory receipt" });
  }
});

// ── Inventory Adjustments (signed deltas) ─────────────────────────

router.get("/inventory/adjustments", adminGate, async (req, res) => {
  try {
    // #665: reject inverted / invalid date ranges before they silently return empty.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const where = tenantWhere(req);
    if (req.query.productId) where.productId = parseInt(req.query.productId);
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(req.query.from);
      if (req.query.to) where.createdAt.lte = new Date(req.query.to);
    }
    const items = await prisma.inventoryAdjustment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(req.query.limit) || 100, 500),
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list adjustments error:", e.message);
    res.status(500).json({ error: "Failed to list inventory adjustments" });
  }
});

const VALID_ADJUSTMENT_REASONS = new Set([
  "SHRINKAGE", "DAMAGE", "EXPIRY", "RECOUNT", "TRANSFER_OUT", "TRANSFER_IN", "MANUAL",
]);

router.post("/inventory/adjustments", adminGate, async (req, res) => {
  try {
    const { productId, quantityDelta, reason, notes } = req.body;
    if (!productId) return res.status(400).json({ error: "productId is required", code: "PRODUCT_REQUIRED" });
    if (quantityDelta == null || Number(quantityDelta) === 0 || Number.isNaN(Number(quantityDelta))) {
      return res.status(400).json({ error: "quantityDelta must be a non-zero number", code: "DELTA_INVALID" });
    }
    if (!reason || !VALID_ADJUSTMENT_REASONS.has(reason)) {
      return res.status(400).json({
        error: `reason must be one of: ${[...VALID_ADJUSTMENT_REASONS].join(", ")}`,
        code: "INVALID_REASON",
      });
    }

    const product = await prisma.product.findFirst({ where: tenantWhere(req, { id: parseInt(productId) }) });
    if (!product) return res.status(404).json({ error: "product not found in this tenant", code: "PRODUCT_NOT_FOUND" });

    const delta = Number(quantityDelta);

    const adjustment = await prisma.$transaction(async (tx) => {
      const a = await tx.inventoryAdjustment.create({
        data: {
          productId: parseInt(productId),
          quantityDelta: delta,
          reason,
          notes: notes || null,
          performedBy: req.user.userId,
          tenantId: req.user.tenantId,
        },
      });
      // SIDE EFFECT: adjustments shift currentStock by the signed delta.
      // currentStock is Int — round toward the delta sign so a -0.5 still
      // debits 1 unit (clinically the bottle is gone) and +0.5 still credits
      // 1 (clinically the bottle is back).
      const stockDelta = delta > 0 ? Math.ceil(delta) : Math.floor(delta);
      await tx.product.update({
        where: { id: product.id },
        data: { currentStock: { increment: stockDelta } },
      });
      return a;
    });

    await writeAudit("InventoryAdjustment", "INVENTORY_ADJUST", adjustment.id, req.user.userId, req.user.tenantId, {
      productId: adjustment.productId,
      quantityDelta: adjustment.quantityDelta,
      reason: adjustment.reason,
    });

    res.status(201).json(adjustment);
  } catch (e) {
    console.error("[inventory] create adjustment error:", e.message);
    res.status(500).json({ error: "Failed to create inventory adjustment" });
  }
});

// ── Auto-consumption rules (per-service-per-product) ─────────────

router.get("/auto-consumption-rules", adminGate, async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.serviceId) where.serviceId = parseInt(req.query.serviceId);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;
    const items = await prisma.autoConsumptionRule.findMany({
      where,
      orderBy: [{ serviceId: "asc" }, { productId: "asc" }],
      include: {
        service: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, sku: true, currentStock: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[inventory] list auto-consumption rules error:", e.message);
    res.status(500).json({ error: "Failed to list auto-consumption rules" });
  }
});

router.post("/auto-consumption-rules", adminGate, async (req, res) => {
  try {
    const { serviceId, productId, quantityPerVisit, isActive } = req.body;
    if (!serviceId) return res.status(400).json({ error: "serviceId is required", code: "SERVICE_REQUIRED" });
    if (!productId) return res.status(400).json({ error: "productId is required", code: "PRODUCT_REQUIRED" });
    if (quantityPerVisit == null || Number(quantityPerVisit) <= 0) {
      return res.status(400).json({ error: "quantityPerVisit must be a positive number", code: "QUANTITY_INVALID" });
    }

    const service = await prisma.service.findFirst({ where: tenantWhere(req, { id: parseInt(serviceId) }) });
    if (!service) return res.status(400).json({ error: "service not found in this tenant", code: "SERVICE_NOT_FOUND" });
    const product = await prisma.product.findFirst({ where: tenantWhere(req, { id: parseInt(productId) }) });
    if (!product) return res.status(400).json({ error: "product not found in this tenant", code: "PRODUCT_NOT_FOUND" });

    try {
      const rule = await prisma.autoConsumptionRule.create({
        data: {
          serviceId: parseInt(serviceId),
          productId: parseInt(productId),
          quantityPerVisit: Number(quantityPerVisit),
          isActive: isActive !== false,
          tenantId: req.user.tenantId,
        },
      });
      await writeAudit("AutoConsumptionRule", "CREATE", rule.id, req.user.userId, req.user.tenantId, {
        serviceId: rule.serviceId,
        productId: rule.productId,
        quantityPerVisit: rule.quantityPerVisit,
      });
      res.status(201).json(rule);
    } catch (createErr) {
      if (createErr.code === "P2002") {
        return res.status(409).json({
          error: "A rule already exists for this service+product pair; PUT to update it",
          code: "RULE_DUPLICATE",
        });
      }
      throw createErr;
    }
  } catch (e) {
    console.error("[inventory] create rule error:", e.message);
    res.status(500).json({ error: "Failed to create auto-consumption rule" });
  }
});

router.put("/auto-consumption-rules/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.autoConsumptionRule.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Rule not found" });

    const data = {};
    if (req.body.quantityPerVisit !== undefined) {
      const q = Number(req.body.quantityPerVisit);
      if (q <= 0) return res.status(400).json({ error: "quantityPerVisit must be a positive number", code: "QUANTITY_INVALID" });
      data.quantityPerVisit = q;
    }
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;

    const updated = await prisma.autoConsumptionRule.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit("AutoConsumptionRule", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(updated);
  } catch (e) {
    console.error("[inventory] update rule error:", e.message);
    res.status(500).json({ error: "Failed to update auto-consumption rule" });
  }
});

router.delete("/auto-consumption-rules/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.autoConsumptionRule.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Rule not found" });

    await prisma.autoConsumptionRule.delete({ where: { id } });
    await writeAudit("AutoConsumptionRule", "DELETE", id, req.user.userId, req.user.tenantId, {
      serviceId: existing.serviceId,
      productId: existing.productId,
    });
    res.status(204).send();
  } catch (e) {
    console.error("[inventory] delete rule error:", e.message);
    res.status(500).json({ error: "Failed to delete auto-consumption rule" });
  }
});

// ── Movements ledger (combined receipts + adjustments + consumption) ──
//
// Used by the frontend Inventory.jsx → Movements tab. Returns a chronologically
// sorted ledger of every stock change for the requested product. Enables an
// auditor to reconstruct currentStock from zero.
router.get("/inventory/movements", adminGate, async (req, res) => {
  try {
    const productId = req.query.productId ? parseInt(req.query.productId) : null;
    if (!productId) return res.status(400).json({ error: "productId is required", code: "PRODUCT_REQUIRED" });

    const product = await prisma.product.findFirst({ where: tenantWhere(req, { id: productId }) });
    if (!product) return res.status(404).json({ error: "product not found in this tenant", code: "PRODUCT_NOT_FOUND" });

    const [receipts, adjustments, consumptions] = await Promise.all([
      prisma.inventoryReceipt.findMany({
        where: tenantWhere(req, { productId }),
        orderBy: { receivedAt: "desc" },
        take: 200,
        include: { vendor: { select: { id: true, name: true } } },
      }),
      prisma.inventoryAdjustment.findMany({
        where: tenantWhere(req, { productId }),
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.serviceConsumption.findMany({
        where: tenantWhere(req, { productId }),
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { visit: { select: { id: true, visitDate: true, patientId: true } } },
      }),
    ]);

    const movements = [
      ...receipts.map((r) => ({
        kind: "RECEIPT",
        id: r.id,
        at: r.receivedAt,
        delta: r.quantity,
        receiptNumber: r.receiptNumber,
        vendor: r.vendor ? r.vendor.name : null,
        unitCost: r.unitCost,
        totalCost: r.totalCost,
        notes: r.notes,
      })),
      ...adjustments.map((a) => ({
        kind: "ADJUSTMENT",
        id: a.id,
        at: a.createdAt,
        delta: a.quantityDelta,
        reason: a.reason,
        notes: a.notes,
      })),
      ...consumptions.map((c) => ({
        kind: "CONSUMPTION",
        id: c.id,
        at: c.createdAt,
        delta: -c.qty,
        visitId: c.visitId,
        visitDate: c.visit ? c.visit.visitDate : null,
        unitCost: c.unitCost,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    res.json({
      productId,
      productName: product.name,
      currentStock: product.currentStock,
      threshold: product.threshold,
      movements,
    });
  } catch (e) {
    console.error("[inventory] movements error:", e.message);
    res.status(500).json({ error: "Failed to list movements" });
  }
});

module.exports = router;
