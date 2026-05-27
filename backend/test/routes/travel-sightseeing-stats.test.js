// @ts-check
/**
 * #907 rollup-family completion — GET /api/travel/sightseeing/stats.
 *
 * Pins the contract for the tenant-wide aggregate handler on
 * backend/routes/travel_sightseeing.js (declared BEFORE GET /:id, so
 * Express doesn't try to parse "stats" as a numeric :id and 400).
 *
 * Why distinct from the existing travel-sightseeing.test.js
 * ---------------------------------------------------------
 * The sibling test file covers list + CRUD (POST / GET / PATCH / DELETE).
 * The /stats endpoint (this file) is the canonical tenant-wide aggregate
 * envelope — separate concern, separate test scaffolding.
 *
 * TravelSightseeing has no status enum; the envelope groups by category
 * + isActive instead, and adds a topDestinations[] slice for the operator
 * dashboard.
 *
 * Contracts asserted (≥10 cases)
 * ------------------------------
 *   1. ADMIN + mixed-category → byCategory + activeCount aggregates correct
 *   2. Empty result → zeroed envelope shape
 *   3. ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}
 *   4. ?from=garbage → 400 INVALID_DATE
 *   5. ?to=garbage   → 400 INVALID_DATE
 *   6. Non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   7. Unauthenticated → 401
 *   8. Sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)
 *   9. Sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *  10. Tenant isolation — token tenantId=A → where.tenantId=A
 *  11. round2 math on grandPriceReferenceValue
 *  12. topDestinations counts + sorted desc (capped at 5)
 *
 * Mocking strategy
 * ----------------
 * Patch prisma singleton with vi.fn() shapes BEFORE requiring the router
 * (CJS require — module cache is pinned by the patch). Real verifyToken
 * + requireTravelTenant middleware runs. Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set). HS256 JWTs signed with the
 * dev fallback secret = "enterprise_super_secret_key_2026".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSightseeing = prisma.travelSightseeing || {};
prisma.travelSightseeing.findMany = vi.fn();
prisma.travelSightseeing.findFirst = prisma.travelSightseeing.findFirst || vi.fn();
prisma.travelSightseeing.count = prisma.travelSightseeing.count || vi.fn();
prisma.travelSightseeing.create = prisma.travelSightseeing.create || vi.fn();
prisma.travelSightseeing.update = prisma.travelSightseeing.update || vi.fn();
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
const travelSightseeingRouter = requireCJS('../../routes/travel_sightseeing');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/sightseeing', travelSightseeingRouter);
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
  prisma.travelSightseeing.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/sightseeing/stats', () => {
  test('case 1: ADMIN + mixed-category → byCategory + activeCount aggregates correctly', async () => {
    // 3 monument (2 active + 1 inactive), 2 museum (active), 1 nature (active)
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, destinationName: 'Paris',    subBrand: 'tmc',         category: 'monument', isActive: true,  durationMinutes: 120, priceReferenceMinor: 5000,  updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 2, destinationName: 'Paris',    subBrand: 'tmc',         category: 'monument', isActive: true,  durationMinutes: 60,  priceReferenceMinor: 2500,  updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 3, destinationName: 'Rome',     subBrand: 'rfu',         category: 'monument', isActive: false, durationMinutes: 90,  priceReferenceMinor: 3000,  updatedAt: new Date('2026-04-05T00:00:00Z') },
      { id: 4, destinationName: 'London',   subBrand: 'rfu',         category: 'museum',   isActive: true,  durationMinutes: 180, priceReferenceMinor: 4000,  updatedAt: new Date('2026-04-06T00:00:00Z') },
      { id: 5, destinationName: 'London',   subBrand: 'travelstall', category: 'museum',   isActive: true,  durationMinutes: 240, priceReferenceMinor: 6000,  updatedAt: new Date('2026-04-10T00:00:00Z') },
      { id: 6, destinationName: 'Bali',     subBrand: 'visasure',    category: 'nature',   isActive: true,  durationMinutes: 300, priceReferenceMinor: 1500,  updatedAt: new Date('2026-04-20T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.activeCount).toBe(5);
    expect(res.body.inactiveCount).toBe(1);
    expect(res.body.byCategory).toEqual({
      monument: 3,
      museum: 2,
      nature: 1,
    });
    expect(res.body.bySubBrand).toEqual({
      tmc:         { count: 2 },
      rfu:         { count: 2 },
      travelstall: { count: 1 },
      visasure:    { count: 1 },
    });
    // grandPriceReferenceValue = 5000+2500+3000+4000+6000+1500 = 22000
    expect(res.body.grandPriceReferenceValue).toBe(22000);
    // averageDurationMinutes = (120+60+90+180+240+300)/6 = 990/6 = 165
    expect(res.body.averageDurationMinutes).toBe(165);
    // topDestinations: London=2, Paris=2, Rome=1, Bali=1 (sorted desc by count)
    expect(res.body.topDestinations).toHaveLength(4);
    expect(res.body.topDestinations[0].count).toBe(2);
    expect(res.body.topDestinations[1].count).toBe(2);
    expect(res.body.topDestinations[2].count).toBe(1);
    expect(res.body.topDestinations[3].count).toBe(1);
    // lastUpdatedAt = max updatedAt (id=6, 2026-04-20)
    expect(res.body.lastUpdatedAt).toBe(new Date('2026-04-20T00:00:00Z').toISOString());
  });

  test('case 2: empty result → zeroed envelope shape', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      activeCount: 0,
      inactiveCount: 0,
      byCategory: {},
      bySubBrand: {},
      grandPriceReferenceValue: 0,
      averageDurationMinutes: null,
      topDestinations: [],
      lastUpdatedAt: null,
    });
  });

  test('case 3: ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([]);

    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    const res = await request(makeApp())
      .get(`/api/travel/sightseeing/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(new Date(from).toISOString());
    expect(call.where.createdAt.lte.toISOString()).toBe(new Date(to).toISOString());
  });

  test('case 4: ?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats?from=not-a-date-at-all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 6: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 7: unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/sightseeing/stats');
    expect(res.status).toBe(401);
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)', async () => {
    // MANAGER role + subBrandAccess JSON with only-invalid brands → after
    // the VALID_SUB_BRANDS filter the Set is empty → route short-circuits
    // to the zeroed envelope BEFORE the findMany call.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.activeCount).toBe(0);
    expect(res.body.inactiveCount).toBe(0);
    expect(res.body.byCategory).toEqual({});
    expect(res.body.averageDurationMinutes).toBeNull();
    expect(res.body.topDestinations).toEqual([]);
    // No findMany call — empty-set short-circuit fires BEFORE prisma.
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 9: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 11, destinationName: 'Rome', subBrand: 'rfu', category: 'monument', isActive: true, durationMinutes: 90, priceReferenceMinor: 3000, updatedAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.byCategory).toEqual({ monument: 1 });
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });
  });

  test('case 10: tenant isolation — token tenantId=A → where.tenantId=A', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 101, destinationName: 'Goa', subBrand: 'tmc', category: 'nature', isActive: true, durationMinutes: 240, priceReferenceMinor: 2000, updatedAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.grandPriceReferenceValue).toBe(2000);
    expect(res.body.averageDurationMinutes).toBe(240);
  });

  test('case 11: round2 math — priceReferenceMinor sums round half-up at 2dp', async () => {
    // 3 rows with .005 fractional minor units to exercise the half-up
    // rounding path (yes, minor units should be integers — but the
    // contract still has to round defensively in case a future caller
    // stores a fractional value).
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 91, destinationName: 'X', subBrand: 'tmc', category: 'a', isActive: true, durationMinutes: 3.005, priceReferenceMinor: 9.005,  updatedAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.grandPriceReferenceValue).toBe(9.01);
    // averageDurationMinutes — single row → equal to that row's duration,
    // rounded.
    expect(res.body.averageDurationMinutes).toBe(3.01);
  });

  test('case 12: topDestinations counts + sorted desc (capped at 5)', async () => {
    // 7 distinct destinations with varying frequencies → top 5 by count
    // sorted desc, last 2 dropped.
    const rows = [];
    // Tokyo × 5, Paris × 4, London × 3, Rome × 2, Bali × 2, NYC × 1, Cairo × 1
    const spec = [
      ['Tokyo',  5],
      ['Paris',  4],
      ['London', 3],
      ['Rome',   2],
      ['Bali',   2],
      ['NYC',    1],
      ['Cairo',  1],
    ];
    let id = 0;
    for (const [dest, n] of spec) {
      for (let i = 0; i < n; i++) {
        id += 1;
        rows.push({
          id,
          destinationName: dest,
          subBrand: null,
          category: 'monument',
          isActive: true,
          durationMinutes: 60,
          priceReferenceMinor: 1000,
          updatedAt: new Date('2026-04-01T00:00:00Z'),
        });
      }
    }
    prisma.travelSightseeing.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(18); // 5+4+3+2+2+1+1
    // Cap at 5.
    expect(res.body.topDestinations).toHaveLength(5);
    // Sorted desc — Tokyo first with count=5, then Paris 4, London 3, then
    // 2-count rows (Rome + Bali in some order — tie-break not specified by
    // contract).
    expect(res.body.topDestinations[0]).toEqual({ destinationName: 'Tokyo', count: 5 });
    expect(res.body.topDestinations[1]).toEqual({ destinationName: 'Paris', count: 4 });
    expect(res.body.topDestinations[2]).toEqual({ destinationName: 'London', count: 3 });
    // Counts must be monotonically non-increasing across the slice.
    for (let i = 1; i < res.body.topDestinations.length; i++) {
      expect(res.body.topDestinations[i].count).toBeLessThanOrEqual(res.body.topDestinations[i - 1].count);
    }
    // bySubBrand: all null → "_tenant" key.
    expect(res.body.bySubBrand).toEqual({ _tenant: { count: 18 } });
  });

  test('case 13: rows with null category roll into "_uncategorized" bucket', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 200, destinationName: 'X', subBrand: 'tmc', category: null, isActive: true,  durationMinutes: 60, priceReferenceMinor: 500, updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 201, destinationName: 'Y', subBrand: 'tmc', category: null, isActive: false, durationMinutes: 30, priceReferenceMinor: 250, updatedAt: new Date('2026-04-02T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byCategory).toEqual({ _uncategorized: 2 });
    expect(res.body.activeCount).toBe(1);
    expect(res.body.inactiveCount).toBe(1);
  });
});
