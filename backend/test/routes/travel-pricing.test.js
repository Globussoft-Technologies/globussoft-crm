// @ts-check
/**
 * backend/routes/travel_pricing.js — Travel CRM pricing engine route tests.
 *
 * Pins the contract for the three resource families hosted by
 * routes/travel_pricing.js (mounted at /api/travel):
 *
 *   1. Seasons         — TravelSeasonCalendar CRUD scoped to travel-tenant +
 *                        ADMIN/MANAGER create/patch, ADMIN-only delete.
 *   2. Markup rules    — TravelMarkupRule CRUD with scope enum
 *                        {flight, hotel, transport, package}, exactly-one-of
 *                        markupPct/markupFlat, priority + isActive filters.
 *   3. Quote compose   — POST /pricing/quote — pulls a TravelCostMaster row
 *                        (preferring the validFrom/validTo bracket), the
 *                        tenant's seasons + active markup rules, then delegates
 *                        the math to lib/travelPricing.js's `quote()`. Returns
 *                        the QuoteResult plus `cost: { id, currency }` echo.
 *
 * What's pinned (31 cases)
 * ------------------------
 *   - Seasons: GET tenant-scoped + subBrand filter; GET /:id happy+400+404;
 *     POST happy path; POST MISSING_FIELDS, INVALID_SUB_BRAND, INVERTED_DATES,
 *     INVALID_MULTIPLIER; DELETE 404 cross-tenant + DELETE 200 same-tenant.
 *   - Markup rules: GET 200 with scope filter; GET /:id happy+400+404;
 *     POST EXACTLY_ONE_MARKUP_TYPE; POST INVALID_SCOPE; POST SUB_BRAND_DENIED;
 *     POST happy path; POST INVALID_MIN_PAX (zero, negative, non-integer);
 *     PATCH minPax: sets, clears (null), rejects invalid.
 *   - Quote: POST 400 MISSING_FIELDS; POST 404 COST_NOT_FOUND; POST 200 happy
 *     path; POST paxCount INVALID_PAX_COUNT; POST paxCount minPax filtering;
 *     POST matchedMarkupMinPax in QuoteResult.
 *   - Auth gate: USER role hits 403 on POST /seasons (requirePermission guard).
 *
 * Pattern mirrors backend/test/routes/travel_suppliers.test.js + travel_quotes.test.js
 * — patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed against the same
 * dev-fallback secret the middleware uses. verifyToken + requirePermission +
 * requireTravelTenant all stay in the chain (no bypass) so auth + vertical +
 * sub-brand-access gates are exercised end-to-end.
 *
 * Date-boundary note (per CLAUDE.md standing rule): trip-date inputs are
 * built as `tomorrow + N days` from Date.now() so the assertions are
 * unambiguously-future in any TZ window.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSeasonCalendar = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelMarkupRule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelCostMaster = {
  findMany: vi.fn(),
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

// Tomorrow + N days, unambiguously-future per CLAUDE.md standing rule.
const tomorrow = new Date(Date.now() + 86_400_000);
const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
const tomorrowIso = tomorrow.toISOString();
const inThreeDaysIso = inThreeDays.toISOString();

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelSeasonCalendar.findMany.mockReset();
  prisma.travelSeasonCalendar.findFirst.mockReset();
  prisma.travelSeasonCalendar.create.mockReset();
  prisma.travelSeasonCalendar.update.mockReset();
  prisma.travelSeasonCalendar.delete.mockReset();
  prisma.travelMarkupRule.findMany.mockReset();
  prisma.travelMarkupRule.findFirst.mockReset();
  prisma.travelMarkupRule.create.mockReset();
  prisma.travelMarkupRule.update.mockReset();
  prisma.travelMarkupRule.delete.mockReset();
  prisma.travelCostMaster.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// ─── Seasons ─────────────────────────────────────────────────────────

describe('GET /api/travel/seasons', () => {
  test('returns tenant-scoped list (where.tenantId from req.user)', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, subBrand: 'tmc', seasonName: 'School Holiday',
        startDate: new Date(), endDate: new Date(), multiplier: 1.25 },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('seasons');
    expect(res.body.seasons).toHaveLength(1);
    expect(prisma.travelSeasonCalendar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1 },
        take: 200,
      }),
    );
  });

  test('?subBrand=rfu narrows the where clause', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/seasons?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSeasonCalendar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, subBrand: 'rfu' },
      }),
    );
  });
});

describe('POST /api/travel/seasons', () => {
  test('happy path returns 201 with the created season', async () => {
    prisma.travelSeasonCalendar.create.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', seasonName: 'Peak',
      startDate: tomorrow, endDate: inThreeDays, multiplier: 1.5,
    });
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        seasonName: 'Peak',
        startDate: tomorrowIso,
        endDate: inThreeDaysIso,
        multiplier: 1.5,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42, subBrand: 'tmc', seasonName: 'Peak', multiplier: 1.5,
    });
    // tenantId MUST come from req.travelTenant.id, not the body.
    expect(prisma.travelSeasonCalendar.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1, subBrand: 'tmc', seasonName: 'Peak', multiplier: 1.5,
        }),
      }),
    );
  });

  test('rejects missing required fields with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc', seasonName: 'Peak' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelSeasonCalendar.create).not.toHaveBeenCalled();
  });

  test('rejects invalid subBrand with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'cruise',  // not in VALID_SUB_BRANDS
        seasonName: 'X',
        startDate: tomorrowIso,
        endDate: inThreeDaysIso,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelSeasonCalendar.create).not.toHaveBeenCalled();
  });

  test('rejects inverted dates with 400 INVERTED_DATES', async () => {
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        seasonName: 'Backwards',
        startDate: inThreeDaysIso,  // end BEFORE start
        endDate: tomorrowIso,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVERTED_DATES' });
    expect(prisma.travelSeasonCalendar.create).not.toHaveBeenCalled();
  });

  test('rejects negative multiplier with 400 INVALID_MULTIPLIER', async () => {
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        seasonName: 'Bad',
        startDate: tomorrowIso,
        endDate: inThreeDaysIso,
        multiplier: -0.5,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MULTIPLIER' });
    expect(prisma.travelSeasonCalendar.create).not.toHaveBeenCalled();
  });

  test('USER role cannot create (403 from verifyRole gate)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/seasons')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        subBrand: 'tmc',
        seasonName: 'X',
        startDate: tomorrowIso,
        endDate: inThreeDaysIso,
      });
    expect(res.status).toBe(403);
    expect(prisma.travelSeasonCalendar.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/seasons/:id', () => {
  test('cross-tenant returns 404 NOT_FOUND (no delete call)', async () => {
    prisma.travelSeasonCalendar.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/seasons/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.travelSeasonCalendar.delete).not.toHaveBeenCalled();
  });

  test('same-tenant returns 200 {deleted:true, id}', async () => {
    prisma.travelSeasonCalendar.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, subBrand: 'tmc',
    });
    prisma.travelSeasonCalendar.delete.mockResolvedValue({ id: 11 });
    const res = await request(makeApp())
      .delete('/api/travel/seasons/11')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 11 });
    expect(prisma.travelSeasonCalendar.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });
});

// ─── Markup rules ────────────────────────────────────────────────────

describe('GET /api/travel/markup-rules', () => {
  test('?scope filter narrows the where clause', async () => {
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/markup-rules?scope=hotel&active=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelMarkupRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1, scope: 'hotel', isActive: true,
        }),
      }),
    );
  });
});

describe('POST /api/travel/markup-rules', () => {
  test('rejects both markup types set with 400 EXACTLY_ONE_MARKUP_TYPE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        scope: 'hotel',
        matchKeyJson: '{"city":"DEL"}',
        markupPct: 10,
        markupFlat: 500,  // both set — error
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EXACTLY_ONE_MARKUP_TYPE' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('rejects invalid scope with 400 INVALID_SCOPE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        scope: 'cruise',  // not in {flight, hotel, transport, package}
        matchKeyJson: '{}',
        markupPct: 5,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SCOPE' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('non-admin without subBrandAccess for target returns 403 SUB_BRAND_DENIED', async () => {
    // MANAGER role passes the RBAC gate but the user's subBrandAccess
    // JSON only includes 'tmc' — the target 'rfu' triggers the deny.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({
        subBrand: 'rfu',
        scope: 'hotel',
        matchKeyJson: '{}',
        markupPct: 10,
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('happy path returns 201 with the created rule', async () => {
    prisma.travelMarkupRule.create.mockResolvedValue({
      id: 7, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{"city":"DEL"}', markupPct: 12, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        scope: 'hotel',
        matchKeyJson: '{"city":"DEL"}',
        markupPct: 12,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 7, subBrand: 'tmc', scope: 'hotel', markupPct: 12, priority: 100,
    });
    expect(prisma.travelMarkupRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          scope: 'hotel',
          matchKeyJson: '{"city":"DEL"}',
          markupPct: 12,
          markupFlat: null,
          priority: 100,
        }),
      }),
    );
  });
});

// ─── Pricing /quote ──────────────────────────────────────────────────

describe('POST /api/travel/pricing/quote', () => {
  test('rejects missing required fields with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc' });  // missing category, routeOrSku, tripDate
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('returns 404 COST_NOT_FOUND when no cost-master row matches', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
      });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'COST_NOT_FOUND' });
  });

  test('happy path returns QuoteResult + echo `cost: {id, currency}`', async () => {
    // Cost row: bracket includes tomorrow → preferred over older rows.
    prisma.travelCostMaster.findMany.mockResolvedValue([
      {
        id: 101, tenantId: 1, subBrand: 'tmc', category: 'hotel',
        routeOrSku: 'DEL-Hilton', baseRate: 5000, currency: 'INR',
        validFrom: new Date(Date.now() - 86_400_000),
        validTo: new Date(Date.now() + 7 * 86_400_000),
        isActive: true, supplierId: null,
      },
    ]);
    // One season covering the trip date.
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, subBrand: 'tmc', seasonName: 'School Holiday',
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 7 * 86_400_000),
        multiplier: 1.2, isActive: true,
      },
    ]);
    // One markup rule (10% on hotel).
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 7, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
        matchKeyJson: '{}', markupPct: 10, markupFlat: null,
        ownerUserId: null, priority: 100, isActive: true,
      },
    ]);
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
      });
    expect(res.status).toBe(200);
    // QuoteResult fields from lib/travelPricing.js quote():
    //   baseRate=5000, seasonMultiplier=1.2 → subtotal=6000
    //   markupPct=10 → markupAmount=600 → grandTotal=6600
    expect(res.body).toMatchObject({
      baseRate: 5000,
      seasonMultiplier: 1.2,
      subtotal: 6000,
      markupAmount: 600,
      grandTotal: 6600,
      matchedSeasonName: 'School Holiday',
      matchedMarkupRuleId: 7,
      cost: { id: 101, currency: 'INR' },
    });
    // Cost-master lookup MUST be tenant-scoped + subBrand-scoped.
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1, subBrand: 'tmc', category: 'hotel',
          routeOrSku: 'DEL-Hilton', isActive: true,
        }),
      }),
    );
  });

  test('rejects invalid paxCount with 400 INVALID_PAX_COUNT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
        paxCount: -5,  // negative — invalid
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAX_COUNT' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('paxCount=0 is rejected with 400 INVALID_PAX_COUNT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
        paxCount: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAX_COUNT' });
  });

  test('minPax rule only applies when paxCount meets threshold', async () => {
    // Cost row.
    prisma.travelCostMaster.findMany.mockResolvedValue([
      {
        id: 202, tenantId: 1, subBrand: 'tmc', category: 'hotel',
        routeOrSku: 'DEL-Hilton', baseRate: 1000, currency: 'INR',
        validFrom: null, validTo: null, isActive: true, supplierId: null,
      },
    ]);
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    // Rule requires minPax=50 — we send paxCount=10, should be excluded.
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 20, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
        matchKeyJson: '{}', markupPct: 15, markupFlat: null,
        ownerUserId: null, priority: 100, isActive: true, minPax: 50,
      },
    ]);
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
        paxCount: 10,  // below minPax=50 → rule excluded → no markup
      });
    expect(res.status).toBe(200);
    // With no markup applied: subtotal=grandTotal=1000
    expect(res.body).toMatchObject({
      baseRate: 1000,
      seasonMultiplier: 1,
      subtotal: 1000,
      markupAmount: 0,
      grandTotal: 1000,
      matchedMarkupRuleId: null,
    });
  });

  test('minPax rule applies when paxCount meets threshold; matchedMarkupMinPax echoed', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      {
        id: 203, tenantId: 1, subBrand: 'tmc', category: 'hotel',
        routeOrSku: 'DEL-Hilton', baseRate: 1000, currency: 'INR',
        validFrom: null, validTo: null, isActive: true, supplierId: null,
      },
    ]);
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 21, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
        matchKeyJson: '{}', markupPct: 10, markupFlat: null,
        ownerUserId: null, priority: 100, isActive: true, minPax: 50,
      },
    ]);
    const res = await request(makeApp())
      .post('/api/travel/pricing/quote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        category: 'hotel',
        routeOrSku: 'DEL-Hilton',
        tripDate: tomorrowIso,
        paxCount: 60,  // meets minPax=50 → rule applies
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      baseRate: 1000,
      subtotal: 1000,
      markupAmount: 100,
      grandTotal: 1100,
      matchedMarkupRuleId: 21,
      matchedMarkupMinPax: 50,
    });
  });
});

// ─── GET /seasons/:id ────────────────────────────────────────────────

describe('GET /api/travel/seasons/:id', () => {
  test('happy path returns 200 with the season row', async () => {
    prisma.travelSeasonCalendar.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', seasonName: 'Eid',
      startDate: tomorrow, endDate: inThreeDays, multiplier: 1.3, isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/travel/seasons/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, subBrand: 'tmc', seasonName: 'Eid' });
    expect(prisma.travelSeasonCalendar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, tenantId: 1 } }),
    );
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/seasons/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSeasonCalendar.findFirst).not.toHaveBeenCalled();
  });

  test('unknown id returns 404 NOT_FOUND', async () => {
    prisma.travelSeasonCalendar.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/seasons/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─── GET /markup-rules/:id ───────────────────────────────────────────

describe('GET /api/travel/markup-rules/:id', () => {
  test('happy path returns 200 with the markup rule row', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, subBrand: 'rfu', scope: 'flight',
      matchKeyJson: '{}', markupPct: 8, markupFlat: null,
      ownerUserId: null, priority: 50, isActive: true, minPax: null,
    });
    const res = await request(makeApp())
      .get('/api/travel/markup-rules/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 9, scope: 'flight', markupPct: 8 });
    expect(prisma.travelMarkupRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9, tenantId: 1 } }),
    );
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/markup-rules/not-a-number')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelMarkupRule.findFirst).not.toHaveBeenCalled();
  });

  test('unknown id returns 404 NOT_FOUND', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/markup-rules/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─── minPax on markup rules (POST + PATCH) ───────────────────────────

describe('POST /api/travel/markup-rules — minPax validation', () => {
  test('minPax=0 returns 400 INVALID_MIN_PAX', async () => {
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc', scope: 'hotel', matchKeyJson: '{}', markupPct: 10, minPax: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MIN_PAX' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('minPax=-1 returns 400 INVALID_MIN_PAX', async () => {
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc', scope: 'hotel', matchKeyJson: '{}', markupPct: 10, minPax: -1,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MIN_PAX' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('minPax="abc" returns 400 INVALID_MIN_PAX', async () => {
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc', scope: 'hotel', matchKeyJson: '{}', markupPct: 10, minPax: 'abc',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MIN_PAX' });
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('minPax=50 (valid positive integer) is accepted and stored', async () => {
    prisma.travelMarkupRule.create.mockResolvedValue({
      id: 30, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{}', markupPct: 10, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true, minPax: 50,
    });
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc', scope: 'hotel', matchKeyJson: '{}', markupPct: 10, minPax: 50,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 30, minPax: 50 });
    expect(prisma.travelMarkupRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minPax: 50 }),
      }),
    );
  });

  test('minPax omitted → stored as null', async () => {
    prisma.travelMarkupRule.create.mockResolvedValue({
      id: 31, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{}', markupPct: 10, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true, minPax: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/markup-rules')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc', scope: 'hotel', matchKeyJson: '{}', markupPct: 10,
      });
    expect(res.status).toBe(201);
    expect(prisma.travelMarkupRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minPax: null }),
      }),
    );
  });
});

describe('PATCH /api/travel/markup-rules/:id — minPax', () => {
  test('PATCH minPax=null clears the threshold', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue({
      id: 40, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{}', markupPct: 10, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true, minPax: 50,
    });
    prisma.travelMarkupRule.update.mockResolvedValue({
      id: 40, minPax: null,
    });
    const res = await request(makeApp())
      .patch('/api/travel/markup-rules/40')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ minPax: null });
    expect(res.status).toBe(200);
    expect(prisma.travelMarkupRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minPax: null }),
      }),
    );
  });

  test('PATCH minPax=100 sets a new threshold', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue({
      id: 41, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{}', markupPct: 10, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true, minPax: null,
    });
    prisma.travelMarkupRule.update.mockResolvedValue({ id: 41, minPax: 100 });
    const res = await request(makeApp())
      .patch('/api/travel/markup-rules/41')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ minPax: 100 });
    expect(res.status).toBe(200);
    expect(prisma.travelMarkupRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ minPax: 100 }),
      }),
    );
  });

  test('PATCH minPax=0 returns 400 INVALID_MIN_PAX', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      matchKeyJson: '{}', markupPct: 10, markupFlat: null,
      ownerUserId: null, priority: 100, isActive: true, minPax: null,
    });
    const res = await request(makeApp())
      .patch('/api/travel/markup-rules/42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ minPax: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MIN_PAX' });
    expect(prisma.travelMarkupRule.update).not.toHaveBeenCalled();
  });
});
