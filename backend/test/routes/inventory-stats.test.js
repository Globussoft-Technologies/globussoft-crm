// @ts-check
/**
 * Wellness/CRM inventory polish — pin GET /api/wellness/inventory/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: no req.user → 401 (verifyWellnessRole short-circuits when
 *     the upstream global verifyToken has not populated req.user).
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation so a bad
 *     ?from doesn't get masked by a missing ?to).
 *   - Empty-tenant: zeroed envelope + lastReceiptAt=null.
 *   - Happy path: 5 products + 3 receipts + 2 adjustments → counts + sums
 *     correct.
 *   - lowStockCount: currentStock <= threshold AND threshold > 0 (mirrors
 *     lowStockEngine.js's filter — threshold=0 means "not tracked").
 *   - outOfStockCount: currentStock <= 0 regardless of threshold (operational
 *     low is operational low).
 *   - totalInventoryValue = sum(currentStock * price) across every product
 *     in the tenant catalog (Product schema has NO isActive column today).
 *   - ?from/?to narrows receipts + adjustments via createdAt clauses on the
 *     prisma query; tenant-wide product counts stay snapshot-shaped (not
 *     filtered by the date window).
 *   - lastReceiptAt: picks the maximum InventoryReceipt.createdAt; ISO string.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId.
 *   - NO audit row written (read-only meta surface).
 *   - activeProducts surfaces as a sibling field equal to totalProducts so the
 *     dashboard tile stays stable if an `isActive` column ever lands on
 *     Product (today the schema has no such column; every product is active).
 *
 * Schema notes (verified against prisma/schema.prisma → model Product /
 * InventoryReceipt / InventoryAdjustment, 2026-05-26)
 * ─────────────────────────────────────────────────────────────────────
 *   Product columns: id, name, sku?, description?, price (Float),
 *     isRecurring (Boolean), threshold (Int default 0),
 *     currentStock (Int default 0), createdAt, tenantId, categoryId?.
 *     NO `costPrice` / `mrp` / `vendor` / `isActive` columns — the prompt's
 *     hypothesised schema was wrong on those four. Inventory value rolls up
 *     `price` (the single Product.price column).
 *   InventoryReceipt: quantity (Float), unitCost (Float), totalCost (Float),
 *     receivedAt (DateTime — domain-meaningful timestamp), createdAt
 *     (DateTime — used by /stats for the date-window aggregate since the
 *     route description says "applies to receipts/adjustments createdAt").
 *   InventoryAdjustment: quantityDelta (Float), createdAt.
 *
 * Pattern reference
 * ─────────────────
 *   billing-stats.test.js for the supertest + JWT pattern;
 *   inventory.test.js for the verifyWellnessRole synthetic-req.user pattern
 *   (since this file's adminGate gates on req.user.vertical/role which is
 *   normally set by the upstream verifyToken in server.js).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── Prisma singleton patching (BEFORE requiring the router) ────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.product = prisma.product || {};
prisma.product.findMany = vi.fn();

prisma.inventoryReceipt = prisma.inventoryReceipt || {};
prisma.inventoryReceipt.findMany = vi.fn();

prisma.inventoryAdjustment = prisma.inventoryAdjustment || {};
prisma.inventoryAdjustment.count = vi.fn();

// audit write target — writeAudit hits auditLog.create. The /stats handler
// does NOT write audit (read-only meta surface) but the spy lets us assert
// the negative case.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// tenant.findUnique is called by verifyWellnessRole when req.user.vertical
// is missing; we inject vertical on req.user so it shouldn't fire, but stub
// defensively.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// eventBus stubs (writeAudit triggers a best-effort emit downstream).
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const inventoryRouter = requireCJS('../../routes/inventory');

/**
 * Build an express app with a synthetic auth middleware. Defaults to ADMIN
 * on a wellness tenant so adminGate admits the request. Override
 * { role, tenantId, vertical } to exercise denial paths. If skipAuth=true,
 * no auth middleware attaches and verifyWellnessRole's `!req.user → 401`
 * fires.
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
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/wellness', inventoryRouter);
  return app;
}

beforeEach(() => {
  prisma.product.findMany.mockReset();
  prisma.inventoryReceipt.findMany.mockReset();
  prisma.inventoryAdjustment.count.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });
});

describe('GET /api/wellness/inventory/stats', () => {
  test('auth gate: no req.user → 401', async () => {
    const app = makeApp({ skipAuth: true });
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(401);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryReceipt.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    // Validation fires BEFORE prisma fan-out.
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryReceipt.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryAdjustment.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats?to=garbage');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope + lastReceiptAt=null', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalProducts: 0,
      activeProducts: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      totalInventoryValue: 0,
      receiptsCount: 0,
      receiptsValue: 0,
      adjustmentsCount: 0,
      lastReceiptAt: null,
    });
  });

  test('happy path: 5 products + 3 receipts + 2 adjustments → counts + sums correct', async () => {
    // Catalog mix:
    //   P1: stock=20, threshold=5, price=100   → contributes 2000 to value
    //   P2: stock=2,  threshold=5, price=50    → low (2<=5, threshold>0); value 100
    //   P3: stock=0,  threshold=3, price=10    → low AND outOfStock; value 0
    //   P4: stock=8,  threshold=0, price=25    → NOT low (threshold=0); value 200
    //   P5: stock=-1, threshold=0, price=15    → outOfStock; NOT low (threshold=0); value -15
    // Inventory value = 2000 + 100 + 0 + 200 + (-15) = 2285
    // lowStockCount = 2 (P2 + P3)
    // outOfStockCount = 2 (P3 + P5; -1 satisfies <=0)
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 20, threshold: 5, price: 100 },
      { currentStock: 2, threshold: 5, price: 50 },
      { currentStock: 0, threshold: 3, price: 10 },
      { currentStock: 8, threshold: 0, price: 25 },
      { currentStock: -1, threshold: 0, price: 15 },
    ]);
    // 3 receipts, total cost 100+250+75 = 425
    prisma.inventoryReceipt.findMany.mockResolvedValue([
      { totalCost: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { totalCost: 250, createdAt: new Date('2026-05-15T10:00:00Z') },
      { totalCost: 75, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.inventoryAdjustment.count.mockResolvedValue(2);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalProducts).toBe(5);
    expect(res.body.activeProducts).toBe(5);
    expect(res.body.lowStockCount).toBe(2);
    expect(res.body.outOfStockCount).toBe(2);
    expect(res.body.totalInventoryValue).toBe(2285);
    expect(res.body.receiptsCount).toBe(3);
    expect(res.body.receiptsValue).toBe(425);
    expect(res.body.adjustmentsCount).toBe(2);
    expect(res.body.lastReceiptAt).toBe(new Date('2026-05-15T10:00:00Z').toISOString());
  });

  test('lowStockCount: requires threshold > 0 AND currentStock <= threshold (mirrors lowStockEngine)', async () => {
    // P1: stock=3, threshold=5 → low (3 <= 5, threshold > 0)
    // P2: stock=5, threshold=5 → low (5 <= 5 boundary, threshold > 0)
    // P3: stock=6, threshold=5 → NOT low
    // P4: stock=2, threshold=0 → NOT low (threshold=0 means not tracked)
    // P5: stock=0, threshold=0 → NOT low (threshold=0; outOfStock asserted separately)
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 3, threshold: 5, price: 0 },
      { currentStock: 5, threshold: 5, price: 0 },
      { currentStock: 6, threshold: 5, price: 0 },
      { currentStock: 2, threshold: 0, price: 0 },
      { currentStock: 0, threshold: 0, price: 0 },
    ]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(res.body.lowStockCount).toBe(2);
  });

  test('outOfStockCount: currentStock <= 0 regardless of threshold', async () => {
    // P1: stock=0, threshold=5 → outOfStock
    // P2: stock=-3, threshold=0 → outOfStock (negative satisfies <=0)
    // P3: stock=1, threshold=5 → NOT outOfStock (still has 1 unit)
    // P4: stock=0, threshold=0 → outOfStock
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 0, threshold: 5, price: 0 },
      { currentStock: -3, threshold: 0, price: 0 },
      { currentStock: 1, threshold: 5, price: 0 },
      { currentStock: 0, threshold: 0, price: 0 },
    ]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(res.body.outOfStockCount).toBe(3);
  });

  test('totalInventoryValue = sum(currentStock * price) across the catalog', async () => {
    // 10*5 + 4*12.5 + 0*99 + 2*7.25 = 50 + 50 + 0 + 14.5 = 114.5
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 10, threshold: 0, price: 5 },
      { currentStock: 4, threshold: 0, price: 12.5 },
      { currentStock: 0, threshold: 0, price: 99 },
      { currentStock: 2, threshold: 0, price: 7.25 },
    ]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalInventoryValue).toBe(114.5);
  });

  test('half-up rounding to 2dp on totalInventoryValue + receiptsValue', async () => {
    // 1 * 100.555 = 100.555 → rounds half-up to 100.56
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 1, threshold: 0, price: 100.555 },
    ]);
    // 50.005 + 25.001 = 75.006 → rounds to 75.01
    prisma.inventoryReceipt.findMany.mockResolvedValue([
      { totalCost: 50.005, createdAt: new Date('2026-05-01T10:00:00Z') },
      { totalCost: 25.001, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalInventoryValue).toBe(100.56);
    expect(res.body.receiptsValue).toBe(75.01);
  });

  test('?from/?to narrows receipts + adjustments via createdAt clauses (product counts stay snapshot)', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/wellness/inventory/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`);

    expect(res.status).toBe(200);
    // Product findMany.where MUST NOT carry createdAt — the snapshot is tenant-wide.
    const productWhere = prisma.product.findMany.mock.calls[0][0].where;
    expect(productWhere.createdAt).toBeUndefined();
    // Receipts findMany.where MUST carry createdAt.gte/lte.
    const receiptWhere = prisma.inventoryReceipt.findMany.mock.calls[0][0].where;
    expect(receiptWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(receiptWhere.createdAt.lte).toEqual(new Date(toIso));
    // Adjustments count.where MUST carry createdAt.gte/lte.
    const adjustmentWhere = prisma.inventoryAdjustment.count.mock.calls[0][0].where;
    expect(adjustmentWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(adjustmentWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('lastReceiptAt: picks the max createdAt across receipts', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.product.findMany.mockResolvedValue([]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([
      { totalCost: 1, createdAt: new Date('2026-05-01T10:00:00Z') },
      { totalCost: 1, createdAt: newest }, // max
      { totalCost: 1, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(res.body.lastReceiptAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp({ tenantId: 42 });
    const res = await request(app).get('/api/wellness/inventory/stats');

    expect(res.status).toBe(200);
    expect(prisma.product.findMany.mock.calls[0][0].where.tenantId).toBe(42);
    expect(prisma.inventoryReceipt.findMany.mock.calls[0][0].where.tenantId).toBe(42);
    expect(prisma.inventoryAdjustment.count.mock.calls[0][0].where.tenantId).toBe(42);
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.product.findMany.mockResolvedValue([
      { currentStock: 5, threshold: 2, price: 10 },
    ]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('defensive: null/undefined numeric fields default to 0 (no NaN poisoning)', async () => {
    prisma.product.findMany.mockResolvedValue([
      { currentStock: null, threshold: null, price: null },
      { currentStock: undefined, threshold: undefined, price: undefined },
      { currentStock: 10, threshold: 5, price: 2 },
    ]);
    prisma.inventoryReceipt.findMany.mockResolvedValue([
      { totalCost: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { totalCost: 50, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.inventoryAdjustment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app).get('/api/wellness/inventory/stats');

    expect(res.status).toBe(200);
    // Only the row with concrete values contributes.
    expect(res.body.totalInventoryValue).toBe(20); // 10 * 2
    expect(res.body.receiptsValue).toBe(50);
    expect(Number.isFinite(res.body.totalInventoryValue)).toBe(true);
    expect(Number.isFinite(res.body.receiptsValue)).toBe(true);
  });
});
