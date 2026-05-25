// @ts-check
/**
 * PRD_TRAVEL §4.5 (RFU sub-brand) — RfuLeadProfile CRUD route contract tests.
 *
 * Pins the contract for backend/routes/travel_rfu_profiles.js — the one-to-one
 * Contact extension that stores RFU-specific pilgrim fields (passport,
 * visa history, frequent-flyer, seat/meal pref, budget, emergency contact,
 * medical notes, product tier).
 *
 * What's pinned
 * -------------
 *   - GET    /api/travel/rfu-profiles                          tenant-scoped list,
 *                                                              productTier filter, 400 on bad tier
 *   - POST   /api/travel/rfu-profiles                          201 happy path; 400 MISSING_FIELDS,
 *                                                              INVALID_CONTACT_ID, INVALID_TIER;
 *                                                              409 DUPLICATE_PASSPORT (cross-contact);
 *                                                              409 DUPLICATE_PROFILE (P2002)
 *   - POST   /api/travel/rfu-profiles/check-duplicate          400 MISSING_FIELDS when no keys;
 *                                                              tenant-scoped duplicate lookup
 *   - GET    /api/travel/rfu-profiles/by-contact/:contactId    400 INVALID_CONTACT_ID;
 *                                                              404 NOT_FOUND cross-tenant
 *   - GET    /api/travel/rfu-profiles/:id                      404 cross-tenant; 200 same-tenant
 *   - PATCH  /api/travel/rfu-profiles/:id                      400 EMPTY_BODY; 400 INVALID_TIER;
 *                                                              409 DUPLICATE_PASSPORT on update;
 *                                                              200 happy path
 *   - DELETE /api/travel/rfu-profiles/:id                      ADMIN-only gate (verifyRole);
 *                                                              200 with { deleted: true, id }
 *   - Sub-brand gate                                           non-admin user with subBrandAccess
 *                                                              excluding "rfu" → 403 SUB_BRAND_DENIED
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev. verifyToken stays in the chain (we
 * don't bypass it) so the auth-gate is exercised end-to-end.
 *
 * deduplication.js instantiates its OWN PrismaClient internally — so the
 * /check-duplicate path needs vi.mock('../../utils/deduplication') to stub
 * findDuplicateContactFull at the module boundary (the prisma singleton
 * patch wouldn't reach the helper's own client).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.rfuLeadProfile = {
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

// Stub the dedup helper at the module boundary — it owns a separate
// PrismaClient internally, so patching the shared prisma singleton
// wouldn't intercept its queries. Patch the function on the live module
// object (CJS exports, mutable) BEFORE requiring the router — the router
// captures it via destructure-at-require-time, so it must be in place
// by the time we require the router.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const dedup = requireCJS('../../utils/deduplication');
dedup.findDuplicateContactFull = vi.fn();
const rfuProfilesRouter = requireCJS('../../routes/travel_rfu_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', rfuProfilesRouter);
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
  prisma.rfuLeadProfile.findMany.mockReset();
  prisma.rfuLeadProfile.findFirst.mockReset();
  prisma.rfuLeadProfile.count.mockReset();
  prisma.rfuLeadProfile.create.mockReset();
  prisma.rfuLeadProfile.update.mockReset();
  prisma.rfuLeadProfile.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  dedup.findDuplicateContactFull.mockReset();
});

// ─── GET /api/travel/rfu-profiles ─────────────────────────────────────

describe('GET /api/travel/rfu-profiles', () => {
  test('returns tenant-scoped list with default limit/offset', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, contactId: 100, productTier: 'primary', passportNumber: 'A1234567' },
    ]);
    prisma.rfuLeadProfile.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.profiles).toHaveLength(1);
    expect(prisma.rfuLeadProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
        take: 50,
        skip: 0,
      }),
    );
  });

  test('?productTier=premium narrows where clause', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/rfu-profiles?productTier=premium')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.rfuLeadProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, productTier: 'premium' }),
      }),
    );
  });

  test('invalid productTier returns 400 INVALID_TIER (no DB call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles?productTier=platinum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TIER' });
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });
});

// ─── POST /api/travel/rfu-profiles ───────────────────────────────────

describe('POST /api/travel/rfu-profiles', () => {
  test('happy path returns 201 with the created profile + scopes tenantId from req.user', async () => {
    prisma.rfuLeadProfile.create.mockResolvedValue({
      id: 42, tenantId: 1, contactId: 100, productTier: 'primary',
      passportNumber: 'A1234567', mealPref: 'veg', budgetMin: 50000, budgetMax: 200000,
    });
    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 100,
        productTier: 'primary',
        passportNumber: 'A1234567',
        mealPref: 'veg',
        budgetMin: 50000,
        budgetMax: 200000,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 42, contactId: 100, productTier: 'primary' });
    expect(prisma.rfuLeadProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          contactId: 100,
          productTier: 'primary',
          passportNumber: 'A1234567',
          budgetMin: 50000,
          budgetMax: 200000,
        }),
      }),
    );
  });

  test('missing contactId returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ productTier: 'primary' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.rfuLeadProfile.create).not.toHaveBeenCalled();
  });

  test('non-numeric contactId returns 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
    expect(prisma.rfuLeadProfile.create).not.toHaveBeenCalled();
  });

  test('invalid productTier returns 400 INVALID_TIER', async () => {
    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, productTier: 'gold' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TIER' });
    expect(prisma.rfuLeadProfile.create).not.toHaveBeenCalled();
  });

  test('cross-contact passport collision returns 409 DUPLICATE_PASSPORT', async () => {
    // Another contact in this tenant already has this passport number.
    prisma.rfuLeadProfile.findFirst.mockResolvedValueOnce({ id: 99, contactId: 88 });

    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, passportNumber: 'A1234567' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'DUPLICATE_PASSPORT',
      existingProfileId: 99,
      existingContactId: 88,
    });
    // The collision scan MUST scope to the caller's tenant + exclude
    // the current contact (NOT { contactId: cid }).
    expect(prisma.rfuLeadProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          passportNumber: 'A1234567',
          NOT: { contactId: 100 },
        }),
      }),
    );
    expect(prisma.rfuLeadProfile.create).not.toHaveBeenCalled();
  });

  test('Prisma P2002 unique-constraint maps to 409 DUPLICATE_PROFILE', async () => {
    // No passport-collision; the @@unique on contactId fires at create-time.
    prisma.rfuLeadProfile.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, productTier: 'entry' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DUPLICATE_PROFILE' });
  });

  test('numeric coercion: budgetMin/budgetMax stringified-in arrive as numbers', async () => {
    prisma.rfuLeadProfile.create.mockResolvedValue({
      id: 43, tenantId: 1, contactId: 101, budgetMin: 75000, budgetMax: 250000,
    });

    await request(makeApp())
      .post('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 101, budgetMin: '75000', budgetMax: '250000' });

    const calledData = prisma.rfuLeadProfile.create.mock.calls[0][0].data;
    expect(calledData.budgetMin).toBe(75000);
    expect(calledData.budgetMax).toBe(250000);
  });
});

// ─── POST /api/travel/rfu-profiles/check-duplicate (PRD §4.5) ────────

describe('POST /api/travel/rfu-profiles/check-duplicate', () => {
  test('no email/phone/passport returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles/check-duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(dedup.findDuplicateContactFull).not.toHaveBeenCalled();
  });

  test('no match returns { duplicate: false }', async () => {
    dedup.findDuplicateContactFull.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles/check-duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ passportNumber: 'A9999999' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ duplicate: false });
    expect(dedup.findDuplicateContactFull).toHaveBeenCalledWith(
      expect.objectContaining({ passportNumber: 'A9999999', tenantId: 1 }),
    );
  });

  test('match returns trimmed contact projection (no sensitive fields)', async () => {
    dedup.findDuplicateContactFull.mockResolvedValue({
      matchedBy: 'passport',
      contact: {
        id: 100,
        name: 'Aslam Khan',
        email: 'aslam@example.com',
        phone: '+919876543210',
        company: 'Khan Travels',
        subBrand: 'rfu',
        status: 'lead',
        // Fields that MUST NOT leak through the trim:
        territoryId: 7,
        portalPasswordHash: 'BAD_LEAK',
      },
    });

    const res = await request(makeApp())
      .post('/api/travel/rfu-profiles/check-duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ passportNumber: 'A1234567' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      duplicate: true,
      matchedBy: 'passport',
      contact: { id: 100, name: 'Aslam Khan', email: 'aslam@example.com', subBrand: 'rfu' },
    });
    // Critical: sensitive fields must NOT be present in the response.
    expect(res.body.contact).not.toHaveProperty('territoryId');
    expect(res.body.contact).not.toHaveProperty('portalPasswordHash');
  });
});

// ─── GET /api/travel/rfu-profiles/by-contact/:contactId ──────────────

describe('GET /api/travel/rfu-profiles/by-contact/:contactId', () => {
  test('non-numeric contactId returns 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-contact/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
  });

  test('cross-tenant (or missing) returns 404 NOT_FOUND', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-contact/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.rfuLeadProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contactId: 9999, tenantId: 1 }),
      }),
    );
  });

  test('same-tenant returns 200 with row', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100, passportNumber: 'A1234567',
    });

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/by-contact/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, contactId: 100 });
  });
});

// ─── GET /api/travel/rfu-profiles/:id ────────────────────────────────

describe('GET /api/travel/rfu-profiles/:id', () => {
  test('cross-tenant returns 404 NOT_FOUND', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.rfuLeadProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

// ─── PATCH /api/travel/rfu-profiles/:id ──────────────────────────────

describe('PATCH /api/travel/rfu-profiles/:id', () => {
  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100,
    });

    const res = await request(makeApp())
      .patch('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.rfuLeadProfile.update).not.toHaveBeenCalled();
  });

  test('invalid productTier on PATCH returns 400 INVALID_TIER', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100,
    });

    const res = await request(makeApp())
      .patch('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ productTier: 'gold' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TIER' });
    expect(prisma.rfuLeadProfile.update).not.toHaveBeenCalled();
  });

  test('passport-collision on PATCH returns 409 DUPLICATE_PASSPORT', async () => {
    // First findFirst = the existing row; second findFirst = collision lookup.
    prisma.rfuLeadProfile.findFirst
      .mockResolvedValueOnce({ id: 7, tenantId: 1, contactId: 100 })
      .mockResolvedValueOnce({ id: 99, contactId: 88 });

    const res = await request(makeApp())
      .patch('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ passportNumber: 'B7654321' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'DUPLICATE_PASSPORT',
      existingProfileId: 99,
      existingContactId: 88,
    });
    // The collision lookup must exclude the current row (NOT { id: existing.id }).
    expect(prisma.rfuLeadProfile.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          passportNumber: 'B7654321',
          NOT: { id: 7 },
        }),
      }),
    );
    expect(prisma.rfuLeadProfile.update).not.toHaveBeenCalled();
  });

  test('happy path returns 200 with the updated profile', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100,
    });
    prisma.rfuLeadProfile.update.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100, mealPref: 'halal', productTier: 'premium',
    });

    const res = await request(makeApp())
      .patch('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ mealPref: 'halal', productTier: 'premium' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, mealPref: 'halal', productTier: 'premium' });
    expect(prisma.rfuLeadProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ mealPref: 'halal', productTier: 'premium' }),
      }),
    );
  });
});

// ─── DELETE /api/travel/rfu-profiles/:id (ADMIN-only) ────────────────

describe('DELETE /api/travel/rfu-profiles/:id', () => {
  test('USER role cannot delete (403 RBAC_DENIED)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });

    const res = await request(makeApp())
      .delete('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.rfuLeadProfile.delete).not.toHaveBeenCalled();
  });

  test('MANAGER role cannot delete (403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });

    const res = await request(makeApp())
      .delete('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(prisma.rfuLeadProfile.delete).not.toHaveBeenCalled();
  });

  test('ADMIN happy path returns 200 with { deleted: true, id }', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, contactId: 100,
    });
    prisma.rfuLeadProfile.delete.mockResolvedValue({ id: 7 });

    const res = await request(makeApp())
      .delete('/api/travel/rfu-profiles/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 7 });
    expect(prisma.rfuLeadProfile.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('ADMIN cross-tenant returns 404 NOT_FOUND (no delete call)', async () => {
    prisma.rfuLeadProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/travel/rfu-profiles/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.rfuLeadProfile.delete).not.toHaveBeenCalled();
  });
});

// ─── Sub-brand isolation (PRD Q25) ───────────────────────────────────

describe('sub-brand access gate (PRD Q25)', () => {
  test('non-admin user lacking "rfu" sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    // Non-admin with subBrandAccess restricted to tmc only — must NOT touch
    // the RFU surface, even read-only.
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('non-admin user with "rfu" in subBrandAccess passes the gate', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu', 'tmc']),
    });
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.rfuLeadProfile.findMany).toHaveBeenCalled();
  });
});

// ─── Vertical / tenant guard ─────────────────────────────────────────

describe('vertical guard (requireTravelTenant)', () => {
  test('wellness-vertical tenant gets 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Enhanced Wellness', slug: 'enhanced-wellness',
    });

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('missing tenant row returns 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});

// ─── Auth gate (verifyToken) ─────────────────────────────────────────

describe('auth gate', () => {
  test('no Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/rfu-profiles');
    expect(res.status).toBe(401);
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('bogus token returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/rfu-profiles')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });
});
