// @ts-check
/**
 * PRD §4.6 — GET /api/travel/webcheckins/by-month tenant-wide WebCheckin
 * creation rollup by UTC YYYY-MM. Pairs with /webcheckins/stats (the
 * at-a-glance snapshot) — this endpoint provides the trend-over-time
 * surface that powers the WebCheckin operations dashboard chart strip.
 *
 * Mirrors the by-month template shipped on:
 *   - /flyer-templates/by-month (slice 21)
 *   - /quotes/by-month (slice 16)
 *   - /invoices/by-month (slice 29)
 *
 * Same UTC YYYY-MM bucketing template, same defensive "unknown" bucket
 * math, same orderBy + pagination semantics. delivered/pending split is
 * the WebCheckin analogue of the flyer active/archived split.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 4 webcheckins across 2 months → 2 rows with correct
 *     count + deliveredCount + pendingCount totals
 *   - Sort: ?orderBy=count:desc puts busier month first
 *   - ?from / ?to narrows the bucket array
 *   - Sub-brand MANAGER (subBrandAccess=['rfu']) — visible Itinerary
 *     id-set resolved first, then WebCheckin narrowed by itineraryId IN
 *   - 401 when no Authorization header
 *
 * Test pattern mirrors travel-webcheckins-stats.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret. verifyToken + requireTravelTenant + getSubBrandAccessSet all
 * run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.webCheckin = prisma.webCheckin || {};
prisma.webCheckin.findMany = vi.fn();
prisma.webCheckin.count = prisma.webCheckin.count || vi.fn();
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

// Spread of webcheckins across May + June 2026, mixed delivered/pending.
//   2026-05: 3 webcheckins, 2 delivered + 1 pending
//   2026-06: 1 webcheckin, 0 delivered + 1 pending
const baseRows = [
  { createdAt: new Date('2026-05-02T08:00:00Z'), deliveredAt: new Date('2026-05-03T10:00:00Z') },
  { createdAt: new Date('2026-05-15T10:30:00Z'), deliveredAt: new Date('2026-05-16T11:00:00Z') },
  { createdAt: new Date('2026-05-28T18:45:00Z'), deliveredAt: null },
  { createdAt: new Date('2026-06-04T09:00:00Z'), deliveredAt: null },
];

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset().mockResolvedValue(baseRows);
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

describe('GET /api/travel/webcheckins/by-month', () => {
  test('400 INVALID_MONTH_FORMAT on bad ?from token (e.g. month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on short ?from token (e.g. "26")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 4 webcheckins across 2 months → 2 rows month:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandDeliveredCount).toBe(2);
    expect(res.body.months).toHaveLength(2);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 3,
      deliveredCount: 2,
      pendingCount: 1,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      count: 1,
      deliveredCount: 0,
      pendingCount: 1,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
    // Per-row identity: count == deliveredCount + pendingCount
    for (const row of res.body.months) {
      expect(row.count).toBe(row.deliveredCount + row.pendingCount);
    }
  });

  test('orderBy=count:desc puts the busier month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].count).toBe(3);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].count).toBe(1);
  });

  test('orderBy=deliveredCount:desc puts the better-followed-through month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?orderBy=deliveredCount:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].deliveredCount).toBe(2);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].deliveredCount).toBe(0);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single month', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandDeliveredCount).toBe(2);
  });

  test('MANAGER subBrandAccess=[rfu] → visible Itinerary id-set resolved, WebCheckin narrowed by itineraryId IN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // First Itinerary.findMany = visible-itinerary id-set resolution.
    prisma.itinerary.findMany.mockResolvedValueOnce([
      { id: 201 },
      { id: 202 },
    ]);
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-10T08:00:00Z'), deliveredAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.grandCount).toBe(1);

    // Verify the Itinerary id-set query carried the sub-brand filter.
    const itinWhere = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(itinWhere.tenantId).toBe(1);
    expect(itinWhere.subBrand).toEqual({ in: ['rfu'] });

    // Verify the WebCheckin query was narrowed by itineraryId IN visible-set.
    const wcWhere = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(wcWhere.tenantId).toBe(1);
    expect(wcWhere.itineraryId).toEqual({ in: [201, 202] });
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month');

    expect(res.status).toBe(401);
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandDeliveredCount).toBe(2);
    expect(res.body.months).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), deliveredAt: null },
      { createdAt: null, deliveredAt: null },
      { createdAt: new Date('not a date'), deliveredAt: new Date('2026-06-01T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.months.find((m) => m.month === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.deliveredCount).toBe(1);
    expect(unknown.pendingCount).toBe(1);
  });
});
