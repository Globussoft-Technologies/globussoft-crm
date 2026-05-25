// @ts-check
/**
 * Arc 2 #903 slice 11 — GET /api/travel/suppliers/exposure cross-supplier
 * credit-utilization summary.
 *
 * Pins the contract for the per-supplier exposure dashboard endpoint added
 * to backend/routes/travel_suppliers.js. The endpoint answers "which of my
 * N suppliers are near credit limit?" in one round-trip, replacing what
 * would otherwise be an O(N) fan-out across /suppliers + per-supplier
 * payable sums.
 *
 * What's pinned
 * -------------
 *   - Happy path:        2 suppliers + their pending+scheduled payables →
 *                        rows include openExposure, utilization, status,
 *                        and the summary block reflects the cohort.
 *   - Status taxonomy:   'ok' (util < 0.8), 'near-limit' (0.8 ≤ util ≤ 1.0),
 *                        'over-limit' (util > 1.0), 'no-limit' (no creditLimit).
 *   - Excluded statuses: paid + cancelled payables don't count toward
 *                        openExposure (the groupBy where-clause pins
 *                        status IN ['pending', 'scheduled']).
 *   - Sort:              openExposure DESC, name ASC as tiebreaker.
 *   - Empty:             zero suppliers → empty response, summary zeros.
 *   - Filter:            ?nearLimitOnly=1 filters to near-limit + over-limit.
 *   - Filter:            ?supplierCategory=hotel narrows where-clause.
 *   - Filter:            ?subBrand=tmc narrows where-clause.
 *   - Filter:            ?includeInactive=1 keeps isActive=false rows.
 *   - Validation:        bad supplierCategory → 400 INVALID_SUPPLIER_CATEGORY.
 *   - Validation:        bad subBrand → 400 INVALID_SUB_BRAND.
 *   - Route ordering:    /suppliers/exposure registers BEFORE /suppliers/:id
 *                        (standing rule — sub-paths before :id) so the
 *                        literal "exposure" token isn't consumed as an id.
 *
 * Test pattern mirrors travel-suppliers-search.test.js (slice 10) — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, then drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
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
prisma.travelSupplierPayable.groupBy = vi.fn();
prisma.travelSupplierPayable.findMany = vi.fn();
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

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplierPayable.groupBy.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.travelSupplierPayable.count.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/suppliers/exposure', () => {
  test('happy path: returns rows with openExposure + utilization + status + summary', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      {
        id: 1, name: 'Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '100000.00', creditCurrency: 'INR', isActive: true,
      },
      {
        id: 2, name: 'Air India', supplierCategory: 'flight', subBrand: 'tmc',
        creditLimit: '50000.00', creditCurrency: 'INR', isActive: true,
      },
      {
        id: 3, name: 'Unbilled Vendor', supplierCategory: 'other', subBrand: 'tmc',
        creditLimit: null, creditCurrency: 'INR', isActive: true,
      },
    ]);
    prisma.travelSupplierPayable.groupBy.mockResolvedValue([
      { supplierId: 1, _sum: { amount: '85000.00' }, _count: { _all: 3 } },
      { supplierId: 2, _sum: { amount: '60000.00' }, _count: { _all: 2 } },
      // Supplier 3 has no open payables (zero rows for that id).
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);

    // Sort: openExposure DESC, name ASC. Air India (60K) before Hilton (85K)? NO —
    // openExposure DESC: 85000 > 60000 > 0. So order is Hilton (1), Air India (2),
    // Unbilled Vendor (3).
    const ids = res.body.suppliers.map((s) => s.id);
    expect(ids).toEqual([1, 2, 3]);

    // Hilton: util = 85000 / 100000 = 0.85 → near-limit
    expect(res.body.suppliers[0]).toMatchObject({
      id: 1,
      name: 'Hilton Mumbai',
      openExposure: 85000,
      utilization: 0.85,
      openPayableCount: 3,
      status: 'near-limit',
      creditLimit: 100000,
      creditCurrency: 'INR',
    });

    // Air India: util = 60000 / 50000 = 1.2 → over-limit
    expect(res.body.suppliers[1]).toMatchObject({
      id: 2,
      name: 'Air India',
      openExposure: 60000,
      utilization: 1.2,
      openPayableCount: 2,
      status: 'over-limit',
    });

    // Unbilled Vendor: no limit, no payables → status 'no-limit', utilization null
    expect(res.body.suppliers[2]).toMatchObject({
      id: 3,
      name: 'Unbilled Vendor',
      openExposure: 0,
      utilization: null,
      openPayableCount: 0,
      status: 'no-limit',
      creditLimit: null,
    });

    // Summary reflects the cohort.
    expect(res.body.summary).toMatchObject({
      overLimitCount: 1,
      nearLimitCount: 1,
      totalExposure: 145000,
    });

    // groupBy must pin status IN ['pending', 'scheduled'] — paid + cancelled
    // payables must not count toward openExposure.
    expect(prisma.travelSupplierPayable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['supplierId'],
        where: expect.objectContaining({
          tenantId: 1,
          supplierId: { in: [1, 2, 3] },
          status: { in: ['pending', 'scheduled'] },
        }),
        _sum: { amount: true },
        _count: { _all: true },
      }),
    );
  });

  test('status taxonomy: ok < 0.8 ≤ near-limit ≤ 1.0 < over-limit', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      // util = 0.5 → 'ok'
      { id: 10, name: 'A', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
      // util = 0.8 (boundary) → 'near-limit'
      { id: 11, name: 'B', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
      // util = 1.0 (boundary) → 'near-limit' (NOT over-limit)
      { id: 12, name: 'C', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
      // util = 1.5 → 'over-limit'
      { id: 13, name: 'D', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
    ]);
    prisma.travelSupplierPayable.groupBy.mockResolvedValue([
      { supplierId: 10, _sum: { amount: '5000' }, _count: { _all: 1 } },
      { supplierId: 11, _sum: { amount: '8000' }, _count: { _all: 1 } },
      { supplierId: 12, _sum: { amount: '10000' }, _count: { _all: 1 } },
      { supplierId: 13, _sum: { amount: '15000' }, _count: { _all: 1 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Sort: 15000, 10000, 8000, 5000
    const byId = Object.fromEntries(res.body.suppliers.map((s) => [s.id, s]));
    expect(byId[10].status).toBe('ok');
    expect(byId[11].status).toBe('near-limit');
    expect(byId[12].status).toBe('near-limit');
    expect(byId[13].status).toBe('over-limit');
  });

  test('utilization is rounded to 4dp', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 50, name: 'Decimal Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '7000', creditCurrency: 'INR', isActive: true },
    ]);
    // 1234.56 / 7000 = 0.17636571428... → round4 → 0.1764
    prisma.travelSupplierPayable.groupBy.mockResolvedValue([
      { supplierId: 50, _sum: { amount: '1234.56' }, _count: { _all: 1 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppliers[0].utilization).toBe(0.1764);
  });

  test('empty suppliers list returns empty response with zero summary', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      suppliers: [],
      total: 0,
      summary: { overLimitCount: 0, nearLimitCount: 0, totalExposure: 0 },
    });
    // No groupBy call when there are no suppliers (skipped optimization).
    expect(prisma.travelSupplierPayable.groupBy).not.toHaveBeenCalled();
  });

  test('?nearLimitOnly=1 filters to near-limit + over-limit only', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 21, name: 'OK Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
      { id: 22, name: 'Near Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
      { id: 23, name: 'Over Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '10000', creditCurrency: 'INR', isActive: true },
    ]);
    prisma.travelSupplierPayable.groupBy.mockResolvedValue([
      { supplierId: 21, _sum: { amount: '5000' }, _count: { _all: 1 } },   // ok
      { supplierId: 22, _sum: { amount: '8500' }, _count: { _all: 1 } },   // near-limit
      { supplierId: 23, _sum: { amount: '15000' }, _count: { _all: 1 } },  // over-limit
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure?nearLimitOnly=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const ids = res.body.suppliers.map((s) => s.id);
    expect(ids).toEqual([23, 22]); // over-limit first (higher openExposure)
    // Summary still counts the OK supplier in cohort tallies — summary is the
    // global picture before filtering; the returned `suppliers` list is the
    // filtered view.
    expect(res.body.summary).toMatchObject({
      overLimitCount: 1,
      nearLimitCount: 1,
    });
  });

  test('?supplierCategory=hotel narrows the where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/exposure?supplierCategory=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          isActive: true,
          supplierCategory: 'hotel',
        }),
      }),
    );
  });

  test('?subBrand=tmc narrows the where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/exposure?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          isActive: true,
          subBrand: 'tmc',
        }),
      }),
    );
  });

  test('?includeInactive=1 drops isActive=true from where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/suppliers/exposure?includeInactive=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const callArgs = prisma.travelSupplier.findMany.mock.calls[0][0];
    expect(callArgs.where).not.toHaveProperty('isActive');
  });

  test('invalid supplierCategory returns 400 INVALID_SUPPLIER_CATEGORY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure?supplierCategory=cruise')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUPPLIER_CATEGORY' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('invalid subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure?subBrand=nonexistent')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: /suppliers/exposure does NOT hit the :id handler', async () => {
    // If the route were misordered, parseInt("exposure", 10) → NaN would
    // hit the :id 400 INVALID_ID path. Pin that we don't.
    prisma.travelSupplier.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).not.toMatchObject({ code: 'INVALID_ID' });
  });

  test('sort: openExposure DESC, name ASC as tiebreaker', async () => {
    // Two suppliers with IDENTICAL openExposure — name ASC must break the tie.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 100, name: 'Zebra Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '20000', creditCurrency: 'INR', isActive: true },
      { id: 101, name: 'Alpha Vendor', supplierCategory: 'hotel', subBrand: 'tmc',
        creditLimit: '20000', creditCurrency: 'INR', isActive: true },
    ]);
    prisma.travelSupplierPayable.groupBy.mockResolvedValue([
      { supplierId: 100, _sum: { amount: '5000' }, _count: { _all: 1 } },
      { supplierId: 101, _sum: { amount: '5000' }, _count: { _all: 1 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/exposure')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const ids = res.body.suppliers.map((s) => s.id);
    // Alpha (101) comes before Zebra (100) on alpha-sort tie-break.
    expect(ids).toEqual([101, 100]);
  });
});
