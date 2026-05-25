// @ts-check
/**
 * Arc 2 #907 slice 14 — Itinerary aggregation rollup endpoint.
 *
 * Pins GET /api/travel/itineraries/:id/totals added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Read-only — no audit log writes, no eventBus emits.
 *   - Aggregates ItineraryItem rows for one itinerary; buckets per
 *     itemType (all 6 keys from VALID_ITEM_TYPES present + zero-filled
 *     when absent — stable shape for the planned dashboard tile).
 *   - Sums unitCost / markup / gstAmount / totalPrice per bucket and
 *     across the whole itinerary (`grand`); null money fields treated
 *     as 0 (no NaN contagion).
 *   - Optional ?itemType=X filter narrows the row scan to that type;
 *     unknown values reject with 400 INVALID_ITEM_TYPE.
 *   - Half-up 2dp rounding via Number.EPSILON.
 *   - Tenant + sub-brand guard via loadItineraryWithGuard → 401 /
 *     404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *
 * Pattern mirrors travel-itinerary-day-costs.test.js — CJS prisma
 * singleton patched BEFORE the router is required; HS256 JWT via the
 * dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// eventBus mock — totals is read-only and never emits, but we patch the
// shared helper to match sibling-test discipline (clone-day / day-costs
// / supplier-rollup) so route refactors that add an emit don't silently
// couple the test to a real bus listener.
vi.mock('../../lib/eventBus.js', () => ({
  default: { emit: vi.fn(), on: vi.fn() },
  emitEvent: vi.fn(),
  safeEmitEvent: vi.fn(),
}));

prisma.itinerary = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.itineraryItem = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ name: 'Test Customer' });
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
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelItinerariesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function parentItinerary(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    itemType: 'hotel',
    unitCost: null,
    markup: null,
    gstAmount: null,
    totalPrice: null,
    ...overrides,
  };
}

const ALL_TYPES = ['flight', 'hotel', 'transfer', 'activity', 'visa', 'insurance'];

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ name: 'Test Customer' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/:id/totals — happy paths', () => {
  test('empty itinerary → totalItems=0, all-zero grand, all 6 byItemType buckets present + zero-filled', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      itineraryId: 100,
      totalItems: 0,
      grand: { totalUnitCost: 0, totalMarkup: 0, totalGstAmount: 0, totalPrice: 0 },
    });
    // All 6 buckets must be present + zero-filled for stable consumer shape.
    expect(Object.keys(res.body.byItemType).sort()).toEqual([...ALL_TYPES].sort());
    for (const t of ALL_TYPES) {
      expect(res.body.byItemType[t]).toEqual({
        count: 0, totalUnitCost: 0, totalMarkup: 0, totalGstAmount: 0, totalPrice: 0,
      });
    }
  });

  test('multi-type itinerary with 4 mixed rows → correct counts + sums + grand', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        itemType: 'hotel',
        unitCost: '5000.00', markup: '500.00', gstAmount: '180.00', totalPrice: '5680.00',
      }),
      makeItem({
        itemType: 'hotel',
        unitCost: '3000.00', markup: '300.00', gstAmount: '108.00', totalPrice: '3408.00',
      }),
      makeItem({
        itemType: 'flight',
        unitCost: '12000.00', markup: '1000.00', gstAmount: '650.00', totalPrice: '13650.00',
      }),
      makeItem({
        itemType: 'activity',
        unitCost: '2000.00', markup: '200.00', gstAmount: '72.00', totalPrice: '2272.00',
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(100);
    expect(res.body.totalItems).toBe(4);

    // Grand totals: 22000 unit / 2000 markup / 1010 gst / 25010 sale.
    expect(res.body.grand).toEqual({
      totalUnitCost: 22000,
      totalMarkup: 2000,
      totalGstAmount: 1010,
      totalPrice: 25010,
    });

    // Hotel bucket: 2 rows, sums of the two hotel rows.
    expect(res.body.byItemType.hotel).toEqual({
      count: 2,
      totalUnitCost: 8000,
      totalMarkup: 800,
      totalGstAmount: 288,
      totalPrice: 9088,
    });
    // Flight bucket: 1 row.
    expect(res.body.byItemType.flight).toEqual({
      count: 1,
      totalUnitCost: 12000,
      totalMarkup: 1000,
      totalGstAmount: 650,
      totalPrice: 13650,
    });
    // Activity bucket: 1 row.
    expect(res.body.byItemType.activity).toEqual({
      count: 1,
      totalUnitCost: 2000,
      totalMarkup: 200,
      totalGstAmount: 72,
      totalPrice: 2272,
    });
    // Untouched buckets are zero-filled but PRESENT.
    expect(res.body.byItemType.transfer).toEqual({
      count: 0, totalUnitCost: 0, totalMarkup: 0, totalGstAmount: 0, totalPrice: 0,
    });
    expect(res.body.byItemType.visa).toEqual({
      count: 0, totalUnitCost: 0, totalMarkup: 0, totalGstAmount: 0, totalPrice: 0,
    });
    expect(res.body.byItemType.insurance).toEqual({
      count: 0, totalUnitCost: 0, totalMarkup: 0, totalGstAmount: 0, totalPrice: 0,
    });
  });

  test('?itemType=hotel filter narrows the prisma where + still returns all 6 buckets', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        itemType: 'hotel',
        unitCost: '5000.00', markup: '500.00', gstAmount: '180.00', totalPrice: '5680.00',
      }),
      makeItem({
        itemType: 'hotel',
        unitCost: '3000.00', markup: '300.00', gstAmount: '108.00', totalPrice: '3408.00',
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals?itemType=hotel')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(2);
    expect(res.body.byItemType.hotel.count).toBe(2);
    expect(res.body.byItemType.hotel.totalPrice).toBe(9088);
    expect(res.body.grand.totalPrice).toBe(9088);
    // Other buckets remain zero-filled in the response.
    expect(res.body.byItemType.flight.count).toBe(0);
    expect(res.body.byItemType.transfer.count).toBe(0);
    expect(res.body.byItemType.activity.count).toBe(0);
    expect(res.body.byItemType.visa.count).toBe(0);
    expect(res.body.byItemType.insurance.count).toBe(0);
    // Prisma was scoped by both itineraryId + itemType.
    const whereArg = prisma.itineraryItem.findMany.mock.calls[0][0].where;
    expect(whereArg).toMatchObject({ itineraryId: 100, itemType: 'hotel' });
  });

  test('null money fields treated as 0 — no NaN in totals or grand', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([
      // Row 1: every money field null — must contribute 0, not NaN.
      makeItem({ itemType: 'transfer' }),
      // Row 2: only totalPrice populated, the other 3 stay null.
      makeItem({
        itemType: 'transfer',
        unitCost: null, markup: null, gstAmount: null, totalPrice: '1500.00',
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(2);
    // No NaN anywhere — every sum is finite.
    expect(res.body.grand.totalUnitCost).toBe(0);
    expect(res.body.grand.totalMarkup).toBe(0);
    expect(res.body.grand.totalGstAmount).toBe(0);
    expect(res.body.grand.totalPrice).toBe(1500);
    expect(res.body.byItemType.transfer).toEqual({
      count: 2,
      totalUnitCost: 0,
      totalMarkup: 0,
      totalGstAmount: 0,
      totalPrice: 1500,
    });
    // Defensive — no NaN leaked into any bucket.
    for (const t of ALL_TYPES) {
      const b = res.body.byItemType[t];
      expect(Number.isFinite(b.totalUnitCost)).toBe(true);
      expect(Number.isFinite(b.totalMarkup)).toBe(true);
      expect(Number.isFinite(b.totalGstAmount)).toBe(true);
      expect(Number.isFinite(b.totalPrice)).toBe(true);
    }
  });

  test('half-up 2dp rounding via Number.EPSILON — penny-irregular sums round cleanly', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    // Three rows that sum to 6000.01 / 1.005 / 0.015 — exercising the
    // Number.EPSILON guard against the classic 0.1 + 0.2 = 0.30000000000000004
    // floating-point drift.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ itemType: 'flight', unitCost: '1000.005', totalPrice: '1000.005' }),
      makeItem({ itemType: 'flight', unitCost: '2000.005', totalPrice: '2000.005' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1000.005 + 2000.005 = 3000.01 — must NOT show 3000.0099999... etc.
    expect(res.body.byItemType.flight.totalUnitCost).toBe(3000.01);
    expect(res.body.byItemType.flight.totalPrice).toBe(3000.01);
    expect(res.body.grand.totalUnitCost).toBe(3000.01);
    expect(res.body.grand.totalPrice).toBe(3000.01);
  });
});

describe('GET /api/travel/itineraries/:id/totals — auth / scoping / validation', () => {
  test('cross-tenant or missing itinerary → 404 ITINERARY_NOT_FOUND', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_NOT_FOUND');
    // Items should NOT have been queried after parent-not-found.
    expect(prisma.itineraryItem.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('unknown ?itemType=X → 400 INVALID_ITEM_TYPE (rejects before prisma query)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/totals?itemType=spaceship')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
    expect(res.body.error).toMatch(/itemType must be one of/i);
    // Item query must NOT have run for a rejected filter.
    expect(prisma.itineraryItem.findMany).not.toHaveBeenCalled();
  });

  test('INVALID_ID non-numeric path param → 400', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/notanumber/totals')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.itinerary.findFirst).not.toHaveBeenCalled();
  });

  test('no auth header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/itineraries/100/totals');
    expect(res.status).toBe(401);
  });
});
