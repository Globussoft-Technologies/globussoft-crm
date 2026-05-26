// @ts-check
/**
 * Arc 2 #903 slice 23 — GET /api/travel/suppliers/stats
 * tenant-wide supplier rollup.
 *
 * Mirrors #905 slice 18 /commission-profiles/stats + #908 slice 19
 * /flyer-templates/global-stats. USER-readable anodyne aggregate that
 * powers the Supplier Master library page header summary strip. Pins
 * the contract for the new route handler added at
 * backend/routes/travel_suppliers.js (placed BEFORE the /:id family so
 * the literal-path /stats wins over the :id matcher).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastActivityAt=null.
 *   - Happy path:          3 suppliers across 2 sub-brands + 4 payables →
 *                          counts + sums correct (total/active/archived
 *                          counts, bySubBrand bucket counts, byCategory
 *                          bucket counts, totalPayables count,
 *                          totalPayableAmount sum, paidPayableAmount
 *                          sum where paidAt non-null, lastActivityAt is
 *                          the max(updatedAt)).
 *   - Sub-brand bucketing: defensive — a null subBrand (forward-compat
 *                          with any future nullable migration) lands in
 *                          the `_tenant` bucket, not lost.
 *   - MANAGER narrowing:   subBrandAccess=['rfu'] → caller sees ONLY rfu
 *                          suppliers (tmc/travelstall filtered before
 *                          aggregation).
 *   - USER-readable:       USER role returns 200 (anodyne aggregate; same
 *                          contract as the sibling stats endpoints).
 *   - Cross-tenant:        suppliers from another tenant must NOT appear
 *                          in counts even if their IDs would have matched
 *                          (defensive — the route's `tenantId` clause +
 *                          requireTravelTenant middleware enforce this).
 *   - Auth gate:           no token → 401.
 *   - Defensive math:      null/NaN/non-numeric `amount` values
 *                          contribute 0 to totalPayableAmount and
 *                          paidPayableAmount.
 *
 * Test pattern mirrors travel-supplier-payables-yearly.test.js (slice 22)
 * — patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with HS256 JWTs signed against the
 * dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findMany = vi.fn();
prisma.travelSupplier.count = vi.fn();
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
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
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

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/suppliers/stats', () => {
  test('empty tenant → all-zeros envelope with empty bucket maps', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    prisma.travelSupplier.count.mockResolvedValue(0);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      archived: 0,
      bySubBrand: {},
      byCategory: {},
      totalPayables: 0,
      totalPayableAmount: 0,
      paidPayableAmount: 0,
      lastActivityAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path: 3 suppliers across 2 sub-brands + 4 payables → counts + sums correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'tmc',
        supplierCategory: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: 'tmc',
        supplierCategory: 'flight',
        isActive: true,
        updatedAt: newest, // newest updatedAt — should drive lastActivityAt
      },
      {
        id: 3,
        subBrand: 'rfu',
        supplierCategory: 'hotel',
        isActive: false, // archived
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(3);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 100, amount: 1000, paidAt: new Date('2026-05-12T10:00:00Z') },
      { id: 101, amount: 2500, paidAt: null },
      { id: 102, amount: 750.5, paidAt: new Date('2026-05-14T10:00:00Z') },
      { id: 103, amount: 320, paidAt: null },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(2);
    expect(res.body.archived).toBe(1);
    expect(res.body.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 1 },
    });
    expect(res.body.byCategory).toEqual({
      hotel: { count: 2 },
      flight: { count: 1 },
    });
    expect(res.body.totalPayables).toBe(4);
    expect(res.body.totalPayableAmount).toBe(4570.5); // 1000+2500+750.5+320
    expect(res.body.paidPayableAmount).toBe(1750.5); // 1000+750.5
    expect(res.body.lastActivityAt).toBe(newest.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('sub-brand bucketing: null/empty subBrand lands in `_tenant` bucket (defensive)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' for forward-compat. Pin that behaviour.
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: null,
        supplierCategory: 'other',
        isActive: true,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: '',
        supplierCategory: 'other',
        isActive: true,
        updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
      {
        id: 3,
        subBrand: 'tmc',
        supplierCategory: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(3);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bySubBrand).toEqual({
      _tenant: { count: 2 },
      tmc: { count: 1 },
    });
  });

  test('MANAGER with subBrandAccess=["rfu"] → query narrowed to rfu only', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 3,
        subBrand: 'rfu',
        supplierCategory: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(1);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });

    // Verify the WHERE clause was narrowed by sub-brand BEFORE the query
    // hit Prisma. This is the contract: MANAGER subBrandAccess narrowing
    // happens at the route level, not in client code.
    const whereArg = prisma.travelSupplier.findMany.mock.calls[0][0].where;
    expect(whereArg.subBrand).toEqual({ in: ['rfu'] });
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    prisma.travelSupplier.count.mockResolvedValue(0);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('cross-tenant: requireTravelTenant + tenantId clause prevents leak from another tenant', async () => {
    // The route's WHERE clause includes tenantId: req.travelTenant.id.
    // findMany is mocked to return ONLY the caller's rows; we verify the
    // tenantId was actually scoped at the route layer (defensive — the
    // payable-fetch also reuses the same tenantId).
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'tmc',
        supplierCategory: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(1);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const supplierWhere = prisma.travelSupplier.findMany.mock.calls[0][0].where;
    expect(supplierWhere.tenantId).toBe(1);
    const payableWhere = prisma.travelSupplierPayable.findMany.mock.calls[0][0].where;
    expect(payableWhere.tenantId).toBe(1);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/suppliers/stats');
    expect(res.status).toBe(401);
  });

  test('defensive math: null/NaN/non-numeric `amount` values contribute 0 to totals', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'tmc',
        supplierCategory: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(1);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, amount: null, paidAt: null }, // null → 0
      { id: 2, amount: 'oops', paidAt: null }, // NaN → 0
      { id: 3, amount: undefined, paidAt: new Date() }, // undefined → 0
      { id: 4, amount: 100, paidAt: new Date() }, // counted
      { id: 5, amount: 50, paidAt: null }, // counted (unpaid)
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/suppliers/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPayables).toBe(5); // count includes the defective rows
    expect(res.body.totalPayableAmount).toBe(150); // 100 + 50, defective skipped
    expect(res.body.paidPayableAmount).toBe(100); // only the paid one with valid amt
  });
});
