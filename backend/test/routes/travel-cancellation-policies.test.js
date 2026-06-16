// @ts-check
/**
 * backend/routes/travel_cancellation_policies.js — S33 (#920) CRUD contract pin.
 *
 * What's pinned
 * -------------
 *   - GET    /api/travel/cancellation-policies      tenant-scoped list; honors
 *                                                    ?subBrand + ?active filters;
 *                                                    paginated envelope.
 *   - GET    /api/travel/cancellation-policies/:id  400 INVALID_ID on bad param;
 *                                                    404 NOT_FOUND cross-tenant.
 *   - POST   /api/travel/cancellation-policies      201 happy; 400 MISSING_FIELDS;
 *                                                    400 INVALID_TIERS; 400
 *                                                    INVALID_TIER_DAYS;
 *                                                    400 INVALID_TIER_PERCENT;
 *                                                    400 INVALID_SUB_BRAND;
 *                                                    403 SUB_BRAND_DENIED; 403
 *                                                    USER role gate.
 *   - PATCH  /api/travel/cancellation-policies/:id  ADMIN/MANAGER gate; 404
 *                                                    cross-tenant; 400 EMPTY_BODY;
 *                                                    200 happy.
 *   - DELETE /api/travel/cancellation-policies/:id  ADMIN-only gate; 404
 *                                                    cross-tenant; 204 No Content.
 *
 * Test pattern mirrors backend/test/routes/travel-cost-master.test.js
 * (cost-master CRUD template) — patch the prisma singleton with vi.fn()
 * shapes BEFORE requiring the router, then drive supertest with real HS256
 * JWTs signed with the same fallback secret the middleware uses in dev.
 * verifyToken + requirePermission + requireTravelTenant stay in the chain so the
 * full guard stack is exercised end-to-end.
 *
 * Also pins the assertValidTiers re-export contract so cron / cancel-handler
 * consumers can lean on the validator without the express layer.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.cancellationPolicy = {
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
const policiesRouter = requireCJS('../../routes/travel_cancellation_policies');
const { assertValidTiers } = policiesRouter;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', policiesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const DEFAULT_TIERS = [
  { daysBeforeServiceStart: 30, refundPercent: 100 },
  { daysBeforeServiceStart: 7, refundPercent: 50 },
  { daysBeforeServiceStart: 0, refundPercent: 0 },
];

beforeEach(() => {
  prisma.cancellationPolicy.findMany.mockReset();
  prisma.cancellationPolicy.findFirst.mockReset();
  prisma.cancellationPolicy.count.mockReset();
  prisma.cancellationPolicy.create.mockReset();
  prisma.cancellationPolicy.update.mockReset();
  prisma.cancellationPolicy.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// -----------------------------------------------------------------------------
// assertValidTiers — re-exported pure validator (covers the credit-note auto-
// issuance path in travel_invoices.js indirectly + the policy CRUD directly).
// -----------------------------------------------------------------------------

describe('assertValidTiers (re-exported)', () => {
  test('accepts a JS array and returns DESC-sorted canonical tiers', () => {
    const out = assertValidTiers([
      { daysBeforeServiceStart: 0, refundPercent: 0 },
      { daysBeforeServiceStart: 30, refundPercent: 100 },
      { daysBeforeServiceStart: 7, refundPercent: 50 },
    ]);
    expect(out).toEqual([
      { daysBeforeServiceStart: 30, refundPercent: 100 },
      { daysBeforeServiceStart: 7, refundPercent: 50 },
      { daysBeforeServiceStart: 0, refundPercent: 0 },
    ]);
  });

  test('accepts a JSON string and parses + canonicalises', () => {
    const out = assertValidTiers(JSON.stringify(DEFAULT_TIERS));
    expect(out).toHaveLength(3);
    expect(out[0].daysBeforeServiceStart).toBe(30);
  });

  test('rejects an empty array with INVALID_TIERS', () => {
    expect(() => assertValidTiers([])).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIERS' }),
    );
  });

  test('rejects unparseable JSON with INVALID_TIERS_JSON', () => {
    expect(() => assertValidTiers('not-json')).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIERS_JSON' }),
    );
  });

  test('rejects negative daysBeforeServiceStart with INVALID_TIER_DAYS', () => {
    expect(() =>
      assertValidTiers([{ daysBeforeServiceStart: -1, refundPercent: 50 }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TIER_DAYS' }));
  });

  test('rejects non-integer daysBeforeServiceStart with INVALID_TIER_DAYS', () => {
    expect(() =>
      assertValidTiers([{ daysBeforeServiceStart: 7.5, refundPercent: 50 }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TIER_DAYS' }));
  });

  test('rejects refundPercent > 100 with INVALID_TIER_PERCENT', () => {
    expect(() =>
      assertValidTiers([{ daysBeforeServiceStart: 7, refundPercent: 150 }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TIER_PERCENT' }));
  });

  test('rejects refundPercent < 0 with INVALID_TIER_PERCENT', () => {
    expect(() =>
      assertValidTiers([{ daysBeforeServiceStart: 7, refundPercent: -1 }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TIER_PERCENT' }));
  });

  test('rejects non-object tier entry with INVALID_TIER_SHAPE', () => {
    expect(() => assertValidTiers(['not-an-object'])).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIER_SHAPE' }),
    );
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/cancellation-policies — list
// -----------------------------------------------------------------------------

describe('GET /api/travel/cancellation-policies', () => {
  test('returns tenant-scoped list with default envelope', async () => {
    prisma.cancellationPolicy.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, name: 'TMC Default', subBrand: 'tmc',
        tiersJson: JSON.stringify(DEFAULT_TIERS), isActive: true,
      },
    ]);
    prisma.cancellationPolicy.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.policies).toHaveLength(1);
    expect(prisma.cancellationPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
        take: 50,
        skip: 0,
      }),
    );
  });

  test('honors ?subBrand + ?active filters in the where clause', async () => {
    prisma.cancellationPolicy.findMany.mockResolvedValue([]);
    prisma.cancellationPolicy.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cancellation-policies?subBrand=rfu&active=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.cancellationPolicy.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({
      tenantId: 1,
      subBrand: 'rfu',
      isActive: true,
    });
  });

  test('?subBrand=null filters tenant-wide defaults', async () => {
    prisma.cancellationPolicy.findMany.mockResolvedValue([]);
    prisma.cancellationPolicy.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cancellation-policies?subBrand=null')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.cancellationPolicy.findMany.mock.calls[0][0].where;
    expect(calledWhere.subBrand).toBeNull();
  });

  test('rejects ?subBrand=bogus with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cancellation-policies?subBrand=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
  });

  test('limit is capped at 200', async () => {
    prisma.cancellationPolicy.findMany.mockResolvedValue([]);
    prisma.cancellationPolicy.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/cancellation-policies?limit=9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.cancellationPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/cancellation-policies/:id — fetch one
// -----------------------------------------------------------------------------

describe('GET /api/travel/cancellation-policies/:id', () => {
  test('rejects non-numeric :id with 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cancellation-policies/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('returns 404 NOT_FOUND on cross-tenant id', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/cancellation-policies/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('returns 200 with policy on hit', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 'TMC Default', tiersJson: '[]',
    });
    const res = await request(makeApp())
      .get('/api/travel/cancellation-policies/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
  });
});

// -----------------------------------------------------------------------------
// POST /api/travel/cancellation-policies — create
// -----------------------------------------------------------------------------

describe('POST /api/travel/cancellation-policies', () => {
  const validBody = () => ({
    name: 'TMC Default',
    subBrand: 'tmc',
    tiersJson: DEFAULT_TIERS,
  });

  test('happy path returns 201 with persisted row + audit row written', async () => {
    prisma.cancellationPolicy.create.mockImplementation(async ({ data }) => ({
      id: 42, ...data,
    }));
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 42, name: 'TMC Default', subBrand: 'tmc' });
    expect(prisma.cancellationPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'TMC Default',
          subBrand: 'tmc',
          isActive: true,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('subBrand=null persists as tenant-wide default', async () => {
    prisma.cancellationPolicy.create.mockImplementation(async ({ data }) => ({
      id: 50, ...data,
    }));
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Tenant Default', tiersJson: DEFAULT_TIERS });
    expect(res.status).toBe(201);
    expect(prisma.cancellationPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subBrand: null }),
      }),
    );
  });

  test('missing name returns 400 MISSING_FIELDS', async () => {
    const body = validBody();
    delete body.name;
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.cancellationPolicy.create).not.toHaveBeenCalled();
  });

  test('missing tiersJson returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('bad tier shape returns 400 INVALID_TIER_PERCENT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'X',
        tiersJson: [{ daysBeforeServiceStart: 7, refundPercent: 150 }],
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TIER_PERCENT' });
    expect(prisma.cancellationPolicy.create).not.toHaveBeenCalled();
  });

  test('invalid subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), subBrand: 'spaceforce' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
  });

  test('USER role returns 403 (verifyRole short-circuits)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(prisma.cancellationPolicy.create).not.toHaveBeenCalled();
  });

  test('MANAGER without sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ ...validBody(), subBrand: 'tmc' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });

  test('duplicate name returns 409 POLICY_NAME_TAKEN', async () => {
    const e = new Error('P2002');
    e.code = 'P2002';
    prisma.cancellationPolicy.create.mockRejectedValue(e);
    const res = await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'POLICY_NAME_TAKEN' });
  });

  test('tiers stored as JSON-string canonicalised DESC by threshold', async () => {
    prisma.cancellationPolicy.create.mockImplementation(async ({ data }) => ({
      id: 60, ...data,
    }));
    await request(makeApp())
      .post('/api/travel/cancellation-policies')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Mixed',
        tiersJson: [
          { daysBeforeServiceStart: 0, refundPercent: 0 },
          { daysBeforeServiceStart: 30, refundPercent: 100 },
          { daysBeforeServiceStart: 7, refundPercent: 50 },
        ],
      });
    const persisted = prisma.cancellationPolicy.create.mock.calls[0][0].data.tiersJson;
    const parsed = JSON.parse(persisted);
    expect(parsed[0].daysBeforeServiceStart).toBe(30);
    expect(parsed[2].daysBeforeServiceStart).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// PATCH /api/travel/cancellation-policies/:id — update
// -----------------------------------------------------------------------------

describe('PATCH /api/travel/cancellation-policies/:id', () => {
  test('happy path returns 200 + persists subset', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'Old', subBrand: 'tmc', tiersJson: '[]', isActive: true,
    });
    prisma.cancellationPolicy.update.mockImplementation(async ({ data }) => ({
      id: 10, tenantId: 1, ...data,
    }));
    const res = await request(makeApp())
      .patch('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'New Name', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New Name', isActive: false });
  });

  test('cross-tenant id returns 404 NOT_FOUND', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/cancellation-policies/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'Old', tiersJson: '[]',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
  });

  test('PATCH tiersJson re-validates + canonicalises', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'Old', tiersJson: '[]',
    });
    prisma.cancellationPolicy.update.mockImplementation(async ({ data }) => ({
      id: 10, ...data,
    }));
    await request(makeApp())
      .patch('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ tiersJson: DEFAULT_TIERS });
    const persisted = prisma.cancellationPolicy.update.mock.calls[0][0].data.tiersJson;
    const parsed = JSON.parse(persisted);
    expect(parsed[0].daysBeforeServiceStart).toBe(30);
  });

  test('PATCH bad tiersJson returns 400 INVALID_TIER_DAYS', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'Old', tiersJson: '[]',
    });
    const res = await request(makeApp())
      .patch('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        tiersJson: [{ daysBeforeServiceStart: -1, refundPercent: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TIER_DAYS' });
    expect(prisma.cancellationPolicy.update).not.toHaveBeenCalled();
  });

  test('USER role returns 403', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ name: 'X' });
    expect(res.status).toBe(403);
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/cancellation-policies/:id — admin-only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/cancellation-policies/:id', () => {
  test('returns 204 No Content on happy path', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'TMC Default',
    });
    prisma.cancellationPolicy.delete.mockResolvedValue({ id: 10 });
    const res = await request(makeApp())
      .delete('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(prisma.cancellationPolicy.delete).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('cross-tenant id returns 404', async () => {
    prisma.cancellationPolicy.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/cancellation-policies/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  test('MANAGER role returns 403 (ADMIN-only on delete)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/cancellation-policies/10')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
  });
});
