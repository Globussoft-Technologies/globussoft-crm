// @ts-check
/**
 * #900 slice 17 — GET /api/travel/quotes/by-quarter tenant-wide quarterly rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/by-quarter     any verified token
 *
 * Mirrors slice 16's by-month spec exactly, swapping the YYYY-MM bucket
 * for YYYY-Qn (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec — calendar
 * quarters, not Indian-FY). Same defensive math, same orderBy semantics,
 * same sub-brand narrowing.
 *
 * Contracts asserted:
 *   - 400 INVALID_QUARTER_FORMAT for ?from / ?to that don't match YYYY-Qn
 *     (regex /^\d{4}-Q[1-4]$/) — rejects "2026-Q5", "2026Q1", "2026-Q",
 *     "2026".
 *   - Bucketing by UTC year + quarter — 4 quotes spanning 2 quarters
 *     collapse to 2 rows with correct per-quarter counts + sums.
 *   - orderBy=totalValue:desc returns quarters in descending value order;
 *     unknown orderBy tokens degrade silently to quarter:asc default.
 *   - ?status=Accepted restricts the entire aggregation to Accepted rows
 *     (other statuses excluded from quoteCount + sums).
 *   - ?from=2026-Q1&?to=2026-Q1 narrows the bucket set inclusively.
 *   - acceptedValue is summed ONLY from Accepted rows (Draft/Sent/Rejected
 *     contribute to totalValue but NOT to acceptedValue).
 *   - Null/zero/non-numeric totalAmount contributes 0; no NaN poisoning.
 *   - Pagination: ?limit=2&offset=1 returns quarters 2..3 of a 4-quarter
 *     dataset.
 *   - Sub-brand restriction: MANAGER with subBrandAccess=['rfu'] sees
 *     only rfu quotes — Prisma where.subBrand uses `{ in: ['rfu'] }` so
 *     non-rfu quotes never reach the aggregator.
 *   - 401 on missing token.
 *
 * Pattern mirrors travel-quote-by-month.test.js — CJS prisma singleton
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
    createdAt: new Date(Date.UTC(2026, 4, 15)), // 2026-Q2
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

describe('GET /api/travel/quotes/by-quarter — validation', () => {
  test('rejects ?from=2026-Q5 with 400 INVALID_QUARTER_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('rejects ?from=2026Q1 (missing hyphen) with 400 INVALID_QUARTER_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?from=2026Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('rejects ?to=2026-Q (no quarter digit) with 400 INVALID_QUARTER_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?to=2026-Q')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('rejects ?from=2026 (year only) with 400 INVALID_QUARTER_FORMAT', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?from=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/by-quarter — happy path bucketing', () => {
  test('4 quotes across 2 quarters → 2 quarter rows with correct counts + sums', async () => {
    // 2 in Q2-2026 (Apr+May: 15000 + 25000 = 40000),
    // 2 in Q3-2026 (Jul+Sep: 10000 + 20000 = 30000)
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '15000.00', createdAt: new Date(Date.UTC(2026, 3, 5)) }),  // Apr → Q2
      makeQuote({ id: 2, totalAmount: '25000.00', createdAt: new Date(Date.UTC(2026, 4, 20)) }), // May → Q2
      makeQuote({ id: 3, totalAmount: '10000.00', createdAt: new Date(Date.UTC(2026, 6, 2)) }),  // Jul → Q3
      makeQuote({ id: 4, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 8, 28)) }), // Sep → Q3
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(2);
    // Default orderBy is quarter:asc.
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[0].quoteCount).toBe(2);
    expect(res.body.quarters[0].totalValue).toBe(40000);
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
    expect(res.body.quarters[1].quoteCount).toBe(2);
    expect(res.body.quarters[1].totalValue).toBe(30000);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(70000);
  });
});

describe('GET /api/travel/quotes/by-quarter — sort + filter', () => {
  test('orderBy=totalValue:desc returns quarters in descending value order', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // Q1: 5000 (low) — Feb
      makeQuote({ id: 1, totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 1, 10)) }),
      // Q2: 50000 (highest) — May
      makeQuote({ id: 2, totalAmount: '50000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      // Q3: 20000 (mid) — Aug
      makeQuote({ id: 3, totalAmount: '20000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2026-Q2', '2026-Q3', '2026-Q1']);
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
      .get('/api/travel/quotes/by-quarter?status=Accepted')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[0].quoteCount).toBe(2);
    expect(res.body.quarters[0].acceptedCount).toBe(2);
    expect(res.body.quarters[0].totalValue).toBe(30000);
    expect(res.body.quarters[0].acceptedValue).toBe(30000);
    expect(res.body.quarters[0].draftCount).toBe(0);
    expect(res.body.quarters[0].rejectedCount).toBe(0);
  });

  test('?from=2026-Q1&to=2026-Q1 restricts to 1 bucket', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // Q1 (Feb)
      makeQuote({ id: 1, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 1, 10)) }),
      // Q2 (May)
      makeQuote({ id: 2, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),
      // Q3 (Aug)
      makeQuote({ id: 3, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?from=2026-Q1&to=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q1');
    expect(res.body.quarters[0].totalValue).toBe(2000);
  });
});

describe('GET /api/travel/quotes/by-quarter — defensive math', () => {
  test('acceptedValue is summed ONLY from Accepted (others excluded)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Draft', totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 4, 5)) }),
      makeQuote({ id: 2, status: 'Sent', totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 6)) }),
      makeQuote({ id: 3, status: 'Accepted', totalAmount: '5000.00', createdAt: new Date(Date.UTC(2026, 4, 7)) }),
      makeQuote({ id: 4, status: 'Rejected', totalAmount: '8000.00', createdAt: new Date(Date.UTC(2026, 4, 8)) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    const q = res.body.quarters[0];
    expect(q.quarter).toBe('2026-Q2');
    // totalValue: every quote contributes
    expect(q.totalValue).toBe(16000);
    // acceptedValue: only the Accepted row
    expect(q.acceptedValue).toBe(5000);
    expect(q.draftCount).toBe(1);
    expect(q.sentCount).toBe(1);
    expect(q.acceptedCount).toBe(1);
    expect(q.rejectedCount).toBe(1);
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
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quoteCount).toBe(4);
    expect(res.body.quarters[0].totalValue).toBe(5000);
    expect(Number.isNaN(res.body.quarters[0].totalValue)).toBe(false);
    expect(res.body.grandTotalValue).toBe(5000);
  });
});

describe('GET /api/travel/quotes/by-quarter — pagination', () => {
  test('limit=2&offset=1 returns quarters 2..3 of a 4-quarter dataset', async () => {
    // 4 quarters: Q1..Q4 2026
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, totalAmount: '1000.00', createdAt: new Date(Date.UTC(2026, 1, 10)) }),  // Feb → Q1
      makeQuote({ id: 2, totalAmount: '2000.00', createdAt: new Date(Date.UTC(2026, 4, 10)) }),  // May → Q2
      makeQuote({ id: 3, totalAmount: '3000.00', createdAt: new Date(Date.UTC(2026, 7, 10)) }),  // Aug → Q3
      makeQuote({ id: 4, totalAmount: '4000.00', createdAt: new Date(Date.UTC(2026, 10, 10)) }), // Nov → Q4
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(2);
    // Default orderBy is quarter:asc; offset=1 skips Q1 → returns Q2 + Q3.
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
    expect(res.body.totalQuarters).toBe(4);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('GET /api/travel/quotes/by-quarter — sub-brand restriction', () => {
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
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quoteCount).toBe(1);
    expect(res.body.quarters[0].totalValue).toBe(8000);
  });
});
