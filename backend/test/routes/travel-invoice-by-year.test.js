// @ts-check
/**
 * #901 slice 31 — GET /api/travel/invoices/by-year tenant-wide annual rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_invoices.js:
 *
 *   GET /api/travel/invoices/by-year     any verified token
 *
 * Completes the by-month/by-quarter/by-year time-series triplet (slices
 * 29/30/31). Mirrors slice 18 of #900 (/quotes/by-year) for shape
 * consistency across quote + invoice annual surfaces.
 *
 * Contracts asserted:
 *   - 400 INVALID_YEAR_FORMAT for ?from / ?to that don't match YYYY
 *     (regex /^\d{4}$/) — rejects "20264" (5-digit), "26" (2-digit),
 *     "twenty26" (alpha).
 *   - Bucketing by UTC year — 4 invoices spanning 2 years collapse to 2
 *     rows with correct per-year counts + sums.
 *   - orderBy=totalValue:desc returns years in descending value order;
 *     unknown orderBy tokens degrade silently to year:asc default.
 *   - ?status=Paid restricts the entire aggregation to Paid rows
 *     (other statuses excluded from invoiceCount + sums).
 *   - ?from=YYYY & ?to=YYYY narrows the bucket set inclusively.
 *   - paidValue is summed ONLY from Paid rows (Draft/Issued/Partial/Voided
 *     contribute to totalValue but NOT to paidValue).
 *   - openValue = totalValue - paidValue - voidedValue arithmetic pinned
 *     across all 5 statuses (voided rows are neither paid nor open).
 *   - Pagination: ?limit=2&offset=1 returns years 2..3 of a 5-year set.
 *   - Sub-brand restriction: MANAGER with subBrandAccess=['rfu'] sees
 *     only rfu invoices — Prisma where.subBrand uses `{ in: ['rfu'] }`
 *     so non-rfu invoices never reach the aggregator.
 *   - 401 on missing token.
 *
 * Pattern mirrors travel-invoice-by-quarter.test.js + travel-quote-by-year.test.js
 * — CJS prisma singleton patched BEFORE the router is required so verifyToken's
 * revokedToken probe + the route's findMany call both hit stubs; HS256 JWT via
 * the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
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
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Issued',
    totalAmount: '10000.00',
    currency: 'INR',
    createdAt: new Date(Date.UTC(2026, 4, 15)), // 2026
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/by-year — validation', () => {
  test('rejects ?from=20264 (5-digit) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?from=20264')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('rejects ?from=26 (2-digit) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('rejects ?to=twenty26 (alpha) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?to=twenty26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/invoices/by-year — happy path bucketing', () => {
  test('4 invoices across 2 years → 2 year rows with correct counts + sums', async () => {
    // 2 in 2025 (Mar + Sep: 15000 + 25000 = 40000),
    // 2 in 2026 (May + Jul: 10000 + 20000 = 30000)
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, totalAmount: '15000.00', createdAt: new Date(Date.UTC(2025, 2, 5)) }),
      makeInvoice({ id: 2, totalAmount: '25000.00', createdAt: new Date(Date.UTC(2025, 8, 20)) }),
      makeInvoice({ id: 3, totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 4, 2)) }),
      makeInvoice({ id: 4, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 6, 28)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(2);
    // Default orderBy is year:asc.
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].invoiceCount).toBe(2);
    expect(res.body.years[0].totalValue).toBe(40000);
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.years[1].invoiceCount).toBe(2);
    expect(res.body.years[1].totalValue).toBe(30000);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandInvoiceCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(70000);
  });
});

describe('GET /api/travel/invoices/by-year — sort + filter', () => {
  test('orderBy=totalValue:desc returns years in descending value order', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      // 2024: 5000 (low)
      makeInvoice({ id: 1, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2024, 1, 10)) }),
      // 2025: 50000 (highest)
      makeInvoice({ id: 2, totalAmount: '50000.00', createdAt: new Date(Date.UTC(2025, 4, 10)) }),
      // 2026: 20000 (mid)
      makeInvoice({ id: 3, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026', '2024']);
  });

  test('status=Paid restricts to paid-only aggregation', async () => {
    // The route passes status into the prisma where; the mock simulates
    // by returning only Paid rows when status filter is requested.
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      const all = [
        makeInvoice({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
        makeInvoice({ id: 2, status: 'Paid', totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
        makeInvoice({ id: 3, status: 'Paid', totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 5, 20)) }),
        makeInvoice({ id: 4, status: 'Issued', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 25)) }),
      ];
      if (where && where.status) return all.filter((q) => q.status === where.status);
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?status=Paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].invoiceCount).toBe(2);
    expect(res.body.years[0].paidCount).toBe(2);
    expect(res.body.years[0].totalValue).toBe(30000);
    expect(res.body.years[0].paidValue).toBe(30000);
    expect(res.body.years[0].draftCount).toBe(0);
    expect(res.body.years[0].issuedCount).toBe(0);
    expect(res.body.years[0].partialCount).toBe(0);
    expect(res.body.years[0].voidedCount).toBe(0);
  });

  test('?from=2025&to=2025 restricts to 1 bucket', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2024, 1, 10)) }),
      makeInvoice({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2025, 4, 10)) }),
      makeInvoice({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?from=2025&to=2025')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].totalValue).toBe(2000);
  });
});

describe('GET /api/travel/invoices/by-year — defensive math', () => {
  test('paidValue is summed ONLY from Paid rows', async () => {
    // Mixed-status year — Paid 10000 + Issued 5000 + Draft 1000 = total 16000;
    // paidValue must be 10000 (Paid only), not 16000.
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeInvoice({ id: 2, status: 'Issued', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      makeInvoice({ id: 3, status: 'Paid', totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 4, 15)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    expect(y.totalValue).toBe(16000);
    expect(y.paidValue).toBe(10000);
    expect(y.draftCount).toBe(1);
    expect(y.issuedCount).toBe(1);
    expect(y.paidCount).toBe(1);
    expect(res.body.grandPaidValue).toBe(10000);
  });

  test('openValue = totalValue - paidValue - voidedValue across all 5 statuses', async () => {
    // 5 rows in 2026 spanning every status:
    //   Draft   1000 — counted, not paid, contributes to open
    //   Issued  2000 — counted, not paid, contributes to open
    //   Partial 3000 — counted, not paid (partial-paid sum is via schedule, not status), contributes to open
    //   Paid    5000 — counted, PAID, contributes to paid (not open)
    //   Voided  8000 — counted in totalValue but NOT paid NOT open
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeInvoice({ id: 2, status: 'Issued', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
      makeInvoice({ id: 3, status: 'Partial', totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      makeInvoice({ id: 4, status: 'Paid', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 8)) }),
      makeInvoice({ id: 5, status: 'Voided', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 9)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    // totalValue: every invoice contributes
    expect(y.totalValue).toBe(19000);
    // paidValue: only the Paid row
    expect(y.paidValue).toBe(5000);
    // openValue = totalValue - paidValue - voidedValue = 19000 - 5000 - 8000 = 6000
    expect(y.openValue).toBe(6000);
    expect(y.draftCount).toBe(1);
    expect(y.issuedCount).toBe(1);
    expect(y.partialCount).toBe(1);
    expect(y.paidCount).toBe(1);
    expect(y.voidedCount).toBe(1);
    expect(res.body.grandPaidValue).toBe(5000);
    expect(res.body.grandOpenValue).toBe(6000);
    expect(res.body.grandTotalValue).toBe(19000);
  });
});

describe('GET /api/travel/invoices/by-year — pagination', () => {
  test('limit=2&offset=1 returns years 2..3 of a 5-year dataset', async () => {
    // 5 years: 2022, 2023, 2024, 2025, 2026
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2022, 0, 10)) }),
      makeInvoice({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2023, 3, 10)) }),
      makeInvoice({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2024, 6, 10)) }),
      makeInvoice({ id: 4, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2025, 9, 10)) }),
      makeInvoice({ id: 5, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 0, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(2);
    // Default orderBy is year:asc; offset=1 skips 2022 → returns 2023 + 2024.
    expect(res.body.years[0].year).toBe('2023');
    expect(res.body.years[1].year).toBe('2024');
    expect(res.body.totalYears).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('GET /api/travel/invoices/by-year — sub-brand restriction', () => {
  test('MANAGER with subBrandAccess=["rfu"] sees only rfu invoices (other sub-brands filtered)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      // Simulate Prisma's `subBrand: { in: [...] }` filter.
      const all = [
        makeInvoice({ id: 1, subBrand: 'tmc', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
        makeInvoice({ id: 2, subBrand: 'rfu', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
        makeInvoice({ id: 3, subBrand: 'travelstall', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].invoiceCount).toBe(1);
    expect(res.body.years[0].totalValue).toBe(8000);
  });
});
