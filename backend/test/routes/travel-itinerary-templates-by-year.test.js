// @ts-check
/**
 * #907 rollup-family — GET /api/travel/itinerary-templates/by-year.
 *
 * Pins the contract for the annual rollup handler on
 * backend/routes/travel_itinerary_templates.js (declared BEFORE GET /:id so
 * Express doesn't parse "by-year" as a numeric :id and 400).
 *
 * Mirrors travel_sightseeing /by-year scaffolding (commit 327c0693) but
 * adapted to ItineraryTemplate — adds a totalUsageCount bucket field +
 * grandUsageCount grand-total so callers see template-usage drift over
 * calendar years. Envelope:
 *
 *   {
 *     years: [{ year, count, totalBasePriceValue, totalUsageCount }],
 *     totalYears, grandCount, grandTotalValue, grandUsageCount,
 *     limit, offset
 *   }
 *
 * Why distinct from travel-itinerary-templates-stats.test.js
 * ----------------------------------------------------------
 * The sibling /stats test covers tenant-wide aggregate (byCategory +
 * bySubBrand + topByUsage + averageDurationDays + lastUpdatedAt). This
 * file ONLY covers /by-year — temporal bucketing, year filter,
 * year-format validation, usageCount accumulation. No case here
 * duplicates any case there.
 *
 * Contracts asserted (≥9 cases)
 * -----------------------------
 *   1. happy path — items spanning 3 UTC years → 3 YYYY buckets with
 *      correct envelope keys + grand-totals envelope
 *   2. empty result → empty years[] + zeroed grand-totals
 *   3. non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   4. unauthenticated → 401 via verifyToken
 *   5. ?from=YYYY + ?to=YYYY filter applied to buckets (post-aggregation)
 *   6. ?from=garbage → 400 INVALID_YEAR_FORMAT
 *   7. sub-brand allow-set EMPTY → zeroed envelope (per #976 fix —
 *      handler short-circuits BEFORE findMany)
 *   8. tenant-isolation — token tenantId=A → findMany where.tenantId=A
 *   9. usageCount sum correct — multiple rows in one year accumulate
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
prisma.itineraryTemplate = prisma.itineraryTemplate || {};
prisma.itineraryTemplate.findMany = vi.fn();
prisma.itineraryTemplate.findFirst = prisma.itineraryTemplate.findFirst || vi.fn();
prisma.itineraryTemplate.count = prisma.itineraryTemplate.count || vi.fn();
prisma.itineraryTemplate.create = prisma.itineraryTemplate.create || vi.fn();
prisma.itineraryTemplate.update = prisma.itineraryTemplate.update || vi.fn();
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
const itineraryTemplatesRouter = requireCJS('../../routes/travel_itinerary_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/itinerary-templates', itineraryTemplatesRouter);
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
  prisma.itineraryTemplate.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/itinerary-templates/by-year
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/itinerary-templates/by-year', () => {
  test('case 1: happy path — items spanning 3 UTC years → 3 YYYY buckets', async () => {
    // 2024: 1 item (price 100, usage 5). 2025: 2 items (200+50, usage 3+7=10).
    // 2026: 1 item (400, usage 2).
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 1, basePriceMinor: 100, usageCount: 5, createdAt: new Date('2024-03-15T08:00:00Z') },
      { id: 2, basePriceMinor: 200, usageCount: 3, createdAt: new Date('2025-07-17T10:30:00Z') },
      { id: 3, basePriceMinor: 50,  usageCount: 7, createdAt: new Date('2025-11-09T09:00:00Z') },
      { id: 4, basePriceMinor: 400, usageCount: 2, createdAt: new Date('2026-02-22T12:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(3);
    expect(res.body.grandCount).toBe(4);
    // grandTotalValue = 100 + 200 + 50 + 400 = 750
    expect(res.body.grandTotalValue).toBe(750);
    // grandUsageCount = 5 + 3 + 7 + 2 = 17
    expect(res.body.grandUsageCount).toBe(17);
    expect(res.body.years).toHaveLength(3);
    // Default orderBy is year:asc → 2024, 2025, 2026.
    expect(res.body.years[0]).toMatchObject({
      year: '2024',
      count: 1,
      totalBasePriceValue: 100,
      totalUsageCount: 5,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2025',
      count: 2,
      totalBasePriceValue: 250,
      totalUsageCount: 10,
    });
    expect(res.body.years[2]).toMatchObject({
      year: '2026',
      count: 1,
      totalBasePriceValue: 400,
      totalUsageCount: 2,
    });
    // Default limit/offset per route: limit=10 (Math.min(10, 30)), offset=0.
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('case 2: empty result — returns empty years[] + zeroed grand-totals', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandCount: 0,
      grandTotalValue: 0,
      grandUsageCount: 0,
    });
  });

  test('case 3: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 4: unauthenticated → 401 via verifyToken', async () => {
    const res = await request(makeApp()).get('/api/travel/itinerary-templates/by-year');
    expect(res.status).toBe(401);
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?from=YYYY + ?to=YYYY filter applied to buckets', async () => {
    // 4 items spanning 2023..2026; ?from=2024&to=2025 → 2 buckets.
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 1, basePriceMinor: 50,  usageCount: 1, createdAt: new Date('2023-06-15T00:00:00Z') },
      { id: 2, basePriceMinor: 100, usageCount: 2, createdAt: new Date('2024-03-15T00:00:00Z') },
      { id: 3, basePriceMinor: 200, usageCount: 4, createdAt: new Date('2025-07-17T00:00:00Z') },
      { id: 4, basePriceMinor: 400, usageCount: 8, createdAt: new Date('2026-02-22T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year?from=2024&to=2025')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.years.map((y) => y.year)).toEqual(['2024', '2025']);
    // grand-totals reflect ONLY the filtered slice.
    expect(res.body.grandCount).toBe(2);
    expect(res.body.grandTotalValue).toBe(300);
    expect(res.body.grandUsageCount).toBe(6);
  });

  test('case 6: ?from=garbage → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year?from=not-a-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 7: sub-brand allow-set EMPTY → zeroed envelope (NOT 403)', async () => {
    // MANAGER role + subBrandAccess containing only unknown brand → empty
    // Set after VALID_SUB_BRANDS filter → short-circuit BEFORE findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandCount: 0,
      grandTotalValue: 0,
      grandUsageCount: 0,
    });
    // No findMany call — short-circuit returns BEFORE prisma.
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 8: tenant-isolation — token tenantId=A → where.tenantId=A', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 101, basePriceMinor: 50, usageCount: 3, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    // Where clause MUST scope to the token's tenantId.
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.grandCount).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
    expect(res.body.grandUsageCount).toBe(3);
  });

  test('case 9: usageCount sum — multiple rows in one year accumulate', async () => {
    // All 4 rows in 2026 with usageCount 1, 5, 12, 100 → 1+5+12+100 = 118.
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 1, basePriceMinor: 0, usageCount: 1,   createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 2, basePriceMinor: 0, usageCount: 5,   createdAt: new Date('2026-02-01T00:00:00Z') },
      { id: 3, basePriceMinor: 0, usageCount: 12,  createdAt: new Date('2026-03-01T00:00:00Z') },
      { id: 4, basePriceMinor: 0, usageCount: 100, createdAt: new Date('2026-04-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 4,
      totalUsageCount: 118,
    });
    expect(res.body.grandUsageCount).toBe(118);
  });

  test('case 10: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 11, basePriceMinor: 100, usageCount: 4, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 1,
      totalBasePriceValue: 100,
      totalUsageCount: 4,
    });
  });
});
