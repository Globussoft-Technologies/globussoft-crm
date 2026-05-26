// @ts-check
/**
 * PRD_TRAVEL_RFU §3 — GET /api/travel/rfu-profiles/by-quarter
 * tenant-wide RFU pilgrim profile quarterly rollup.
 *
 * Sibling to /rfu-profiles/stats + /rfu-profiles/by-month. Same UTC
 * bucketing template applied at quarter granularity (YYYY-Q[1-4]).
 * Mirrors /itineraries/by-quarter + /suppliers/by-quarter — same
 * defensive math, same orderBy semantics.
 *
 * What's pinned
 * -------------
 *   - 401 no Authorization header (verifyToken gate)
 *   - 403 SUB_BRAND_DENIED when caller lacks RFU access
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 profiles across 2 quarters → 2 quarter rows,
 *     correct counts, default quarter:asc ordering
 *   - ?orderBy=count:desc flips ordering
 *   - ?from / ?to narrows the bucket array
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from / ?to is set
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Unknown ?orderBy token degrades silently to default
 *   - Tenant isolation: the WHERE clause threads tenantId
 *   - No `bySubBrand` field in response (RfuLeadProfile has no
 *     subBrand column; RFU lock lives in requireRfuAccess middleware)
 *
 * Test pattern mirrors travel-rfu-profiles-by-month.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with HS256 JWTs signed against the
 * dev-fallback secret. verifyToken + requireTravelTenant +
 * requireRfuAccess all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.rfuLeadProfile = prisma.rfuLeadProfile || {};
prisma.rfuLeadProfile.findMany = vi.fn();
prisma.rfuLeadProfile.count = prisma.rfuLeadProfile.count || vi.fn();
prisma.rfuLeadProfile.findFirst = prisma.rfuLeadProfile.findFirst || vi.fn();
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
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const rfuProfilesRouter = requireCJS('../../routes/travel_rfu_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', rfuProfilesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of profiles across Q2 + Q3 2026.
//   2026-Q2 (Apr-Jun): 2 profiles
//   2026-Q3 (Jul-Sep): 1 profile
const baseRows = [
  { createdAt: new Date('2026-04-10T08:00:00Z') },
  { createdAt: new Date('2026-05-17T10:30:00Z') },
  { createdAt: new Date('2026-08-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.rfuLeadProfile.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/rfu-profiles/by-quarter', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp()).get('/api/travel/rfu-profiles/by-quarter');
    expect(res.status).toBe(401);
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('403 SUB_BRAND_DENIED when caller lacks RFU access (requireRfuAccess gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // Prisma should NEVER be hit — the gate denies before query.
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from (e.g. Q5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to (numeric month form)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?to=2026-06')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 profiles across 2 quarters → 2 quarter rows, correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({ quarter: '2026-Q2', count: 2 });
    expect(res.body.rows[1]).toMatchObject({ quarter: '2026-Q3', count: 1 });
    expect(res.body.limit).toBe(8);
    expect(res.body.offset).toBe(0);
    // No bySubBrand bucket — RfuLeadProfile has no subBrand column.
    expect(res.body.rows[0].bySubBrand).toBeUndefined();
  });

  test('default orderBy=quarter:asc is chronological', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Earlier quarter first.
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('?orderBy=count:desc flips the ordering (busier quarter first)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-Q3&to=2026-Q3 narrows the bucket array to a single quarter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?from=2026-Q3&to=2026-Q3')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
    expect(res.body.rows[0].count).toBe(1);
  });

  test('defensive: null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      { createdAt: new Date('2026-04-10T08:00:00Z') },
      { createdAt: null },
      { createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-Q2 + 2 in "unknown" → 2 buckets total.
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((q) => q.quarter === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      { createdAt: new Date('2026-04-10T08:00:00Z') },
      { createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
  });

  test('pagination: ?limit=1&offset=1 slices AFTER aggregation (returns 2nd of 2 quarter buckets)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // total reflects the FULL aggregation, not the paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q3.
    expect(res.body.rows[0].quarter).toBe('2026-Q3');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('unknown ?orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter?orderBy=bogus:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('tenant isolation: WHERE clause threads tenantId; NO subBrand narrowing (model has no subBrand column)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.rfuLeadProfile.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // RFU lock is at the middleware (requireRfuAccess); the model has
    // no subBrand column, so the where-clause MUST NOT carry a
    // subBrand key.
    expect(call.where.subBrand).toBeUndefined();
    expect(call.where.OR).toBeUndefined();
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('no `bySubBrand` field in response envelope (RFU-locked, no subBrand column)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('bySubBrand');
    for (const row of res.body.rows) {
      expect(row).not.toHaveProperty('bySubBrand');
    }
  });
});
