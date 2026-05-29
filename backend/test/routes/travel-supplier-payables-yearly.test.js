// @ts-check
/**
 * Arc 2 #903 slice 22 — GET /api/travel/suppliers/:id/payables/yearly
 * per-supplier annual payable rollup.
 *
 * Completes the time-series triplet alongside slice 18's
 * /:id/payables/monthly and slice 20's /:id/payables/quarterly. Pins
 * the contract for the per-supplier yearly-rollup endpoint added at
 * the end of backend/routes/travel_suppliers.js. Feeds the per-supplier
 * dashboard's "decade lookback" widget (PRD_TRAVEL_SUPPLIER_MASTER §3.7).
 *
 * Aggregation differs intentionally from sibling rollups: yearly buckets
 * by `createdAt` UTC year (when payable was BOOKED, not when DUE) since
 * yearly is the historical "annual supplier spend" surface; finance
 * teams reconcile against the year the obligation was incurred, not the
 * year it was due. Paid-vs-open split uses `paidAt non-null` rather
 * than the 4-way status break used by monthly/quarterly — same as
 * slice 21 timeline + slice 6 PATCH conventions (status=paid implies
 * paidAt non-null).
 *
 * What's pinned
 * -------------
 *   - Happy path:         4 payables across 2 years → 2 year buckets,
 *                         paidAmount + openAmount split correct per
 *                         paidAt non-null, grandTotal* fields sum across
 *                         the windowed set.
 *   - Sort:               ?orderBy=totalAmount:desc returns years in
 *                         descending total order; unknown token degrades
 *                         silently to default year:asc.
 *   - Filter:             ?from=YYYY&to=YYYY restricts the bucket set;
 *                         grand totals + totalYears reflect the filtered
 *                         set, not the full population.
 *   - INVALID_YEAR_FORMAT: ?from=26 / ?from=2026-Q1 → 400; supplier
 *                         lookup NOT attempted.
 *   - Defensive math:     null + NaN + non-numeric `amount` values
 *                         contribute 0 to every bucket sum.
 *   - INVALID_ID:         non-numeric :id → 400 INVALID_ID.
 *   - SUPPLIER_NOT_FOUND: supplier missing or wrong-tenant → 404.
 *   - SUB_BRAND_DENIED:   sub-brand-restricted manager → 403.
 *   - Pagination:         limit + offset slice the years[] array AFTER
 *                         aggregate + sort; grand totals stay window-wide
 *                         (not page-scoped); limit caps at YEARLY_MAX_LIMIT=30.
 *   - `unknown` bucket:   null createdAt aggregates into year="unknown"
 *                         (excluded from any bounded from/to window).
 *
 * Test pattern mirrors travel-suppliers-quarterly.test.js (slice 20) —
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

describe('GET /api/travel/suppliers/:id/payables/yearly', () => {
  test('happy path: 4 payables across 2 years → 2 buckets, paid/open split + grand totals correct', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 42,
      name: 'Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    // 2025: 2 payables, one paid (paidAt set), one open
    //   2025: total=300, paid=100, open=200
    // 2026: 2 payables, both open
    //   2026: total=550, paid=0, open=550
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2025, 3, 15), paidAt: utc(2025, 4, 10), amount: '100.00' },
      { id: 2, createdAt: utc(2025, 8, 20), paidAt: null,             amount: '200.00' },
      { id: 3, createdAt: utc(2026, 1, 5),  paidAt: null,             amount: '250.00' },
      { id: 4, createdAt: utc(2026, 6, 18), paidAt: null,             amount: '300.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplierId).toBe(42);
    expect(res.body.supplierName).toBe('Hilton Mumbai');
    expect(res.body.years).toHaveLength(2);

    // Default sort year:asc.
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026']);

    const y2025 = res.body.years[0];
    expect(y2025).toMatchObject({
      year: '2025',
      payableCount: 2,
    });
    expect(y2025.totalAmount).toBeCloseTo(300, 2);
    expect(y2025.paidAmount).toBeCloseTo(100, 2);
    expect(y2025.openAmount).toBeCloseTo(200, 2);

    const y2026 = res.body.years[1];
    expect(y2026).toMatchObject({
      year: '2026',
      payableCount: 2,
    });
    expect(y2026.totalAmount).toBeCloseTo(550, 2);
    expect(y2026.paidAmount).toBeCloseTo(0, 2);
    expect(y2026.openAmount).toBeCloseTo(550, 2);

    // Grand totals across the windowed set.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandTotalAmount).toBeCloseTo(850, 2);
    expect(res.body.grandPaidAmount).toBeCloseTo(100, 2);
    expect(res.body.grandOpenAmount).toBeCloseTo(750, 2);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('sort: ?orderBy=totalAmount:desc returns years in descending total order', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 43, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2024, 6, 1),  paidAt: null, amount: '100' }, // 2024 total=100
      { id: 2, createdAt: utc(2025, 6, 1),  paidAt: null, amount: '500' }, // 2025 total=500
      { id: 3, createdAt: utc(2026, 6, 1),  paidAt: null, amount: '300' }, // 2026 total=300
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/43/payables/yearly?orderBy=totalAmount:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026', '2024']);
    expect(res.body.years[0].totalAmount).toBeCloseTo(500, 2);
    expect(res.body.years[1].totalAmount).toBeCloseTo(300, 2);
    expect(res.body.years[2].totalAmount).toBeCloseTo(100, 2);
  });

  test('sort: unknown orderBy token degrades silently to default year:asc', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 44, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2025, 6, 1), paidAt: null, amount: '100' },
      { id: 2, createdAt: utc(2024, 6, 1), paidAt: null, amount: '500' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/44/payables/yearly?orderBy=bogus:up')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Default year:asc.
    expect(res.body.years.map((y) => y.year)).toEqual(['2024', '2025']);
  });

  test('filter: ?from=2026&to=2026 restricts to 1 bucket + grand totals follow window', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 50, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2024, 1, 1), paidAt: null, amount: '100' },
      { id: 2, createdAt: utc(2025, 1, 1), paidAt: null, amount: '200' },
      { id: 3, createdAt: utc(2026, 1, 1), paidAt: utc(2026, 2, 1), amount: '300' },
      { id: 4, createdAt: utc(2026, 6, 1), paidAt: null, amount: '400' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/50/payables/yearly?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].payableCount).toBe(2);
    expect(res.body.years[0].totalAmount).toBeCloseTo(700, 2);
    expect(res.body.years[0].paidAmount).toBeCloseTo(300, 2);
    expect(res.body.years[0].openAmount).toBeCloseTo(400, 2);

    // Grand totals scoped to the windowed set, not full population.
    expect(res.body.totalYears).toBe(1);
    expect(res.body.grandTotalAmount).toBeCloseTo(700, 2);
    expect(res.body.grandPaidAmount).toBeCloseTo(300, 2);
    expect(res.body.grandOpenAmount).toBeCloseTo(400, 2);
  });

  test('invalid ?from=26 → 400 INVALID_YEAR_FORMAT, supplier lookup NOT attempted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/yearly?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('invalid ?from=2026-Q1 → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/yearly?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('invalid ?to=garbage → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/77/payables/yearly?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('defensive math: null + NaN + non-numeric amounts contribute 0 to every sum', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 60, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2026, 1, 1), paidAt: null, amount: null },
      { id: 2, createdAt: utc(2026, 2, 1), paidAt: null, amount: 'not-a-number' },
      { id: 3, createdAt: utc(2026, 3, 1), paidAt: null, amount: NaN },
      { id: 4, createdAt: utc(2026, 4, 1), paidAt: utc(2026, 5, 1), amount: '100' }, // only valid row
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/60/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    expect(y.year).toBe('2026');
    expect(y.payableCount).toBe(4); // all 4 counted (defensive math doesn't drop rows)
    expect(y.totalAmount).toBeCloseTo(100, 2); // only the valid row contributes
    expect(y.paidAmount).toBeCloseTo(100, 2);
    expect(y.openAmount).toBeCloseTo(0, 2);
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('supplier missing → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/payables/yearly')
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
      .get('/api/travel/suppliers/13/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('pagination: limit + offset slice years[] AFTER sort; grand totals stay window-wide', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 70, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    // Years 2020..2025 (6 buckets).
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2020, 1, 1), paidAt: null, amount: '100' },
      { id: 2, createdAt: utc(2021, 1, 1), paidAt: null, amount: '100' },
      { id: 3, createdAt: utc(2022, 1, 1), paidAt: null, amount: '100' },
      { id: 4, createdAt: utc(2023, 1, 1), paidAt: null, amount: '100' },
      { id: 5, createdAt: utc(2024, 1, 1), paidAt: null, amount: '100' },
      { id: 6, createdAt: utc(2025, 1, 1), paidAt: null, amount: '100' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/70/payables/yearly?limit=2&offset=2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Sliced page is 2 items starting from index 2 (2022, 2023).
    expect(res.body.years.map((y) => y.year)).toEqual(['2022', '2023']);
    expect(res.body.totalYears).toBe(6);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(2);
    // Grand totals reflect ALL 6 buckets, not just the page.
    expect(res.body.grandTotalAmount).toBeCloseTo(600, 2);
    expect(res.body.grandOpenAmount).toBeCloseTo(600, 2);
  });

  test('limit caps at YEARLY_MAX_LIMIT=30', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 71, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/71/payables/yearly?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });

  test('unknown bucket: null createdAt aggregates into year="unknown" + excluded from from/to window', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 80, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      { id: 1, createdAt: utc(2026, 1, 1), paidAt: null, amount: '100' },
      { id: 2, createdAt: null,             paidAt: null, amount: '999' },
    ]);

    // Without from/to: both buckets present.
    const res1 = await request(makeApp())
      .get('/api/travel/suppliers/80/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res1.status).toBe(200);
    expect(res1.body.years).toHaveLength(2);
    const yearKeys = res1.body.years.map((y) => y.year);
    expect(yearKeys).toContain('2026');
    expect(yearKeys).toContain('unknown');

    // With from=2020&to=2099: unknown is excluded (doesn't match YYYY).
    const res2 = await request(makeApp())
      .get('/api/travel/suppliers/80/payables/yearly?from=2020&to=2099')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res2.status).toBe(200);
    expect(res2.body.years).toHaveLength(1);
    expect(res2.body.years[0].year).toBe('2026');
    expect(res2.body.totalYears).toBe(1);
  });

  test('findMany take cap: 10_000 row limit + scoped to tenant+supplier; createdAt+paidAt+amount projected', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 15, name: 'V', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/15/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArgs.take).toBe(10_000);
    expect(callArgs.where).toMatchObject({ tenantId: 1, supplierId: 15 });
    expect(callArgs.select).toMatchObject({
      createdAt: true,
      paidAt: true,
      amount: true,
    });
  });

  test('empty payables → years=[] grandTotals=0 totalYears=0', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 16, name: 'Empty', supplierCategory: 'hotel', subBrand: 'tmc',
    });
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/16/payables/yearly')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([]);
    expect(res.body.totalYears).toBe(0);
    expect(res.body.grandTotalAmount).toBe(0);
    expect(res.body.grandPaidAmount).toBe(0);
    expect(res.body.grandOpenAmount).toBe(0);
  });
});
