// @ts-check
/**
 * Arc 2 #903 slice 8 — GET /api/travel/payables/aging contract
 * (PRD_TRAVEL_BILLING UC-2.5 month-end-close aged-payable bucket report).
 *
 * Pins the route surface that consumes backend/lib/payableAging.js (commit
 * 7ba550d4 — exports `computeAgingReport(payables, { asOf })`). The lib's
 * bucket math itself is covered by backend/test/lib/payableAging.test.js;
 * this file's job is the ROUTE layer:
 *
 *   - Query param parsing + validation
 *     (asOf / subBrand / supplierCategory)
 *   - Prisma findMany WHERE shape (tenantId scope, sub-brand join, category join)
 *   - Sub-brand access-set enforcement (MANAGER scoped to ['tmc'] → RFU
 *     payables silently hidden via supplier.is.subBrand IN [...] filter,
 *     mirrors the cross-supplier `/payables` endpoint shipped slice 5)
 *   - Pass-through of the lib's shape (bucketTotals / grandTotal /
 *     excludedCount / excludedReasons) onto the JSON response.
 *
 * Test pattern mirrors backend/test/routes/travel-payables-cross-supplier.test.js
 * (commit f7cfc364) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, then drive supertest with real HS256 JWTs signed with
 * the dev-fallback secret the middleware uses. verifyToken stays in the chain
 * so the auth gate is exercised end-to-end.
 *
 * 12 cases.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplierPayable = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelSupplier = prisma.travelSupplier || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.supplierCredential = prisma.supplierCredential || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.supplierCredentialAccessLog = prisma.supplierCredentialAccessLog || {
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
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

// Build a payable shaped the way the lib (`computeAgingReport`) reads it.
// The route's findMany SELECTs { id, dueDate, paidAt, status, amount } only —
// supplier-join columns aren't needed for aging (only for the cross-supplier
// `/payables` list endpoint).
function makePayable(overrides = {}) {
  return {
    id: 500,
    dueDate: new Date(Date.now() + 5 * 86_400_000), // 5 days in future → 'current'
    paidAt: null,
    status: 'pending',
    amount: '10000.00',
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelSupplierPayable.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/payables/aging', () => {
  test('happy path: 3 payables across 3 buckets → bucketTotals + grandTotal computed', async () => {
    // Pin asOf so day-boundary arithmetic is deterministic regardless of
    // when the test runs.
    const asOf = '2026-06-01T00:00:00.000Z';
    const asOfMs = new Date(asOf).getTime();
    const rows = [
      // 5 days BEFORE asOf → current
      makePayable({ id: 1, amount: '1000.00', dueDate: new Date(asOfMs + 5 * 86_400_000) }),
      // 10 days overdue → 1-30 bucket
      makePayable({ id: 2, amount: '2000.00', dueDate: new Date(asOfMs - 10 * 86_400_000) }),
      // 75 days overdue → 61-90 bucket
      makePayable({ id: 3, amount: '3000.00', dueDate: new Date(asOfMs - 75 * 86_400_000) }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get(`/api/travel/payables/aging?asOf=${asOf}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(asOf);
    expect(res.body.bucketTotals.current).toMatchObject({ count: 1, totalAmount: 1000 });
    expect(res.body.bucketTotals['1-30']).toMatchObject({ count: 1, totalAmount: 2000 });
    expect(res.body.bucketTotals['31-60']).toMatchObject({ count: 0, totalAmount: 0 });
    expect(res.body.bucketTotals['61-90']).toMatchObject({ count: 1, totalAmount: 3000 });
    expect(res.body.bucketTotals['90+']).toMatchObject({ count: 0, totalAmount: 0 });
    expect(res.body.grandTotal).toBe(6000);
    expect(res.body.excludedCount).toBe(0);
    expect(res.body.excludedReasons).toEqual({});
    // Sub-brand + supplierCategory echoed as nulls when not provided.
    expect(res.body.subBrand).toBeNull();
    expect(res.body.supplierCategory).toBeNull();
  });

  test('?asOf shifts the aging window — same payable can land in a different bucket', async () => {
    // Same dueDate (a fixed past date); two requests with different asOf.
    // dueDate = 2026-04-15. At asOf=2026-05-01 → 16 days overdue → '1-30'.
    // At asOf=2026-07-15 → 91 days overdue → '90+'.
    const fixedDue = new Date('2026-04-15T00:00:00.000Z');
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      makePayable({ id: 1, amount: '5000.00', dueDate: fixedDue }),
    ]);

    const res1 = await request(makeApp())
      .get('/api/travel/payables/aging?asOf=2026-05-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res1.body.bucketTotals['1-30']).toMatchObject({ count: 1, totalAmount: 5000 });
    expect(res1.body.bucketTotals['90+']).toMatchObject({ count: 0, totalAmount: 0 });

    const res2 = await request(makeApp())
      .get('/api/travel/payables/aging?asOf=2026-07-15T00:00:00.000Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res2.body.bucketTotals['90+']).toMatchObject({ count: 1, totalAmount: 5000 });
    expect(res2.body.bucketTotals['1-30']).toMatchObject({ count: 0, totalAmount: 0 });
  });

  test('?subBrand=tmc pushes a nested supplier.is.subBrand filter through the join', async () => {
    await request(makeApp())
      .get('/api/travel/payables/aging?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .expect(200);

    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    // ADMIN with no subBrandAccess restriction + ?subBrand=tmc → exact match.
    expect(callArg.where.supplier).toMatchObject({ is: { subBrand: 'tmc' } });
    // Tenant scope always present.
    expect(callArg.where.tenantId).toBe(1);
    // Response echoes the filter.
  });

  test('?supplierCategory=hotel pushes a nested supplier.is.supplierCategory filter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables/aging?supplierCategory=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplierCategory).toBe('hotel');
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.supplier).toMatchObject({
      is: expect.objectContaining({ supplierCategory: 'hotel' }),
    });
  });

  test('empty payables list → all buckets zero', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.excludedCount).toBe(0);
    expect(res.body.bucketTotals).toEqual({
      current: { count: 0, totalAmount: 0 },
      '1-30': { count: 0, totalAmount: 0 },
      '31-60': { count: 0, totalAmount: 0 },
      '61-90': { count: 0, totalAmount: 0 },
      '90+': { count: 0, totalAmount: 0 },
    });
  });

  test('cross-tenant payables excluded — where.tenantId always = req.travelTenant.id', async () => {
    // Token claims tenantId=99 but requireTravelTenant resolves to id=1.
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    });

    await request(makeApp())
      .get('/api/travel/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 99 })}`)
      .expect(200);

    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(1);
  });

  test('sub-brand-restricted MANAGER (subBrandAccess=["tmc"]) → supplier.subBrand narrowed to {in:["tmc"]}', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    await request(makeApp())
      .get('/api/travel/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .expect(200);

    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    // The funnel pushes a {in:[...allowed]} filter through supplier.is.subBrand
    // so RFU rows are excluded even though no explicit ?subBrand was passed.
    expect(callArg.where.supplier).toMatchObject({
      is: { subBrand: { in: ['tmc'] } },
    });
  });

  test('paid + cancelled payables contribute to excludedCount, NOT bucketTotals', async () => {
    const asOf = '2026-06-01T00:00:00.000Z';
    const asOfMs = new Date(asOf).getTime();
    const rows = [
      // pending + overdue → 1-30 bucket
      makePayable({ id: 1, amount: '1000.00', status: 'pending',
        dueDate: new Date(asOfMs - 5 * 86_400_000) }),
      // paid + overdue → EXCLUDED
      makePayable({ id: 2, amount: '50000.00', status: 'paid',
        dueDate: new Date(asOfMs - 5 * 86_400_000),
        paidAt: new Date(asOfMs - 2 * 86_400_000) }),
      // cancelled + overdue → EXCLUDED
      makePayable({ id: 3, amount: '7500.00', status: 'cancelled',
        dueDate: new Date(asOfMs - 5 * 86_400_000) }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get(`/api/travel/payables/aging?asOf=${asOf}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bucketTotals['1-30']).toMatchObject({ count: 1, totalAmount: 1000 });
    expect(res.body.grandTotal).toBe(1000);
    expect(res.body.excludedCount).toBe(2);
    expect(res.body.excludedReasons).toMatchObject({
      EXCLUDED_PAID: 1,
      EXCLUDED_CANCELLED: 1,
    });
  });

  test('payables with missing/null dueDate count as excluded (NO_DUE_DATE)', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      makePayable({ id: 1, amount: '1000.00', dueDate: null, status: 'pending' }),
      makePayable({ id: 2, amount: '2000.00', dueDate: null, status: 'pending' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/payables/aging')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.excludedCount).toBe(2);
    expect(res.body.excludedReasons).toMatchObject({ NO_DUE_DATE: 2 });
  });

  test('invalid ?asOf → 400 INVALID_ASOF (and no prisma call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables/aging?asOf=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ASOF' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?subBrand → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables/aging?subBrand=mars')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?supplierCategory → 400 INVALID_SUPPLIER_CATEGORY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables/aging?supplierCategory=spaceship')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUPPLIER_CATEGORY' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });
});
