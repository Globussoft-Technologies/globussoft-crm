// @ts-check
/**
 * Unit tests for backend/routes/inventory.js — first vitest-level pin of the
 * wellness inventory backbone (mounted under /api/wellness by server.js).
 *
 * Why this file exists
 * ────────────────────
 * routes/inventory.js (775 LOC, Wave 11 Agent HH) owns the four MISSING-from-
 * Google-Doc primitives that the per-visit ServiceConsumption ledger lacked:
 * ProductCategory hierarchy, Vendor master, InventoryReceipt (incoming stock),
 * InventoryAdjustment (signed delta with reason enum) — plus the auto-
 * consumption rules engine and a combined movements ledger. Every mutation
 * has a downstream side effect on Product.currentStock and emits a
 * tenant-scoped writeAudit row. Silent drift on any of these → either stock
 * walks out of sync with reality (operational disaster) or audit chain is
 * incomplete (compliance disaster). Pin the wire shape and side effects now.
 *
 * Endpoints under test
 * ────────────────────
 *   GET    /product-categories                 — list, tenant-scoped, with _count
 *   POST   /product-categories                 — create with NAME_REQUIRED guard
 *   PUT    /product-categories/:id             — update; 404 cross-tenant; PARENT_SELF_REFERENCE
 *   DELETE /product-categories/:id             — 204 No Content
 *   GET    /products                           — list with select projection
 *   GET    /vendors                            — list with optional isActive filter
 *   POST   /vendors                            — create with INVALID_GSTIN length guard
 *   DELETE /vendors/:id                        — deactivate-if-has-receipts vs hard-delete
 *   POST   /inventory/receipts                 — create + transactional currentStock increment
 *   GET    /inventory/receipts                 — list; INVERTED_DATE_RANGE guard (#665)
 *   POST   /inventory/adjustments              — signed delta + reason enum
 *   GET    /inventory/movements                — PRODUCT_REQUIRED + combined ledger
 *   POST   /auto-consumption-rules             — create + Prisma P2002 → 409 RULE_DUPLICATE
 *
 * Cases pinned (15 total)
 * ───────────────────────
 *   ProductCategory:
 *     1. GET — tenant-scoped findMany with _count include + ordered by parent/name
 *     2. POST — 400 NAME_REQUIRED when name is missing or whitespace
 *     3. POST — 201 with tenantId from JWT; defaults isActive=true; audit fires
 *     4. PUT — 400 PARENT_SELF_REFERENCE when parentId === id
 *     5. DELETE — 404 cross-tenant (findFirst returns null)
 *
 *   Vendor:
 *     6. GET — ?isActive=true narrows where clause
 *     7. POST — 400 INVALID_GSTIN when gstin length ≠ 15
 *     8. DELETE — deactivates (200 + isActive=false) when vendor has receipts;
 *        hard-deletes (204) when receipt count is 0
 *
 *   InventoryReceipt:
 *     9. POST — 400 QUANTITY_INVALID when quantity is 0 or negative
 *    10. POST — 201 with transactional currentStock increment via tx.product.update
 *    11. GET — 400 INVERTED_DATE_RANGE when ?to < ?from (#665 validateDateRange)
 *
 *   InventoryAdjustment:
 *    12. POST — 400 INVALID_REASON when reason is not in VALID_ADJUSTMENT_REASONS
 *    13. POST — 201 with signed delta written through to product.update
 *        (NOTE: negative-stock prevention is NOT enforced by the route today —
 *         a delta that would drive currentStock below 0 still succeeds. See
 *         test #13's TODO note. This test pins TODAY's behavior; flag candidate
 *         for a follow-up bug-test-cron issue.)
 *
 *   AutoConsumptionRule:
 *    14. POST — 409 RULE_DUPLICATE when Prisma raises P2002 (unique violation)
 *
 *   Movements:
 *    15. GET — 400 PRODUCT_REQUIRED when ?productId is absent
 *
 * Auth gating
 * ───────────
 * adminGate = verifyWellnessRole(['admin', 'manager']) — covered indirectly by
 * the test 'no req.user → 401' on the GET /product-categories case (case 1
 * variant). Per-case role tests are omitted here because drugs.test.js covers
 * the verifyWellnessRole branch exhaustively — duplicating role-table tests
 * across every wellness route would be churn.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/drugs.test.js — synthetic auth middleware
 * injects req.user with vertical='wellness' so verifyWellnessRole's
 * tenant.findUnique short-circuit fires. Prisma singleton patched BEFORE
 * the router is required so the route binds to the spy'd functions.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── Prisma singleton patching (BEFORE requiring the router) ───────────────
const prisma = requireCJS('../../lib/prisma');

prisma.productCategory = prisma.productCategory || {};
prisma.productCategory.findMany = vi.fn();
prisma.productCategory.findFirst = vi.fn();
prisma.productCategory.create = vi.fn();
prisma.productCategory.update = vi.fn();
prisma.productCategory.delete = vi.fn();

prisma.product = prisma.product || {};
prisma.product.findMany = vi.fn();
prisma.product.findFirst = vi.fn();
prisma.product.update = vi.fn();
prisma.product.create = vi.fn();

prisma.vendor = prisma.vendor || {};
prisma.vendor.findMany = vi.fn();
prisma.vendor.findFirst = vi.fn();
prisma.vendor.create = vi.fn();
prisma.vendor.update = vi.fn();
prisma.vendor.delete = vi.fn();

prisma.inventoryReceipt = prisma.inventoryReceipt || {};
prisma.inventoryReceipt.findMany = vi.fn();
prisma.inventoryReceipt.findFirst = vi.fn();
prisma.inventoryReceipt.create = vi.fn();
prisma.inventoryReceipt.count = vi.fn();

prisma.inventoryAdjustment = prisma.inventoryAdjustment || {};
prisma.inventoryAdjustment.findMany = vi.fn();
prisma.inventoryAdjustment.create = vi.fn();

prisma.serviceConsumption = prisma.serviceConsumption || {};
prisma.serviceConsumption.findMany = vi.fn().mockResolvedValue([]);

prisma.autoConsumptionRule = prisma.autoConsumptionRule || {};
prisma.autoConsumptionRule.findMany = vi.fn();
prisma.autoConsumptionRule.findFirst = vi.fn();
prisma.autoConsumptionRule.create = vi.fn();
prisma.autoConsumptionRule.update = vi.fn();
prisma.autoConsumptionRule.delete = vi.fn();

prisma.service = prisma.service || {};
prisma.service.findFirst = vi.fn();

// audit write target — writeAudit hits auditLog.create.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// tenant.findUnique is called by verifyWellnessRole when req.user.vertical
// is missing; we inject vertical on req.user so it shouldn't fire, but stub
// defensively so a missed injection doesn't blow up.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// eventBus stubs — writeAudit triggers a best-effort emit downstream.
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

// $transaction: pass through the callback with the patched prisma as tx so
// the transaction-scoped tx.inventoryReceipt.create / tx.product.update /
// tx.inventoryAdjustment.create calls land on our spies.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));

import express from 'express';
import request from 'supertest';

const inventoryRouter = requireCJS('../../routes/inventory');

/**
 * Build an express app with a synthetic auth middleware. Defaults to ADMIN
 * on a wellness tenant so adminGate admits the request. Override
 * { role, wellnessRole, tenantId } to exercise denial paths.
 *
 * If `skipAuth: true`, no auth middleware is attached at all — req.user
 * stays undefined so verifyWellnessRole's `if (!req.user) → 401` fires.
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole,
  vertical = 'wellness',
  skipAuth = false,
} = {}) {
  const app = express();
  app.use(express.json());
  if (!skipAuth) {
    app.use((req, _res, next) => {
      // isOwner short-circuits requirePermission (the route's gate) so the
      // synthetic ADMIN passes every products/inventory permission check
      // without needing prisma.userRole stubs. The verifyWellnessRole
      // adminGate (used only on /upload/service-* in this file) still
      // honours role === 'ADMIN' under a wellness vertical.
      req.user = { userId, tenantId, role, wellnessRole, vertical, isOwner: true };
      next();
    });
  }
  app.use('/api/wellness', inventoryRouter);
  return app;
}

beforeEach(() => {
  prisma.productCategory.findMany.mockReset();
  prisma.productCategory.findFirst.mockReset();
  prisma.productCategory.create.mockReset();
  prisma.productCategory.update.mockReset();
  prisma.productCategory.delete.mockReset();

  prisma.product.findMany.mockReset();
  prisma.product.findFirst.mockReset();
  prisma.product.update.mockReset();
  prisma.product.create.mockReset();
  prisma.product.create.mockImplementation(async ({ data }) => ({ id: 500, ...data }));

  prisma.vendor.findMany.mockReset();
  prisma.vendor.findFirst.mockReset();
  prisma.vendor.create.mockReset();
  prisma.vendor.update.mockReset();
  prisma.vendor.delete.mockReset();

  prisma.inventoryReceipt.findMany.mockReset();
  prisma.inventoryReceipt.findFirst.mockReset();
  prisma.inventoryReceipt.create.mockReset();
  prisma.inventoryReceipt.count.mockReset();

  prisma.inventoryAdjustment.findMany.mockReset();
  prisma.inventoryAdjustment.create.mockReset();

  prisma.autoConsumptionRule.findMany.mockReset();
  prisma.autoConsumptionRule.findFirst.mockReset();
  prisma.autoConsumptionRule.create.mockReset();
  prisma.autoConsumptionRule.update.mockReset();
  prisma.autoConsumptionRule.delete.mockReset();

  prisma.service.findFirst.mockReset();
  prisma.auditLog.create.mockClear();

  // Sensible defaults.
  prisma.productCategory.findMany.mockResolvedValue([]);
  prisma.productCategory.findFirst.mockResolvedValue(null);
  prisma.product.findMany.mockResolvedValue([]);
  prisma.product.findFirst.mockResolvedValue(null);
  prisma.vendor.findMany.mockResolvedValue([]);
  prisma.vendor.findFirst.mockResolvedValue(null);
  prisma.inventoryReceipt.findMany.mockResolvedValue([]);
  prisma.inventoryReceipt.findFirst.mockResolvedValue(null);
  prisma.inventoryReceipt.count.mockResolvedValue(0);
  prisma.inventoryAdjustment.findMany.mockResolvedValue([]);
  prisma.autoConsumptionRule.findMany.mockResolvedValue([]);
  prisma.autoConsumptionRule.findFirst.mockResolvedValue(null);
  prisma.service.findFirst.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// ProductCategory CRUD
// ─────────────────────────────────────────────────────────────────────────

describe('GET /product-categories — list', () => {
  test('1. tenant-scoped findMany with _count include + parent/name ordering', async () => {
    prisma.productCategory.findMany.mockResolvedValue([
      { id: 1, name: 'Skincare', parentId: null, _count: { products: 5, children: 2 } },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/wellness/product-categories');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const callArg = prisma.productCategory.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ tenantId: 42 });
    expect(callArg.orderBy).toEqual([{ parentId: 'asc' }, { name: 'asc' }]);
    expect(callArg.include._count.select).toEqual({ products: true, children: true });
  });

  test('no req.user → 401 (verifyWellnessRole auth gate)', async () => {
    const res = await request(makeApp({ skipAuth: true })).get('/api/wellness/product-categories');
    expect(res.status).toBe(401);
    expect(prisma.productCategory.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /product-categories — create', () => {
  test('2. 400 NAME_REQUIRED when name is whitespace-only', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/product-categories')
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(prisma.productCategory.create).not.toHaveBeenCalled();
  });

  test('3. 201 with tenantId from JWT; defaults isActive=true; audit emitted', async () => {
    prisma.productCategory.create.mockResolvedValue({
      id: 99,
      name: 'Serums',
      parentId: null,
      isActive: true,
      imageUrl: null,
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/wellness/product-categories')
      .send({ name: '  Serums  ' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArg = prisma.productCategory.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(42);
    expect(createArg.data.name).toBe('Serums'); // trimmed
    expect(createArg.data.isActive).toBe(true); // default
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('PUT /product-categories/:id — update', () => {
  test('4. 400 PARENT_SELF_REFERENCE when parentId equals own id', async () => {
    prisma.productCategory.findFirst.mockResolvedValue({
      id: 10, name: 'Skincare', parentId: null, isActive: true, tenantId: 1,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/wellness/product-categories/10')
      .send({ parentId: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PARENT_SELF_REFERENCE');
    expect(prisma.productCategory.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /product-categories/:id', () => {
  test('5. 404 when category belongs to a different tenant', async () => {
    prisma.productCategory.findFirst.mockResolvedValue(null); // not found in caller tenant

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/wellness/product-categories/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.productCategory.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Vendor CRUD
// ─────────────────────────────────────────────────────────────────────────

describe('GET /vendors — list', () => {
  test('6. ?isActive=true narrows the where clause', async () => {
    prisma.vendor.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/wellness/vendors?isActive=true');

    expect(res.status).toBe(200);
    const callArg = prisma.vendor.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(1);
    expect(callArg.where.isActive).toBe(true);
  });
});

describe('POST /vendors — create', () => {
  test('7. 400 INVALID_GSTIN when gstin length is not exactly 15', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/vendors')
      .send({ name: 'Acme Pharma', gstin: 'TOO_SHORT' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GSTIN');
    expect(prisma.vendor.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /vendors/:id', () => {
  test('8a. has receipts → deactivate (200 + isActive=false), do NOT hard-delete', async () => {
    prisma.vendor.findFirst.mockResolvedValue({
      id: 5, name: 'Acme', isActive: true, tenantId: 1,
    });
    prisma.inventoryReceipt.count.mockResolvedValue(3);
    prisma.vendor.update.mockResolvedValue({
      id: 5, name: 'Acme', isActive: false, tenantId: 1,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/wellness/vendors/5');

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(prisma.vendor.delete).not.toHaveBeenCalled();
    expect(prisma.vendor.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { isActive: false },
    });
  });

  test('8b. zero receipts → hard delete (204 No Content)', async () => {
    prisma.vendor.findFirst.mockResolvedValue({
      id: 6, name: 'NewSupplier', isActive: true, tenantId: 1,
    });
    prisma.inventoryReceipt.count.mockResolvedValue(0);
    prisma.vendor.delete.mockResolvedValue({ id: 6 });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/wellness/vendors/6');

    expect(res.status).toBe(204);
    expect(prisma.vendor.delete).toHaveBeenCalledWith({ where: { id: 6 } });
    expect(prisma.vendor.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// InventoryReceipt — incoming stock with transactional side effect
// ─────────────────────────────────────────────────────────────────────────

describe('POST /inventory/receipts — create incoming stock', () => {
  test('9. 400 QUANTITY_INVALID when quantity is 0', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/inventory/receipts')
      .send({ productId: 1, quantity: 0, unitCost: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUANTITY_INVALID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('10. 201 with transactional currentStock increment on product.update', async () => {
    prisma.product.findFirst.mockResolvedValue({
      id: 50, name: 'Vitamin C Serum', currentStock: 20, tenantId: 1,
    });
    // The route calls $transaction(cb); our stub passes prisma as tx.
    // First call inside the tx is generateReceiptNumber → inventoryReceipt.findFirst (returns null → seq=1).
    prisma.inventoryReceipt.findFirst.mockResolvedValue(null);
    prisma.inventoryReceipt.create.mockResolvedValue({
      id: 1000,
      receiptNumber: 'RCP-2026-0001',
      productId: 50,
      quantity: 5,
      unitCost: 100,
      totalCost: 500,
      tenantId: 1,
    });
    prisma.product.update.mockResolvedValue({ id: 50, currentStock: 25 });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/wellness/inventory/receipts')
      .send({ productId: 50, quantity: 5, unitCost: 100 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1000);
    expect(res.body.receiptNumber).toBe('RCP-2026-0001');
    // SIDE EFFECT: product.update was called with an increment on currentStock.
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.product.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.currentStock).toEqual({ increment: 5 }); // Math.ceil(5) = 5
    // Receipt was created with totalCost = qty * unitCost.
    const createArg = prisma.inventoryReceipt.create.mock.calls[0][0];
    expect(createArg.data.totalCost).toBe(500);
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.receivedBy).toBe(7);
  });
});

describe('GET /inventory/receipts — list', () => {
  test('11. 400 INVERTED_DATE_RANGE when ?to < ?from (#665 validateDateRange)', async () => {
    const res = await request(makeApp())
      .get('/api/wellness/inventory/receipts?from=2026-12-31&to=2026-01-01');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_DATE_RANGE');
    expect(prisma.inventoryReceipt.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// InventoryAdjustment — signed delta with reason enum
// ─────────────────────────────────────────────────────────────────────────

describe('POST /inventory/adjustments — create signed adjustment', () => {
  test('12. 400 INVALID_REASON when reason is not in VALID_ADJUSTMENT_REASONS set', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/inventory/adjustments')
      .send({ productId: 1, quantityDelta: -2, reason: 'WHIM' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
    expect(prisma.inventoryAdjustment.create).not.toHaveBeenCalled();
  });

  test('13. 201 with signed delta written through to product.update — and NEGATIVE STOCK IS NOT REJECTED today (TODAY\'s contract; flag for follow-up)', async () => {
    // NOTE: this test pins what the route ACTUALLY does today. The route
    // accepts any signed delta — even one that would drive currentStock
    // below 0. There's no `if (newStock < 0) return 400` guard. The receipt
    // SIDE EFFECT comment at line 561 explicitly describes the delta as
    // shifting stock by the signed value with no floor check. Whether this
    // is the right behavior is a separate product call (a clinic might
    // legitimately need to record damage that exceeds known stock from a
    // stale recount, or might want hard rejection — depends on workflow).
    // Pin today's behavior here; if product calls "negative stock should
    // be rejected" file a bug-test-cron issue and we'll flip this to a
    // 400 expectation + skip until the route is fixed.
    prisma.product.findFirst.mockResolvedValue({
      id: 50, name: 'Vitamin C', currentStock: 2, tenantId: 1,
    });
    prisma.inventoryAdjustment.create.mockResolvedValue({
      id: 200, productId: 50, quantityDelta: -10, reason: 'DAMAGE', tenantId: 1,
    });
    prisma.product.update.mockResolvedValue({ id: 50, currentStock: -8 });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/wellness/inventory/adjustments')
      .send({ productId: 50, quantityDelta: -10, reason: 'DAMAGE' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(200);
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.product.update.mock.calls[0][0];
    // delta = -10 → Math.floor(-10) = -10 → increment: -10
    expect(updateArg.data.currentStock).toEqual({ increment: -10 });
    // No floor check today — the call goes through.
    expect(prisma.inventoryAdjustment.create).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AutoConsumptionRule — Prisma P2002 uniqueness violation surface
// ─────────────────────────────────────────────────────────────────────────

describe('POST /auto-consumption-rules — create rule', () => {
  test('14. 409 RULE_DUPLICATE when Prisma raises P2002 (unique constraint)', async () => {
    prisma.service.findFirst.mockResolvedValue({ id: 1, name: 'Facial', tenantId: 1 });
    prisma.product.findFirst.mockResolvedValue({ id: 5, name: 'Serum', tenantId: 1 });
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.autoConsumptionRule.create.mockRejectedValue(p2002);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/wellness/auto-consumption-rules')
      .send({ serviceId: 1, productId: 5, quantityPerVisit: 2 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RULE_DUPLICATE');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Movements ledger
// ─────────────────────────────────────────────────────────────────────────

describe('GET /inventory/movements — combined ledger', () => {
  test('15. 400 PRODUCT_REQUIRED when ?productId is absent', async () => {
    const res = await request(makeApp())
      .get('/api/wellness/inventory/movements');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_REQUIRED');
    expect(prisma.inventoryReceipt.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryAdjustment.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Product write — non-negative numeric guards (stock / threshold / price)
// ─────────────────────────────────────────────────────────────────────────
//
// A product's stock, reorder threshold, price and volume can never be
// negative; stock + threshold must additionally be whole numbers. The
// frontend guards too, but a direct API call must not be able to seed a
// negative stock level — these pin the server-side guard.
describe('POST /products — non-negative numeric guards', () => {
  test('rejects a negative currentStock with 400 INVALID_QUANTITY (no create)', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/products')
      .send({ name: 'Massage Oil', currentStock: -1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  test('rejects a fractional currentStock with 400 INVALID_QUANTITY', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/products')
      .send({ name: 'Massage Oil', currentStock: 2.5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
  });

  test('rejects a negative reorder threshold with 400 INVALID_QUANTITY', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/products')
      .send({ name: 'Massage Oil', threshold: -5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
  });

  test('rejects a negative price with 400 INVALID_NUMERIC', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/products')
      .send({ name: 'Massage Oil', price: -100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NUMERIC');
  });

  test('allows currentStock = 0 (valid) → 201', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/products')
      .send({ name: 'Massage Oil', currentStock: 0, price: 899 });
    expect(res.status).toBe(201);
    expect(prisma.product.create).toHaveBeenCalled();
  });
});

describe('PUT /products/:id — non-negative numeric guards', () => {
  test('rejects updating to a negative currentStock (no update)', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 9, tenantId: 1, name: 'Oil', currentStock: 5 });
    const res = await request(makeApp())
      .put('/api/wellness/products/9')
      .send({ currentStock: -3 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});
