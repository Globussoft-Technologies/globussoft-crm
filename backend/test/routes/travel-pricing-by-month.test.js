// @ts-check
/**
 * PRD_TRAVEL_PRICING §3 — GET /api/travel/pricing/by-month
 * tenant-wide pricing-config monthly rollup.
 *
 * Pins the contract for the new tenant-wide UTC YYYY-MM rollup that
 * pairs with /pricing/stats (`5feca84c`). Buckets BOTH
 * TravelSeasonCalendar AND TravelMarkupRule rows by createdAt into the
 * same month buckets — seasonCount + markupCount + totalCount per row,
 * plus grand-totals for the page header.
 *
 * Mirrors #908 slice 21 (/flyer-templates/by-month) + #900 slice 16
 * (/quotes/by-month) — same UTC bucketing template, same ?from / ?to
 * narrowing semantics, same pagination posture.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 2 seasons + 2 markup rules across 2 UTC months → 2
 *     month rows with correct seasonCount/markupCount/totalCount splits
 *   - Sort: ?orderBy=seasonCount:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-month window)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     subBrand: { in: ['rfu'] } into BOTH season + rule queries
 *   - Empty bucket list (zero rows) returns stable envelope
 *   - 401 when no Authorization header (verifyToken gate)
 *
 * Test pattern mirrors travel-pricing-stats.test.js — patch prisma
 * BEFORE requiring the router, drive supertest with HS256 JWTs against
 * the dev-fallback secret.
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

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread: 2 seasons + 2 markup rules across May + June 2026.
//   2026-05: 2 seasons + 1 markup = 3 total
//   2026-06: 0 seasons + 1 markup = 1 total
const baseSeasons = [
  { createdAt: new Date('2026-05-02T08:00:00Z') },
  { createdAt: new Date('2026-05-15T10:30:00Z') },
];
const baseRules = [
  { createdAt: new Date('2026-05-20T12:00:00Z') },
  { createdAt: new Date('2026-06-04T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelSeasonCalendar.findMany.mockReset().mockResolvedValue(baseSeasons);
  prisma.travelMarkupRule.findMany.mockReset().mockResolvedValue(baseRules);
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

describe('GET /api/travel/pricing/by-month', () => {
  test('400 INVALID_MONTH_FORMAT on bad ?from token (e.g. month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to token (non-ISO shape)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 2 seasons + 2 markup rules across 2 months → correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandSeasonCount).toBe(2);
    expect(res.body.grandMarkupCount).toBe(2);
    expect(res.body.grandTotalCount).toBe(4);
    expect(res.body.months).toHaveLength(2);

    // Default order is month:asc.
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      seasonCount: 2,
      markupCount: 1,
      totalCount: 3,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      seasonCount: 0,
      markupCount: 1,
      totalCount: 1,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);

    // Per-row identity: totalCount === seasonCount + markupCount
    for (const row of res.body.months) {
      expect(row.totalCount).toBe(row.seasonCount + row.markupCount);
    }
  });

  test('orderBy=seasonCount:desc puts the season-heavier month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?orderBy=seasonCount:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 2026-05 has 2 seasons; 2026-06 has 0.
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].seasonCount).toBe(2);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].seasonCount).toBe(0);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single month', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandSeasonCount).toBe(2);
    expect(res.body.grandMarkupCount).toBe(1);
    expect(res.body.grandTotalCount).toBe(3);
  });

  test('MANAGER subBrandAccess=[rfu] threads { subBrand: { in: [rfu] } } into BOTH queries', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.grandSeasonCount).toBe(1);
    expect(res.body.grandMarkupCount).toBe(0);

    // Verify where clauses on BOTH queries carry the sub-brand narrowing.
    const seasonCall = prisma.travelSeasonCalendar.findMany.mock.calls[0][0];
    const ruleCall = prisma.travelMarkupRule.findMany.mock.calls[0][0];
    expect(seasonCall.where.tenantId).toBe(1);
    expect(seasonCall.where.subBrand).toEqual({ in: ['rfu'] });
    expect(ruleCall.where.tenantId).toBe(1);
    expect(ruleCall.where.subBrand).toEqual({ in: ['rfu'] });
  });

  test('empty buckets pre-seeded for unbounded query (0 rows in DB → stable envelope)', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      months: [],
      totalMonths: 0,
      grandSeasonCount: 0,
      grandMarkupCount: 0,
      grandTotalCount: 0,
      limit: 12,
      offset: 0,
    });
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month');

    expect(res.status).toBe(401);
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row with stable totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect FULL aggregation, not paged window.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandSeasonCount).toBe(2);
    expect(res.body.grandMarkupCount).toBe(2);
    expect(res.body.months).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit caps at 60 even when ?limit=999 is requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(60);
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('unknown orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-month?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[1].month).toBe('2026-06');
  });
});
