// @ts-check
/**
 * #907 slice 17 — GET /api/travel/itineraries/by-quarter tenant-wide quarterly rollup.
 *
 * Pins the read-only aggregator added to backend/routes/travel_itineraries.js:
 *
 *   GET /api/travel/itineraries/by-quarter     any verified token
 *
 * Mirrors slice 16 by-month at quarter resolution. One row per UTC
 * YYYY-Qn bucket with count + per-status splits + totalValue +
 * acceptedValue, plus grand totals for the page header.
 *
 * Calendar quarter mapping (0-indexed UTC month → quarter):
 *   Q1: Jan–Mar (months 0..2)
 *   Q2: Apr–Jun (months 3..5)
 *   Q3: Jul–Sep (months 6..8)
 *   Q4: Oct–Dec (months 9..11)
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_QUARTER_FORMAT for ?from / ?to that don't match YYYY-Qn
 *     (regex /^\d{4}-Q[1-4]$/) — rejects "2026-Q5", "2026-05", "2026".
 *   - 400 INVALID_STATUS when ?status= is not in VALID_STATUSES.
 *   - Happy path: 6 itineraries spanning 2 quarters (Q1 + Q2 2026)
 *     collapse to 2 rows with correct per-quarter counts/splits.
 *   - orderBy=totalValue:desc returns quarters in descending value order.
 *   - ?status=accepted narrows the aggregation to accepted rows only.
 *   - ?from=YYYY-Qn & ?to=YYYY-Qn narrows the bucket set inclusively
 *     to a single-quarter window.
 *   - acceptedValue sums totalAmount across {accepted, advance_paid,
 *     fully_paid} but NOT draft/sent/revised/rejected.
 *   - Null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning).
 *   - Pagination ?limit / ?offset returns a paged window; grand totals
 *     reflect the full aggregation.
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     where.subBrand = { in: ['rfu'] } into the Prisma call (Itinerary
 *     .subBrand is non-nullable — NO NULL OR-clause).
 *   - 401 on missing Authorization header (verifyToken gate).
 *   - Unknown orderBy token degrades silently to quarter:asc default.
 *   - NO audit row written by this read-only endpoint.
 *   - Quarter-edge math: month=2 (March) → Q1, month=3 (April) → Q2,
 *     month=11 (December) → Q4.
 *
 * Pattern mirrors travel-itinerary-by-month.test.js — CJS prisma
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

// Spread of 6 itineraries across Q1 + Q2 2026, mixed status + values.
//   2026-Q1 (Jan–Mar): 3 itineraries (draft Feb 100, accepted Feb 5000, sent Mar 200)
//   2026-Q2 (Apr–Jun): 3 itineraries (revised Apr 700, advance_paid May 3000, rejected Jun 400)
//   totalValue: Q1=5300, Q2=4100 — grand 9400
//   acceptedValue: Q1=5000 (accepted), Q2=3000 (advance_paid) — grand 8000
const baseRows = [
  { id: 1, status: 'draft',        totalAmount: '100.00',  createdAt: new Date('2026-02-02T08:00:00Z') },
  { id: 2, status: 'accepted',     totalAmount: '5000.00', createdAt: new Date('2026-02-15T10:30:00Z') },
  { id: 3, status: 'sent',         totalAmount: '200.00',  createdAt: new Date('2026-03-28T18:45:00Z') },
  { id: 4, status: 'revised',      totalAmount: '700.00',  createdAt: new Date('2026-04-10T08:00:00Z') },
  { id: 5, status: 'advance_paid', totalAmount: '3000.00', createdAt: new Date('2026-05-04T09:00:00Z') },
  { id: 6, status: 'rejected',     totalAmount: '400.00',  createdAt: new Date('2026-06-20T12:00:00Z') },
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

describe('GET /api/travel/itineraries/by-quarter (slice 17) — validation', () => {
  test('400 INVALID_QUARTER_FORMAT on out-of-range ?from token (Q5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on month-shaped ?to token (2026-05)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_QUARTER_FORMAT on year-only ?from token ("2026")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?from=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_STATUS when ?status= is not in VALID_STATUSES', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });
});

describe('GET /api/travel/itineraries/by-quarter (slice 17) — happy path + envelope', () => {
  test('happy path: 6 itineraries across 2 quarters → 2 rows quarter:asc with correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(6);
    expect(res.body.grandTotalValue).toBe(9400);
    expect(res.body.grandAcceptedValue).toBe(8000); // 5000 (accepted Q1) + 3000 (advance_paid Q2)
    expect(res.body.quarters).toHaveLength(2);

    // 2026-Q1: 3 itineraries (draft, accepted, sent) — totalValue 5300, acceptedValue 5000
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q1',
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
    // 2026-Q2: 3 itineraries (revised, advance_paid, rejected) — totalValue 4100, acceptedValue 3000
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q2',
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
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('acceptedValue sums {accepted, advance_paid, fully_paid} but NOT draft/sent/revised/rejected', async () => {
    // 7 itineraries in the same quarter (Q3 2026 = Jul–Sep), one per status.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 10, status: 'accepted',     totalAmount: '1000.00', createdAt: new Date('2026-07-01T00:00:00Z') },
      { id: 11, status: 'advance_paid', totalAmount: '2000.00', createdAt: new Date('2026-07-02T00:00:00Z') },
      { id: 12, status: 'fully_paid',   totalAmount: '3000.00', createdAt: new Date('2026-08-03T00:00:00Z') },
      { id: 13, status: 'rejected',     totalAmount: '9999.00', createdAt: new Date('2026-08-04T00:00:00Z') },
      { id: 14, status: 'draft',        totalAmount: '8888.00', createdAt: new Date('2026-09-05T00:00:00Z') },
      { id: 15, status: 'sent',         totalAmount: '7777.00', createdAt: new Date('2026-09-06T00:00:00Z') },
      { id: 16, status: 'revised',      totalAmount: '6666.00', createdAt: new Date('2026-09-07T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    const q3 = res.body.quarters[0];
    expect(q3.quarter).toBe('2026-Q3');
    expect(q3.count).toBe(7);
    expect(q3.totalValue).toBe(1000 + 2000 + 3000 + 9999 + 8888 + 7777 + 6666);
    // acceptedValue = accepted + advance_paid + fully_paid ONLY = 6000
    expect(q3.acceptedValue).toBe(6000);
    expect(res.body.grandAcceptedValue).toBe(6000);
  });

  test('quarter-edge math: month=2 (March) → Q1; month=3 (April) → Q2; month=11 (December) → Q4', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      // 2026-03-31 = month index 2 → Q1
      { id: 50, status: 'draft', totalAmount: '100.00', createdAt: new Date('2026-03-31T23:59:59Z') },
      // 2026-04-01 = month index 3 → Q2
      { id: 51, status: 'draft', totalAmount: '200.00', createdAt: new Date('2026-04-01T00:00:00Z') },
      // 2026-12-31 = month index 11 → Q4
      { id: 52, status: 'draft', totalAmount: '300.00', createdAt: new Date('2026-12-31T23:59:59Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(3);
    const labels = res.body.quarters.map((r) => r.quarter);
    expect(labels).toEqual(['2026-Q1', '2026-Q2', '2026-Q4']);
  });
});

describe('GET /api/travel/itineraries/by-quarter (slice 17) — sort + filter', () => {
  test('orderBy=totalValue:desc puts the higher-value quarter first', async () => {
    // Flip the fixture so Q2 has a much larger value than Q1.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'draft',    totalAmount: '100.00',   createdAt: new Date('2026-02-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: '50000.00', createdAt: new Date('2026-05-15T10:30:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?orderBy=totalValue:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[0].totalValue).toBe(50000);
    expect(res.body.quarters[1].quarter).toBe('2026-Q1');
    expect(res.body.quarters[1].totalValue).toBe(100);
  });

  test('?status=accepted narrows the aggregation (verify where.status threaded into Prisma)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?status=accepted')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('accepted');
    expect(call.where.tenantId).toBe(1);
  });

  test('?from=2026-Q1&to=2026-Q1 narrows the bucket array to a single-quarter window', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?from=2026-Q1&to=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q1');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandTotalValue).toBe(5300);
    expect(res.body.grandAcceptedValue).toBe(5000);
  });
});

describe('GET /api/travel/itineraries/by-quarter (slice 17) — defensive math + envelope', () => {
  test('null/zero/non-numeric totalAmount contributes 0 (no NaN poisoning)', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'accepted', totalAmount: null,         createdAt: new Date('2026-02-02T08:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: 'not-a-num',  createdAt: new Date('2026-02-15T10:30:00Z') },
      { id: 3, status: 'accepted', totalAmount: '500.00',     createdAt: new Date('2026-03-28T18:45:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].count).toBe(3);
    expect(res.body.quarters[0].acceptedCount).toBe(3);
    expect(res.body.quarters[0].totalValue).toBe(500);
    expect(res.body.quarters[0].acceptedValue).toBe(500);
    expect(res.body.grandTotalValue).toBe(500);
    expect(res.body.grandAcceptedValue).toBe(500);
    // Confirm no NaN snuck into any numeric envelope field
    for (const k of ['count', 'totalValue', 'acceptedValue', 'draftCount', 'acceptedCount']) {
      expect(Number.isNaN(res.body.quarters[0][k])).toBe(false);
    }
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable grand totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Grand totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(6);
    expect(res.body.grandTotalValue).toBe(9400);
    expect(res.body.grandAcceptedValue).toBe(8000);
    expect(res.body.quarters).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q2.
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('?limit=999 clamps to max 40', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(40);
  });
});

describe('GET /api/travel/itineraries/by-quarter (slice 17) — sub-brand + auth', () => {
  test('MANAGER subBrandAccess=[rfu] threads where.subBrand = { in: [rfu] } into Prisma', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 99, status: 'accepted', totalAmount: '1000.00', createdAt: new Date('2026-02-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
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
      .get('/api/travel/itineraries/by-quarter');

    expect(res.status).toBe(401);
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('unknown orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q1');
    expect(res.body.quarters[1].quarter).toBe('2026-Q2');
  });
});
