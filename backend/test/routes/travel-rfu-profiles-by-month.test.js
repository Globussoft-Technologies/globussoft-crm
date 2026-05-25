// @ts-check
/**
 * PRD_TRAVEL_RFU §3 — GET /api/travel/rfu-profiles/by-month
 * tenant-wide RFU pilgrim profile monthly rollup.
 *
 * Mirrors #903 slice 24 /suppliers/by-month + #908 slice 21
 * /flyer-templates/by-month — same UTC YYYY-MM bucketing template, same
 * defensive math, same orderBy semantics. The sibling endpoint to
 * /rfu-profiles/stats: /stats is the KPI-tile snapshot, /by-month is the
 * trend chart over the same population.
 *
 * What's pinned
 * -------------
 *   - 401 no Authorization header (verifyToken gate)
 *   - 403 SUB_BRAND_DENIED when caller lacks RFU access
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 profiles across 2 months → 2 month rows, correct
 *     counts, default month:asc ordering
 *   - ?orderBy=count:desc flips ordering
 *   - ?from / ?to narrows the bucket array
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from / ?to is set
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Unknown ?orderBy token degrades silently to default
 *   - Tenant isolation: the WHERE clause threads tenantId
 *
 * Sub-brand handling — RfuLeadProfile has no `subBrand` column
 * (RFU-exclusive model gated by requireRfuAccess middleware). Tests
 * therefore verify NO bySubBrand bucket appears in the response and
 * NO subBrand narrowing leaks into the Prisma where-clause.
 *
 * Test pattern mirrors travel-rfu-profiles-stats.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret. verifyToken + requireTravelTenant + requireRfuAccess all run
 * for real.
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

// Spread of profiles across May + June 2026.
//   2026-05: 2 profiles
//   2026-06: 1 profile
const baseRows = [
  { createdAt: new Date('2026-05-03T08:00:00Z') },
  { createdAt: new Date('2026-05-17T10:30:00Z') },
  { createdAt: new Date('2026-06-09T09:00:00Z') },
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

describe('GET /api/travel/rfu-profiles/by-month', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp()).get('/api/travel/rfu-profiles/by-month');
    expect(res.status).toBe(401);
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('403 SUB_BRAND_DENIED when caller lacks RFU access (requireRfuAccess gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // Prisma should NEVER be hit — the gate denies before query.
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?from (e.g. month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to (no dash)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 3 profiles across 2 months → 2 month rows, correct counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({ month: '2026-05', count: 2 });
    expect(res.body.rows[1]).toMatchObject({ month: '2026-06', count: 1 });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
    // No bySubBrand bucket — RfuLeadProfile has no subBrand column.
    expect(res.body.rows[0].bySubBrand).toBeUndefined();
  });

  test('default orderBy=month:asc is chronological', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Earlier month first.
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('?orderBy=count:desc flips the ordering (busier month first)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].month).toBe('2026-06');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-06&to=2026-06 narrows the bucket array to a single month', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?from=2026-06&to=2026-06')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-06');
    expect(res.body.rows[0].count).toBe(1);
  });

  test('defensive: null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-03T08:00:00Z') },
      { createdAt: null },
      { createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-05 + 2 in "unknown" → 2 buckets total.
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((m) => m.month === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-03T08:00:00Z') },
      { createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-05');
  });

  test('pagination: ?limit=1&offset=1 slices AFTER aggregation (returns 2nd of 2 month buckets)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // total reflects the FULL aggregation, not the paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.rows[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('unknown ?orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month?orderBy=bogus:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('tenant isolation: WHERE clause threads tenantId; NO subBrand narrowing (model has no subBrand column)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-month')
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
      .get('/api/travel/rfu-profiles/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
