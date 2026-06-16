// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 2 — TravelCommissionProfile CRUD tests.
 *
 * Pins the contract for routes/travel_commission_profiles.js shipped
 * alongside the TravelCommissionProfile Prisma model and consuming the
 * lib/agentCommissionCalculator.js (slice 1, commit cb284098) profile
 * shapes (flat_percent | tiered | per_pax_flat | hybrid).
 *
 * What's pinned
 * -------------
 *   - POST   /api/travel/commission-profiles
 *       happy path with flat_percent profile shape → 201
 *       happy path with tiered profile (richer JSON) → 201
 *       missing name → 400 MISSING_FIELDS
 *       missing profileType → 400 MISSING_FIELDS
 *       invalid profileType (whitelist miss) → 400 INVALID_PROFILE_TYPE
 *       unparseable profileJson string → 400 INVALID_PROFILE_JSON
 *       invalid subBrand → 400 INVALID_SUB_BRAND
 *       MANAGER with subBrandAccess outside target → 403 SUB_BRAND_DENIED
 *   - GET    /api/travel/commission-profiles
 *       tenant-scoped list shape
 *       ?subBrand filter narrows where clause
 *   - GET    /api/travel/commission-profiles/:id
 *       cross-tenant lookup returns 404 PROFILE_NOT_FOUND
 *   - PUT    /api/travel/commission-profiles/:id
 *       partial update happy path
 *       cross-tenant returns 404 PROFILE_NOT_FOUND (no update fires)
 *   - DELETE /api/travel/commission-profiles/:id
 *       ADMIN happy path → 204 + audit row written before prisma.delete
 *       MANAGER → 403 RBAC_DENIED (route is ADMIN-only on delete)
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed against the same
 * fallback secret the middleware uses in dev. verifyToken + requirePermission
 * stay in the chain so the full auth + RBAC + sub-brand gate runs.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = {
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
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const profilesRouter = requireCJS('../../routes/travel_commission_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', profilesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Canonical sample profile shapes that match lib/agentCommissionCalculator.js.
const flatPercentProfile = { type: 'flat_percent', percent: 5 };
const tieredProfile = {
  type: 'tiered',
  tiers: [
    { uptoCents: 5_000_000, percent: 10 },
    { uptoCents: 20_000_000, percent: 5 },
    { uptoCents: null, percent: 2 },
  ],
};

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelCommissionProfile.findMany.mockReset();
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.travelCommissionProfile.count.mockReset();
  prisma.travelCommissionProfile.create.mockReset();
  prisma.travelCommissionProfile.update.mockReset();
  prisma.travelCommissionProfile.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/commission-profiles', () => {
  test('happy path with flat_percent profile returns 201', async () => {
    prisma.travelCommissionProfile.create.mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: 'Standard 5%',
      profileType: 'flat_percent',
      profileJson: JSON.stringify(flatPercentProfile),
      subBrand: 'tmc',
      isActive: true,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Standard 5%',
        profileType: 'flat_percent',
        profileJson: flatPercentProfile,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      name: 'Standard 5%',
      profileType: 'flat_percent',
      subBrand: 'tmc',
      isActive: true,
    });
    expect(prisma.travelCommissionProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'Standard 5%',
          profileType: 'flat_percent',
          subBrand: 'tmc',
        }),
      }),
    );
    // profileJson must be stored as a JSON string.
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(typeof callArgs.data.profileJson).toBe('string');
    expect(JSON.parse(callArgs.data.profileJson)).toEqual(flatPercentProfile);
    // Audit row must be written.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('happy path with tiered profile (richer JSON) returns 201', async () => {
    prisma.travelCommissionProfile.create.mockResolvedValue({
      id: 43,
      tenantId: 1,
      name: 'Tiered slabs',
      profileType: 'tiered',
      profileJson: JSON.stringify(tieredProfile),
      subBrand: null,
      isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Tiered slabs',
        profileType: 'tiered',
        // Accept stringified JSON too (column is @db.Text).
        profileJson: JSON.stringify(tieredProfile),
      });
    expect(res.status).toBe(201);
    expect(res.body.profileType).toBe('tiered');
    // subBrand null = tenant-wide.
    expect(prisma.travelCommissionProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subBrand: null,
          profileType: 'tiered',
        }),
      }),
    );
  });

  test('rejects missing name with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        profileType: 'flat_percent',
        profileJson: flatPercentProfile,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('rejects invalid profileType with 400 INVALID_PROFILE_TYPE + whitelist hint', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'bad',
        profileType: 'percentage_of_margin',
        profileJson: flatPercentProfile,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PROFILE_TYPE' });
    expect(res.body.error).toMatch(/flat_percent/);
    expect(res.body.error).toMatch(/tiered/);
    expect(res.body.error).toMatch(/per_pax_flat/);
    expect(res.body.error).toMatch(/hybrid/);
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('rejects unparseable profileJson string with 400 INVALID_PROFILE_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'bad',
        profileType: 'flat_percent',
        profileJson: '{not-valid-json',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PROFILE_JSON' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('rejects invalid subBrand with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'wrong-brand',
        profileType: 'flat_percent',
        profileJson: flatPercentProfile,
        subBrand: 'gold-package',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"] creating a "tmc" profile gets 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({
        name: 'cross-brand',
        profileType: 'flat_percent',
        profileJson: flatPercentProfile,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/commission-profiles', () => {
  test('returns tenant-scoped list', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      {
        id: 1,
        tenantId: 1,
        name: 'Standard 5%',
        profileType: 'flat_percent',
        profileJson: JSON.stringify(flatPercentProfile),
        subBrand: null,
        isActive: true,
      },
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.profiles).toHaveLength(1);
    expect(prisma.travelCommissionProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('?subBrand filter narrows the where clause', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([]);
    prisma.travelCommissionProfile.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/commission-profiles?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelCommissionProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, subBrand: 'rfu' }),
      }),
    );
  });
});

describe('GET /api/travel/commission-profiles/:id', () => {
  test('cross-tenant lookup returns 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.travelCommissionProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

describe('PUT /api/travel/commission-profiles/:id', () => {
  test('partial update happy path returns 200 + only touches sent fields', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'old',
      profileType: 'flat_percent',
      profileJson: JSON.stringify(flatPercentProfile),
      subBrand: 'tmc',
      isActive: true,
    });
    prisma.travelCommissionProfile.update.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'renamed',
      profileType: 'flat_percent',
      profileJson: JSON.stringify(flatPercentProfile),
      subBrand: 'tmc',
      isActive: false,
    });
    const res = await request(makeApp())
      .put('/api/travel/commission-profiles/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'renamed', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, name: 'renamed', isActive: false });
    expect(prisma.travelCommissionProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ name: 'renamed', isActive: false }),
      }),
    );
    // Untouched fields must NOT appear in the update payload.
    const updateData = prisma.travelCommissionProfile.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('profileType');
    expect(updateData).not.toHaveProperty('profileJson');
  });

  test('cross-tenant returns 404 PROFILE_NOT_FOUND (no update fires)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/commission-profiles/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'oops' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.travelCommissionProfile.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/commission-profiles/:id (ADMIN-only hard delete)', () => {
  test('ADMIN: returns 204 and writes audit row before prisma.delete fires', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'doomed',
      profileType: 'flat_percent',
      profileJson: JSON.stringify(flatPercentProfile),
      subBrand: 'tmc',
      isActive: true,
    });
    prisma.travelCommissionProfile.delete.mockResolvedValue({ id: 5 });

    const callOrder = [];
    prisma.auditLog.create.mockImplementation(async (args) => {
      callOrder.push('audit');
      return { id: 1, ...args };
    });
    prisma.travelCommissionProfile.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return { id: 5 };
    });

    const res = await request(makeApp())
      .delete('/api/travel/commission-profiles/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.travelCommissionProfile.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(callOrder).toEqual(['audit', 'delete']);

    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'TravelCommissionProfile',
      action: 'DELETE',
      entityId: 5,
      userId: 7,
      tenantId: 1,
    });
  });

  test('MANAGER: returns 403 RBAC_DENIED (route is ADMIN-only on delete)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/commission-profiles/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelCommissionProfile.delete).not.toHaveBeenCalled();
  });
});
