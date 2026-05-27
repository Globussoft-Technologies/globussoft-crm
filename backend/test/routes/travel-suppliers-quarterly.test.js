// @ts-check
/**
 * Arc 2 #903 slice 20 — GET /api/travel/suppliers/:id/payables/quarterly
 * per-supplier quarterly invoice rollup.
 *
 * Pins the contract for the per-supplier quarterly-rollup endpoint added
 * to backend/routes/travel_suppliers.js. Sibling to slice 18's
 * /:id/payables/monthly — sub-paths-before-:id ordering preserves both
 * registrations + the new /quarterly registration. Feeds the per-supplier
 * dashboard "next 4 quarters payable schedule" widget
 * (PRD §3.3.d + §3.5.b "commission ledger per FY" precursor — FY rollup
 * composes from quarterly which composes from monthly).
 *
 * Aggregation math lives in backend/lib/payableAging.js's
 * computeQuarterlyRollup (slice 20 extension that composes from
 * computeMonthlyRollup). This spec focuses on the route's contract
 * surface — parent-supplier guards, from/to query bounds, response
 * envelope shape, sub-path-vs-:id ordering — not the lib's per-status
 * math (lib-level cases already covered indirectly via the monthly tests
 * since quarterly composes from monthly).
 *
 * What's pinned
 * -------------
 *   - Happy path:         payables across 3 calendar quarters → quarters[]
 *                         sorted ASC by (year, q), per-status break
 *                         populated, grandTotal + totalCount echoed.
 *   - Quarter mapping:    Jan/Feb/Mar → Q1, Apr/May/Jun → Q2,
 *                         Jul/Aug/Sep → Q3, Oct/Nov/Dec → Q4.
 *   - from / to filter:   bounds the quarters[] window (inclusive YYYY-Qn
 *                         lexical compare); window grandTotal recomputed.
 *   - from invalid:       unparseable ?from → 400 INVALID_FROM
 *                         (supplier lookup NOT attempted).
 *   - to invalid:         unparseable ?to → 400 INVALID_TO.
 *   - Excluded rows:      null dueDate → excludedCount + NO_DUE_DATE.
 *   - INVALID_ID:         non-numeric :id → 400 INVALID_ID.
 *   - SUPPLIER_NOT_FOUND: supplier missing → 404 SUPPLIER_NOT_FOUND.
 *   - SUB_BRAND_DENIED:   sub-brand-restricted manager → 403
 *                         SUB_BRAND_DENIED (lib never called).
 *   - Route ordering:     /:id/payables/quarterly registers BEFORE
 *                         /:id/payables/:payableId so "quarterly" cannot
 *                         be captured as a payableId — pinned via
 *                         response shape (quarters[] present).
 *   - take cap:           findMany take=10_000.
 *
 * Test pattern mirrors travel-suppliers-monthly.test.js (slice 18) —
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

describe('GET /api/travel/suppliers/:id/payables/quarterly', () => {
  test('happy path: 3 quarters populated → quarters[] sorted ASC + byStatus break + grandTotal', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    // Spread payables across Q1 (Feb), Q2 (May), Q4 (Nov) of 2026.
    //   Q1: 1 pending 100.00, 1 paid 50.00 → total 150.00
    //   Q2: 1 scheduled 200.50 → total 200.50
    //   Q4: 1 cancelled 999.99 → total 999.99
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending',   dueDate: utc(2026, 2, 15), amount: '100.00' },
      { id: 2, status: 'paid',      dueDate: utc(2026, 2, 20), amount: '50.00' },
      { id: 3, status: 'scheduled', dueDate: utc(2026, 5, 1),  amount: '200.50' },
      { id: 4, status: 'cancelled', dueDate: utc(2026, 11, 10), amount: '999.99' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    expect(res.body.quarters).toHaveLength(3);

    // Quarters sorted ASC by (year, q).
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2026-Q1', '2026-Q2', '2026-Q4']);

    // Q1 has the pending+paid split.
    const q1 = res.body.quarters[0];
    expect(q1).toMatchObject({ year: 2026, q: 1 });
    expect(q1.totalCount).toBe(2);
    expect(q1.totalAmount).toBeCloseTo(150, 2);
    expect(q1.byStatus.pending).toMatchObject({ count: 1, totalAmount: 100 });
    expect(q1.byStatus.paid).toMatchObject({ count: 1, totalAmount: 50 });
    expect(q1.byStatus.scheduled).toMatchObject({ count: 0, totalAmount: 0 });
    expect(q1.byStatus.cancelled).toMatchObject({ count: 0, totalAmount: 0 });

    // Q2 has just scheduled.
    expect(res.body.quarters[1].byStatus.scheduled).toMatchObject({ count: 1, totalAmount: 200.5 });

    // Q4 has just cancelled.
    expect(res.body.quarters[2].byStatus.cancelled).toMatchObject({ count: 1, totalAmount: 999.99 });

    // Grand total across all quarters.
    expect(res.body.grandTotal).toBeCloseTo(150 + 200.5 + 999.99, 2);
    expect(res.body.totalCount).toBe(4);
    expect(res.body.excludedCount).toBe(0);
  });

  test('quarter boundary mapping: month boundaries land in correct quarter', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 43, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    // One payable per month — pin quarter classification.
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1,  status: 'pending', dueDate: utc(2026, 1,  15), amount: '10' }, // Q1
      { id: 2,  status: 'pending', dueDate: utc(2026, 3,  15), amount: '10' }, // Q1
      { id: 3,  status: 'pending', dueDate: utc(2026, 4,  15), amount: '10' }, // Q2
      { id: 4,  status: 'pending', dueDate: utc(2026, 6,  15), amount: '10' }, // Q2
      { id: 5,  status: 'pending', dueDate: utc(2026, 7,  15), amount: '10' }, // Q3
      { id: 6,  status: 'pending', dueDate: utc(2026, 9,  15), amount: '10' }, // Q3
      { id: 7,  status: 'pending', dueDate: utc(2026, 10, 15), amount: '10' }, // Q4
      { id: 8,  status: 'pending', dueDate: utc(2026, 12, 15), amount: '10' }, // Q4
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/43/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual([
      '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4',
    ]);
    // Each quarter has exactly 2 payables of ₹10 each = ₹20.
    for (const q of res.body.quarters) {
      expect(q.totalCount).toBe(2);
      expect(q.totalAmount).toBeCloseTo(20, 2);
    }
  });

  test('from/to filter bounds the quarters window inclusive + recomputes window grandTotal', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 50, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending', dueDate: utc(2026, 2,  15), amount: '100' }, // Q1
      { id: 2, status: 'pending', dueDate: utc(2026, 5,  15), amount: '200' }, // Q2
      { id: 3, status: 'pending', dueDate: utc(2026, 8,  15), amount: '300' }, // Q3
      { id: 4, status: 'pending', dueDate: utc(2026, 11, 15), amount: '400' }, // Q4
    ]);

    // Bound to Q2..Q3 2026 — should keep only those 2 quarters.
    const res = await request(makeApp())
      .get('/api/travel/suppliers/50/payables/quarterly?from=2026-04-01&to=2026-09-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-Q2');
    expect(res.body.to).toBe('2026-Q3');
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2026-Q2', '2026-Q3']);
    expect(res.body.grandTotal).toBeCloseTo(500, 2); // 200 + 300, not 1000
    expect(res.body.totalCount).toBe(2);
  });

  test('invalid ?from → 400 INVALID_FROM, supplier lookup NOT attempted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/quarterly?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FROM' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('invalid ?to → 400 INVALID_TO, supplier lookup NOT attempted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/quarterly?to=garbage-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TO' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('payables with null dueDate excluded with NO_DUE_DATE reason', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 60, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending', dueDate: utc(2026, 2, 1), amount: '100' },
      { id: 2, status: 'pending', dueDate: null,             amount: '99' },
      { id: 3, status: 'pending', dueDate: null,             amount: '50' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/60/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q1');
    expect(res.body.totalCount).toBe(1);
    expect(res.body.excludedCount).toBe(2);
    expect(res.body.excludedReasons).toMatchObject({ NO_DUE_DATE: 2 });
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('supplier missing → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/payables/quarterly')
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
      .get('/api/travel/suppliers/13/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /:id/payables/quarterly does NOT collide with /:id/payables/:payableId', async () => {
    // If /:payableId were registered first, "quarterly" would be captured
    // as a payableId. Response shape pin: quarters[] present (rollup
    // handler shape), not a single payable object.
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 14, name: 'X', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/14/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quarters');
    expect(Array.isArray(res.body.quarters)).toBe(true);
    expect(res.body).toHaveProperty('grandTotal');
    expect(res.body).toHaveProperty('totalCount');
  });

  test('findMany take cap: 10_000 row limit + scoped to tenant+supplier', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 15, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/15/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.take).toBe(10_000);
    expect(callArgs.where).toMatchObject({ tenantId: 1, supplierId: 15 });
  });

  test('empty payables → quarters=[] grandTotal=0 totalCount=0', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 16, name: 'Empty', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/16/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toEqual([]);
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.excludedCount).toBe(0);
    expect(res.body.excludedReasons).toEqual({});
    expect(res.body.from).toBeNull();
    expect(res.body.to).toBeNull();
  });

  test('multi-year: payables spanning 2025-Q4 and 2026-Q1 produce 2 distinct quarter buckets sorted ASC', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 17, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending', dueDate: utc(2025, 12, 15), amount: '100' }, // 2025-Q4
      { id: 2, status: 'pending', dueDate: utc(2026, 1,  10), amount: '200' }, // 2026-Q1
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/17/payables/quarterly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2025-Q4', '2026-Q1']);
    expect(res.body.quarters[0]).toMatchObject({ year: 2025, q: 4, totalAmount: 100, totalCount: 1 });
    expect(res.body.quarters[1]).toMatchObject({ year: 2026, q: 1, totalAmount: 200, totalCount: 1 });
    expect(res.body.grandTotal).toBeCloseTo(300, 2);
  });
});
