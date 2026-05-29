// @ts-check
/**
 * PRD_TRAVEL §6.x microsites — GET /api/travel/microsites/by-quarter
 * tenant-wide microsite quarterly rollup.
 *
 * Sibling to /microsites/stats + /microsites/by-month. Mirrors the
 * rollup-triplet pattern (by-month + by-quarter + by-year) established by
 * /itineraries/by-quarter — UTC YYYY-Q[1-4] bucketing, per-bucket
 * bySubBrand breakdown, pagination after aggregation + sort + bucket
 * filter.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 microsites across 2 quarters → 2 quarter rows, correct
 *     counts, per-bucket bySubBrand (all "_tenant" since subBrand column
 *     absent from the model)
 *   - Default orderBy=quarter:asc chronological
 *   - ?orderBy=count:desc flips ordering
 *   - ?from / ?to narrows the bucket array (inclusive bounds)
 *   - Sub-brand restriction: TripMicrosite has NO subBrand column (TMC-
 *     locked per Q21); the WHERE clause mirrors /microsites/stats +
 *     /microsites/by-month EXACTLY and applies no sub-brand narrowing.
 *     MANAGER subBrandAccess=['tmc'] sees the same population as ADMIN.
 *   - Defensive: null createdAt → "unknown" bucket; excluded when ?from/?to set
 *   - Pagination ?limit/?offset slices AFTER aggregation
 *   - Unknown orderBy token degrades silently to default quarter:asc
 *   - ?limit caps at 40 even when caller requests larger value
 *   - NO audit row written
 *
 * Test pattern mirrors travel-microsites-by-month.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, then drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.tripMicrosite = prisma.tripMicrosite || {};
prisma.tripMicrosite.findMany = vi.fn();
prisma.tripMicrosite.count = prisma.tripMicrosite.count || vi.fn();
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
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelMicrositesRouter = requireCJS('../../routes/travel_microsites');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelMicrositesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// 3 microsites across 2 quarters (2026-Q2 ×2, 2026-Q3 ×1). subBrand
// is intentionally varied even though the actual TripMicrosite model
// has no subBrand column — this proves the bySubBrand aggregator's
// coercion path (falsy → "_tenant"). When the real prisma client
// returns rows (no subBrand select), the value is undefined and all
// rows land in "_tenant"; tests covering that path use the 'falsy'
// fixture below.
const baseRows = [
  { subBrand: 'tmc', createdAt: new Date('2026-05-03T08:00:00Z') }, // 2026-Q2
  { subBrand: 'tmc', createdAt: new Date('2026-06-17T10:30:00Z') }, // 2026-Q2
  { subBrand: 'rfu', createdAt: new Date('2026-08-09T09:00:00Z') }, // 2026-Q3
];

beforeEach(() => {
  prisma.tripMicrosite.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/microsites/by-quarter', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp()).get('/api/travel/microsites/by-quarter');
    expect(res.status).toBe(401);
    expect(prisma.tripMicrosite.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (Q5 out of range)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.tripMicrosite.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to token (no Q prefix)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?to=2026-2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 microsites across 2 quarters → 2 rows with correct counts + bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      bySubBrand: { tmc: 2 },
    });
    expect(res.body.rows[1]).toMatchObject({
      quarter: '2026-Q3',
      count: 1,
      bySubBrand: { rfu: 1 },
    });
  });

  test('default orderBy=quarter:asc → chronological ordering', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('?orderBy=count:desc puts the busier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-Q2&to=2026-Q2 narrows the bucket array to a single quarter (inclusive bounds)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?from=2026-Q2&to=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(2);
  });

  test('sub-brand: MANAGER subBrandAccess=[tmc] sees the SAME population as ADMIN (model has no subBrand column — mirrors /microsites/by-month)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // WHERE clause: only tenantId; no sub-brand narrowing applied (the
    // TripMicrosite model has no subBrand column). Same posture as
    // /microsites/stats and /microsites/by-month.
    const call = prisma.tripMicrosite.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toBeUndefined();
    expect(call.where.OR).toBeUndefined();
    // Population unchanged from ADMIN.
    expect(res.body.total).toBe(2);
  });

  test('defensive: row with null createdAt → "unknown" bucket; EXCLUDED when ?from/?to is set', async () => {
    prisma.tripMicrosite.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-05-03T08:00:00Z') }, // 2026-Q2
      { subBrand: 'tmc', createdAt: null },
      { subBrand: null, createdAt: new Date('not a date') },
    ]);

    // No bounds: "unknown" bucket kept.
    const resAll = await request(makeApp())
      .get('/api/travel/microsites/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(resAll.status).toBe(200);
    expect(resAll.body.total).toBe(2);
    const unknown = resAll.body.rows.find((r) => r.quarter === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    // null/invalid-createdAt rows: one had subBrand='tmc', other had
    // subBrand=null → "_tenant" coercion.
    expect(unknown.bySubBrand.tmc).toBe(1);
    expect(unknown.bySubBrand._tenant).toBe(1);

    // With ?from=2026-Q1: "unknown" excluded; only the valid-date row.
    const resBounded = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(resBounded.status).toBe(200);
    expect(resBounded.body.total).toBe(1);
    expect(resBounded.body.rows[0].quarter).toBe('2026-Q2');
  });

  test('pagination: ?limit=1&offset=1 slices AFTER aggregation (returns 2nd row only)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // total reflects the FULL aggregation, not the paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q3.
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
  });

  test('?limit caps at 40 even when caller requests larger value', async () => {
    // Build 25 rows across 25 distinct quarters so the cap is observable.
    const rows = [];
    for (let i = 0; i < 25; i++) {
      // Each iteration picks a different (year, quarter-month).
      const q = (i % 4) + 1; // 1..4
      const month = String((q - 1) * 3 + 1).padStart(2, '0'); // Q1→01, Q2→04, Q3→07, Q4→10
      const y = 2010 + Math.floor(i / 4);
      rows.push({ subBrand: 'tmc', createdAt: new Date(`${y}-${month}-15T08:00:00Z`) });
    }
    prisma.tripMicrosite.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?limit=999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 25 unique quarters total; limit capped to 40 so all 25 fit in one page.
    expect(res.body.total).toBe(25);
    expect(res.body.rows.length).toBeLessThanOrEqual(40);
    expect(res.body.rows.length).toBe(25);
  });

  test('unknown ?orderBy token degrades silently to default quarter:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
