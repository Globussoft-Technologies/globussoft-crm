// @ts-check
/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice 22 — by-quarter endpoint tests.
 *
 * Pins the contract for the new tenant-wide quarterly rollup:
 *   GET /api/travel/flyer-templates/by-quarter
 *
 * Mirrors slice 21 (/flyer-templates/by-month) at quarter resolution.
 * One row per UTC YYYY-Qn bucket with count + activeCount +
 * archivedCount, plus grand totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens (Q0/Q5/YYYY-MM)
 *   - Happy path: 4 templates spanning Q2 + Q3 → 2 quarter rows with
 *     correct counts + quarter-asc ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-quarter window)
 *   - activeCount vs archivedCount split (1 archived in a quarter)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] only sees
 *     rfu + tenant-wide rows (where.OR carries the narrowing)
 *   - Pagination ?limit / ?offset
 *   - limit cap at 40 (not the by-month 60)
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when from/to is set
 *   - Calendar-quarter math: Jan-Mar=Q1, Apr-Jun=Q2, Jul-Sep=Q3, Oct-Dec=Q4
 *
 * Pattern mirrors travel-flyer-templates-by-month.test.js — patch
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

// Spread of templates across Q2 + Q3 2026, mixed isActive split.
//   2026-Q2 (Apr-Jun): 3 templates, 2 active + 1 archived
//     - 2026-05-02 (active), 2026-05-15 (active), 2026-06-04 (archived)
//   2026-Q3 (Jul-Sep): 1 template, 1 active + 0 archived
//     - 2026-08-10 (active)
const baseRows = [
  { isActive: true,  createdAt: new Date('2026-05-02T08:00:00Z') },
  { isActive: true,  createdAt: new Date('2026-05-15T10:30:00Z') },
  { isActive: false, createdAt: new Date('2026-06-04T18:45:00Z') },
  { isActive: true,  createdAt: new Date('2026-08-10T09:00:00Z') },
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

describe('GET /api/travel/flyer-templates/by-quarter (slice 22)', () => {
  test('400 INVALID_QUARTER_FORMAT on bad ?from token (Q5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelFlyerTemplate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on Q0 ?from token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?from=2026-Q0')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_QUARTER_FORMAT when ?from is a YYYY-MM token (slice-21 shape)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?from=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?to=2026Q2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 4 templates across Q2 + Q3 → 2 rows quarter:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.quarters).toHaveLength(2);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 3,
      activeCount: 2,
      archivedCount: 1,
    });
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q3',
      count: 1,
      activeCount: 1,
      archivedCount: 0,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('orderBy=count:desc puts the busier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[0].count).toBe(3);
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
    expect(res.body.quarters[1].count).toBe(1);
  });

  test('?from=2026-Q2&to=2026-Q2 narrows the bucket array to a single quarter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?from=2026-Q2&to=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandActiveCount).toBe(2);
  });

  test('activeCount vs archivedCount split: 1 archived row in Q2', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const q2 = res.body.quarters.find((q) => q.quarter === '2026-Q2');
    expect(q2.count).toBe(3);
    expect(q2.activeCount).toBe(2);
    expect(q2.archivedCount).toBe(1);
    // Per-row identity: count == activeCount + archivedCount
    for (const row of res.body.quarters) {
      expect(row.count).toBe(row.activeCount + row.archivedCount);
    }
  });

  test('calendar-quarter math: Jan→Q1, Apr→Q2, Jul→Q3, Oct→Q4', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-01-15T00:00:00Z') }, // Q1
      { isActive: true, createdAt: new Date('2026-04-15T00:00:00Z') }, // Q2
      { isActive: true, createdAt: new Date('2026-07-15T00:00:00Z') }, // Q3
      { isActive: true, createdAt: new Date('2026-10-15T00:00:00Z') }, // Q4
      { isActive: true, createdAt: new Date('2026-03-31T23:59:59Z') }, // still Q1 (Mar)
      { isActive: true, createdAt: new Date('2026-12-31T23:59:59Z') }, // Q4 (Dec)
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(4);
    const tokens = res.body.quarters.map((q) => q.quarter);
    expect(tokens).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
    const counts = Object.fromEntries(
      res.body.quarters.map((q) => [q.quarter, q.count]),
    );
    expect(counts['2026-Q1']).toBe(2); // Jan-15 + Mar-31
    expect(counts['2026-Q2']).toBe(1);
    expect(counts['2026-Q3']).toBe(1);
    expect(counts['2026-Q4']).toBe(2); // Oct-15 + Dec-31
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
      .get('/api/travel/flyer-templates/by-quarter')
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
      .get('/api/travel/flyer-templates/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.quarters).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q3.
    expect(res.body.quarters[0].quarter).toBe('2026-Q3');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit cap at 40 (a request for 200 caps at 40, not the by-month 60)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?limit=200')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(40);
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter');

    expect(res.status).toBe(401);
    expect(prisma.travelFlyerTemplate.findMany).not.toHaveBeenCalled();
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-02T08:00:00Z') }, // Q2
      { isActive: true, createdAt: null },
      { isActive: false, createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-Q2 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.quarters.find((q) => q.quarter === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.activeCount).toBe(1);
    expect(unknown.archivedCount).toBe(1);
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-02T08:00:00Z') }, // Q2
      { isActive: true, createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
