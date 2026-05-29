// @ts-check
/**
 * #900 slices 16 / 17 / 18 — Quote rollup endpoints (by-month / by-quarter / by-year).
 *
 * Pins three sibling tenant-wide rollup endpoints on
 * backend/routes/travel_quotes.js:
 *   GET /api/travel/quotes/by-month   (line 632)
 *   GET /api/travel/quotes/by-quarter (line 890)
 *   GET /api/travel/quotes/by-year    (line 1148)
 *
 * Distinct from the other travel-quotes-*.test.js files in
 * backend/test/routes/:
 *   - travel-quotes-accept-decline.test.js   — POST /:id/accept|decline
 *   - travel-quotes-analytics.test.js        — GET /quotes/analytics (line 489)
 *   - travel-quotes-audit-trail.test.js      — GET /:id/audit-trail
 *   - travel-quotes-bulk-decline-expired.test.js — POST /bulk-decline-expired
 *   - travel-quotes-convert-to-invoice.test.js — POST /:id/convert-to-invoice
 *   - travel-quotes-duplicate-pdf.test.js    — POST /:id/duplicate + GET /:id/pdf
 *   - travel-quotes-expiry.test.js           — validUntil expiry semantics
 *
 * This file covers the three orthogonal analytic rollup contracts that
 * none of those files touch. Pattern mirrors travel-itineraries-rollups.test.js
 * (the most-recent rollup test that landed; see commit 23f7a923).
 *
 * Contracts asserted (numbered):
 *   1. Happy path: 4 quotes bucketed correctly per resolution
 *      (YYYY-MM / YYYY-Qn / YYYY) with quoteCount + totalValue + the
 *      4-status split counts (draftCount / sentCount / acceptedCount /
 *      rejectedCount) + acceptedValue per row. The status enum on
 *      TravelQuote is the 4-state {Draft, Sent, Accepted, Rejected} per
 *      schema.prisma:4913 — NOT the 7-state itinerary enum.
 *   2. Tenant-isolation: requireTravelTenant gate uses req.user.tenantId
 *      to resolve req.travelTenant, so where.tenantId matches the JWT's
 *      tenantId — NOT a body-supplied tenantId (stripDangerous removes
 *      body.tenantId globally).
 *   3. Non-travel tenant → 403 WRONG_VERTICAL.
 *   4. Unauthenticated → 401 (verifyToken).
 *   5. Empty result set → returns empty bucket array with zeroed grand
 *      totals (NOT null/undefined).
 *   6. Sub-brand allow-set empty (subBrandAccess=[]) → all-zeros envelope
 *      (NOT 403) so dashboard tiles render cleanly for not-yet-onboarded
 *      operators. See route comments at travel_quotes.js:678-696 /
 *      937-955 / 1194-1212. #976 resolved 2026-05-26 — the
 *      getSubBrandAccessSet helper now returns `new Set()` for explicit
 *      "[]" input so this short-circuit is reachable.
 *   7. ?from / ?to format validation:
 *      - by-month: INVALID_MONTH_FORMAT on bad YYYY-MM token.
 *      - by-quarter: INVALID_QUARTER_FORMAT on bad YYYY-Qn token.
 *      - by-year: INVALID_YEAR_FORMAT on non-4-digit token.
 *      Good tokens bound the bucket array.
 *   8. acceptedValue rolls up ONLY across status='Accepted' rows per
 *      PRD §3 (terminal-positive). TravelQuote has no advance_paid /
 *      fully_paid statuses — those belong to TravelInvoice downstream.
 *   9. MANAGER with subBrandAccess=['tmc'] threads { in: ['tmc'] } into
 *      where.subBrand. Quote.subBrand is non-nullable (schema.prisma:4911)
 *      so no NULL-OR clause is needed (unlike nullable-subBrand routes).
 *
 * Mocking strategy: Prisma-singleton-patch BEFORE requiring the router
 * (mirrors travel-quotes-analytics.test.js + travel-itineraries-rollups
 * .test.js). Bare express + supertest + real HS256 JWTs against the dev
 * fallback secret. verifyToken + requireTravelTenant +
 * getSubBrandAccessSet all execute for real — no middleware mocks.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = prisma.travelQuoteLine || {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoice = prisma.travelInvoice || {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.travelMarkupRule = prisma.travelMarkupRule || {
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.$transaction = prisma.$transaction || vi.fn(async (cb) => cb(prisma));
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

// 4 quotes spanning May (3) + June (1) of 2026 with a deliberate status
// mix so per-bucket 4-status splits + acceptedValue summation can be
// asserted at multiple resolutions from one base fixture.
//
//   2026-05: 3 rows — 1 Draft, 1 Accepted (1000), 1 Sent (500)
//   2026-06: 1 row  — Rejected (2000)
// Grand totals: quoteCount=4, totalValue=3500, acceptedValue=1000
// (only the single Accepted row contributes to acceptedValue per
// route comments at travel_quotes.js:754-757).
const baseRows = [
  { id: 1, subBrand: 'tmc', status: 'Draft',    totalAmount: 0,    createdAt: new Date('2026-05-03T08:00:00Z') },
  { id: 2, subBrand: 'tmc', status: 'Accepted', totalAmount: 1000, createdAt: new Date('2026-05-17T10:30:00Z') },
  { id: 3, subBrand: 'rfu', status: 'Sent',     totalAmount: 500,  createdAt: new Date('2026-05-28T18:45:00Z') },
  { id: 4, subBrand: 'rfu', status: 'Rejected', totalAmount: 2000, createdAt: new Date('2026-06-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.travelQuote.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── GET /api/travel/quotes/by-month ─────────────────────────────────────

describe('GET /api/travel/quotes/by-month (slice 16)', () => {
  test('happy path: 4 quotes across 2 months → 2 rows month:asc with 4-status split', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(3500);
    // Only the single Accepted row (1000) contributes to acceptedValue.
    expect(res.body.grandAcceptedValue).toBe(1000);
    expect(res.body.months).toHaveLength(2);

    const may = res.body.months[0];
    expect(may).toMatchObject({
      month: '2026-05',
      quoteCount: 3,
      totalValue: 1500,
      draftCount: 1,
      acceptedCount: 1,
      sentCount: 1,
      rejectedCount: 0,
      acceptedValue: 1000,
    });

    const jun = res.body.months[1];
    expect(jun).toMatchObject({
      month: '2026-06',
      quoteCount: 1,
      totalValue: 2000,
      draftCount: 0,
      sentCount: 0,
      acceptedCount: 0,
      rejectedCount: 1,
      acceptedValue: 0,
    });

    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('tenant-isolation: where.tenantId pins to req.travelTenant.id (from JWT, not body)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 42, vertical: 'travel', name: 'Other Tenant', slug: 'other',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER', { userId: 7, tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(42);
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month');

    expect(res.status).toBe(401);
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('empty quote set → empty months[] + zero grand totals (not null)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandQuoteCount).toBe(0);
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandAcceptedValue).toBe(0);
  });

  test('sub-brand allow-set empty → all-zeros rollup (NOT 403) — #976 short-circuit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify([]),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandQuoteCount).toBe(0);
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandAcceptedValue).toBe(0);
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?from token (month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('?from=2026-05&to=2026-05 narrows months[] to single bucket', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandQuoteCount).toBe(3);
    expect(res.body.grandAcceptedValue).toBe(1000);
  });

  test('MANAGER subBrandAccess=[tmc] threads { in: [tmc] } into where (Quote.subBrand non-nullable → no NULL OR-clause)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelQuote.findMany.mockResolvedValue([baseRows[0]]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['tmc'] });
    expect(call.where.OR).toBeUndefined();
  });
});

// ─── GET /api/travel/quotes/by-quarter ───────────────────────────────────

describe('GET /api/travel/quotes/by-quarter (slice 17)', () => {
  test('happy path: 4 quotes → bucketed YYYY-Qn (May+Jun both Q2 → 1 row)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // All 4 rows fall in 2026-Q2 (months 5+6 → quarter 2).
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      quoteCount: 4,
      totalValue: 3500,
      draftCount: 1,
      sentCount: 1,
      acceptedCount: 1,
      rejectedCount: 1,
      acceptedValue: 1000,
    });
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(3500);
    expect(res.body.grandAcceptedValue).toBe(1000);
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('tenant-isolation: where.tenantId pins to req.travelTenant.id', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 99, vertical: 'travel', name: 'Other', slug: 'other',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER', { userId: 7, tenantId: 99 })}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(99);
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'w',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter');

    expect(res.status).toBe(401);
  });

  test('empty quote set → empty quarters[] + zero grand totals', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toEqual([]);
    expect(res.body.totalQuarters).toBe(0);
    expect(res.body.grandQuoteCount).toBe(0);
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandAcceptedValue).toBe(0);
  });

  test('sub-brand allow-set empty → all-zeros rollup (NOT 403) — #976 short-circuit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify([]),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toEqual([]);
    expect(res.body.totalQuarters).toBe(0);
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (Q5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('cross-quarter spread: row in Q1 + Q2 → 2 buckets', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 10, subBrand: 'tmc', status: 'Accepted', totalAmount: 100, createdAt: new Date('2026-02-15T08:00:00Z') },
      { id: 11, subBrand: 'tmc', status: 'Accepted', totalAmount: 200, createdAt: new Date('2026-05-15T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2026-Q1', '2026-Q2']);
    expect(res.body.quarters[0].acceptedValue).toBe(100);
    expect(res.body.quarters[1].acceptedValue).toBe(200);
    expect(res.body.grandAcceptedValue).toBe(300);
  });
});

// ─── GET /api/travel/quotes/by-year ──────────────────────────────────────

describe('GET /api/travel/quotes/by-year (slice 18)', () => {
  test('happy path: 4 quotes all in 2026 → single year bucket', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      quoteCount: 4,
      totalValue: 3500,
      draftCount: 1,
      sentCount: 1,
      acceptedCount: 1,
      rejectedCount: 1,
      acceptedValue: 1000,
    });
    expect(res.body.grandQuoteCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(3500);
    expect(res.body.grandAcceptedValue).toBe(1000);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('tenant-isolation: where.tenantId pins to req.travelTenant.id', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 77, vertical: 'travel', name: 'Other', slug: 'other',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER', { userId: 7, tenantId: 77 })}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(77);
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic', slug: 'g',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
  });

  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year');

    expect(res.status).toBe(401);
  });

  test('empty quote set → empty years[] + zero grand totals', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([]);
    expect(res.body.totalYears).toBe(0);
    expect(res.body.grandQuoteCount).toBe(0);
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandAcceptedValue).toBe(0);
  });

  test('sub-brand allow-set empty → all-zeros rollup (NOT 403) — #976 short-circuit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify([]),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([]);
    expect(res.body.totalYears).toBe(0);
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?from token (3 digits)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?from=202')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('multi-year spread: 2025 + 2026 → 2 buckets year:asc', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 20, subBrand: 'tmc', status: 'Accepted', totalAmount: 50,  createdAt: new Date('2025-11-15T08:00:00Z') },
      { id: 21, subBrand: 'tmc', status: 'Accepted', totalAmount: 150, createdAt: new Date('2026-03-15T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026']);
    expect(res.body.years[0].acceptedValue).toBe(50);
    expect(res.body.years[1].acceptedValue).toBe(150);
    expect(res.body.grandAcceptedValue).toBe(200);
  });

  test('?from=2026&to=2026 narrows years[] to single bucket', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 30, subBrand: 'tmc', status: 'Accepted', totalAmount: 10, createdAt: new Date('2024-06-01T08:00:00Z') },
      { id: 31, subBrand: 'tmc', status: 'Accepted', totalAmount: 20, createdAt: new Date('2026-06-01T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandAcceptedValue).toBe(20);
  });
});
