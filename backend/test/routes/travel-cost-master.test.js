// @ts-check
/**
 * backend/routes/travel_cost_master.js — Phase 1 supplier rate-book CRUD contract pin.
 *
 * What's pinned
 * -------------
 *   - GET    /api/travel/cost-master              tenant-scoped list; honors
 *                                                  ?subBrand + ?category +
 *                                                  ?supplierId + ?active +
 *                                                  ?routeOrSku filters;
 *                                                  paginated (limit/offset).
 *   - POST   /api/travel/cost-master              201 happy; 400 MISSING_FIELDS
 *                                                  on missing required;
 *                                                  400 INVALID_SUB_BRAND on bad
 *                                                  subBrand; 400 INVALID_CATEGORY
 *                                                  on bad category;
 *                                                  400 INVALID_BASE_RATE on
 *                                                  negative baseRate;
 *                                                  403 SUB_BRAND_DENIED when
 *                                                  caller lacks sub-brand
 *                                                  access; 403 ADMIN/MANAGER
 *                                                  gate (USER rejected).
 *   - GET    /api/travel/cost-master/:id          400 INVALID_ID on bad param;
 *                                                  404 NOT_FOUND cross-tenant;
 *                                                  200 same-tenant; 403
 *                                                  SUB_BRAND_DENIED on
 *                                                  out-of-scope.
 *   - PATCH  /api/travel/cost-master/:id          ADMIN/MANAGER gate; 404
 *                                                  cross-tenant; 400 EMPTY_BODY
 *                                                  on no fields; 400
 *                                                  INVALID_CATEGORY on bad
 *                                                  category; 200 happy.
 *   - DELETE /api/travel/cost-master/:id          ADMIN-only gate; 404
 *                                                  cross-tenant; 200 + body
 *                                                  { deleted: true, id }.
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with real HS256 JWTs signed with the same fallback secret
 * the middleware uses in dev. verifyToken + requirePermission + requireTravelTenant
 * stay in the chain (we don't bypass them) so the full guard stack is
 * exercised end-to-end.
 *
 * Note: travel_cost_master.js calls `getSubBrandAccessSet(req.user.userId)`
 * which reads `prisma.user.findUnique`. We default that mock to ADMIN +
 * subBrandAccess=null (full access) and override per-test when narrowing.
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
});

// -----------------------------------------------------------------------------
// GET /api/travel/cost-master — list
// -----------------------------------------------------------------------------

describe('GET /api/travel/cost-master', () => {
  test('returns tenant-scoped list with default limit/offset envelope', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX', baseRate: '4500.00', isActive: true },
    ]);
    prisma.travelCostMaster.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.rates).toHaveLength(1);
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
        take: 50,
        skip: 0,
      }),
    );
  });

  test('honors ?subBrand + ?category + ?active filters in the where clause', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    prisma.travelCostMaster.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cost-master?subBrand=rfu&category=hotel&active=true&supplierId=12&routeOrSku=MAKKAH')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({
      tenantId: 1,
      subBrand: 'rfu',
      category: 'hotel',
      supplierId: 12,
      isActive: true,
      routeOrSku: { contains: 'MAKKAH' },
    });
  });

  test('rejects ?category=cruise with 400 INVALID_CATEGORY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master?category=cruise')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CATEGORY' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('rejects ?subBrand=bogus with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master?subBrand=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('non-admin with subBrandAccess narrows where.subBrand by allowed set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu', 'tmc']),
    });
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    prisma.travelCostMaster.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(1);
    // narrowWhereBySubBrand sets subBrand={in:[...]} when query.subBrand is absent.
    expect(calledWhere.subBrand).toEqual({ in: expect.arrayContaining(['rfu', 'tmc']) });
  });

  test('limit is capped at 200 (?limit=9999 yields take:200)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    prisma.travelCostMaster.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cost-master?limit=9999&offset=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, skip: 100 }),
    );
  });
});

// -----------------------------------------------------------------------------
// POST /api/travel/cost-master — create
// -----------------------------------------------------------------------------

describe('POST /api/travel/cost-master', () => {
  const validBody = () => ({
    subBrand: 'tmc',
    category: 'hotel',
    routeOrSku: 'AGRA-DLX',
    baseRate: 4500,
  });

  test('happy path returns 201 with persisted row', async () => {
    prisma.travelCostMaster.create.mockResolvedValue({
      id: 42, tenantId: 1, ...validBody(), currency: 'INR', isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 42, category: 'hotel', subBrand: 'tmc' });
    // tenantId comes from req.travelTenant.id, NOT from body.
    expect(prisma.travelCostMaster.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          category: 'hotel',
          routeOrSku: 'AGRA-DLX',
          baseRate: 4500,
          currency: 'INR',
          isActive: true,
        }),
      }),
    );
  });

  test('missing baseRate returns 400 MISSING_FIELDS (no create)', async () => {
    const body = validBody();
    delete body.baseRate;
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('invalid category returns 400 INVALID_CATEGORY (with allowed values listed)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), category: 'cruise' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CATEGORY' });
    expect(res.body.error).toMatch(/hotel/);
    expect(res.body.error).toMatch(/visa/);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('invalid subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), subBrand: 'spaceforce' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('negative baseRate returns 400 INVALID_BASE_RATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), baseRate: -100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BASE_RATE' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('NaN baseRate returns 400 INVALID_BASE_RATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), baseRate: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BASE_RATE' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('USER role is rejected with 403 (verifyRole gate)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('MANAGER role IS allowed (gate is ADMIN+MANAGER)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    prisma.travelCostMaster.create.mockResolvedValue({
      id: 99, tenantId: 1, ...validBody(), currency: 'INR', isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(prisma.travelCostMaster.create).toHaveBeenCalled();
  });

  test('non-admin without access to target subBrand returns 403 SUB_BRAND_DENIED', async () => {
    // MANAGER with subBrandAccess limited to ['rfu'] cannot create a 'tmc' row.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validBody()); // subBrand: 'tmc'
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('optional fields (supplierId, currency, validFrom/To) are persisted', async () => {
    prisma.travelCostMaster.create.mockResolvedValue({ id: 100, tenantId: 1 });
    await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        ...validBody(),
        supplierId: 5,
        currency: 'USD',
        validFrom: '2026-06-01',
        validTo: '2026-12-31',
        isActive: false,
      });
    const calledData = prisma.travelCostMaster.create.mock.calls[0][0].data;
    expect(calledData).toMatchObject({
      supplierId: 5,
      currency: 'USD',
      isActive: false,
    });
    expect(calledData.validFrom).toBeInstanceOf(Date);
    expect(calledData.validTo).toBeInstanceOf(Date);
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/cost-master/:id — fetch one
// -----------------------------------------------------------------------------

describe('GET /api/travel/cost-master/:id', () => {
  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCostMaster.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant lookup returns 404 NOT_FOUND', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/cost-master/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // The lookup MUST scope by req.travelTenant.id (=1).
    expect(prisma.travelCostMaster.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9999, tenantId: 1 } }),
    );
  });

  test('same-tenant returns 200 with the row', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX', baseRate: '4500.00', isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/travel/cost-master/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, category: 'hotel' });
  });

  test('caller without sub-brand access to the row returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 6, tenantId: 1, subBrand: 'visasure', category: 'visa', routeOrSku: 'IN-UAE',
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .get('/api/travel/cost-master/6')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });
});

// -----------------------------------------------------------------------------
// PATCH /api/travel/cost-master/:id — amend
// -----------------------------------------------------------------------------

describe('PATCH /api/travel/cost-master/:id', () => {
  test('happy update returns 200 with updated row', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX', baseRate: '4500.00', isActive: true,
    });
    prisma.travelCostMaster.update.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX', baseRate: 5000, isActive: true,
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseRate: 5000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 10, baseRate: 5000 });
    expect(prisma.travelCostMaster.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10 }, data: expect.objectContaining({ baseRate: 5000 }) }),
    );
  });

  test('USER role is rejected with 403 (no findFirst call)', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/10')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ baseRate: 5000 });
    expect(res.status).toBe(403);
    expect(prisma.travelCostMaster.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('cross-tenant target returns 404 NOT_FOUND (no update)', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseRate: 1000 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('empty body returns 400 EMPTY_BODY (no update)', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'tmc', category: 'hotel',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('invalid category in PATCH returns 400 INVALID_CATEGORY', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'tmc', category: 'hotel',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ category: 'cruise' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CATEGORY' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('negative baseRate in PATCH returns 400 INVALID_BASE_RATE', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'tmc', category: 'hotel',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseRate: -50 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BASE_RATE' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('PATCH on row caller cannot reach via sub-brand returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, subBrand: 'visasure', category: 'visa',
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/11')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ baseRate: 7500 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/cost-master/:id — ADMIN only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/cost-master/:id', () => {
  test('happy delete returns 200 + { deleted: true, id }', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 20, tenantId: 1, subBrand: 'tmc', category: 'hotel',
    });
    prisma.travelCostMaster.delete.mockResolvedValue({ id: 20 });
    const res = await request(makeApp())
      .delete('/api/travel/cost-master/20')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 20 });
    expect(prisma.travelCostMaster.delete).toHaveBeenCalledWith({ where: { id: 20 } });
  });

  test('MANAGER role IS allowed to delete (cost_master.delete in MANAGER_PERMISSIONS)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 20, tenantId: 1, subBrand: 'tmc', category: 'hotel',
    });
    prisma.travelCostMaster.delete.mockResolvedValue({ id: 20 });
    const res = await request(makeApp())
      .delete('/api/travel/cost-master/20')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 20 });
    expect(prisma.travelCostMaster.delete).toHaveBeenCalledWith({ where: { id: 20 } });
  });

  test('USER role is rejected with 403 (no delete permission)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/cost-master/20')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelCostMaster.delete).not.toHaveBeenCalled();
  });

  test('cross-tenant DELETE returns 404 NOT_FOUND (no delete call)', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/cost-master/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.travelCostMaster.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Hotel preference attributes (PRD §4.3 RFU preference filters — gap A7)
//
// Structured `attributes` body field (view/floorLevel/roomCategory) validates
// against routes/travel_cost_master.js HOTEL_ATTRIBUTES, stores stringified
// into attributesJson (String? @db.Text), and every read surface echoes the
// defensively-parsed `attributes` object. List endpoint grows ?view= /
// ?floorLevel= / ?roomCategory= post-fetch filters (pagination applied AFTER
// filtering, same discipline as /cost-master/by-month).
// -----------------------------------------------------------------------------

describe('hotel preference attributes (PRD §4.3 gap A7)', () => {
  const hotelBody = () => ({
    subBrand: 'rfu',
    category: 'hotel',
    routeOrSku: 'Makkah:Hilton:Deluxe',
    baseRate: 12000,
  });

  test('POST with valid attributes persists stringified attributesJson + echoes parsed attributes', async () => {
    prisma.travelCostMaster.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 70, ...data }),
    );
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        ...hotelBody(),
        attributes: { view: 'haram_facing', floorLevel: 'high', roomCategory: 'Deluxe' },
      });
    expect(res.status).toBe(201);
    // Stored value is a JSON string (call-site stringify per lib/sanitizeJson).
    const calledData = prisma.travelCostMaster.create.mock.calls[0][0].data;
    expect(typeof calledData.attributesJson).toBe('string');
    expect(JSON.parse(calledData.attributesJson)).toEqual({
      view: 'haram_facing',
      floorLevel: 'high',
      roomCategory: 'Deluxe',
    });
    // Response echoes the parsed attributes object alongside the raw column.
    expect(res.body.attributes).toEqual({
      view: 'haram_facing',
      floorLevel: 'high',
      roomCategory: 'Deluxe',
    });
  });

  test('POST with unknown view value returns 400 INVALID_ATTRIBUTES (no create)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...hotelBody(), attributes: { view: 'ocean_facing' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
    expect(res.body.error).toMatch(/haram_facing/);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('POST with unknown floorLevel value returns 400 INVALID_ATTRIBUTES (no create)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...hotelBody(), attributes: { floorLevel: 'penthouse' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('PATCH with structured attributes stores stringified + echoes parsed', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 71, tenantId: 1, subBrand: 'rfu', category: 'hotel',
    });
    prisma.travelCostMaster.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 71, tenantId: 1, subBrand: 'rfu', category: 'hotel', ...data }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/71')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ attributes: { view: 'kaaba_facing', roomCategory: 'Suite' } });
    expect(res.status).toBe(200);
    const calledData = prisma.travelCostMaster.update.mock.calls[0][0].data;
    expect(JSON.parse(calledData.attributesJson)).toEqual({
      view: 'kaaba_facing',
      roomCategory: 'Suite',
    });
    expect(res.body.attributes).toEqual({ view: 'kaaba_facing', roomCategory: 'Suite' });
  });

  test('PATCH with invalid attributes returns 400 INVALID_ATTRIBUTES (no update)', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 71, tenantId: 1, subBrand: 'rfu', category: 'hotel',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/71')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ attributes: { view: 'garden' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
    expect(prisma.travelCostMaster.update).not.toHaveBeenCalled();
  });

  test('PATCH attributes:null clears attributesJson', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 72, tenantId: 1, subBrand: 'rfu', category: 'hotel',
      attributesJson: '{"view":"standard"}',
    });
    prisma.travelCostMaster.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 72, tenantId: 1, subBrand: 'rfu', category: 'hotel', ...data }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/cost-master/72')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ attributes: null });
    expect(res.status).toBe(200);
    expect(prisma.travelCostMaster.update.mock.calls[0][0].data.attributesJson).toBeNull();
    expect(res.body.attributes).toBeNull();
  });

  test('list ?view= filter returns only matching rows (post-fetch filter, paginated after)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Hilton:Deluxe', attributesJson: '{"view":"haram_facing","floorLevel":"high"}' },
      { id: 2, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Pullman:Std', attributesJson: '{"view":"city_view"}' },
      { id: 3, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Raffles:Suite', attributesJson: 'not-json{{{' },
      { id: 4, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Swissotel:Std', attributesJson: null },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master?category=hotel&view=haram_facing')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rates).toHaveLength(1);
    expect(res.body.rates[0]).toMatchObject({
      id: 1,
      attributes: { view: 'haram_facing', floorLevel: 'high' },
    });
    // Post-filter path fetches the full tenant-scoped where (no take/skip)
    // and paginates AFTER filtering — count() is not used.
    const findArgs = prisma.travelCostMaster.findMany.mock.calls[0][0];
    expect(findArgs.take).toBeUndefined();
    expect(findArgs.skip).toBeUndefined();
    expect(prisma.travelCostMaster.count).not.toHaveBeenCalled();
  });

  test('list ?roomCategory= is a case-insensitive substring match', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 5, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'A', attributesJson: '{"roomCategory":"Deluxe Twin"}' },
      { id: 6, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'B', attributesJson: '{"roomCategory":"Suite"}' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/cost-master?roomCategory=deluxe')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rates).toHaveLength(1);
    expect(res.body.rates[0].id).toBe(5);
  });

  test('list ?view=bogus returns 400 INVALID_ATTRIBUTES (no query)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master?view=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('list ?floorLevel=bogus returns 400 INVALID_ATTRIBUTES', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master?floorLevel=basement')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
  });

  test('unfiltered list parses attributesJson into attributes (null on garbage)', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      { id: 7, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'A', attributesJson: '{"view":"standard"}' },
      { id: 8, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'B', attributesJson: '[1,2,3]' },
      { id: 9, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'C', attributesJson: '}{garbage' },
    ]);
    prisma.travelCostMaster.count.mockResolvedValue(3);
    const res = await request(makeApp())
      .get('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rates[0].attributes).toEqual({ view: 'standard' });
    expect(res.body.rates[1].attributes).toBeNull(); // array → not an attributes object
    expect(res.body.rates[2].attributes).toBeNull(); // garbage → defensive null
  });

  test('GET /:id echoes parsed attributes', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 73, tenantId: 1, subBrand: 'rfu', category: 'hotel', routeOrSku: 'Makkah:Hilton:Deluxe',
      attributesJson: '{"view":"kaaba_facing","floorLevel":"mid","roomCategory":"Suite"}',
    });
    const res = await request(makeApp())
      .get('/api/travel/cost-master/73')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.attributes).toEqual({
      view: 'kaaba_facing', floorLevel: 'mid', roomCategory: 'Suite',
    });
  });

  test('exported HOTEL_ATTRIBUTES vocabulary is the canonical set', () => {
    expect(costMasterRouter.HOTEL_ATTRIBUTES).toEqual({
      view: ['haram_facing', 'kaaba_facing', 'city_view', 'standard'],
      floorLevel: ['low', 'mid', 'high'],
    });
  });
});

// -----------------------------------------------------------------------------
// Auth gate
// -----------------------------------------------------------------------------

describe('auth gate', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/cost-master');
    expect(res.status).toBe(401);
  });

  test('non-travel-vertical tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/cost-master')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });
});
