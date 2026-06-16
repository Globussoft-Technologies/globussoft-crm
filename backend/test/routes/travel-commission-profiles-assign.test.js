// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 6 — bulk-assign endpoint contract.
 *
 * Pins POST /api/travel/commission-profiles/:id/assign which writes
 * Contact.commissionProfileId for a list of agent contacts. Sibling to
 * travel-commission-profiles.test.js (slice 2 CRUD).
 *
 * What's pinned
 * -------------
 *   - POST /api/travel/commission-profiles/:id/assign
 *       happy path: 3 contacts assigned → 200 { profileId, assignedCount:3, requestedCount:3 }
 *       partial overlap: 2 of 3 contactIds belong to tenant → assignedCount=2, requestedCount=3
 *       zero overlap (all cross-tenant ids) → assignedCount=0, requestedCount=N
 *       missing contactIds → 400 MISSING_FIELDS
 *       empty contactIds array → 400 MISSING_FIELDS
 *       contactIds is a string (non-array) → 400 INVALID_CONTACT_IDS
 *       contactIds contains a non-integer → 400 INVALID_CONTACT_IDS
 *       cross-tenant profile lookup → 404 PROFILE_NOT_FOUND (updateMany NOT called)
 *       MANAGER restricted to ["rfu"] assigning a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       USER role → 403 RBAC_DENIED (endpoint is ADMIN/MANAGER only)
 *       audit row written with action='TRAVEL_COMMISSION_PROFILE_ASSIGNED' + assignedCount
 *
 * Test pattern mirrors travel-commission-profiles.test.js — patch prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, drive supertest
 * with HS256 JWTs signed against the fallback secret. verifyToken + requirePermission
 * stay in the chain so auth + RBAC + sub-brand gates all run.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findFirst = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.updateMany = vi.fn();
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

const ENABLED_PROFILE = {
  id: 42,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: null,
  isActive: true,
};

const TMC_PROFILE = {
  id: 42,
  tenantId: 1,
  name: 'TMC schools 8%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 8 }),
  subBrand: 'tmc',
  isActive: true,
};

beforeEach(() => {
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.contact.updateMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/commission-profiles/:id/assign', () => {
  test('happy path: 3 contacts assigned → 200 { profileId, assignedCount:3, requestedCount:3 }', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(ENABLED_PROFILE);
    prisma.contact.updateMany.mockResolvedValue({ count: 3 });

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101, 102, 103] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profileId: 42,
      assignedCount: 3,
      requestedCount: 3,
    });

    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [101, 102, 103] },
        tenantId: 1,
      },
      data: { commissionProfileId: 42 },
    });
  });

  test('partial overlap: only 2 of 3 contactIds belong to tenant → assignedCount=2, requestedCount=3', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(ENABLED_PROFILE);
    // prisma.updateMany naturally returns the count of rows matched + updated;
    // cross-tenant ids silently miss because the where clause is tenant-scoped.
    prisma.contact.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101, 102, 9999] }); // 9999 belongs to a different tenant

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profileId: 42,
      assignedCount: 2,
      requestedCount: 3,
    });
  });

  test('zero overlap: all contactIds are cross-tenant → assignedCount=0, requestedCount=N (200, no error)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(ENABLED_PROFILE);
    prisma.contact.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [8001, 8002] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profileId: 42,
      assignedCount: 0,
      requestedCount: 2,
    });
  });

  test('missing contactIds → 400 MISSING_FIELDS (updateMany NOT called)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('empty contactIds array → 400 MISSING_FIELDS (updateMany NOT called)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('contactIds is a string (non-array) → 400 INVALID_CONTACT_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: '101,102,103' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_IDS' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('contactIds contains a non-integer → 400 INVALID_CONTACT_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101, '102', 103] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_IDS' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('contactIds contains a float → 400 INVALID_CONTACT_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101, 102.5, 103] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_IDS' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('cross-tenant profile id → 404 PROFILE_NOT_FOUND (updateMany NOT called)', async () => {
    // findFirst returns null because tenantId scope misses.
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/9999/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101, 102] });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"] assigning a "tmc"-scoped profile → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(TMC_PROFILE);
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ contactIds: [101] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED (endpoint is ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ contactIds: [101] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    // Profile lookup must not fire — RBAC gate runs first.
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('audit row written with action=TRAVEL_COMMISSION_PROFILE_ASSIGNED + assignedCount', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(ENABLED_PROFILE);
    prisma.contact.updateMany.mockResolvedValue({ count: 5 });

    await request(makeApp())
      .post('/api/travel/commission-profiles/42/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [201, 202, 203, 204, 205] });

    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'TravelCommissionProfile',
      action: 'TRAVEL_COMMISSION_PROFILE_ASSIGNED',
      entityId: 42,
      userId: 7,
      tenantId: 1,
    });
    // The audit details payload should include the delta numbers.
    const detailsRaw = auditCallArgs.data.details;
    const details = typeof detailsRaw === 'string' ? JSON.parse(detailsRaw) : detailsRaw;
    expect(details).toMatchObject({
      profileId: 42,
      assignedCount: 5,
      requestedCount: 5,
    });
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/not-an-int/assign')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactIds: [101] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });
});
