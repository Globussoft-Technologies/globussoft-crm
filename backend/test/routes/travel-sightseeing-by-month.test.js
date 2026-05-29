// @ts-check
/**
 * #907 rollup-family — GET /api/travel/sightseeing/by-month.
 *
 * Pins the contract for the monthly rollup handler on
 * backend/routes/travel_sightseeing.js (declared BEFORE GET /:id so
 * Express doesn't parse "by-month" as a numeric :id and 400).
 *
 * Pairs with /by-year shipped at 327c0693. Mirrors travel_invoices
 * /invoices/by-month envelope shape (commit 5c96a28e) but adapted to
 * TravelSightseeing — no status enum, so the envelope drops per-status
 * sub-counts and tracks only count + totalPriceReferenceValue per
 * YYYY-MM bucket. Second of the eventual rollup triplet (by-quarter
 * follows in a later slice).
 *
 * Why distinct from travel-sightseeing-by-year.test.js
 * ----------------------------------------------------
 * /by-year buckets by UTC year (YYYY). This file ONLY covers /by-month —
 * UTC YYYY-MM bucketing, INVALID_MONTH_FORMAT regex validation. No case
 * here duplicates any case there.
 *
 * Contracts asserted (≥9 cases)
 * -----------------------------
 *   1. happy path — items spanning 3 UTC months → 3 YYYY-MM buckets with
 *      correct envelope keys (month, count, totalPriceReferenceValue) +
 *      grand-totals envelope
 *   2. empty result → empty months[] + zeroed grand-totals
 *   3. non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   4. unauthenticated → 401 via verifyToken
 *   5. ?from=YYYY-MM + ?to=YYYY-MM filter applied to buckets (post-aggregation)
 *   6. ?from=garbage → 400 INVALID_MONTH_FORMAT
 *   7. sub-brand allow-set EMPTY → zeroed envelope (per #976 fix —
 *      handler short-circuits BEFORE findMany)
 *   8. tenant-isolation — token tenantId=A → findMany where.tenantId=A
 *   9. round2 math — priceReferenceMinor=9.005 → 9.01 (half-up at 2dp)
 *   10. sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *
 * Mocking strategy
 * ----------------
 * Patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router (CJS require — module-cache pinned by the patch). Real
 * verifyToken + requireTravelTenant middleware runs. Real
 * getSubBrandAccessSet runs (user.findUnique controls the access set).
 * HS256 JWTs signed with the dev fallback secret =
 * "enterprise_super_secret_key_2026". Mirrors
 * travel-sightseeing-by-year.test.js exactly.
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
// GET /api/travel/sightseeing/by-month
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/sightseeing/by-month', () => {
  test('case 1: happy path — items spanning 3 UTC months → 3 YYYY-MM buckets', async () => {
    // 2026-03: 1 item (price 100). 2026-04: 2 items (200 + 50). 2026-05: 1 item (400).
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, priceReferenceMinor: 100, createdAt: new Date('2026-03-15T08:00:00Z') },
      { id: 2, priceReferenceMinor: 200, createdAt: new Date('2026-04-17T10:30:00Z') },
      { id: 3, priceReferenceMinor: 50,  createdAt: new Date('2026-04-09T09:00:00Z') },
      { id: 4, priceReferenceMinor: 400, createdAt: new Date('2026-05-22T12:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(3);
    expect(res.body.grandCount).toBe(4);
    // grandTotalValue = 100 + 200 + 50 + 400 = 750
    expect(res.body.grandTotalValue).toBe(750);
    expect(res.body.months).toHaveLength(3);
    // Default orderBy is month:asc → 2026-03, 2026-04, 2026-05.
    expect(res.body.months[0]).toMatchObject({
      month: '2026-03',
      count: 1,
      totalPriceReferenceValue: 100,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-04',
      count: 2,
      totalPriceReferenceValue: 250,
    });
    expect(res.body.months[2]).toMatchObject({
      month: '2026-05',
      count: 1,
      totalPriceReferenceValue: 400,
    });
    // Default limit/offset per route: limit=12 (Math.min(12, 60)), offset=0.
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('case 2: empty result — returns empty months[] + zeroed grand-totals', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: [],
      totalMonths: 0,
      grandCount: 0,
      grandTotalValue: 0,
    });
  });

  test('case 3: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 4: unauthenticated → 401 via verifyToken', async () => {
    const res = await request(makeApp()).get('/api/travel/sightseeing/by-month');
    expect(res.status).toBe(401);
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?from=YYYY-MM + ?to=YYYY-MM filter applied to buckets', async () => {
    // 4 items spanning 2026-01..2026-04; ?from=2026-02&to=2026-03 → 2 buckets.
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 1, priceReferenceMinor: 50,  createdAt: new Date('2026-01-15T00:00:00Z') },
      { id: 2, priceReferenceMinor: 100, createdAt: new Date('2026-02-15T00:00:00Z') },
      { id: 3, priceReferenceMinor: 200, createdAt: new Date('2026-03-17T00:00:00Z') },
      { id: 4, priceReferenceMinor: 400, createdAt: new Date('2026-04-22T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month?from=2026-02&to=2026-03')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-02', '2026-03']);
    // grand-totals reflect ONLY the filtered slice.
    expect(res.body.grandCount).toBe(2);
    expect(res.body.grandTotalValue).toBe(300);
  });

  test('case 6: ?from=garbage → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month?from=not-a-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 6b: ?to=2026-13 (invalid month component) → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month?to=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 7: sub-brand allow-set EMPTY → zeroed envelope (NOT 403)', async () => {
    // MANAGER role + subBrandAccess containing only unknown brand → empty
    // Set after VALID_SUB_BRANDS filter → short-circuit BEFORE findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: [],
      totalMonths: 0,
      grandCount: 0,
      grandTotalValue: 0,
    });
    // No findMany call — short-circuit returns BEFORE prisma.
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('case 8: tenant-isolation — token tenantId=A → where.tenantId=A', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 101, priceReferenceMinor: 50, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    // Where clause MUST scope to the token's tenantId.
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.grandCount).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
  });

  test('case 9: round2 math — priceReferenceMinor=9.005 → totalPriceReferenceValue=9.01', async () => {
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 91, priceReferenceMinor: 9.005, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Per round2 in route: Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.months[0].totalPriceReferenceValue).toBe(9.01);
    expect(res.body.grandTotalValue).toBe(9.01);
  });

  test('case 10: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSightseeing.findMany.mockResolvedValue([
      { id: 11, priceReferenceMinor: 100, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-04',
      count: 1,
      totalPriceReferenceValue: 100,
    });
  });
});
