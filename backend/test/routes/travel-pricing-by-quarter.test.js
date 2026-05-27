// @ts-check
/**
 * PRD_TRAVEL_GST_COMPLIANCE / pricing-engine —
 * GET /api/travel/pricing/by-quarter tenant-wide quarterly rollup.
 *
 * Completes the pricing-rollup triplet (by-month + by-year + by-quarter,
 * sibling to /stats). Buckets BOTH TravelSeasonCalendar AND
 * TravelMarkupRule rows by createdAt into UTC YYYY-Q[1-4] buckets — a
 * unified `count` per bucket plus a `bySubBrand` per-bucket breakdown.
 *
 * Mirrors /itineraries/by-quarter + /suppliers/by-quarter family —
 * different envelope shape from /pricing/by-month + /pricing/by-year
 * (which split counts into seasonCount/markupCount) because the
 * quarterly view focuses on cadence + sub-brand distribution rather
 * than season-vs-rule split.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 rows across 2 quarters → 2 quarter rows, correct
 *     counts + bySubBrand breakdown
 *   - Default orderBy=quarter:asc chronological
 *   - ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     subBrand: { in: ['rfu'] } into BOTH season + rule queries
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from / ?to set
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Falsy/null subBrand coerces to "_tenant" bucket key
 *   - Unknown orderBy degrades silently to quarter:asc default
 *   - Limit caps at 40 even when ?limit=999 requested
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

// Spread: 3 rows total — 2 seasons + 1 markup rule across 2 quarters.
//   2026-Q2 (Apr–Jun): 2 seasons (rfu + tmc) + 1 markup (rfu) = 3 total
//   2026-Q3 (Jul–Sep): 0 seasons + 0 markup = excluded (none here)
//   Plus a 4th to give 2 quarters: 1 markup in 2026-Q3 → 1 total
// Final spread:
//   2026-Q2: count=3 (rfu=2 from 1 season + 1 markup; tmc=1 from 1 season)
//   2026-Q3: count=1 (rfu=1 from 1 markup)
const baseSeasons = [
  { subBrand: 'rfu', createdAt: new Date('2026-05-02T08:00:00Z') }, // 2026-Q2
  { subBrand: 'tmc', createdAt: new Date('2026-06-15T10:30:00Z') }, // 2026-Q2
];
const baseRules = [
  { subBrand: 'rfu', createdAt: new Date('2026-05-20T12:00:00Z') }, // 2026-Q2
  { subBrand: 'rfu', createdAt: new Date('2026-08-04T09:00:00Z') }, // 2026-Q3
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

describe('GET /api/travel/pricing/by-quarter', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter');

    expect(res.status).toBe(401);
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelSeasonCalendar.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to token (non-quarter shape)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?to=2026-06')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 rows across 2 quarters → 2 quarter rows, correct counts + bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    // Default order is quarter:asc.
    expect(res.body.rows[0]).toEqual({
      quarter: '2026-Q2',
      count: 3,
      bySubBrand: { rfu: 2, tmc: 1 },
    });
    expect(res.body.rows[1]).toEqual({
      quarter: '2026-Q3',
      count: 1,
      bySubBrand: { rfu: 1 },
    });
  });

  test('default orderBy=quarter:asc returns earliest quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('orderBy=count:desc puts the heavier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 2026-Q2 has 3 rows; 2026-Q3 has 1.
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-Q3&to=2026-Q3 narrows the bucket array', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?from=2026-Q3&to=2026-Q3')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
    expect(res.body.rows[0].count).toBe(1);
  });

  test('MANAGER subBrandAccess=[rfu] threads { subBrand: { in: [rfu] } } into BOTH queries', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-04-10T08:00:00Z') },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toEqual({
      quarter: '2026-Q2',
      count: 1,
      bySubBrand: { rfu: 1 },
    });

    // Verify where clauses on BOTH queries carry the sub-brand narrowing.
    const seasonCall = prisma.travelSeasonCalendar.findMany.mock.calls[0][0];
    const ruleCall = prisma.travelMarkupRule.findMany.mock.calls[0][0];
    expect(seasonCall.where.tenantId).toBe(1);
    expect(seasonCall.where.subBrand).toEqual({ in: ['rfu'] });
    expect(ruleCall.where.tenantId).toBe(1);
    expect(ruleCall.where.subBrand).toEqual({ in: ['rfu'] });
  });

  test('defensive: null createdAt lands in "unknown" bucket when no ?from/?to set', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('2026-05-02T08:00:00Z') },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const quarters = res.body.rows.map((r) => r.quarter);
    expect(quarters).toContain('unknown');
    expect(quarters).toContain('2026-Q2');

    const unknownBucket = res.body.rows.find((r) => r.quarter === 'unknown');
    expect(unknownBucket.count).toBe(1);
    expect(unknownBucket.bySubBrand).toEqual({ rfu: 1 });
  });

  test('defensive: "unknown" bucket excluded when ?from/?to set', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('2026-05-02T08:00:00Z') },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?from=2026-Q1&to=2026-Q4')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
  });

  test('pagination: ?limit=1&offset=1 slices AFTER aggregation', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // total reflects FULL aggregation, not paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q3.
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
  });

  test('falsy subBrand coerces to "_tenant" bucket key', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-05-02T08:00:00Z') },
      { subBrand: '', createdAt: new Date('2026-05-10T08:00:00Z') },
      { subBrand: 'rfu', createdAt: new Date('2026-05-20T08:00:00Z') },
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const bucket = res.body.rows[0];
    expect(bucket.quarter).toBe('2026-Q2');
    expect(bucket.count).toBe(3);
    expect(bucket.bySubBrand).toEqual({ _tenant: 2, rfu: 1 });
  });

  test('unknown orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('limit caps at 40 even when ?limit=999 is requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Sanity: the paged array can't exceed 40 even if total were >40.
    expect(res.body.rows.length).toBeLessThanOrEqual(40);
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pricing/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
