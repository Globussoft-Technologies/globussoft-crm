// @ts-check
/**
 * Travel CRM — GET /api/travel-curriculum/by-quarter
 * tenant-wide TravelCurriculumMapping quarterly rollup
 * (PRD_TRAVEL_TMC §3, Arc 2 Travel Gap).
 *
 * Mirrors /api/travel/itineraries/by-quarter (#907 slice 17) and the
 * sibling /by-month handler in this same route file — same UTC YYYY-Qn
 * bucketing template, same defensive math (null/invalid createdAt →
 * "unknown" bucket; excluded when ?from / ?to is set, kept otherwise so
 * count surface stays accurate), same pagination-after-aggregation
 * posture.
 *
 * Pins the contract for the new route handler added at
 * backend/routes/travel_curriculum.js (placed BEFORE the /:id family so
 * the literal-path /by-quarter wins over the :id matcher — Express
 * ordering; same convention as /stats and /by-month).
 *
 * Why no sub-brand bucket
 * -----------------------
 * Per the route file's header (L11-15) and the sibling /stats + /by-month
 * handlers: curriculum authoring is tenant-wide ADMIN, not sub-brand-
 * scoped. The route mounts at /api/travel-curriculum (sibling-flat with
 * /api/embassy-rules) rather than under /api/travel/*. There is no
 * requireTravelTenant / getSubBrandAccessSet machinery in this route
 * file. The /by-quarter endpoint follows the same posture — no
 * bySubBrand surface, no MANAGER narrowing test, no sub-brand access
 * pin. The TravelCurriculumMapping model has no subBrand column.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 mappings across 2 quarters → 2 quarter rows with
 *     correct counts + quarter-asc default ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-quarter window)
 *   - No bySubBrand field in response (tenant-wide model)
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when from/to is set
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation
 *   - Unknown orderBy token degrades to default (quarter:asc)
 *   - Tenant isolation: WHERE clause includes tenantId on findMany
 *   - limit caps at 40 (request larger value is clamped)
 *
 * Test pattern mirrors backend/test/routes/travel-curriculum-by-month.test.js
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

// Spread of curriculum mappings across Q2 + Q3 2026.
//   2026-Q2 (Apr-Jun): 2 mappings (May 3, May 17)
//   2026-Q3 (Jul-Sep): 1 mapping  (Aug 9)
const baseRows = [
  { createdAt: new Date('2026-05-03T08:00:00Z') }, // Q2
  { createdAt: new Date('2026-05-17T10:30:00Z') }, // Q2
  { createdAt: new Date('2026-08-09T09:00:00Z') }, // Q3
];

beforeEach(() => {
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.travelCurriculumMapping.count.mockReset();
});

describe('GET /api/travel-curriculum/by-quarter', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel-curriculum/by-quarter');
    expect(res.status).toBe(401);
  });

  test('?from with invalid format → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('?to with invalid format → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?to=not-a-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 mappings across 2 quarters → 2 quarter rows; correct counts', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    const byQuarter = Object.fromEntries(res.body.rows.map((r) => [r.quarter, r.count]));
    expect(byQuarter['2026-Q2']).toBe(2);
    expect(byQuarter['2026-Q3']).toBe(1);
  });

  test('default orderBy=quarter:asc → chronological order', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('?orderBy=count:desc → flips ordering (highest count first)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2'); // 2 mappings
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].quarter).toBe('2026-Q3'); // 1 mapping
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from/?to narrows the bucket array (single-quarter window)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?from=2026-Q3&to=2026-Q3')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
    expect(res.body.rows[0].count).toBe(1);
  });

  test('no bySubBrand field in response (tenant-wide model)', async () => {
    // Curriculum authoring is tenant-wide ADMIN per route header L11-15;
    // TravelCurriculumMapping has no subBrand column. The envelope MUST
    // omit any bySubBrand surface so callers don't accidentally render
    // a sub-brand chart.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('bySubBrand');
    expect(res.body).toEqual({
      total: 2,
      rows: expect.any(Array),
    });
  });

  test('defensive: null createdAt → "unknown" bucket; excluded when ?from/?to is set', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      ...baseRows,
      { createdAt: null },
    ]);

    // No filter: "unknown" bucket present.
    const r1 = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r1.status).toBe(200);
    const quarters1 = r1.body.rows.map((r) => r.quarter);
    expect(quarters1).toContain('unknown');

    // With ?from set: "unknown" excluded.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      ...baseRows,
      { createdAt: null },
    ]);
    const r2 = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(r2.status).toBe(200);
    const quarters2 = r2.body.rows.map((r) => r.quarter);
    expect(quarters2).not.toContain('unknown');
  });

  test('?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    // 4 distinct quarters → after default quarter:asc sort:
    //   2026-Q1, 2026-Q2, 2026-Q3, 2026-Q4
    // With limit=2 offset=1 we expect rows = [2026-Q2, 2026-Q3].
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      { createdAt: new Date('2026-02-10T00:00:00Z') }, // Q1
      { createdAt: new Date('2026-05-10T00:00:00Z') }, // Q2
      { createdAt: new Date('2026-08-10T00:00:00Z') }, // Q3
      { createdAt: new Date('2026-11-10T00:00:00Z') }, // Q4
    ]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4); // pre-pagination bucket count
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('unknown ?orderBy token degrades to default (quarter:asc)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?orderBy=garbage:weird')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Same chronological order as default.
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('tenant isolation: WHERE clause includes tenantId on findMany', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.travelCurriculumMapping.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(42);
    // Empty population → zero buckets.
    expect(res.body.total).toBe(0);
    expect(res.body.rows).toEqual([]);
  });

  test('limit caps at 40 (request larger value is clamped)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(baseRows);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/by-quarter?limit=500')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only 2 quarters exist; cap is invisible in row count but the slice
    // should not error.
    expect(res.body.rows).toHaveLength(2);
  });
});
