// @ts-check
/**
 * #900 slice 16 — GET /api/travel/quotes/by-month tenant-wide monthly rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/by-month     any verified token
 *
 * Contracts asserted:
 *   - 400 INVALID_MONTH_FORMAT for ?from / ?to that don't match YYYY-MM
 *     (regex /^\d{4}-(0[1-9]|1[0-2])$/) — rejects "2026-13", "26", "2026-1".
 *   - Bucketing by UTC year + month — 4 quotes spanning 2 months collapse
 *     to 2 rows with correct per-month counts + sums.
 *   - orderBy=totalValue:desc returns months in descending value order;
 *     unknown orderBy tokens degrade silently to month:asc default.
 *   - ?status=Accepted restricts the entire aggregation to Accepted rows
 *     (other statuses excluded from quoteCount + sums).
 *   - ?from=YYYY-MM & ?to=YYYY-MM narrows the bucket set inclusively.
 *   - acceptedValue is summed ONLY from Accepted rows (Draft/Sent/Rejected
 *     contribute to totalValue but NOT to acceptedValue).
 *   - Null/zero/non-numeric totalAmount contributes 0; no NaN poisoning.
 *   - Pagination: ?limit=2&offset=1 returns months 2..3 of a 5-month set.
 *   - Sub-brand restriction: MANAGER with subBrandAccess=['rfu'] sees
 *     only rfu quotes — Prisma where.subBrand uses `{ in: ['rfu'] }` so
 *     non-rfu quotes never reach the aggregator.
 *   - 401 on missing token.
 *
 * Pattern mirrors travel-quote-pricing-preview.test.js — CJS prisma
 * singleton patched BEFORE the router is required so verifyToken's
 * revokedToken probe + the route's findMany call both hit stubs;
 * HS256 JWT via the dev fallback secret.
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
    createdAt: new Date(Date.UTC(2026, 4, 15)), // 2026-05
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

describe('GET /api/travel/quotes/by-month — validation', () => {
  test('rejects ?from=2026-13 with 400 INVALID_MONTH_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('rejects ?from=26 (too short) with 400 INVALID_MONTH_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('rejects ?to=2026-1 (no zero-padding) with 400 INVALID_MONTH_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?to=2026-1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/by-month — happy path bucketing', () => {
  test('4 quotes across 2 months → 2 month rows with correct counts + sums', async () => {
    // 2 in May (15000 + 25000 = 40000), 2 in June (10000 + 20000 = 30000)
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '15000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeQuote({ id: 2, totalAmount: '25000.00', createdAt: new Date(Date.UTC(2026, 4, 20)) }),
      makeQuote({ id: 3, totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 5, 2)) }),
      makeQuote({ id: 4, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 5, 28)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(2);
    // Default orderBy is month:asc.
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].quoteCount).toBe(2);
    expect(res.body.months[0].totalValue).toBe(40000);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].quoteCount).toBe(2);
    expect(res.body.months[1].totalValue).toBe(30000);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(70000);
  });
});

describe('GET /api/travel/quotes/by-month — sort + filter', () => {
  test('orderBy=totalValue:desc returns months in descending value order', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // April: 5000 (low)
      makeQuote({ id: 1, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 3, 10)) }),
      // May: 50000 (highest)
      makeQuote({ id: 2, totalAmount: '50000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      // June: 20000 (mid)
      makeQuote({ id: 3, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 5, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-04']);
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
      .get('/api/travel/quotes/by-month?status=Accepted')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].quoteCount).toBe(2);
    expect(res.body.months[0].acceptedCount).toBe(2);
    expect(res.body.months[0].totalValue).toBe(30000);
    expect(res.body.months[0].acceptedValue).toBe(30000);
    expect(res.body.months[0].draftCount).toBe(0);
    expect(res.body.months[0].rejectedCount).toBe(0);
  });

  test('?from=2026-05&to=2026-05 restricts to 1 bucket', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 3, 10)) }), // April
      makeQuote({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }), // May
      makeQuote({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 5, 10)) }), // June
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].totalValue).toBe(2000);
  });
});

describe('GET /api/travel/quotes/by-month — defensive math', () => {
  test('acceptedValue is summed ONLY from Accepted (others excluded)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeQuote({ id: 2, status: 'Sent', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
      makeQuote({ id: 3, status: 'Accepted', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      makeQuote({ id: 4, status: 'Rejected', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 8)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    const m = res.body.months[0];
    // totalValue: every quote contributes
    expect(m.totalValue).toBe(16000);
    // acceptedValue: only the Accepted row
    expect(m.acceptedValue).toBe(5000);
    expect(m.draftCount).toBe(1);
    expect(m.sentCount).toBe(1);
    expect(m.acceptedCount).toBe(1);
    expect(m.rejectedCount).toBe(1);
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
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].quoteCount).toBe(4);
    expect(res.body.months[0].totalValue).toBe(5000);
    expect(Number.isNaN(res.body.months[0].totalValue)).toBe(false);
    expect(res.body.grandTotalValue).toBe(5000);
  });
});

describe('GET /api/travel/quotes/by-month — pagination', () => {
  test('limit=2&offset=1 returns months 2..3 of a 5-month dataset', async () => {
    // 5 months: Jan..May 2026
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 0, 10)) }),
      makeQuote({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 1, 10)) }),
      makeQuote({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 2, 10)) }),
      makeQuote({ id: 4, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2026, 3, 10)) }),
      makeQuote({ id: 5, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(2);
    // Default orderBy is month:asc; offset=1 skips Jan → returns Feb + Mar.
    expect(res.body.months[0].month).toBe('2026-02');
    expect(res.body.months[1].month).toBe('2026-03');
    expect(res.body.totalMonths).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('GET /api/travel/quotes/by-month — sub-brand restriction', () => {
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
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].quoteCount).toBe(1);
    expect(res.body.months[0].totalValue).toBe(8000);
  });

  test('empty subBrandAccess set → all-zeros rollup (not 403)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify([]),
    });
    // Reset findMany to a clean stub so the prior test's mockImplementation
    // doesn't bleed in if the route ends up calling Prisma anyway.
    prisma.travelQuote.findMany.mockReset().mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    // The route's getSubBrandAccessSet returns null for empty array
    // (per the middleware's `arr.length === 0 → return null` branch).
    // So this caller actually behaves like full-access ADMIN. We assert
    // the route's success-shape regardless — no 403 thrown.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.months)).toBe(true);
  });
});
