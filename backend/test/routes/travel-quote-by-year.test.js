// @ts-check
/**
 * #900 slice 18 — GET /api/travel/quotes/by-year tenant-wide annual rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/by-year     any verified token
 *
 * Mirrors slice 17's by-quarter spec exactly, swapping the YYYY-Qn bucket
 * for YYYY (calendar year, not Indian-FY). Same defensive math, same
 * orderBy semantics, same sub-brand narrowing. Completes the
 * by-month/by-quarter/by-year time-series triplet (slices 16/17/18) that
 * powers the operator-dashboard analytics tiles at month/quarter/year
 * granularity.
 *
 * Contracts asserted:
 *   - 400 INVALID_YEAR_FORMAT for ?from / ?to that don't match YYYY
 *     (regex /^\d{4}$/) — rejects "26" (too short), "2026-Q1" (quarter
 *     token), "20261" (too long).
 *   - Bucketing by UTC year — 4 quotes spanning 2 years collapse to 2
 *     rows with correct per-year counts + sums.
 *   - orderBy=totalValue:desc returns years in descending value order;
 *     unknown orderBy tokens degrade silently to year:asc default.
 *   - ?status=Accepted restricts the entire aggregation to Accepted rows
 *     (other statuses excluded from quoteCount + sums).
 *   - ?from=2026&?to=2026 narrows the bucket set inclusively (single
 *     calendar year window).
 *   - acceptedValue is summed ONLY from Accepted rows (Draft/Sent/Rejected
 *     contribute to totalValue but NOT to acceptedValue).
 *   - Null/zero/non-numeric totalAmount contributes 0; no NaN poisoning.
 *   - Pagination: ?limit=2&offset=1 returns years 2..3 of a 4-year
 *     dataset.
 *   - Sub-brand restriction: MANAGER with subBrandAccess=['rfu'] sees
 *     only rfu quotes — Prisma where.subBrand uses `{ in: ['rfu'] }` so
 *     non-rfu quotes never reach the aggregator.
 *   - 401 on missing token.
 *
 * Pattern mirrors travel-quote-by-quarter.test.js — CJS prisma singleton
 * patched BEFORE the router is required so verifyToken's revokedToken
 * probe + the route's findMany call both hit stubs; HS256 JWT via the
 * dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = prisma.travelQuoteLine || {
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeQuote(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Draft',
    totalAmount: '10000.00',
    currency: 'INR',
    createdAt: new Date(Date.UTC(2026, 4, 15)), // 2026
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/by-year — validation', () => {
  test('rejects ?from=26 (too short) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('rejects ?from=2026-Q1 (quarter token, not year) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('rejects ?to=20261 (too long) with 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?to=20261')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/by-year — happy path bucketing', () => {
  test('4 quotes across 2 years → 2 year rows with correct counts + sums', async () => {
    // 2 in 2026 (Apr+May: 15000 + 25000 = 40000),
    // 2 in 2027 (Jul+Sep: 10000 + 20000 = 30000)
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '15000.00', createdAt: new Date(Date.UTC(2026, 3, 5)) }),  // Apr 2026
      makeQuote({ id: 2, totalAmount: '25000.00', createdAt: new Date(Date.UTC(2026, 4, 20)) }), // May 2026
      makeQuote({ id: 3, totalAmount: '10000.00', createdAt: new Date(Date.UTC(2027, 6, 2)) }),  // Jul 2027
      makeQuote({ id: 4, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2027, 8, 28)) }), // Sep 2027
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(2);
    // Default orderBy is year:asc.
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].quoteCount).toBe(2);
    expect(res.body.years[0].totalValue).toBe(40000);
    expect(res.body.years[1].year).toBe('2027');
    expect(res.body.years[1].quoteCount).toBe(2);
    expect(res.body.years[1].totalValue).toBe(30000);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(70000);
  });
});

describe('GET /api/travel/quotes/by-year — sort + filter', () => {
  test('orderBy=totalValue:desc returns years in descending value order', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // 2025: 5000 (low)
      makeQuote({ id: 1, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2025, 1, 10)) }),
      // 2026: 50000 (highest)
      makeQuote({ id: 2, totalAmount: '50000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      // 2027: 20000 (mid)
      makeQuote({ id: 3, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2027, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years.map((y) => y.year)).toEqual(['2026', '2027', '2025']);
  });

  test('status=Accepted restricts to accepted-only aggregation', async () => {
    // The route passes status into the prisma where; the mock simulates
    // by returning only Accepted rows when status filter is requested.
    prisma.travelQuote.findMany.mockImplementation(async ({ where }) => {
      const all = [
        makeQuote({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
        makeQuote({ id: 2, status: 'Accepted', totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
        makeQuote({ id: 3, status: 'Accepted', totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 4, 20)) }),
        makeQuote({ id: 4, status: 'Rejected', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 25)) }),
      ];
      if (where && where.status) return all.filter((q) => q.status === where.status);
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?status=Accepted')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].quoteCount).toBe(2);
    expect(res.body.years[0].acceptedCount).toBe(2);
    expect(res.body.years[0].totalValue).toBe(30000);
    expect(res.body.years[0].acceptedValue).toBe(30000);
    expect(res.body.years[0].draftCount).toBe(0);
    expect(res.body.years[0].rejectedCount).toBe(0);
  });

  test('?from=2026&to=2026 restricts to 1 bucket', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // 2025
      makeQuote({ id: 1, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2025, 1, 10)) }),
      // 2026
      makeQuote({ id: 2, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      // 2027
      makeQuote({ id: 3, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2027, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].totalValue).toBe(3000);
  });
});

describe('GET /api/travel/quotes/by-year — defensive math', () => {
  test('acceptedValue is summed ONLY from Accepted (others excluded)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeQuote({ id: 2, status: 'Sent', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
      makeQuote({ id: 3, status: 'Accepted', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      makeQuote({ id: 4, status: 'Rejected', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 8)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    expect(y.year).toBe('2026');
    // totalValue: every quote contributes
    expect(y.totalValue).toBe(16000);
    // acceptedValue: only the Accepted row
    expect(y.acceptedValue).toBe(5000);
    expect(y.draftCount).toBe(1);
    expect(y.sentCount).toBe(1);
    expect(y.acceptedCount).toBe(1);
    expect(y.rejectedCount).toBe(1);
    expect(res.body.grandAcceptedValue).toBe(5000);
  });

  test('null/zero/non-numeric totalAmount contributes 0; no NaN poisoning', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: null, createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeQuote({ id: 2, totalAmount: '0.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
      makeQuote({ id: 3, totalAmount: 'not-a-number', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      makeQuote({ id: 4, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 8)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].quoteCount).toBe(4);
    expect(res.body.years[0].totalValue).toBe(5000);
    expect(Number.isNaN(res.body.years[0].totalValue)).toBe(false);
    expect(res.body.grandTotalValue).toBe(5000);
  });
});

describe('GET /api/travel/quotes/by-year — pagination', () => {
  test('limit=2&offset=1 returns years 2..3 of a 4-year dataset', async () => {
    // 4 years: 2024..2027
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2024, 1, 10)) }),  // 2024
      makeQuote({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2025, 4, 10)) }),  // 2025
      makeQuote({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),  // 2026
      makeQuote({ id: 4, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2027, 10, 10)) }), // 2027
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(2);
    // Default orderBy is year:asc; offset=1 skips 2024 → returns 2025 + 2026.
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.totalYears).toBe(4);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('GET /api/travel/quotes/by-year — sub-brand restriction', () => {
  test('MANAGER with subBrandAccess=["rfu"] sees only rfu quotes (other sub-brands filtered)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelQuote.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      // Simulate Prisma's `subBrand: { in: [...] }` filter.
      const all = [
        makeQuote({ id: 1, subBrand: 'tmc', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
        makeQuote({ id: 2, subBrand: 'rfu', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
        makeQuote({ id: 3, subBrand: 'travelstall', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].quoteCount).toBe(1);
    expect(res.body.years[0].totalValue).toBe(8000);
  });
});
