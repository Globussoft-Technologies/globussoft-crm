// @ts-check
/**
 * PRD_TRAVEL_PRICING §3 — GET /api/travel/pricing/by-year
 * tenant-wide pricing-config annual rollup.
 *
 * Calendar-year complement to /pricing/by-month. Pricing config moves
 * on a yearly cadence (season calendars re-published per trip year,
 * markup-rule cohorts refreshed annually), so the year bucket is the
 * natural surface for the "last decade of pricing churn" trend.
 *
 * Pins the contract for the new tenant-wide UTC YYYY rollup that pairs
 * with /pricing/by-month + /pricing/stats. Buckets BOTH
 * TravelSeasonCalendar AND TravelMarkupRule rows by createdAt into the
 * same year buckets — seasonCount + markupCount + totalCount per row,
 * plus grand-totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_YEAR_FORMAT on bad ?from / ?to tokens
 *   - Happy path: seasons + markup rules across 2 UTC years → 2 year
 *     rows with correct seasonCount/markupCount/totalCount splits
 *   - Sort: ?orderBy=seasonCount:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-year window)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     subBrand: { in: ['rfu'] } into BOTH season + rule queries
 *   - Empty bucket list (zero rows) returns stable envelope
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Pagination: ?limit + ?offset slice AFTER aggregation
 *   - Limit cap at 30 even when ?limit=999 requested
 *   - No audit row on read-only endpoint
 *
 * Test pattern mirrors travel-pricing-by-month.test.js — patch prisma
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

// Spread: 3 seasons + 2 markup rules across 2025 + 2026 UTC years.
//   2025: 2 seasons + 1 markup = 3 total
//   2026: 1 season + 1 markup = 2 total
const baseSeasons = [
  { createdAt: new Date('2025-03-02T08:00:00Z') },
  { createdAt: new Date('2025-11-15T10:30:00Z') },
  { createdAt: new Date('2026-05-15T10:30:00Z') },
];
const baseRules = [
  { createdAt: new Date('2025-06-20T12:00:00Z') },
  { createdAt: new Date('2026-02-04T09:00:00Z') },
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
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel/pricing/by-year', () => {
  test('400 INVALID_YEAR_FORMAT on bad ?from token (e.g. 3-digit year)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?from=202')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?to token (YYYY-MM shape rejected)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 3 seasons + 2 markup rules across 2 years → correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandSeasonCount).toBe(3);
    expect(res.body.grandMarkupCount).toBe(2);
    expect(res.body.grandTotalCount).toBe(5);
    expect(res.body.years).toHaveLength(2);

    // Default order is year:asc.
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      seasonCount: 2,
      markupCount: 1,
      totalCount: 3,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      seasonCount: 1,
      markupCount: 1,
      totalCount: 2,
    });
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);

    // Per-row identity: totalCount === seasonCount + markupCount
    for (const row of res.body.years) {
      expect(row.totalCount).toBe(row.seasonCount + row.markupCount);
    }
  });

  test('orderBy=seasonCount:desc puts the season-heavier year first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?orderBy=seasonCount:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 2025 has 2 seasons; 2026 has 1.
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].seasonCount).toBe(2);
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.years[1].seasonCount).toBe(1);
  });

  test('?from=2026&to=2026 narrows the bucket array to a single year', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandSeasonCount).toBe(1);
    expect(res.body.grandMarkupCount).toBe(1);
    expect(res.body.grandTotalCount).toBe(2);
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
      .get('/api/travel/pricing/by-year')
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

  test('empty buckets for zero-row tenant returns stable envelope', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      years: [],
      totalYears: 0,
      grandSeasonCount: 0,
      grandMarkupCount: 0,
      grandTotalCount: 0,
      limit: 10,
      offset: 0,
    });
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year');

    expect(res.status).toBe(401);
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row with stable totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect FULL aggregation, not paged window.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandSeasonCount).toBe(3);
    expect(res.body.grandMarkupCount).toBe(2);
    expect(res.body.years).toHaveLength(1);
    // Default order is year:asc → offset=1 returns 2026.
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit caps at 30 even when ?limit=999 is requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('unknown orderBy token degrades silently to year:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-year?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });
});
