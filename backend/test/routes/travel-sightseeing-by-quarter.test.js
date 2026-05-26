// @ts-check
/**
 * #907 rollup-family — GET /api/travel/sightseeing/by-quarter.
 *
 * Pins the contract for the quarterly rollup handler on
 * backend/routes/travel_sightseeing.js (declared BEFORE GET /:id so
 * Express doesn't parse "by-quarter" as a numeric :id and 400).
 *
 * Completes the sightseeing rollup triplet — /by-year shipped at 327c0693,
 * /by-month at 9d406d55, this /by-quarter slice. Mirrors travel_invoices
 * /invoices/by-quarter envelope shape but adapted to TravelSightseeing —
 * no status enum, so the envelope drops per-status sub-counts and tracks
 * only count + totalPriceReferenceValue per YYYY-Q[1-4] bucket.
 *
 * Why distinct from travel-sightseeing-by-{year,month}.test.js
 * ------------------------------------------------------------
 * /by-year buckets by UTC year (YYYY); /by-month by UTC YYYY-MM. This file
 * ONLY covers /by-quarter — UTC YYYY-Q[1-4] bucketing, INVALID_QUARTER_FORMAT
 * regex validation, and a Q1↔Q2 cross-boundary fixture that the other two
 * rollups can't surface (year-aggregate hides intra-year drift; month-aggregate
 * doesn't bucket Q1+Q2 together). No case here duplicates any case there.
 *
 * Contracts asserted (≥8 cases — actual 11)
 * -----------------------------------------
 *   1. happy path — items across Q1/Q2/Q3/Q4 → 4 YYYY-Q[1-4] buckets
 *   2. empty result → empty quarters[] + zeroed grand-totals
 *   3. non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   4. unauthenticated → 401 via verifyToken
 *   5. ?from=YYYY-Q1 + ?to=YYYY-Q4 narrows applied to buckets
 *   6. ?from=garbage → 400 INVALID_QUARTER_FORMAT
 *   7. ?to=2026-Q5 → 400 INVALID_QUARTER_FORMAT (only Q1-Q4 valid)
 *   8. sub-brand allow-set EMPTY → zeroed envelope (per #976 fix —
 *      handler short-circuits BEFORE findMany)
 *   9. tenant-isolation — token tenantId=A → findMany where.tenantId=A
 *   10. round2 math — priceReferenceMinor=9.005 → 9.01 (half-up at 2dp)
 *   11. Q1↔Q2 boundary fixture — createdAt 2026-03-31 (Q1) vs 2026-04-01
 *       (Q2) bucket separately (catches off-by-one in month-to-quarter
 *       derivation)
 *
 * Mocking strategy
 * ----------------
 * Patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router (CJS require — module-cache pinned by the patch). Real
 * verifyToken + requireTravelTenant middleware runs. Real
 * getSubBrandAccessSet runs (user.findUnique controls the access set).
 * HS256 JWTs signed with the dev fallback secret =
 * "enterprise_super_secret_key_2026". Mirrors
 * travel-sightseeing-by-month.test.js exactly.
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

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/sightseeing/by-quarter
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/sightseeing/by-quarter', () => {
  test('case 1: happy path — items across Q1/Q2/Q3/Q4 → 4 YYYY-Q[1-4] buckets', async () => {
    // Q1=Feb (50), Q2=May (100+200), Q3=Aug (400), Q4=Nov (10).
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, priceReferenceMinor: 50,  createdAt: new Date('2026-02-15T08:00:00Z') },
      { id: 2, priceReferenceMinor: 100, createdAt: new Date('2026-05-10T10:30:00Z') },
      { id: 3, priceReferenceMinor: 200, createdAt: new Date('2026-05-22T09:00:00Z') },
      { id: 4, priceReferenceMinor: 400, createdAt: new Date('2026-08-01T12:00:00Z') },
      { id: 5, priceReferenceMinor: 10,  createdAt: new Date('2026-11-15T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(4);
    expect(res.body.grandCount).toBe(5);
    // grandTotalValue = 50 + 100 + 200 + 400 + 10 = 760
    expect(res.body.grandTotalValue).toBe(760);
    expect(res.body.quarters).toHaveLength(4);
    // Default orderBy is quarter:asc → 2026-Q1, 2026-Q2, 2026-Q3, 2026-Q4.
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q1',
      count: 1,
      totalPriceReferenceValue: 50,
    });
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      totalPriceReferenceValue: 300,
    });
    expect(res.body.quarters[2]).toMatchObject({
      quarter: '2026-Q3',
      count: 1,
      totalPriceReferenceValue: 400,
    });
    expect(res.body.quarters[3]).toMatchObject({
      quarter: '2026-Q4',
      count: 1,
      totalPriceReferenceValue: 10,
    });
    // Default limit/offset per route: limit=8 (Math.min(8, 40)), offset=0.
    expect(res.body.limit).toBe(8);
    expect(res.body.offset).toBe(0);
  });

  test('case 2: empty result — returns empty quarters[] + zeroed grand-totals', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      quarters: [],
      totalQuarters: 0,
      grandCount: 0,
      grandTotalValue: 0,
    });
  });

  test('case 3: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 4: unauthenticated → 401 via verifyToken', async () => {
    const res = await request(makeApp()).get('/api/travel/sightseeing/by-quarter');
    expect(res.status).toBe(401);
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?from=YYYY-Q1 + ?to=YYYY-Q4 narrows applied to buckets', async () => {
    // 5 items spanning 2025-Q4..2027-Q1; ?from=2026-Q1&to=2026-Q4 → 4 buckets.
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, priceReferenceMinor: 999, createdAt: new Date('2025-11-15T00:00:00Z') }, // 2025-Q4
      { id: 2, priceReferenceMinor: 50,  createdAt: new Date('2026-02-15T00:00:00Z') }, // 2026-Q1
      { id: 3, priceReferenceMinor: 100, createdAt: new Date('2026-05-15T00:00:00Z') }, // 2026-Q2
      { id: 4, priceReferenceMinor: 200, createdAt: new Date('2026-08-15T00:00:00Z') }, // 2026-Q3
      { id: 5, priceReferenceMinor: 400, createdAt: new Date('2026-11-15T00:00:00Z') }, // 2026-Q4
      { id: 6, priceReferenceMinor: 888, createdAt: new Date('2027-02-15T00:00:00Z') }, // 2027-Q1
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter?from=2026-Q1&to=2026-Q4')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(4);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual([
      '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4',
    ]);
    // grand-totals reflect ONLY the filtered slice (50 + 100 + 200 + 400 = 750).
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(750);
  });

  test('case 6: ?from=garbage → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter?from=not-a-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 7: ?to=2026-Q5 → 400 INVALID_QUARTER_FORMAT (only Q1-Q4 valid)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter?to=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 7b: ?from=2026-Q0 → 400 INVALID_QUARTER_FORMAT (Q0 also invalid)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter?from=2026-Q0')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403)', async () => {
    // MANAGER role + subBrandAccess containing only unknown brand → empty
    // Set after VALID_SUB_BRANDS filter → short-circuit BEFORE findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      quarters: [],
      totalQuarters: 0,
      grandCount: 0,
      grandTotalValue: 0,
    });
    // No findMany call — short-circuit returns BEFORE prisma.
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 9: tenant-isolation — token tenantId=A → where.tenantId=A', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 101, priceReferenceMinor: 50, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    // Where clause MUST scope to the token's tenantId.
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.grandCount).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
  });

  test('case 10: round2 math — priceReferenceMinor=9.005 → totalPriceReferenceValue=9.01', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 91, priceReferenceMinor: 9.005, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Per round2 in route: Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.quarters[0].totalPriceReferenceValue).toBe(9.01);
    expect(res.body.grandTotalValue).toBe(9.01);
  });

  test('case 11: Q1↔Q2 boundary — 2026-03-31 (Q1) vs 2026-04-01 (Q2) bucket separately', async () => {
    // The classic off-by-one trap: month=3 must yield Q1 and month=4 must
    // yield Q2. Catches Math.ceil(month / 3) vs Math.floor((month - 1) / 3) + 1
    // confusion at the boundary.
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, priceReferenceMinor: 100, createdAt: new Date('2026-03-31T23:59:59Z') }, // Q1
      { id: 2, priceReferenceMinor: 200, createdAt: new Date('2026-04-01T00:00:00Z') }, // Q2
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.quarters).toEqual([
      { quarter: '2026-Q1', count: 1, totalPriceReferenceValue: 100 },
      { quarter: '2026-Q2', count: 1, totalPriceReferenceValue: 200 },
    ]);
    expect(res.body.grandCount).toBe(2);
    expect(res.body.grandTotalValue).toBe(300);
  });

  test('case 12: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 11, priceReferenceMinor: 100, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 1,
      totalPriceReferenceValue: 100,
    });
  });
});
