// @ts-check
/**
 * PRD §4.6 — GET /api/travel/webcheckins/stats tenant-wide WebCheckin
 * rollup. Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
 * /commission-profiles/stats + #908 slice 19 /flyer-templates/global-stats.
 * USER-readable anodyne aggregate that powers a WebCheckin operations
 * dashboard tile strip. Pins the contract for the new route handler
 * added at backend/routes/travel_webcheckin.js (placed BEFORE the /:id
 * family so the literal-path /stats wins over the :id matcher — same
 * trap as /upcoming).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastDeliveredAt=null.
 *   - Happy path:          4 webcheckins (mix delivered + pending +
 *                          upcoming-window) → correct counts +
 *                          byAirline/bySubBrand buckets + lastDeliveredAt
 *                          is the max(deliveredAt).
 *   - Cross-tenant:        the WHERE clause includes tenantId scoped
 *                          to req.travelTenant.id; rows from another
 *                          tenant cannot leak in.
 *   - Sub-brand MANAGER:   subBrandAccess=['rfu'] resolves the visible
 *                          Itinerary id-set first, then narrows
 *                          WebCheckin.itineraryId IN — verified by
 *                          inspecting the mock call args.
 *   - USER role:           returns 200 (anodyne aggregate).
 *   - Auth gate:           no token → 401.
 *   - ?from/?to bounds:    valid ISO → passed through as createdAt
 *                          gte/lte; invalid → 400 INVALID_DATE.
 *   - upcomingWindow:      windowOpenAt < now+48h AND deliveredAt IS
 *                          NULL counts toward upcomingWindow; rows
 *                          delivered or window-far-future do NOT.
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
prisma.webCheckin = prisma.webCheckin || {};
prisma.webCheckin.findMany = vi.fn();
prisma.webCheckin.count = vi.fn();
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = vi.fn();
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
const travelWebcheckinRouter = requireCJS('../../routes/travel_webcheckin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelWebcheckinRouter);
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
  prisma.webCheckin.findMany.mockReset();
  prisma.webCheckin.count.mockReset();
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
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

describe('GET /api/travel/webcheckins/stats', () => {
  test('empty tenant → all-zeros envelope with empty bucket maps', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    prisma.webCheckin.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      delivered: 0,
      pending: 0,
      upcomingWindow: 0,
      byAirline: {},
      bySubBrand: {},
      lastDeliveredAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path: 4 webcheckins (mix delivered + pending + upcoming) → correct counts', async () => {
    const now = Date.now();
    const inOneHour = new Date(now + 60 * 60 * 1000); // < 48h horizon
    const inTwoHours = new Date(now + 2 * 60 * 60 * 1000); // < 48h horizon
    const inThreeDays = new Date(now + 3 * 24 * 60 * 60 * 1000); // > 48h
    const newest = new Date('2026-05-20T10:00:00Z');
    const older = new Date('2026-05-18T10:00:00Z');

    prisma.webCheckin.findMany.mockResolvedValue([
      // Delivered — counts as delivered + by-airline 6E + bySubBrand tmc
      {
        id: 1,
        airlineCode: '6E',
        itineraryId: 101,
        deliveredAt: older,
        windowOpenAt: new Date('2026-05-15T10:00:00Z'),
      },
      // Delivered — newest deliveredAt → drives lastDeliveredAt
      {
        id: 2,
        airlineCode: '6E',
        itineraryId: 101,
        deliveredAt: newest,
        windowOpenAt: new Date('2026-05-16T10:00:00Z'),
      },
      // Pending, window-soon — counts as pending + upcomingWindow
      {
        id: 3,
        airlineCode: 'AI',
        itineraryId: 102,
        deliveredAt: null,
        windowOpenAt: inOneHour,
      },
      // Pending, window-soon (no itinerary) — counts as pending +
      // upcomingWindow + bySubBrand _tenant
      {
        id: 4,
        airlineCode: 'AI',
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: inTwoHours,
      },
      // Pending, window-FAR — counts as pending but NOT upcomingWindow
      {
        id: 5,
        airlineCode: 'UK',
        itineraryId: 102,
        deliveredAt: null,
        windowOpenAt: inThreeDays,
      },
    ]);
    prisma.webCheckin.count.mockResolvedValue(5);
    // Itinerary sub-brand lookup batched at the end.
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 101, subBrand: 'tmc' },
      { id: 102, subBrand: 'rfu' },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.delivered).toBe(2);
    expect(res.body.pending).toBe(3);
    expect(res.body.upcomingWindow).toBe(2);
    expect(res.body.byAirline).toEqual({
      '6E': { count: 2 },
      AI: { count: 2 },
      UK: { count: 1 },
    });
    expect(res.body.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 2 },
      _tenant: { count: 1 },
    });
    expect(res.body.lastDeliveredAt).toBe(newest.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('cross-tenant: WHERE includes tenantId scoped to req.travelTenant.id', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    prisma.webCheckin.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(1);
    const countWhere = prisma.webCheckin.count.mock.calls[0][0].where;
    expect(countWhere.tenantId).toBe(1);
  });

  test('MANAGER with subBrandAccess=["rfu"] → query narrowed via itineraryId IN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // The route fetches visible Itinerary ids first.
    prisma.itinerary.findMany
      .mockResolvedValueOnce([{ id: 201 }, { id: 202 }]) // sub-brand resolution
      .mockResolvedValueOnce([
        { id: 201, subBrand: 'rfu' },
        { id: 202, subBrand: 'rfu' },
      ]); // final sub-brand lookup
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 10,
        airlineCode: 'SV',
        itineraryId: 201,
        deliveredAt: null,
        windowOpenAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ]);
    prisma.webCheckin.count.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });

    // First Itinerary.findMany was the sub-brand narrowing query.
    const itinWhere = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(itinWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(itinWhere.tenantId).toBe(1);

    // WebCheckin.findMany was narrowed by itineraryId IN visible-set.
    const wcWhere = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(wcWhere.itineraryId).toEqual({ in: [201, 202] });
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.webCheckin.findMany.mockResolvedValue([]);
    prisma.webCheckin.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/webcheckins/stats');
    expect(res.status).toBe(401);
  });

  test('?from / ?to ISO bounds passed to Prisma as createdAt gte/lte', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    prisma.webCheckin.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.gte.toISOString()).toBe(
      new Date('2026-05-01').toISOString(),
    );
    expect(whereArg.createdAt.lte.toISOString()).toBe(
      new Date('2026-05-31').toISOString(),
    );
  });

  test('invalid ?from → 400 INVALID_DATE', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('upcomingWindow: only undelivered rows whose windowOpenAt < now+48h count', async () => {
    const now = Date.now();
    const inHalfHour = new Date(now + 30 * 60 * 1000); // soon
    const inFiveDays = new Date(now + 5 * 24 * 60 * 60 * 1000); // far
    prisma.webCheckin.findMany.mockResolvedValue([
      // Delivered, window-soon → does NOT count toward upcomingWindow.
      {
        id: 1,
        airlineCode: '6E',
        itineraryId: null,
        deliveredAt: new Date('2026-05-19T10:00:00Z'),
        windowOpenAt: inHalfHour,
      },
      // Pending, window-soon → DOES count.
      {
        id: 2,
        airlineCode: '6E',
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: inHalfHour,
      },
      // Pending, window-far → does NOT count.
      {
        id: 3,
        airlineCode: 'AI',
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: inFiveDays,
      },
    ]);
    prisma.webCheckin.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.delivered).toBe(1);
    expect(res.body.pending).toBe(2);
    expect(res.body.upcomingWindow).toBe(1);
  });

  test('byAirline: missing airlineCode lands in `_unknown` bucket (defensive)', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 1,
        airlineCode: '6E',
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        id: 2,
        airlineCode: null,
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: new Date('2026-06-02T10:00:00Z'),
      },
      {
        id: 3,
        airlineCode: '',
        itineraryId: null,
        deliveredAt: null,
        windowOpenAt: new Date('2026-06-03T10:00:00Z'),
      },
    ]);
    prisma.webCheckin.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/webcheckins/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byAirline).toEqual({
      '6E': { count: 1 },
      _unknown: { count: 2 },
    });
  });
});
