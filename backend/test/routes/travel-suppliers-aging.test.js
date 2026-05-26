// @ts-check
/**
 * Arc 2 #903 slice 17 — GET /api/travel/suppliers/:id/payables/aging
 * per-supplier aged-payable bucket report.
 *
 * Pins the contract for the per-supplier aging endpoint added to
 * backend/routes/travel_suppliers.js. Mirrors the cross-supplier
 * /payables/aging (slice 8) but scoped to ONE supplier — feeds the
 * per-supplier dashboard "month-end close" widget (PRD §3.3.d + §3.7.a
 * "credit utilization gauge").
 *
 * Both routes consume backend/lib/payableAging.js — the lib enforces
 * bucket boundaries (current / 1-30 / 31-60 / 61-90 / 90+) + exclusion
 * rules (paid + cancelled + missing/invalid dueDate → excludedCount).
 * This spec focuses on the route's contract surface, not the lib math.
 *
 * What's pinned
 * -------------
 *   - Happy path:         mixed payables → bucketTotals populated, supplier
 *                         block echoed, asOf in response.
 *   - asOf default:       no ?asOf → defaults to "now" (echoed ISO is
 *                         within request window).
 *   - asOf explicit:      ?asOf=ISODate → echoed in response.
 *   - asOf invalid:       unparseable ?asOf → 400 INVALID_ASOF
 *                         (not INVALID_DATE — mirrors slice 8).
 *   - Excluded rows:      paid + cancelled + null-dueDate counted into
 *                         excludedCount with proper excludedReasons keys.
 *   - INVALID_ID:         non-numeric :id → 400 INVALID_ID.
 *   - SUPPLIER_NOT_FOUND: supplier missing → 404 SUPPLIER_NOT_FOUND.
 *   - SUB_BRAND_DENIED:   sub-brand-restricted manager → 403
 *                         SUB_BRAND_DENIED (lib never called).
 *   - Route ordering:     /:id/payables/aging registers BEFORE
 *                         /:id/payables/:payableId (sub-paths-before-:id
 *                         standing rule) so "aging" cannot be captured as
 *                         a payableId.
 *   - take cap:           findMany take=10_000 (sanity cap).
 *
 * Test pattern mirrors travel-suppliers-scorecard.test.js (slice 16) —
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

describe('GET /api/travel/suppliers/:id/payables/aging', () => {
  test('happy path: mixed payables → bucketTotals populated + supplier echoed', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    // Layout: 1 current (future due), 1 in 1-30, 1 in 31-60, 1 in 61-90,
    //         1 in 90+, 1 paid (excluded), 1 cancelled (excluded), 1 no
    //         dueDate (excluded).
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, status: 'pending',   dueDate: dateDaysFromNow(10),  paidAt: null, amount: '100.00' },
      { id: 2, status: 'pending',   dueDate: dateDaysFromNow(-15), paidAt: null, amount: '200.50' },
      { id: 3, status: 'scheduled', dueDate: dateDaysFromNow(-45), paidAt: null, amount: '300.25' },
      { id: 4, status: 'pending',   dueDate: dateDaysFromNow(-75), paidAt: null, amount: '400.00' },
      { id: 5, status: 'pending',   dueDate: dateDaysFromNow(-120),paidAt: null, amount: '500.00' },
      { id: 6, status: 'paid',      dueDate: dateDaysFromNow(-30), paidAt: dateDaysFromNow(-25), amount: '999.99' },
      { id: 7, status: 'cancelled', dueDate: dateDaysFromNow(-10), paidAt: null, amount: '111.11' },
      { id: 8, status: 'pending',   dueDate: null,                 paidAt: null, amount: '0.01' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    expect(res.body).toHaveProperty('asOf');
    expect(typeof res.body.asOf).toBe('string');

    // 5 active payables across 5 buckets — 1 per bucket.
    expect(res.body.bucketTotals).toMatchObject({
      'current': { count: 1, totalAmount: 100 },
      '1-30':    { count: 1, totalAmount: 200.5 },
      '31-60':   { count: 1, totalAmount: 300.25 },
      '61-90':   { count: 1, totalAmount: 400 },
      '90+':     { count: 1, totalAmount: 500 },
    });
    // Grand total = sum of active = 1500.75
    expect(res.body.grandTotal).toBeCloseTo(1500.75, 2);

    // Excluded: 1 paid, 1 cancelled, 1 missing dueDate
    expect(res.body.excludedCount).toBe(3);
    expect(res.body.excludedReasons).toMatchObject({
      EXCLUDED_PAID: 1,
      EXCLUDED_CANCELLED: 1,
      NO_DUE_DATE: 1,
    });
  });

  test('asOf default: no ?asOf → defaults to now (ISO string returned within request window)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 7,
      name: 'V',
      supplierCategory: 'other',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const before = Date.now();
    const res = await request(makeApp())
      .get('/api/travel/suppliers/7/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const after = Date.now();

    expect(res.status).toBe(200);
    const asOfMs = new Date(res.body.asOf).getTime();
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  test('asOf explicit: ?asOf=ISODate → echoed in response', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 10,
      name: 'V',
      supplierCategory: 'other',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/10/payables/aging?asOf=2026-03-15T00:00:00.000Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe('2026-03-15T00:00:00.000Z');
  });

  test('asOf invalid: unparseable date → 400 INVALID_ASOF', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/11/payables/aging?asOf=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ASOF' });
    // Supplier lookup must NOT have been made (validation fails first).
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('supplier missing → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    // findMany must NOT have been called.
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED (lib never called)', async () => {
    // MANAGER scoped to ['rfu'] querying a 'tmc' supplier.
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
      .get('/api/travel/suppliers/13/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /:id/payables/aging does NOT collide with /:id/payables/:payableId', async () => {
    // The crucial registration-order test — if /:payableId came first,
    // "aging" would be captured as a payableId. Slice 17 is registered
    // BEFORE PUT/DELETE on /:payableId so the GET response must carry
    // bucketTotals (not anything from the PUT/DELETE handler shape).
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 14,
      name: 'X',
      supplierCategory: 'other',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/14/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // The presence of `bucketTotals` confirms we hit the aging handler,
    // not a payableId handler.
    expect(res.body).toHaveProperty('bucketTotals');
    expect(res.body.bucketTotals).toHaveProperty('current');
    expect(res.body.bucketTotals).toHaveProperty('90+');
  });

  test('findMany take cap: pagination guard at 10_000 rows', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 15,
      name: 'V',
      supplierCategory: 'other',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/15/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.take).toBe(10_000);
    expect(callArgs.where).toMatchObject({ tenantId: 1, supplierId: 15 });
  });

  test('empty payables → all buckets zero, grandTotal 0, excludedCount 0', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 16,
      name: 'Empty',
      supplierCategory: 'other',
      subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/16/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bucketTotals).toMatchObject({
      'current': { count: 0, totalAmount: 0 },
      '1-30':    { count: 0, totalAmount: 0 },
      '31-60':   { count: 0, totalAmount: 0 },
      '61-90':   { count: 0, totalAmount: 0 },
      '90+':     { count: 0, totalAmount: 0 },
    });
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.excludedCount).toBe(0);
    expect(res.body.excludedReasons).toEqual({});
  });
});
