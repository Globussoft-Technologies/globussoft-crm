// @ts-check
/**
 * PRD_TRAVEL_PRICING §3 — GET /api/travel/pricing/stats
 * tenant-wide pricing-config rollup.
 *
 * Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
 * /commission-profiles/stats + #908 slice 19 /flyer-templates/global-stats.
 * USER-readable anodyne aggregate that powers the Pricing Config library
 * page header summary strip. Pins the contract for the new route handler
 * added at backend/routes/travel_pricing.js between the /markup-rules
 * family and the /pricing/quote handler.
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastUpdatedAt=null.
 *   - Happy path:          mix of seasons + markup rules → counts,
 *                          active subset (date-bracket for seasons,
 *                          isActive=true for rules), bySubBrand,
 *                          byScope, lastUpdatedAt (max(updatedAt) across
 *                          both models).
 *   - Cross-tenant:        the route's WHERE clause threads tenantId
 *                          through to both findMany calls — defensive.
 *   - MANAGER narrowing:   subBrandAccess=['rfu'] → both queries
 *                          narrowed to rfu only.
 *   - USER role:           USER returns 200 (anodyne aggregate).
 *   - Auth gate:           no token → 401.
 *   - ?from / ?to:         ISO date bounds applied to createdAt on
 *                          BOTH season + rule queries.
 *   - Defensive: 0 rows → lastUpdatedAt: null + empty bucket maps.
 *
 * Test pattern mirrors travel-supplier-stats.test.js (slice 23) — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.travelSeasonCalendar = prisma.travelSeasonCalendar || {};
prisma.travelSeasonCalendar.findMany = vi.fn();
prisma.travelMarkupRule = prisma.travelMarkupRule || {};
prisma.travelMarkupRule.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
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
const travelPricingRouter = requireCJS('../../routes/travel_pricing');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelPricingRouter);
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
  prisma.travelSeasonCalendar.findMany.mockReset();
  prisma.travelMarkupRule.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/pricing/stats', () => {
  test('empty tenant → all-zeros envelope with empty bucket maps + null lastUpdatedAt', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      seasons: { total: 0, active: 0, bySubBrand: {} },
      markupRules: { total: 0, active: 0, bySubBrand: {}, byScope: {} },
      lastUpdatedAt: null,
    });
  });

  test('happy path: 3 seasons (1 currently active) + 4 markup rules (3 isActive) → correct counts + bucket maps + lastUpdatedAt', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 30 * 86400000); // -30d
    const future = new Date(now.getTime() + 30 * 86400000); // +30d
    const farPast = new Date(now.getTime() - 365 * 86400000); // -365d
    const farFuture = new Date(now.getTime() + 365 * 86400000); // +365d
    const newest = new Date('2026-05-20T10:00:00Z');

    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'tmc',
        startDate: past,
        endDate: future, // currently active (now is in [past, future])
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: 'tmc',
        startDate: future,
        endDate: farFuture, // scheduled, NOT yet active
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
      {
        id: 3,
        subBrand: 'rfu',
        startDate: farPast,
        endDate: past, // expired, NOT active
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 10,
        subBrand: 'tmc',
        scope: 'flight',
        isActive: true,
        updatedAt: new Date('2026-05-08T10:00:00Z'),
      },
      {
        id: 11,
        subBrand: 'tmc',
        scope: 'hotel',
        isActive: true,
        updatedAt: newest, // newest → drives lastUpdatedAt
      },
      {
        id: 12,
        subBrand: 'rfu',
        scope: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-18T10:00:00Z'),
      },
      {
        id: 13,
        subBrand: 'rfu',
        scope: 'transport',
        isActive: false, // disabled, NOT counted in active
        updatedAt: new Date('2026-05-19T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.seasons.total).toBe(3);
    expect(res.body.seasons.active).toBe(1); // only the first season brackets `now`
    expect(res.body.seasons.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 1 },
    });

    expect(res.body.markupRules.total).toBe(4);
    expect(res.body.markupRules.active).toBe(3); // 3 isActive=true
    expect(res.body.markupRules.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 2 },
    });
    expect(res.body.markupRules.byScope).toEqual({
      flight: { count: 1 },
      hotel: { count: 2 },
      transport: { count: 1 },
    });

    expect(res.body.lastUpdatedAt).toBe(newest.toISOString());
  });

  test('cross-tenant: tenantId is threaded through to BOTH findMany WHERE clauses', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const seasonWhere = prisma.travelSeasonCalendar.findMany.mock.calls[0][0].where;
    const ruleWhere = prisma.travelMarkupRule.findMany.mock.calls[0][0].where;
    expect(seasonWhere.tenantId).toBe(1);
    expect(ruleWhere.tenantId).toBe(1);
  });

  test('MANAGER with subBrandAccess=["rfu"] → both queries narrowed to rfu only', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      {
        id: 3,
        subBrand: 'rfu',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 12,
        subBrand: 'rfu',
        scope: 'hotel',
        isActive: true,
        updatedAt: new Date('2026-05-18T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.seasons.total).toBe(1);
    expect(res.body.markupRules.total).toBe(1);

    // Verify the WHERE clause was narrowed by sub-brand BEFORE the query
    // hit Prisma. This is the contract: MANAGER subBrandAccess narrowing
    // happens at the route level, not in client code.
    const seasonWhere = prisma.travelSeasonCalendar.findMany.mock.calls[0][0].where;
    const ruleWhere = prisma.travelMarkupRule.findMany.mock.calls[0][0].where;
    expect(seasonWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(ruleWhere.subBrand).toEqual({ in: ['rfu'] });
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.seasons.total).toBe(0);
    expect(res.body.markupRules.total).toBe(0);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/pricing/stats');
    expect(res.status).toBe(401);
  });

  test('?from / ?to ISO date bounds applied to createdAt on BOTH season + rule queries', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);

    const seasonWhere = prisma.travelSeasonCalendar.findMany.mock.calls[0][0].where;
    const ruleWhere = prisma.travelMarkupRule.findMany.mock.calls[0][0].where;
    expect(seasonWhere.createdAt).toEqual({
      gte: new Date('2026-01-01T00:00:00Z'),
      lte: new Date('2026-12-31T23:59:59Z'),
    });
    expect(ruleWhere.createdAt).toEqual({
      gte: new Date('2026-01-01T00:00:00Z'),
      lte: new Date('2026-12-31T23:59:59Z'),
    });
  });

  test('?from with invalid ISO → 400 INVALID_DATE (without hitting Prisma)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    // Defensive: invalid input must NOT have hit Prisma.
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('defensive: seasons-only tenant (no markup rules) → seasons populated, markupRules zeroed, lastUpdatedAt = season.updatedAt', async () => {
    const seasonTs = new Date('2026-04-10T10:00:00Z');
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'tmc',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
        updatedAt: seasonTs,
      },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/pricing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.seasons.total).toBe(1);
    expect(res.body.seasons.active).toBe(1); // 2026 range brackets `now`
    expect(res.body.markupRules.total).toBe(0);
    expect(res.body.markupRules.active).toBe(0);
    expect(res.body.markupRules.byScope).toEqual({});
    expect(res.body.lastUpdatedAt).toBe(seasonTs.toISOString());
  });
});
