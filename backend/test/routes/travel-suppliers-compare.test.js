// @ts-check
/**
 * Arc 2 #903 slice 19 — GET /api/travel/suppliers/compare
 * multi-supplier side-by-side scorecard.
 *
 * Pins the contract for the supplier-comparison endpoint added to
 * backend/routes/travel_suppliers.js. Same metric shape as slice-16
 * scorecard (bookingVolume, onTimeDeliveryRate, cancelRate, paid /
 * cancelled / pending / scheduled / on-time / late counts,
 * totalAmountPaid) but computed for 2..10 suppliers in a single batched
 * query, with a cross-supplier summary block picking best/worst.
 *
 * What's pinned
 * -------------
 *   - Happy path:           two suppliers → suppliers[] in requested order
 *                           with metrics populated + summary picks correct.
 *   - Window default:       no from/to → trailing 365-day window applied.
 *   - Window explicit:      ?from/to → those bounds passed to prisma.
 *   - Window inverted:      from > to → 400 INVALID_DATE_RANGE.
 *   - Window invalid:       unparseable date → 400 INVALID_DATE.
 *   - Missing ids param:    no ?ids → 400 INVALID_IDS.
 *   - Too few ids:          1 id → 400 TOO_FEW_IDS.
 *   - Too many ids:         11 ids → 400 TOO_MANY_IDS.
 *   - Non-numeric id:       ?ids=1,abc → 400 INVALID_ID.
 *   - Dedup ids:            ?ids=1,1,2 collapses to [1,2] (still valid).
 *   - 404:                  any id not found → 404 NOT_FOUND + missingIds[].
 *   - 403:                  any sub-brand denied → 403 SUB_BRAND_DENIED +
 *                           deniedIds[].
 *   - Empty payables:       all metrics 0 + rates null + summary picks null.
 *   - Route ordering:       /suppliers/compare registers BEFORE /suppliers/:id
 *                           (sub-paths-before-:id standing rule).
 *
 * Test pattern mirrors travel-suppliers-scorecard.test.js (slice 16) — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findMany = vi.fn();
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplier.count = vi.fn();
prisma.travelSupplier.create = vi.fn();
prisma.travelSupplier.update = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findMany = vi.fn();
prisma.travelSupplierPayable.groupBy = vi.fn();
prisma.travelSupplierPayable.count = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function dateDaysFromNow(n) {
  return new Date(Date.now() + n * 86_400_000);
}

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/suppliers/compare', () => {
  test('happy path: two suppliers → metrics + summary picks correct', async () => {
    // Supplier A (id=10) is an on-time star; Supplier B (id=20) is a laggard.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 10, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 20, name: 'Marriott Mumbai', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      // Supplier 10: 2 on-time paid, 1 cancelled → onTime = 1.0000, cancel = 1/3 = 0.3333
      { supplierId: 10, status: 'paid', dueDate: dateDaysFromNow(-1), paidAt: dateDaysFromNow(-2), amount: '1000' },
      { supplierId: 10, status: 'paid', dueDate: dateDaysFromNow(-5), paidAt: dateDaysFromNow(-7), amount: '2000' },
      { supplierId: 10, status: 'cancelled', dueDate: null, paidAt: null, amount: '0' },
      // Supplier 20: 1 on-time + 2 late, 1 cancelled, 1 pending → onTime = 1/3 = 0.3333
      // bookingVolume = 4, cancel = 1/4 = 0.25
      { supplierId: 20, status: 'paid', dueDate: dateDaysFromNow(-1), paidAt: dateDaysFromNow(-2), amount: '500' },
      { supplierId: 20, status: 'paid', dueDate: dateDaysFromNow(-10), paidAt: dateDaysFromNow(-5), amount: '600' },
      { supplierId: 20, status: 'paid', dueDate: dateDaysFromNow(-15), paidAt: dateDaysFromNow(-2), amount: '700' },
      { supplierId: 20, status: 'cancelled', dueDate: null, paidAt: null, amount: '0' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10,20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(2);
    // Returned in requested order
    expect(res.body.suppliers[0].id).toBe(10);
    expect(res.body.suppliers[1].id).toBe(20);
    expect(res.body.suppliers[0].metrics).toMatchObject({
      bookingVolume: 3,
      paidCount: 2,
      cancelledCount: 1,
      onTimeCount: 2,
      lateCount: 0,
      onTimeDeliveryRate: 1,
      cancelRate: 0.3333,
      totalAmountPaid: 3000,
    });
    expect(res.body.suppliers[1].metrics).toMatchObject({
      bookingVolume: 4,
      paidCount: 3,
      cancelledCount: 1,
      onTimeCount: 1,
      lateCount: 2,
      onTimeDeliveryRate: 0.3333,
      cancelRate: 0.25,
      totalAmountPaid: 1800,
    });
    // Summary picks
    expect(res.body.summary).toMatchObject({
      bestOnTimeSupplierId: 10,
      worstOnTimeSupplierId: 20,
      // Supplier 20 has lower cancel rate (0.25 vs 0.3333)
      lowestCancelSupplierId: 20,
      // Supplier 20 has higher booking volume (4 vs 3)
      highestVolumeSupplierId: 20,
    });
    // window block echoed
    expect(res.body.window).toHaveProperty('from');
    expect(res.body.window).toHaveProperty('to');
  });

  test('missing ids param → 400 INVALID_IDS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDS' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('one id → 400 TOO_FEW_IDS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_FEW_IDS' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('eleven ids → 400 TOO_MANY_IDS', async () => {
    const ids = '1,2,3,4,5,6,7,8,9,10,11';
    const res = await request(makeApp())
      .get(`/api/travel/suppliers/compare?ids=${ids}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_IDS' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10,abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('dedup duplicate ids: ?ids=1,1,2 → 2 unique ids accepted', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 2, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,1,2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(2);
    expect(res.body.suppliers.map((s) => s.id)).toEqual([1, 2]);
  });

  test('dedup leaves only 1 distinct id → 400 TOO_FEW_IDS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=5,5,5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_FEW_IDS' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('missing supplier → 404 NOT_FOUND with missingIds[]', async () => {
    // Asked for 10, 20, 30 but only 10 + 20 exist.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 10, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 20, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10,20,30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', missingIds: [30] });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denied for one supplier → 403 SUB_BRAND_DENIED with deniedIds[]', async () => {
    // MANAGER scoped to ['rfu']; supplier 20 is 'tmc' → denied.
    prisma.user.findUnique.mockReset().mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 10, name: 'A', supplierCategory: 'hotel', subBrand: 'rfu' },
      { id: 20, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10,20')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'SUB_BRAND_DENIED',
      deniedIds: [20],
    });
    // Payable findMany must NOT have been called (denied before the heavy query).
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('empty payables → all metrics 0 + rates null + summary picks null', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 10, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 20, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=10,20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers[0].metrics).toEqual({
      bookingVolume: 0,
      paidCount: 0,
      cancelledCount: 0,
      pendingCount: 0,
      scheduledCount: 0,
      onTimeCount: 0,
      lateCount: 0,
      onTimeDeliveryRate: null,
      cancelRate: null,
      totalAmountPaid: 0,
    });
    expect(res.body.summary).toEqual({
      bestOnTimeSupplierId: null,
      worstOnTimeSupplierId: null,
      lowestCancelSupplierId: null,
      highestVolumeSupplierId: null,
    });
  });

  test('default window: no from/to → trailing 365 days', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 2, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const before = Date.now();
    await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const after = Date.now();

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      tenantId: 1,
      supplierId: { in: [1, 2] },
    });
    expect(callArgs.where.createdAt).toHaveProperty('gte');
    expect(callArgs.where.createdAt).toHaveProperty('lte');
    const gte = callArgs.where.createdAt.gte.getTime();
    const lte = callArgs.where.createdAt.lte.getTime();
    expect(lte).toBeGreaterThanOrEqual(before);
    expect(lte).toBeLessThanOrEqual(after);
    const oneYearMs = 365 * 86_400_000;
    expect(lte - gte).toBeCloseTo(oneYearMs, -3);
  });

  test('explicit window bounds passed to prisma createdAt range', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 2, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,2&from=2026-01-01&to=2026-03-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(callArgs.where.createdAt.lte.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  test('inverted window bounds → 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,2&from=2026-06-01&to=2026-01-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE_RANGE' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('unparseable date → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,2&from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
  });

  test('route ordering: /suppliers/compare does NOT hit the :id handler', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc' },
      { id: 2, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc' },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/compare?ids=1,2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Compare returns a `suppliers` array + `summary` object — the bare :id
    // handler returns a single raw supplier row. The presence of both
    // confirms ordering precedence.
    expect(res.body).toHaveProperty('suppliers');
    expect(res.body).toHaveProperty('summary');
  });
});
