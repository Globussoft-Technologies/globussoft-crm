// @ts-check
/**
 * Travel CRM — GET /api/travel-curriculum/stats
 * tenant-wide TravelCurriculumMapping rollup (PRD_TRAVEL_TMC §3).
 *
 * Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
 * /commission-profiles/stats + PRD_TRAVEL_RFU_DIAGNOSTIC §3 /diagnostics/stats.
 * USER-readable anodyne aggregate that powers the Curriculum admin page's
 * header strip ("X mappings authored across Y curricula × Z subjects").
 *
 * Pins the contract for the new route handler added at
 * backend/routes/travel_curriculum.js (placed BEFORE the /:id family so
 * the literal-path /stats wins over the :id matcher — Express ordering).
 *
 * Why no sub-brand bucket
 * -----------------------
 * Per the route file's header (L11-15): curriculum authoring is tenant-wide
 * ADMIN, not sub-brand-scoped. The route mounts at /api/travel-curriculum
 * (sibling-flat with /api/embassy-rules) rather than under the /api/travel/*
 * prefix, and there is no requireTravelTenant / getSubBrandAccessSet
 * machinery in this route file. The /stats endpoint follows the same
 * pattern — no bySubBrand bucket, no MANAGER narrowing test, no
 * sub-brand-access pin. The contract is tenant-scoped, period.
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastUpdatedAt:null, aggregateExceedsCap:false.
 *   - Happy path:          4 mappings across 2 curricula + 2 grades + 3
 *                          subjects → counts correct (total, byCurriculum
 *                          bucket counts incl. .active sub-count, byGrade
 *                          bucket counts, bySubject bucket counts,
 *                          lastUpdatedAt is max(updatedAt) as ISO string).
 *   - Cross-tenant scoping:WHERE clause includes tenantId: req.user.tenantId
 *                          on BOTH findMany + count — no leak from another
 *                          tenant even if FK IDs would have matched.
 *   - USER-readable:       USER role returns 200 (anodyne aggregate; same
 *                          contract as sibling /stats endpoints).
 *   - Auth gate:           no token → 401.
 *   - ?from/?to ISO bounds:populated → createdAt gets {gte,lte} clauses
 *                          on BOTH findMany + count; invalid → 400
 *                          INVALID_DATE.
 *   - Active vs archived:  isActive=false rows counted in `archived`, not
 *                          `active`; byCurriculum.active sub-count excludes
 *                          archived rows.
 *
 * Test pattern mirrors backend/test/routes/travel_curriculum.test.js
 * (the sibling CRUD test for the same route file) — patch the prisma
 * singleton BEFORE requiring the router, drive supertest with HS256 JWTs
 * signed against the dev-fallback secret.
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

beforeEach(() => {
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.travelCurriculumMapping.count.mockReset();
});

describe('GET /api/travel-curriculum/stats', () => {
  test('empty tenant → all-zeros envelope with empty bucket maps and lastUpdatedAt:null', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      archived: 0,
      byCurriculum: {},
      byGrade: {},
      bySubject: {},
      lastUpdatedAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path: 4 mappings across 2 curricula × 2 grades × 3 subjects → bucket counts correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1, curriculum: 'CBSE', grade: 'Class 10', subject: 'Geography',
        isActive: true, updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2, curriculum: 'CBSE', grade: 'Class 10', subject: 'History',
        isActive: true, updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
      {
        id: 3, curriculum: 'CBSE', grade: 'Class 9', subject: 'Geography',
        isActive: false, updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 4, curriculum: 'ICSE', grade: 'Class 10', subject: 'Biology',
        isActive: true, updatedAt: newest, // drives lastUpdatedAt
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(4);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.active).toBe(3);
    expect(res.body.archived).toBe(1);
    expect(res.body.byCurriculum).toEqual({
      CBSE: { count: 3, active: 2 },   // 3 rows, 1 archived
      ICSE: { count: 1, active: 1 },
    });
    expect(res.body.byGrade).toEqual({
      'Class 10': { count: 3 },
      'Class 9': { count: 1 },
    });
    expect(res.body.bySubject).toEqual({
      Geography: { count: 2 },
      History: { count: 1 },
      Biology: { count: 1 },
    });
    expect(res.body.lastUpdatedAt).toBe(newest.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('cross-tenant: WHERE clause includes tenantId on BOTH findMany and count (no FK leak)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1, curriculum: 'CBSE', grade: 'Class 10', subject: 'Geography',
        isActive: true, updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.travelCurriculumMapping.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(42);
    const countWhere = prisma.travelCurriculumMapping.count.mock.calls[0][0].where;
    expect(countWhere.tenantId).toBe(42);
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byCurriculum).toEqual({});
  });

  test('auth gate: missing token → 401', async () => {
    const res = await request(makeApp()).get('/api/travel-curriculum/stats');
    expect(res.status).toBe(401);
  });

  test('?from/?to ISO bounds → createdAt gets {gte,lte} clauses on BOTH findMany and count', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.travelCurriculumMapping.findMany.mock.calls[0][0].where;
    expect(findManyWhere.createdAt).toBeTruthy();
    expect(findManyWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(findManyWhere.createdAt.lte).toBeInstanceOf(Date);
    const countWhere = prisma.travelCurriculumMapping.count.mock.calls[0][0].where;
    expect(countWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(countWhere.createdAt.lte).toBeInstanceOf(Date);
  });

  test('?from with invalid date → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('?to with invalid date → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats?to=garbage-value')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('active/archived split: isActive=false rows counted in archived; byCurriculum.active excludes them', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1, curriculum: 'CBSE', grade: 'Class 10', subject: 'Geography',
        isActive: true, updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2, curriculum: 'CBSE', grade: 'Class 10', subject: 'History',
        isActive: false, updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
      {
        id: 3, curriculum: 'CBSE', grade: 'Class 10', subject: 'Biology',
        isActive: false, updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(1);
    expect(res.body.archived).toBe(2);
    expect(res.body.byCurriculum.CBSE).toEqual({ count: 3, active: 1 });
  });

  test('aggregateExceedsCap true when totalMatching > CURRICULUM_STATS_CAP (2000)', async () => {
    // findMany returns the bounded slice (2000 rows); count returns the
    // true total (2500). Route should mark aggregateExceedsCap=true and
    // still return the bounded aggregation.
    const slice = Array.from({ length: 2000 }, (_, i) => ({
      id: i + 1,
      curriculum: 'CBSE',
      grade: 'Class 10',
      subject: 'Geography',
      isActive: true,
      updatedAt: new Date('2026-05-10T10:00:00Z'),
    }));
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(slice);
    prisma.travelCurriculumMapping.count.mockResolvedValue(2500);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2500); // true total, not slice length
    expect(res.body.aggregateExceedsCap).toBe(true);
    expect(res.body.byCurriculum.CBSE.count).toBe(2000); // bounded slice
  });

  test('defensive: empty curriculum/grade/subject strings coalesce to _unknown bucket (forward-compat)', async () => {
    // Schema says non-nullable + non-empty, but the route defensively
    // coalesces falsy → '_unknown' for forward-compat if a future
    // migration relaxes the constraint.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1, curriculum: 'CBSE', grade: 'Class 10', subject: 'Geography',
        isActive: true, updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2, curriculum: '', grade: '   ', subject: null,
        isActive: true, updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byCurriculum._unknown).toEqual({ count: 1, active: 1 });
    expect(res.body.byGrade._unknown).toEqual({ count: 1 });
    expect(res.body.bySubject._unknown).toEqual({ count: 1 });
    expect(res.body.byCurriculum.CBSE).toEqual({ count: 1, active: 1 });
  });
});
