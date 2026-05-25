// @ts-check
/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice 23 — by-year endpoint tests.
 *
 * Pins the contract for the new tenant-wide annual rollup:
 *   GET /api/travel/flyer-templates/by-year
 *
 * Completes the by-month / by-quarter / by-year triplet (slices
 * 21 + 22 + 23). Mirrors slice 22 (/flyer-templates/by-quarter) at
 * year resolution. One row per UTC YYYY bucket with count +
 * activeCount + archivedCount, plus grand totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_YEAR_FORMAT on bad ?from / ?to tokens (YYYY-Qn,
 *     YYYY-MM, 3-digit, 5-digit)
 *   - Happy path: 4 templates spanning 2025 + 2026 → 2 year rows with
 *     correct counts + year-asc ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-year window)
 *   - activeCount vs archivedCount split (1 archived in a year)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] only sees
 *     rfu + tenant-wide rows (where.OR carries the narrowing)
 *   - Pagination ?limit / ?offset
 *   - limit cap at 30 (not the by-quarter 40)
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when from/to is set
 *   - Calendar-year math: getUTCFullYear() — Dec-31 23:59:59 UTC stays
 *     in that year, Jan-01 00:00:00 UTC starts the next
 *   - Unknown orderBy degrades silently to year:asc
 *   - No audit row written (read-only meta endpoint)
 *
 * Pattern mirrors travel-flyer-templates-by-quarter.test.js — patch
 * prisma BEFORE requiring the router, drive with real HS256 JWTs
 * against the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelFlyerTemplate = prisma.travelFlyerTemplate || {};
prisma.travelFlyerTemplate.findMany = vi.fn();
prisma.travelFlyerTemplate.findFirst = prisma.travelFlyerTemplate.findFirst || vi.fn();
prisma.travelFlyerTemplate.count = prisma.travelFlyerTemplate.count || vi.fn();
prisma.travelFlyerTemplate.create = prisma.travelFlyerTemplate.create || vi.fn();
prisma.travelFlyerTemplate.update = prisma.travelFlyerTemplate.update || vi.fn();
prisma.travelFlyerTemplate.delete = prisma.travelFlyerTemplate.delete || vi.fn();
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
const templatesRouter = requireCJS('../../routes/travel_flyer_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', templatesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of templates across 2025 + 2026, mixed isActive split.
//   2025: 3 templates, 2 active + 1 archived
//     - 2025-03-12 (active), 2025-07-04 (active), 2025-11-20 (archived)
//   2026: 1 template, 1 active + 0 archived
//     - 2026-05-10 (active)
const baseRows = [
  { isActive: true,  createdAt: new Date('2025-03-12T08:00:00Z') },
  { isActive: true,  createdAt: new Date('2025-07-04T10:30:00Z') },
  { isActive: false, createdAt: new Date('2025-11-20T18:45:00Z') },
  { isActive: true,  createdAt: new Date('2026-05-10T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelFlyerTemplate.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/flyer-templates/by-year (slice 23)', () => {
  test('400 INVALID_YEAR_FORMAT on YYYY-Qn ?from token (slice-22 shape)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?from=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelFlyerTemplate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on YYYY-MM ?from token (slice-21 shape)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?from=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on 3-digit ?from token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?from=202')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on 5-digit ?to token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?to=20266')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 4 templates across 2025 + 2026 → 2 rows year:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.years).toHaveLength(2);
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 3,
      activeCount: 2,
      archivedCount: 1,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 1,
      activeCount: 1,
      archivedCount: 0,
    });
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('orderBy=count:desc puts the busier year first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].count).toBe(3);
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.years[1].count).toBe(1);
  });

  test('?from=2025&to=2025 narrows the bucket array to a single year', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?from=2025&to=2025')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandActiveCount).toBe(2);
  });

  test('activeCount vs archivedCount split: 1 archived row in 2025', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const y2025 = res.body.years.find((y) => y.year === '2025');
    expect(y2025.count).toBe(3);
    expect(y2025.activeCount).toBe(2);
    expect(y2025.archivedCount).toBe(1);
    // Per-row identity: count == activeCount + archivedCount
    for (const row of res.body.years) {
      expect(row.count).toBe(row.activeCount + row.archivedCount);
    }
  });

  test('calendar-year math: getUTCFullYear() — boundaries Dec-31 23:59:59Z stays in year, Jan-01 00:00:00Z starts next', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2024-12-31T23:59:59Z') }, // 2024
      { isActive: true, createdAt: new Date('2025-01-01T00:00:00Z') }, // 2025
      { isActive: true, createdAt: new Date('2025-12-31T23:59:59Z') }, // 2025
      { isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') }, // 2026
      { isActive: true, createdAt: new Date('2026-06-15T12:00:00Z') }, // 2026
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(3);
    const tokens = res.body.years.map((y) => y.year);
    expect(tokens).toEqual(['2024', '2025', '2026']);
    const counts = Object.fromEntries(
      res.body.years.map((y) => [y.year, y.count]),
    );
    expect(counts['2024']).toBe(1); // Dec-31 23:59:59Z
    expect(counts['2025']).toBe(2); // Jan-01 + Dec-31
    expect(counts['2026']).toBe(2); // Jan-01 + Jun-15
  });

  test('MANAGER subBrandAccess=[rfu] threads OR clause into Prisma where', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelFlyerTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.OR).toBeTruthy();
    const subBrandClauses = call.where.OR;
    const hasRfuIn = subBrandClauses.some(
      (c) => c.subBrand && c.subBrand.in && c.subBrand.in.includes('rfu'),
    );
    const hasNull = subBrandClauses.some(
      (c) => c.subBrand === null,
    );
    expect(hasRfuIn).toBe(true);
    expect(hasNull).toBe(true);
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.years).toHaveLength(1);
    // Default order is year:asc → offset=1 returns 2026.
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].count).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit cap at 30 (a request for 200 caps at 30, not the by-quarter 40)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?limit=200')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year');

    expect(res.status).toBe(401);
    expect(prisma.travelFlyerTemplate.findMany).not.toHaveBeenCalled();
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-02T08:00:00Z') }, // 2026
      { isActive: true, createdAt: null },
      { isActive: false, createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.years.find((y) => y.year === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.activeCount).toBe(1);
    expect(unknown.archivedCount).toBe(1);
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-02T08:00:00Z') }, // 2026
      { isActive: true, createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?from=2025')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to year:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
