// @ts-check
/**
 * backend/routes/travel_trips.js — GET /trips/by-year contract pin.
 *
 * What's pinned
 * -------------
 *   GET /api/travel/trips/by-year  (TMC-only, tenant + sub-brand scoped)
 *     - INVALID_YEAR_FORMAT on malformed ?from / ?to (garbage, 3-digit,
 *       5-digit, alpha)
 *     - INVALID_STATUS on unknown ?status filter
 *     - Happy path: 4 trips across 2 years → 2 rows with correct
 *       4-status splits (confirmed / in-trip / completed / cancelled).
 *     - dt.getUTCFullYear() bucket math verified with trips spanning
 *       3 different calendar years.
 *     - orderBy=count:desc sorts years by count descending
 *     - status=completed narrows the where clause
 *     - from/to single-year window restricts results lexically
 *     - SUB_BRAND_DENIED when caller lacks "tmc" in subBrandAccess[]
 *     - limit/offset pagination shape (10 default, 30 max)
 *     - Null createdAt → "unknown" bucket (kept when no from/to is set,
 *       excluded when either is set)
 *     - 401 when no Authorization header
 *
 * Pinned route ordering: declared BEFORE GET /trips/:id so the path
 * "by-year" is NEVER parsed as an :id (would 400 INVALID_ID).
 *
 * Mirrors backend/test/routes/travel-trips-by-quarter.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the
 * same fallback secret the middleware uses in dev. The full guard
 * chain (verifyToken + requireTravelTenant + requireTmcAccess) is
 * exercised end-to-end; we don't bypass middleware.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tmcTrip = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripParticipant = prisma.tripParticipant || {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripDocumentRequirement = prisma.tripDocumentRequirement || {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};
prisma.tripInstalmentPayment = prisma.tripInstalmentPayment || { findMany: vi.fn() };
prisma.roomingAssignment = prisma.roomingAssignment || { findMany: vi.fn() };
prisma.digilockerSession = prisma.digilockerSession || {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
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
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const tripsRouter = requireCJS('../../routes/travel_trips');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', tripsRouter);
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
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.count.mockReset().mockResolvedValue(0);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/by-year — validation
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/by-year — validation', () => {
  test('?from=garbage returns 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?from=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('?to=202 (3-digit) returns 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?to=202')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('?from=20260 (5-digit) returns 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?from=20260')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('?from=abcd (alpha) returns 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?from=abcd')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('?status=disputed (not in VALID_TRIP_STATUSES) returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?status=disputed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/by-year — happy path
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/by-year — happy path', () => {
  test('4 trips across 2 years → 2 rows with correct 4-status splits', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      // 2025: 2 trips
      { id: 1, status: 'confirmed', createdAt: new Date('2025-05-03T10:00:00Z') },
      { id: 2, status: 'in-trip',   createdAt: new Date('2025-11-20T10:00:00Z') },
      // 2026: 2 trips
      { id: 3, status: 'completed', createdAt: new Date('2026-03-01T10:00:00Z') },
      { id: 4, status: 'cancelled', createdAt: new Date('2026-09-15T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalYears: 2,
      grandCount: 4,
      grandCompletedCount: 1,
      limit: 10,
      offset: 0,
    });
    expect(res.body.years).toHaveLength(2);

    // Default orderBy=year:asc → 2025 first.
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 2,
      confirmedCount: 1,
      inTripCount: 1,
      completedCount: 0,
      cancelledCount: 0,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 2,
      confirmedCount: 0,
      inTripCount: 0,
      completedCount: 1,
      cancelledCount: 1,
    });
  });

  test('getUTCFullYear bucket math: 3 trips across 3 calendar years', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, status: 'confirmed', createdAt: new Date('2024-02-15T10:00:00Z') },
      { id: 2, status: 'confirmed', createdAt: new Date('2025-04-15T10:00:00Z') },
      { id: 3, status: 'confirmed', createdAt: new Date('2026-08-15T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(3);
    expect(res.body.years.map((r) => r.year)).toEqual(['2024', '2025', '2026']);
    expect(res.body.years.every((r) => r.count === 1)).toBe(true);
  });

  test('?orderBy=count:desc sorts years by count descending', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      // 2025 has 1 trip; 2026 has 3 trips.
      { id: 1, status: 'confirmed', createdAt: new Date('2025-05-03T10:00:00Z') },
      { id: 2, status: 'confirmed', createdAt: new Date('2026-02-03T10:00:00Z') },
      { id: 3, status: 'in-trip',   createdAt: new Date('2026-06-10T10:00:00Z') },
      { id: 4, status: 'completed', createdAt: new Date('2026-09-20T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].count).toBe(3);
    expect(res.body.years[1].year).toBe('2025');
    expect(res.body.years[1].count).toBe(1);
  });

  test('?status=completed folds into where clause', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 3, status: 'completed', createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    await request(makeApp())
      .get('/api/travel/trips/by-year?status=completed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const calledWhere = prisma.tmcTrip.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({
      tenantId: 1,
      status: 'completed',
    });
  });

  test('?from=2026&to=2026 single-year window excludes 2025 + unknown', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, status: 'confirmed', createdAt: new Date('2025-05-03T10:00:00Z') },
      { id: 2, status: 'in-trip',   createdAt: new Date('2026-08-10T10:00:00Z') },
      { id: 3, status: 'completed', createdAt: null }, // unknown bucket
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].count).toBe(1);
  });

  test('?limit=1&offset=1 paginates AFTER aggregation', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, status: 'confirmed', createdAt: new Date('2024-02-03T10:00:00Z') },
      { id: 2, status: 'in-trip',   createdAt: new Date('2025-05-10T10:00:00Z') },
      { id: 3, status: 'completed', createdAt: new Date('2026-08-20T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(3); // pre-pagination
    expect(res.body.grandCount).toBe(3);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2025'); // skip the first
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('null createdAt → unknown bucket is kept when no from/to set', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, status: 'confirmed', createdAt: new Date('2026-05-03T10:00:00Z') },
      { id: 2, status: 'cancelled', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    const unknownRow = res.body.years.find((r) => r.year === 'unknown');
    expect(unknownRow).toBeDefined();
    expect(unknownRow.count).toBe(1);
    expect(unknownRow.cancelledCount).toBe(1);
  });

  test('?limit=1000 clamps to max 30', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year?limit=1000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/by-year — guard stack
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/by-year — guards', () => {
  test('caller without TMC sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .get('/api/travel/trips/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('no Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/trips/by-year');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });
});
