// @ts-check
/**
 * #907 slice 16 — GET /api/travel/itineraries/by-month tenant-wide monthly rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_itineraries.js:
 *
 *   GET /api/travel/itineraries/by-month     any verified token
 *
 * Mirrors #900 slice 16 (/quotes/by-month) + #901 slice 29
 * (/invoices/by-month) + #908 slice 21 (/flyer-templates/by-month).
 * One row per UTC YYYY-MM bucket with count + per-status splits +
 * totalValue + acceptedValue, plus grand totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_MONTH_FORMAT for ?from / ?to that don't match YYYY-MM
 *     (regex /^\d{4}-(0[1-9]|1[0-2])$/) — rejects "2026-13", "26", "20260501".
 *   - Happy path: 5 itineraries spanning 2 months collapse to 2 rows
 *     with correct per-month counts and per-status splits.
 *   - orderBy=totalValue:desc returns months in descending value order.
 *   - ?status=accepted narrows the aggregation to accepted rows only.
 *   - ?from=YYYY-MM & ?to=YYYY-MM narrows the bucket set inclusively
 *     to a single-month window.
 *   - acceptedValue sums totalAmount across {accepted, advance_paid,
 *     fully_paid} but NOT draft/sent/revised/rejected.
 *   - Null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning).
 *   - Pagination ?limit / ?offset returns a paged window; grand totals
 *     reflect the full aggregation.
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     where.subBrand = { in: ['rfu'] } into the Prisma call (mirrors
 *     the existing list endpoint — NO NULL OR-clause, since Itinerary
 *     .subBrand is non-nullable).
 *   - 401 on missing Authorization header (verifyToken gate).
 *
 * Pattern mirrors travel-quote-by-month.test.js — CJS prisma singleton
 * patched BEFORE the router is required so verifyToken's revokedToken
 * probe + the route's findMany call both hit stubs; HS256 JWT via the
 * dev fallback secret. verifyToken + requireTravelTenant +
 * getSubBrandAccessSet all run for real.
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

// Spread of 5 itineraries across May + June 2026, mixed status + values.
//   2026-05: 3 itineraries (draft 100, accepted 5000, sent 200)
//   2026-06: 2 itineraries (advance_paid 3000, rejected 400)
//   totalValue: 5300 (May), 3400 (Jun) — grand 8700
//   acceptedValue: 5000 (May, just the accepted one), 3000 (Jun, advance_paid) — grand 8000
const baseRows = [
  { id: 1, status: 'draft',        totalAmount: '100.00',  createdAt: new Date('2026-05-02T08:00:00Z') },
  { id: 2, status: 'accepted',     totalAmount: '5000.00', createdAt: new Date('2026-05-15T10:30:00Z') },
  { id: 3, status: 'sent',         totalAmount: '200.00',  createdAt: new Date('2026-05-28T18:45:00Z') },
  { id: 4, status: 'advance_paid', totalAmount: '3000.00', createdAt: new Date('2026-06-04T09:00:00Z') },
  { id: 5, status: 'rejected',     totalAmount: '400.00',  createdAt: new Date('2026-06-20T12:00:00Z') },
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

describe('GET /api/travel/itineraries/by-month (slice 16) — validation', () => {
  test('400 INVALID_MONTH_FORMAT on out-of-range ?from token (month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on malformed ?to token (date-shaped 20260501)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('400 INVALID_MONTH_FORMAT on year-only ?from token ("2026")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?from=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('400 INVALID_STATUS when ?status= is not in VALID_STATUSES', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });
});

describe('GET /api/travel/itineraries/by-month (slice 16) — happy path + envelope', () => {
  test('happy path: 5 itineraries across 2 months → 2 rows month:asc with correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(5);
    expect(res.body.grandTotalValue).toBe(8700);
    expect(res.body.grandAcceptedValue).toBe(8000); // 5000 (accepted) + 3000 (advance_paid)
    expect(res.body.months).toHaveLength(2);

    // 2026-05: 3 itineraries (draft, accepted, sent) — totalValue 5300, acceptedValue 5000
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
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
    // 2026-06: 2 itineraries (advance_paid, rejected) — totalValue 3400, acceptedValue 3000
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      count: 2,
      draftCount: 0,
      sentCount: 0,
      revisedCount: 0,
      acceptedCount: 0,
      rejectedCount: 1,
      advancePaidCount: 1,
      fullyPaidCount: 0,
      totalValue: 3400,
      acceptedValue: 3000,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('acceptedValue sums {accepted, advance_paid, fully_paid} but NOT draft/sent/revised/rejected', async () => {
    // 4 itineraries in the same month, one for each "agreement-secured"
    // status + one rejected control to prove it's excluded.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 10, status: 'accepted',     totalAmount: '1000.00', createdAt: new Date('2026-07-01T00:00:00Z') },
      { id: 11, status: 'advance_paid', totalAmount: '2000.00', createdAt: new Date('2026-07-02T00:00:00Z') },
      { id: 12, status: 'fully_paid',   totalAmount: '3000.00', createdAt: new Date('2026-07-03T00:00:00Z') },
      { id: 13, status: 'rejected',     totalAmount: '9999.00', createdAt: new Date('2026-07-04T00:00:00Z') },
      { id: 14, status: 'draft',        totalAmount: '8888.00', createdAt: new Date('2026-07-05T00:00:00Z') },
      { id: 15, status: 'sent',         totalAmount: '7777.00', createdAt: new Date('2026-07-06T00:00:00Z') },
      { id: 16, status: 'revised',      totalAmount: '6666.00', createdAt: new Date('2026-07-07T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    const jul = res.body.months[0];
    expect(jul.month).toBe('2026-07');
    expect(jul.count).toBe(7);
    // totalValue = sum of all 7
    expect(jul.totalValue).toBe(1000 + 2000 + 3000 + 9999 + 8888 + 7777 + 6666);
    // acceptedValue = accepted + advance_paid + fully_paid ONLY = 6000
    expect(jul.acceptedValue).toBe(6000);
    expect(res.body.grandAcceptedValue).toBe(6000);
  });
});

describe('GET /api/travel/itineraries/by-month (slice 16) — sort + filter', () => {
  test('orderBy=totalValue:desc puts the higher-value month first', async () => {
    // May totalValue=5300 > June totalValue=3400 — desc keeps May first
    // (it's already first chronologically too), so use a flipped fixture
    // where June is the higher-value month.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'draft',    totalAmount: '100.00',  createdAt: new Date('2026-05-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: '50000.00', createdAt: new Date('2026-06-15T10:30:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.months[0].totalValue).toBe(50000);
    expect(res.body.months[1].month).toBe('2026-05');
    expect(res.body.months[1].totalValue).toBe(100);
  });

  test('?status=accepted narrows the aggregation to accepted rows only', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?status=accepted')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Verify the where.status was threaded through
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('accepted');
    expect(call.where.tenantId).toBe(1);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single-month window', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandTotalValue).toBe(5300);
    expect(res.body.grandAcceptedValue).toBe(5000);
  });
});

describe('GET /api/travel/itineraries/by-month (slice 16) — defensive math + envelope', () => {
  test('null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning)', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'accepted', totalAmount: null,         createdAt: new Date('2026-05-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: 'not-a-num',  createdAt: new Date('2026-05-15T10:30:00Z') },
      { id: 3, status: 'accepted', totalAmount: '500.00',     createdAt: new Date('2026-05-28T18:45:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].count).toBe(3);
    expect(res.body.months[0].acceptedCount).toBe(3);
    // Only the 500.00 row contributes
    expect(res.body.months[0].totalValue).toBe(500);
    expect(res.body.months[0].acceptedValue).toBe(500);
    expect(res.body.grandTotalValue).toBe(500);
    expect(res.body.grandAcceptedValue).toBe(500);
    // Confirm no NaN snuck into any numeric envelope field
    for (const k of ['count', 'totalValue', 'acceptedValue', 'draftCount', 'acceptedCount']) {
      expect(Number.isNaN(res.body.months[0][k])).toBe(false);
    }
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable grand totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Grand totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(5);
    expect(res.body.grandTotalValue).toBe(8700);
    expect(res.body.grandAcceptedValue).toBe(8000);
    expect(res.body.months).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });
});

describe('GET /api/travel/itineraries/by-month (slice 16) — sub-brand + auth', () => {
  test('MANAGER subBrandAccess=[rfu] threads where.subBrand = { in: [rfu] } into Prisma', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 99, status: 'accepted', totalAmount: '1000.00', createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // Verify the where carried the sub-brand narrowing. Itinerary.subBrand
    // is non-nullable, so the narrowing is { in: ['rfu'] } — NOT an OR
    // clause with a NULL fallback (unlike flyer-templates).
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month');

    expect(res.status).toBe(401);
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('unknown orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-month?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[1].month).toBe('2026-06');
  });
});
