// @ts-check
/**
 * Travel CRM — GET /api/travel-curriculum/by-month
 * tenant-wide TravelCurriculumMapping monthly rollup
 * (PRD_TRAVEL_TMC §3, Arc 2 Travel Gap).
 *
 * Mirrors #903 slice 24 /suppliers/by-month + #908 slice 21
 * /flyer-templates/by-month + #900 slice 16 /quotes/by-month — same
 * UTC YYYY-MM bucketing template, same defensive math (null/invalid
 * createdAt → "unknown" bucket; excluded when ?from / ?to is set, kept
 * otherwise so count surface stays accurate), same pagination-after-
 * aggregation posture.
 *
 * Pins the contract for the new route handler added at
 * backend/routes/travel_curriculum.js (placed BEFORE the /:id family so
 * the literal-path /by-month wins over the :id matcher — Express
 * ordering; same convention as /stats).
 *
 * Why no sub-brand bucket
 * -----------------------
 * Per the route file's header (L11-15) and the sibling /stats handler:
 * curriculum authoring is tenant-wide ADMIN, not sub-brand-scoped. The
 * route mounts at /api/travel-curriculum (sibling-flat with
 * /api/embassy-rules) rather than under /api/travel/* prefix. There is
 * no requireTravelTenant / getSubBrandAccessSet machinery in this route
 * file. The /by-month endpoint follows the same posture — no bySubBrand
 * surface, no MANAGER narrowing test, no sub-brand access pin. The
 * TravelCurriculumMapping model has no subBrand column.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 mappings across 2 months → 2 month rows with correct
 *     counts + month-asc default ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-month window)
 *   - Sub-brand neutrality: ANY role (incl USER) returns 200; route does
 *     NOT consult getSubBrandAccessSet — authoring is tenant-wide
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when from/to is set
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation
 *   - Unknown orderBy token degrades to default (month:asc)
 *   - Tenant isolation: WHERE clause includes tenantId on findMany
 *
 * Test pattern mirrors backend/test/routes/travel-curriculum-stats.test.js
 * — patch the prisma singleton BEFORE requiring the router, drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Patch prisma BEFORE requiring the router (CJS self-mocking — patch on
// the SAME require() path the route uses).
prisma.travelCurriculumMapping = {
  ...(prisma.travelCurriculumMapping || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const travelCurriculumRouter = requireCJS('../../routes/travel_curriculum');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel-curriculum', travelCurriculumRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of curriculum mappings across May + June 2026.
//   2026-05: 2 mappings
//   2026-06: 1 mapping
const baseRows = [
  { createdAt: new Date('2026-05-03T08:00:00Z') },
  { createdAt: new Date('2026-05-17T10:30:00Z') },
  { createdAt: new Date('2026-06-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.travelCurriculumMapping.count.mockReset();
});

describe('GET /api/travel-curriculum/by-month', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel-curriculum/by-month');
    expect(res.status).toBe(401);
  });

  test('?from with invalid format → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('?to with invalid format → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?to=not-a-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 3 mappings across 2 months → 2 month rows; correct counts', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    const byMonth = Object.fromEntries(res.body.rows.map((r) => [r.month, r.count]));
    expect(byMonth['2026-05']).toBe(2);
    expect(byMonth['2026-06']).toBe(1);
  });

  test('default orderBy=month:asc → chronological order', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('?orderBy=count:desc → flips ordering (highest count first)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05'); // 2 mappings
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].month).toBe('2026-06'); // 1 mapping
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from/?to narrows the bucket array (single-month window)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?from=2026-06&to=2026-06')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-06');
    expect(res.body.rows[0].count).toBe(1);
  });

  test('sub-brand neutrality: USER role returns 200 (no sub-brand gate; tenant-wide endpoint)', async () => {
    // Curriculum authoring is tenant-wide ADMIN per route header
    // L11-15; the endpoint does NOT consult getSubBrandAccessSet, and
    // the response shape is anodyne (counts + month tokens). USER role
    // gets the same envelope as ADMIN.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
  });

  test('defensive: null createdAt → "unknown" bucket; excluded when ?from/?to is set', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      ...baseRows,
      { createdAt: null },
    ]);

    // No filter: "unknown" bucket present.
    const r1 = await request(makeApp())
      .get('/api/travel-curriculum/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r1.status).toBe(200);
    const months1 = r1.body.rows.map((r) => r.month);
    expect(months1).toContain('unknown');

    // With ?from set: "unknown" excluded.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      ...baseRows,
      { createdAt: null },
    ]);
    const r2 = await request(makeApp())
      .get('/api/travel-curriculum/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r2.status).toBe(200);
    const months2 = r2.body.rows.map((r) => r.month);
    expect(months2).not.toContain('unknown');
  });

  test('?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    // 4 distinct months → after default month:asc sort:
    //   2026-03, 2026-04, 2026-05, 2026-06
    // With limit=2 offset=1 we expect rows = [2026-04, 2026-05].
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      { createdAt: new Date('2026-03-10T00:00:00Z') },
      { createdAt: new Date('2026-04-10T00:00:00Z') },
      { createdAt: new Date('2026-05-10T00:00:00Z') },
      { createdAt: new Date('2026-06-10T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4); // pre-pagination bucket count
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].month).toBe('2026-04');
    expect(res.body.rows[1].month).toBe('2026-05');
  });

  test('unknown ?orderBy token degrades to default (month:asc)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?orderBy=garbage:weird')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Same chronological order as default.
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('tenant isolation: WHERE clause includes tenantId on findMany', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.travelCurriculumMapping.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(42);
    // Empty population → zero buckets.
    expect(res.body.total).toBe(0);
    expect(res.body.rows).toEqual([]);
  });

  test('limit caps at 60 (request larger value is clamped)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-month?limit=500')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only 2 months exist; cap is invisible in row count but the slice
    // should not error.
    expect(res.body.rows).toHaveLength(2);
  });
});
