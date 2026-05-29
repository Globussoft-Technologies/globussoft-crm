// @ts-check
/**
 * backend/routes/travel_cost_master.js — /cost-master/by-month contract pin.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/cost-master/by-month   tenant-wide monthly rollup;
 *                                             returns { total, rows: [...] }
 *                                             with per-bucket bySubBrand.
 *   - 401 on missing Authorization header.
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to.
 *   - Happy path: 3 rows across 2 months → 2 month rows with correct counts
 *                  and per-bucket bySubBrand breakdown.
 *   - Default ?orderBy=month:asc is chronological.
 *   - ?orderBy=count:desc flips the ordering.
 *   - ?from / ?to narrows the bucket array.
 *   - Sub-brand restriction: MANAGER subBrandAccess=['tmc'] narrows the
 *                             where clause via subBrand: { in: ['tmc'] }.
 *   - Defensive: null createdAt → "unknown" bucket; excluded when ?from/?to.
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation.
 *   - Falsy subBrand coerces to "_tenant" bucket.
 *   - Unknown ?orderBy token degrades silently to default.
 *
 * Test pattern mirrors backend/test/routes/travel-cost-master-stats.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with HS256 JWTs signed with the fallback secret.
 * verifyToken + requireTravelTenant remain in the chain.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCostMaster = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const costMasterRouter = requireCJS('../../routes/travel_cost_master');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', costMasterRouter);
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
  prisma.travelCostMaster.findMany.mockReset();
  prisma.travelCostMaster.findFirst.mockReset();
  prisma.travelCostMaster.count.mockReset();
  prisma.travelCostMaster.create.mockReset();
  prisma.travelCostMaster.update.mockReset();
  prisma.travelCostMaster.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset();
});

describe('GET /api/travel/cost-master/by-month', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/cost-master/by-month');
    expect(res.status).toBe(401);
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('bad ?from returns 400 INVALID_MONTH_FORMAT (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?from=not-a-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('bad ?to returns 400 INVALID_MONTH_FORMAT (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?to=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('happy path: 3 rows across 2 months → 2 buckets with per-bucket bySubBrand', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-04-10T00:00:00.000Z') },
      { subBrand: 'rfu', createdAt: new Date('2026-04-22T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-05-03T12:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    // Default order is month:asc.
    expect(res.body.rows[0]).toMatchObject({
      month: '2026-04',
      count: 2,
      bySubBrand: { tmc: 1, rfu: 1 },
    });
    expect(res.body.rows[1]).toMatchObject({
      month: '2026-05',
      count: 1,
      bySubBrand: { tmc: 1 },
    });
  });

  test('default orderBy=month:asc is chronological', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-06-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-01T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-01', '2026-03', '2026-06']);
  });

  test('?orderBy=count:desc flips ordering by count', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-02-15T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-10T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-20T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // March(3) > February(2) > January(1)
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-02', '2026-01']);
    expect(res.body.rows.map((r) => r.count)).toEqual([3, 2, 1]);
  });

  test('?from / ?to narrows the bucket array', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-01-15T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-15T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-05-15T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-07-15T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?from=2026-03&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-05']);
  });

  test('MANAGER subBrandAccess=["tmc"] narrows where via subBrand: { in: ["tmc"] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(1);
    expect(calledWhere.subBrand).toEqual({ in: expect.arrayContaining(['tmc']) });
  });

  test('null createdAt → "unknown" bucket; excluded when ?from/?to set', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('2026-04-10T00:00:00.000Z') },
    ]);
    // No ?from/?to — "unknown" included.
    const res1 = await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res1.status).toBe(200);
    const monthsKept1 = res1.body.rows.map((r) => r.month);
    expect(monthsKept1).toContain('unknown');
    expect(monthsKept1).toContain('2026-04');

    // With ?from — "unknown" excluded.
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('2026-04-10T00:00:00.000Z') },
    ]);
    const res2 = await request(makeApp())
      .get('/api/travel/cost-master/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res2.status).toBe(200);
    const monthsKept2 = res2.body.rows.map((r) => r.month);
    expect(monthsKept2).not.toContain('unknown');
    expect(monthsKept2).toEqual(['2026-04']);
  });

  test('?limit=2&offset=1 slices AFTER aggregation', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-04-01T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Pre-pagination total = 4 buckets; sorted asc, offset=1 skip 1, limit=2.
    expect(res.body.total).toBe(4);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
  });

  test('falsy subBrand (null/empty) coerces to "_tenant" bucket', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-04-01T00:00:00.000Z') },
      { subBrand: '', createdAt: new Date('2026-04-02T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-04-03T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      month: '2026-04',
      count: 3,
      bySubBrand: { _tenant: 2, tmc: 1 },
    });
  });

  test('unknown ?orderBy token degrades silently to default (month:asc)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month?orderBy=garbage:wat')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Default = month:asc.
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-01', '2026-03']);
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-04-10T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
