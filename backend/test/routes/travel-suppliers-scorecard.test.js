// @ts-check
/**
 * Arc 2 #903 slice 16 — GET /api/travel/suppliers/:id/scorecard
 * per-supplier performance scorecard.
 *
 * Pins the contract for the supplier-quality dashboard endpoint added to
 * backend/routes/travel_suppliers.js. Three operational signals computed
 * entirely from existing TravelSupplierPayable rows (no schema edits):
 *
 *   - bookingVolume:      total payable count in window
 *   - onTimeDeliveryRate: paid where paidAt <= dueDate / (onTime + late)
 *   - cancelRate:         cancelled / total
 *
 * What's pinned
 * -------------
 *   - Happy path:         mixed payables → metrics populated, rates rounded.
 *   - On-time exclusion:  paid rows without BOTH dueDate AND paidAt drop out
 *                         of onTime+late denominator (but still count in
 *                         paidCount + totalAmountPaid).
 *   - Empty:              zero payables → all counts 0, rates null.
 *   - Window default:     no from/to → trailing 365-day window applied.
 *   - Window explicit:    ?from/to → those bounds passed to prisma createdAt
 *                         range.
 *   - Window inverted:    from > to → 400 INVALID_DATE_RANGE.
 *   - Window invalid:     unparseable date → 400 INVALID_DATE.
 *   - 404:                supplier not found → 404 NOT_FOUND.
 *   - 403:                sub-brand denied → 403 SUB_BRAND_DENIED.
 *   - Route ordering:     /suppliers/:id/scorecard registers BEFORE
 *                         /suppliers/:id (sub-paths-before-:id standing rule).
 *   - INVALID_ID:         non-numeric :id → 400 INVALID_ID.
 *   - Rounding:           rates rounded to 4dp; totalAmountPaid to 2dp.
 *
 * Test pattern mirrors travel-suppliers-exposure.test.js (slice 11) — patch
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
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/suppliers/:id/scorecard', () => {
  test('happy path: mixed payables → bookingVolume + rates + counts populated', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    // Layout: 5 paid (3 on-time, 1 late, 1 missing dueDate),
    //         2 cancelled, 1 pending, 1 scheduled → bookingVolume = 9.
    //
    // Note: every on-time row uses paidAt STRICTLY EARLIER than dueDate by at
    // least 1 day. The earlier shape `paidAt: dateDaysFromNow(-5), dueDate:
    // dateDaysFromNow(-5)` was flaky on slow CI runners because each call to
    // dateDaysFromNow() reads Date.now() at a different microsecond — under
    // load the gap can extend into milliseconds, flipping paidAt > dueDate and
    // mis-classifying the row as LATE. Always make the timeliness intent
    // unambiguous by spacing paidAt and dueDate by ≥1 day.
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      // 3 on-time paid (paidAt strictly < dueDate; ≥1d apart for clock safety)
      { status: 'paid', dueDate: dateDaysFromNow(-10), paidAt: dateDaysFromNow(-15), amount: '1000.00' },
      { status: 'paid', dueDate: dateDaysFromNow(-4),  paidAt: dateDaysFromNow(-5),  amount: '2000.50' },
      { status: 'paid', dueDate: dateDaysFromNow(-20), paidAt: dateDaysFromNow(-25), amount: '3000.25' },
      // 1 late paid
      { status: 'paid', dueDate: dateDaysFromNow(-30), paidAt: dateDaysFromNow(-20), amount: '4000.00' },
      // 1 paid but missing dueDate (excluded from on-time denominator)
      { status: 'paid', dueDate: null, paidAt: dateDaysFromNow(-1), amount: '500.00' },
      // 2 cancelled
      { status: 'cancelled', dueDate: dateDaysFromNow(-2), paidAt: null, amount: '750.00' },
      { status: 'cancelled', dueDate: null, paidAt: null, amount: '250.00' },
      // 1 pending
      { status: 'pending', dueDate: dateDaysFromNow(10), paidAt: null, amount: '5000.00' },
      // 1 scheduled
      { status: 'scheduled', dueDate: dateDaysFromNow(5), paidAt: null, amount: '6000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      id: 42, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    expect(res.body.metrics).toMatchObject({
      bookingVolume: 9,
      paidCount: 5,
      cancelledCount: 2,
      pendingCount: 1,
      scheduledCount: 1,
      onTimeCount: 3,
      lateCount: 1,
      // 3 on-time / (3 + 1) = 0.75
      onTimeDeliveryRate: 0.75,
      // 2 cancelled / 9 total = 0.2222
      cancelRate: 0.2222,
      // 1000 + 2000.50 + 3000.25 + 4000 + 500 = 10500.75
      totalAmountPaid: 10500.75,
    });
    // window block echoed
    expect(res.body.window).toHaveProperty('from');
    expect(res.body.window).toHaveProperty('to');
  });

  test('empty payables: all counts 0, rates null', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 7, name: 'Empty Vendor', supplierCategory: 'other', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/7/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.metrics).toEqual({
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
  });

  test('on-time exclusion: paid rows missing dueDate OR paidAt drop from rate denom', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 8, name: 'Mixed Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      // 1 on-time (full data)
      { status: 'paid', dueDate: dateDaysFromNow(-1), paidAt: dateDaysFromNow(-2), amount: '100' },
      // 1 paid with no dueDate (excluded from denom)
      { status: 'paid', dueDate: null, paidAt: dateDaysFromNow(-1), amount: '200' },
      // 1 paid with no paidAt — defensive: shouldn't exist in real data, but guarded
      { status: 'paid', dueDate: dateDaysFromNow(-1), paidAt: null, amount: '300' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/8/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.metrics).toMatchObject({
      bookingVolume: 3,
      paidCount: 3,
      onTimeCount: 1,
      lateCount: 0,
      // Only the row with BOTH dueDate AND paidAt counts → 1 / 1 = 1.0000
      onTimeDeliveryRate: 1,
      // 0 cancelled / 3 total
      cancelRate: 0,
      // Sum of all paid (regardless of timing exclusion)
      totalAmountPaid: 600,
    });
  });

  test('default window: no from/to → trailing 365 days', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 9, name: 'V', supplierCategory: 'other', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const before = Date.now();
    await request(makeApp())
      .get('/api/travel/suppliers/9/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const after = Date.now();

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      tenantId: 1,
      supplierId: 9,
    });
    expect(callArgs.where.createdAt).toHaveProperty('gte');
    expect(callArgs.where.createdAt).toHaveProperty('lte');
    const gte = callArgs.where.createdAt.gte.getTime();
    const lte = callArgs.where.createdAt.lte.getTime();
    // lte ~= now (within the request window)
    expect(lte).toBeGreaterThanOrEqual(before);
    expect(lte).toBeLessThanOrEqual(after);
    // gte ~= now - 365 days
    const oneYearMs = 365 * 86_400_000;
    expect(lte - gte).toBeCloseTo(oneYearMs, -3);
  });

  test('explicit window bounds passed to prisma createdAt range', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 10, name: 'V', supplierCategory: 'other', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/10/scorecard?from=2026-01-01&to=2026-03-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(callArgs.where.createdAt.lte.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  test('inverted window bounds → 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/11/scorecard?from=2026-06-01&to=2026-01-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE_RANGE' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('unparseable date → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/12/scorecard?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
  });

  test('supplier missing → 404 NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/999/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    // "abc" is non-numeric — but note: this only hits the scorecard handler
    // if Express has routed past slice 13/14/15 paths. Use a path that ONLY
    // matches scorecard's shape.
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    // MANAGER scoped to ['rfu'] querying a 'tmc' supplier.
    prisma.user.findUnique.mockReset().mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 13, name: 'TMC supplier', supplierCategory: 'hotel', subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/13/scorecard')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    // findMany must NOT have been called (denied before query).
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /suppliers/:id/scorecard does NOT hit the :id handler', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 14, name: 'X', supplierCategory: 'other', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/14/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Scorecard returns a `metrics` object — the bare :id handler returns
    // the raw supplier row. The presence of `metrics` confirms ordering.
    expect(res.body).toHaveProperty('metrics');
    expect(res.body).toHaveProperty('window');
  });

  test('round4 + round2: rates and amounts rounded properly', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 15, name: 'Rounder', supplierCategory: 'other', subBrand: 'tmc',
    });
    // 1 on-time + 2 late → rate = 1/3 = 0.3333...→ 0.3333
    // 1 cancelled / 7 total = 0.142857 → 0.1429
    // totalAmountPaid: 123.456 + 234.567 + 345.678 = 703.701 → 703.70
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { status: 'paid', dueDate: dateDaysFromNow(-1), paidAt: dateDaysFromNow(-2), amount: '123.456' },
      { status: 'paid', dueDate: dateDaysFromNow(-5), paidAt: dateDaysFromNow(-1), amount: '234.567' },
      { status: 'paid', dueDate: dateDaysFromNow(-5), paidAt: dateDaysFromNow(-1), amount: '345.678' },
      { status: 'cancelled', dueDate: null, paidAt: null, amount: '0' },
      { status: 'pending', dueDate: null, paidAt: null, amount: '0' },
      { status: 'pending', dueDate: null, paidAt: null, amount: '0' },
      { status: 'pending', dueDate: null, paidAt: null, amount: '0' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/15/scorecard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.metrics.onTimeDeliveryRate).toBe(0.3333);
    expect(res.body.metrics.cancelRate).toBe(0.1429);
    expect(res.body.metrics.totalAmountPaid).toBe(703.7);
  });
});
