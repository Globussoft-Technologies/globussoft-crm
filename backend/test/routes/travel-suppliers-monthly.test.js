// @ts-check
/**
 * Arc 2 #903 slice 18 — GET /api/travel/suppliers/:id/payables/monthly
 * per-supplier monthly invoice rollup.
 *
 * Pins the contract for the per-supplier monthly-rollup endpoint added to
 * backend/routes/travel_suppliers.js. Sibling to slice 17's /:id/payables/aging
 * (sub-paths-before-:id ordering preserves both registrations) — feeds the
 * per-supplier dashboard "next 6 months payable schedule" widget
 * (PRD §3.3.d + §3.5.b "commission ledger per FY" precursor — FY rollup
 * composes from monthly).
 *
 * Aggregation math lives in backend/lib/payableAging.js's
 * computeMonthlyRollup (slice 18 extension). This spec focuses on the
 * route's contract surface — parent-supplier guards, from/to query
 * bounds, response envelope shape, sub-path-vs-:id ordering — not the
 * lib's per-status math.
 *
 * What's pinned
 * -------------
 *   - Happy path:         payables across 3 months → months[] sorted ASC,
 *                         per-status breakdown populated, grandTotal +
 *                         totalCount echoed.
 *   - Status split:       pending + scheduled + paid + cancelled all
 *                         show under byStatus per month.
 *   - from / to filter:   bounds the months[] window (inclusive YYYY-MM
 *                         compare); window grandTotal recomputed.
 *   - from invalid:       unparseable ?from → 400 INVALID_FROM
 *                         (supplier lookup NOT attempted).
 *   - to invalid:         unparseable ?to → 400 INVALID_TO.
 *   - Excluded rows:      null dueDate → excludedCount + NO_DUE_DATE.
 *   - INVALID_ID:         non-numeric :id → 400 INVALID_ID.
 *   - SUPPLIER_NOT_FOUND: supplier missing → 404 SUPPLIER_NOT_FOUND.
 *   - SUB_BRAND_DENIED:   sub-brand-restricted manager → 403
 *                         SUB_BRAND_DENIED (lib never called).
 *   - Route ordering:     /:id/payables/monthly registers BEFORE
 *                         /:id/payables/:payableId so "monthly" cannot be
 *                         captured as a payableId — pinned via response
 *                         shape (months[] present, not a single payable
 *                         object).
 *   - take cap:           findMany take=10_000.
 *
 * Test pattern mirrors travel-suppliers-aging.test.js (slice 17) —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with HS256 JWTs signed against the
 * dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findMany = vi.fn();
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

// Build a Date set to YYYY-MM-DD in UTC.
function utc(yyyy, mm, dd) {
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/suppliers/:id/payables/monthly', () => {
  test('happy path: 3 months populated → months[] sorted ASC + byStatus break + grandTotal', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    // 3 months — Feb / Mar / Apr 2026.
    //   Feb: 1 pending 100.00, 1 paid 50.00 → total 150.00
    //   Mar: 1 scheduled 200.50 → total 200.50
    //   Apr: 1 cancelled 999.99 → total 999.99
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending',   dueDate: utc(2026, 2, 15), amount: '100.00' },
      { id: 2, status: 'paid',      dueDate: utc(2026, 2, 20), amount: '50.00' },
      { id: 3, status: 'scheduled', dueDate: utc(2026, 3, 1),  amount: '200.50' },
      { id: 4, status: 'cancelled', dueDate: utc(2026, 4, 10), amount: '999.99' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    expect(res.body.months).toHaveLength(3);

    // Months sorted ASC.
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-02', '2026-03', '2026-04']);

    // Feb has the pending+paid split.
    const feb = res.body.months[0];
    expect(feb.totalCount).toBe(2);
    expect(feb.totalAmount).toBeCloseTo(150, 2);
    expect(feb.byStatus.pending).toMatchObject({ count: 1, totalAmount: 100 });
    expect(feb.byStatus.paid).toMatchObject({ count: 1, totalAmount: 50 });
    expect(feb.byStatus.scheduled).toMatchObject({ count: 0, totalAmount: 0 });
    expect(feb.byStatus.cancelled).toMatchObject({ count: 0, totalAmount: 0 });

    // Mar has just scheduled.
    expect(res.body.months[1].byStatus.scheduled).toMatchObject({ count: 1, totalAmount: 200.5 });

    // Apr has just cancelled.
    expect(res.body.months[2].byStatus.cancelled).toMatchObject({ count: 1, totalAmount: 999.99 });

    // Grand total = sum across all months.
    expect(res.body.grandTotal).toBeCloseTo(150 + 200.5 + 999.99, 2);
    expect(res.body.totalCount).toBe(4);
    expect(res.body.excludedCount).toBe(0);
  });

  test('from/to filter bounds the months window inclusive + recomputes window grandTotal', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 50,
      name: 'V',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending', dueDate: utc(2026, 1, 15), amount: '100' },
      { id: 2, status: 'pending', dueDate: utc(2026, 2, 15), amount: '200' },
      { id: 3, status: 'pending', dueDate: utc(2026, 3, 15), amount: '300' },
      { id: 4, status: 'pending', dueDate: utc(2026, 4, 15), amount: '400' },
    ]);

    // Bound to Feb..Mar 2026 — should keep only those 2 months.
    const res = await request(makeApp())
      .get('/api/travel/suppliers/50/payables/monthly?from=2026-02-01&to=2026-03-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-02');
    expect(res.body.to).toBe('2026-03');
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-02', '2026-03']);
    expect(res.body.grandTotal).toBeCloseTo(500, 2); // 200 + 300, not 1000
    expect(res.body.totalCount).toBe(2);
  });

  test('invalid ?from → 400 INVALID_FROM, supplier lookup NOT attempted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/monthly?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FROM' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('invalid ?to → 400 INVALID_TO, supplier lookup NOT attempted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/monthly?to=garbage-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TO' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('payables with null dueDate excluded with NO_DUE_DATE reason', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 60,
      name: 'V',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending', dueDate: utc(2026, 2, 1), amount: '100' },
      { id: 2, status: 'pending', dueDate: null,            amount: '99' },
      { id: 3, status: 'pending', dueDate: null,            amount: '50' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/60/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-02');
    expect(res.body.totalCount).toBe(1); // 2 rows excluded
    expect(res.body.excludedCount).toBe(2);
    expect(res.body.excludedReasons).toMatchObject({ NO_DUE_DATE: 2 });
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('supplier missing → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED (findMany never called)', async () => {
    prisma.user.findUnique.mockReset().mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 13,
      name: 'TMC supplier',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/13/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /:id/payables/monthly does NOT collide with /:id/payables/:payableId', async () => {
    // If /:payableId were registered first, "monthly" would be captured
    // as a payableId. Response shape pin: months[] present (rollup
    // handler shape), not a single payable object.
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 14,
      name: 'X',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/14/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('months');
    expect(Array.isArray(res.body.months)).toBe(true);
    expect(res.body).toHaveProperty('grandTotal');
    expect(res.body).toHaveProperty('totalCount');
  });

  test('findMany take cap: 10_000 row limit + scoped to tenant+supplier', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 15,
      name: 'V',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/15/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.take).toBe(10_000);
    expect(callArgs.where).toMatchObject({ tenantId: 1, supplierId: 15 });
  });

  test('empty payables → months=[] grandTotal=0 totalCount=0', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 16,
      name: 'Empty',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/16/payables/monthly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.excludedCount).toBe(0);
    expect(res.body.excludedReasons).toEqual({});
    expect(res.body.from).toBeNull();
    expect(res.body.to).toBeNull();
  });
});
