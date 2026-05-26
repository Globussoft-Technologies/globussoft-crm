// @ts-check
/**
 * backend/routes/travel_cost_master.js — /cost-master/stats contract pin.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/cost-master/stats     tenant-wide rollup; returns
 *                                            total + active + bySubBrand +
 *                                            bySupplier + lastCreatedAt.
 *   - 401 on missing Authorization header.
 *   - 400 INVALID_DATE on bad ?from / ?to.
 *   - Empty-tenant happy path: total=0, bySubBrand={}, bySupplier={},
 *                              lastCreatedAt=null.
 *   - Multi-row happy path: counts across 2 sub-brands → bySubBrand={tmc:2,
 *                            rfu:1}; lastCreatedAt = max(createdAt).
 *   - Sub-brand restriction: USER subBrandAccess=['rfu'] narrows the where
 *                             clause to {subBrand: {in: ['rfu']}}.
 *   - Tenant isolation: different tenantId returns 0 rows (verified by
 *                        asserting the where filter contains tenantId=1).
 *   - ?from/?to narrows the date window via createdAt bounds.
 *   - Falsy subBrand (null) coerces to '_tenant' bucket.
 *   - lastCreatedAt is the maximum, not minimum.
 *   - NO audit row written — read-only meta surface.
 *   - Defensive: null createdAt rows counted in total, skipped for
 *                lastCreatedAt.
 *
 * Test pattern mirrors backend/test/routes/travel-cost-master.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with HS256 JWTs signed with the same fallback
 * secret. verifyToken + requireTravelTenant remain in the chain.
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

describe('GET /api/travel/cost-master/stats', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/cost-master/stats');
    expect(res.status).toBe(401);
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('bad ?from returns 400 INVALID_DATE (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('bad ?to returns 400 INVALID_DATE (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant returns zeroed envelope', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      bySubBrand: {},
      bySupplier: {},
      lastCreatedAt: null,
    });
    // Tenant-scoped where.
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });

  test('multi-row happy path returns total + bySubBrand + lastCreatedAt', async () => {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-02-15T12:00:00.000Z');
    const t3 = new Date('2026-03-20T08:30:00.000Z'); // newest
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', supplierId: 10, isActive: true, createdAt: t1 },
      { id: 2, subBrand: 'tmc', supplierId: 11, isActive: false, createdAt: t2 },
      { id: 3, subBrand: 'rfu', supplierId: 10, isActive: true, createdAt: t3 },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 3,
      active: 2,
      bySubBrand: { tmc: 2, rfu: 1 },
      lastCreatedAt: t3.toISOString(),
    });
    // bySupplier: supplierId 10 appears twice (rows 1 + 3), supplier 11 once.
    expect(res.body.bySupplier).toEqual({ '10': 2, '11': 1 });
  });

  test('USER subBrandAccess=["rfu"] narrows where.subBrand by allowed set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(1);
    expect(calledWhere.subBrand).toEqual({ in: expect.arrayContaining(['rfu']) });
  });

  test('tenant isolation: where clause always contains caller tenantId', async () => {
    // Caller's JWT tenantId=99, but tenant lookup returns id=99 vertical=travel.
    prisma.tenant.findUnique.mockResolvedValue({
      id: 99, vertical: 'travel', name: 'Other Travel', slug: 'other-travel',
    });
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 99 })}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(99);
  });

  test('?from/?to narrows the date window via createdAt bounds', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/cost-master/stats?from=2026-01-01&to=2026-06-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.createdAt).toBeDefined();
    expect(calledWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(calledWhere.createdAt.lte).toBeInstanceOf(Date);
    expect(calledWhere.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('falsy subBrand (null) coerces to "_tenant" bucket', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, subBrand: null, supplierId: null, isActive: true, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { id: 2, subBrand: '', supplierId: null, isActive: true, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 3, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: new Date('2026-01-03T00:00:00.000Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.bySubBrand).toEqual({ _tenant: 2, tmc: 1 });
    expect(res.body.total).toBe(3);
    // No supplierId on any row → bySupplier empty.
    expect(res.body.bySupplier).toEqual({});
  });

  test('lastCreatedAt picks the maximum (not the minimum)', async () => {
    const oldest = new Date('2025-01-01T00:00:00.000Z');
    const middle = new Date('2025-06-15T00:00:00.000Z');
    const newest = new Date('2026-03-20T08:30:00.000Z');
    prisma.travelCostMaster.findMany.mockResolvedValue([
      // Deliberately out of order so the test exercises max-reduction, not just last.
      { id: 1, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: middle },
      { id: 2, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: newest },
      { id: 3, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: oldest },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
    expect(res.body.lastCreatedAt).not.toBe(oldest.toISOString());
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', supplierId: 10, isActive: true, createdAt: new Date() },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('null createdAt rows still counted in total (lastCreatedAt skips them)', async () => {
    const real = new Date('2026-02-01T00:00:00.000Z');
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: null },
      { id: 2, subBrand: 'tmc', supplierId: null, isActive: true, createdAt: real },
      { id: 3, subBrand: 'rfu', supplierId: null, isActive: false, createdAt: null },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(2);
    expect(res.body.bySubBrand).toEqual({ tmc: 2, rfu: 1 });
    // Only the row with a real createdAt feeds the max.
    expect(res.body.lastCreatedAt).toBe(real.toISOString());
  });
});
