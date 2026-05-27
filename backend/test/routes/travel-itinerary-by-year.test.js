// @ts-check
/**
 * #907 slice 18 — GET /api/travel/itineraries/by-year tenant-wide annual rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_itineraries.js:
 *
 *   GET /api/travel/itineraries/by-year     any verified token
 *
 * Mirrors slices 16/17 (by-month, by-quarter) at year resolution.
 * One row per UTC YYYY bucket with count + per-status splits +
 * totalValue + acceptedValue, plus grand totals for the page header.
 * Completes the by-month/by-quarter/by-year triplet (slices 16/17/18).
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_YEAR_FORMAT for ?from / ?to that don't match YYYY
 *     (regex /^\d{4}$/) — rejects "2026-Q1", "2026-05", "26", "20260".
 *   - 400 INVALID_STATUS when ?status= is not in VALID_STATUSES.
 *   - Happy path: 6 itineraries spanning 2 years (2025 + 2026) collapse
 *     to 2 rows with correct per-year counts/splits.
 *   - orderBy=totalValue:desc returns years in descending value order.
 *   - ?status=accepted narrows the aggregation to accepted rows only.
 *   - ?from=YYYY & ?to=YYYY narrows the bucket set inclusively to a
 *     single-year window.
 *   - acceptedValue sums totalAmount across {accepted, advance_paid,
 *     fully_paid} but NOT draft/sent/revised/rejected.
 *   - Null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning).
 *   - Pagination ?limit / ?offset returns a paged window; grand totals
 *     reflect the full aggregation.
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     where.subBrand = { in: ['rfu'] } into the Prisma call (Itinerary
 *     .subBrand is non-nullable — NO NULL OR-clause).
 *   - 401 on missing Authorization header (verifyToken gate).
 *   - Unknown orderBy token degrades silently to year:asc default.
 *   - NO audit row written by this read-only endpoint.
 *   - Year-edge math: 2025-12-31T23:59:59Z → "2025"; 2026-01-01T00:00:00Z
 *     → "2026" (UTC boundary).
 *
 * Pattern mirrors travel-itinerary-by-quarter.test.js — CJS prisma
 * singleton patched BEFORE the router is required so verifyToken's
 * revokedToken probe + the route's findMany call both hit stubs;
 * HS256 JWT via the dev fallback secret. verifyToken +
 * requireTravelTenant + getSubBrandAccessSet all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = vi.fn();
prisma.itinerary.findFirst = prisma.itinerary.findFirst || vi.fn();
prisma.itinerary.count = prisma.itinerary.count || vi.fn();
prisma.itinerary.create = prisma.itinerary.create || vi.fn();
prisma.itinerary.update = prisma.itinerary.update || vi.fn();
prisma.itinerary.delete = prisma.itinerary.delete || vi.fn();
prisma.itineraryItem = prisma.itineraryItem || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
};
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
  findMany: vi.fn().mockResolvedValue([]),
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
const itineraryRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', itineraryRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of 6 itineraries across 2025 + 2026, mixed status + values.
//   2025: 3 itineraries (draft Feb 100, accepted Aug 5000, sent Dec 200)
//   2026: 3 itineraries (revised Mar 700, advance_paid Jun 3000, rejected Sep 400)
//   totalValue: 2025=5300, 2026=4100 — grand 9400
//   acceptedValue: 2025=5000 (accepted), 2026=3000 (advance_paid) — grand 8000
const baseRows = [
  { id: 1, status: 'draft',        totalAmount: '100.00',  createdAt: new Date('2025-02-02T08:00:00Z') },
  { id: 2, status: 'accepted',     totalAmount: '5000.00', createdAt: new Date('2025-08-15T10:30:00Z') },
  { id: 3, status: 'sent',         totalAmount: '200.00',  createdAt: new Date('2025-12-28T18:45:00Z') },
  { id: 4, status: 'revised',      totalAmount: '700.00',  createdAt: new Date('2026-03-10T08:00:00Z') },
  { id: 5, status: 'advance_paid', totalAmount: '3000.00', createdAt: new Date('2026-06-04T09:00:00Z') },
  { id: 6, status: 'rejected',     totalAmount: '400.00',  createdAt: new Date('2026-09-20T12:00:00Z') },
];

beforeEach(() => {
  prisma.itinerary.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/by-year (slice 18) — validation', () => {
  test('400 INVALID_YEAR_FORMAT on quarter-shaped ?from token (2026-Q1)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on month-shaped ?to token (2026-05)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on 2-digit ?from token ("26")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on 5-digit ?to token ("20260")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?to=20260')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_STATUS when ?status= is not in VALID_STATUSES', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });
});

describe('GET /api/travel/itineraries/by-year (slice 18) — happy path + envelope', () => {
  test('happy path: 6 itineraries across 2 years → 2 rows year:asc with correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(6);
    expect(res.body.grandTotalValue).toBe(9400);
    expect(res.body.grandAcceptedValue).toBe(8000); // 5000 (accepted 2025) + 3000 (advance_paid 2026)
    expect(res.body.years).toHaveLength(2);

    // 2025: 3 itineraries (draft, accepted, sent) — totalValue 5300, acceptedValue 5000
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 3,
      draftCount: 1,
      sentCount: 1,
      revisedCount: 0,
      acceptedCount: 1,
      rejectedCount: 0,
      advancePaidCount: 0,
      fullyPaidCount: 0,
      totalValue: 5300,
      acceptedValue: 5000,
    });
    // 2026: 3 itineraries (revised, advance_paid, rejected) — totalValue 4100, acceptedValue 3000
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 3,
      draftCount: 0,
      sentCount: 0,
      revisedCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      advancePaidCount: 1,
      fullyPaidCount: 0,
      totalValue: 4100,
      acceptedValue: 3000,
    });
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('acceptedValue sums {accepted, advance_paid, fully_paid} but NOT draft/sent/revised/rejected', async () => {
    // 7 itineraries in the same year (2027), one per status.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 10, status: 'accepted',     totalAmount: '1000.00', createdAt: new Date('2027-01-01T00:00:00Z') },
      { id: 11, status: 'advance_paid', totalAmount: '2000.00', createdAt: new Date('2027-03-02T00:00:00Z') },
      { id: 12, status: 'fully_paid',   totalAmount: '3000.00', createdAt: new Date('2027-05-03T00:00:00Z') },
      { id: 13, status: 'rejected',     totalAmount: '9999.00', createdAt: new Date('2027-07-04T00:00:00Z') },
      { id: 14, status: 'draft',        totalAmount: '8888.00', createdAt: new Date('2027-09-05T00:00:00Z') },
      { id: 15, status: 'sent',         totalAmount: '7777.00', createdAt: new Date('2027-10-06T00:00:00Z') },
      { id: 16, status: 'revised',      totalAmount: '6666.00', createdAt: new Date('2027-12-07T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    expect(y.year).toBe('2027');
    expect(y.count).toBe(7);
    expect(y.totalValue).toBe(1000 + 2000 + 3000 + 9999 + 8888 + 7777 + 6666);
    // acceptedValue = accepted + advance_paid + fully_paid ONLY = 6000
    expect(y.acceptedValue).toBe(6000);
    expect(res.body.grandAcceptedValue).toBe(6000);
  });

  test('year-edge math: 2025-12-31T23:59:59Z → "2025"; 2026-01-01T00:00:00Z → "2026"', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      // last instant of 2025 UTC
      { id: 50, status: 'draft', totalAmount: '100.00', createdAt: new Date('2025-12-31T23:59:59Z') },
      // first instant of 2026 UTC
      { id: 51, status: 'draft', totalAmount: '200.00', createdAt: new Date('2026-01-01T00:00:00Z') },
      // middle of 2027
      { id: 52, status: 'draft', totalAmount: '300.00', createdAt: new Date('2027-06-15T12:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(3);
    const labels = res.body.years.map((r) => r.year);
    expect(labels).toEqual(['2025', '2026', '2027']);
  });
});

describe('GET /api/travel/itineraries/by-year (slice 18) — sort + filter', () => {
  test('orderBy=totalValue:desc puts the higher-value year first', async () => {
    // Flip so 2026 has a much larger value than 2025.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'draft',    totalAmount: '100.00',   createdAt: new Date('2025-02-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: '50000.00', createdAt: new Date('2026-05-15T10:30:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].totalValue).toBe(50000);
    expect(res.body.years[1].year).toBe('2025');
    expect(res.body.years[1].totalValue).toBe(100);
  });

  test('?status=accepted narrows the aggregation (verify where.status threaded into Prisma)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?status=accepted')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('accepted');
    expect(call.where.tenantId).toBe(1);
  });

  test('?from=2025&to=2025 narrows the bucket array to a single-year window', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?from=2025&to=2025')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].count).toBe(3);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandTotalValue).toBe(5300);
    expect(res.body.grandAcceptedValue).toBe(5000);
  });
});

describe('GET /api/travel/itineraries/by-year (slice 18) — defensive math + envelope', () => {
  test('null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning)', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'accepted', totalAmount: null,        createdAt: new Date('2026-02-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: 'not-a-num', createdAt: new Date('2026-05-15T10:30:00Z') },
      { id: 3, status: 'accepted', totalAmount: '500.00',    createdAt: new Date('2026-09-28T18:45:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].count).toBe(3);
    expect(res.body.years[0].acceptedCount).toBe(3);
    expect(res.body.years[0].totalValue).toBe(500);
    expect(res.body.years[0].acceptedValue).toBe(500);
    expect(res.body.grandTotalValue).toBe(500);
    expect(res.body.grandAcceptedValue).toBe(500);
    // Confirm no NaN snuck into any numeric envelope field
    for (const k of ['count', 'totalValue', 'acceptedValue', 'draftCount', 'acceptedCount']) {
      expect(Number.isNaN(res.body.years[0][k])).toBe(false);
    }
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable grand totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Grand totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(6);
    expect(res.body.grandTotalValue).toBe(9400);
    expect(res.body.grandAcceptedValue).toBe(8000);
    expect(res.body.years).toHaveLength(1);
    // Default order is year:asc → offset=1 returns 2026.
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('?limit=999 clamps to max 30', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });
});

describe('GET /api/travel/itineraries/by-year (slice 18) — sub-brand + auth', () => {
  test('MANAGER subBrandAccess=[rfu] threads where.subBrand = { in: [rfu] } into Prisma', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 99, status: 'accepted', totalAmount: '1000.00', createdAt: new Date('2026-02-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // Verify the where carried the sub-brand narrowing. Itinerary.subBrand
    // is non-nullable, so the narrowing is { in: ['rfu'] } — NOT an OR
    // clause with a NULL fallback.
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year');

    expect(res.status).toBe(401);
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('unknown orderBy token degrades silently to year:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-year?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });
});
