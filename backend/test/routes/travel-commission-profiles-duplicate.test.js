// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 13 — commission-profile duplicate endpoint contract.
 *
 * Pins POST /api/travel/commission-profiles/:id/duplicate which clones an
 * existing TravelCommissionProfile row into a fresh row under the same
 * tenant. Mirrors #908 slice 6's flyer-template duplicate pattern so
 * operator UI affordances stay consistent across the travel admin surface.
 *
 * What's pinned
 * -------------
 *   - POST /api/travel/commission-profiles/:id/duplicate
 *       happy path no overrides → 201, name=<source> (copy), shape inherited verbatim
 *       body override name → uses override (skips "(copy)" suffix)
 *       body override subBrand → uses override (validates against assertValidSubBrand)
 *       invalid subBrand override → 400 INVALID_SUB_BRAND
 *       cross-tenant source returns 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to other sub-brand → 403 SUB_BRAND_DENIED
 *       USER role → 403 RBAC_DENIED (route is ADMIN/MANAGER only)
 *       source.isActive=false still duplicates fine (no INVALID_STATE gate;
 *         new copy is reset to active so it enters the operator's active list)
 *       audit row written with action=TRAVEL_COMMISSION_PROFILE_DUPLICATED
 *         + sourceId + newId
 *       empty-name override → 400 MISSING_FIELDS
 *
 * Test pattern mirrors travel-commission-profiles-preview.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs signed against the fallback secret. verifyToken +
 * requirePermission stay in the chain so auth + RBAC + sub-brand gates all run.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findFirst = vi.fn();
prisma.travelCommissionProfile.create = vi.fn();
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

// Canonical source-row shape — operator-authored "Standard 5%" profile
// under the TMC sub-brand. Re-used across all happy/error tests below so
// the duplicate semantics can be asserted against a stable reference.
const sourceRow = {
  id: 11,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: 'tmc',
  isActive: true,
  notes: 'Operator-approved baseline 2026-04-15',
  createdAt: new Date('2026-04-15T10:00:00Z'),
  updatedAt: new Date('2026-04-15T10:00:00Z'),
};

beforeEach(() => {
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.travelCommissionProfile.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/commission-profiles/:id/duplicate (slice 13)', () => {
  test('happy path with no overrides → 201, name=<source> (copy), inherits shape', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 99,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 99,
      name: 'Standard 5% (copy)',
      profileType: 'flat_percent',
      subBrand: 'tmc',
      isActive: true,
    });

    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data).toMatchObject({
      tenantId: 1,
      name: 'Standard 5% (copy)',
      profileType: 'flat_percent',
      profileJson: sourceRow.profileJson,
      subBrand: 'tmc',
      isActive: true,
      notes: 'Operator-approved baseline 2026-04-15',
    });

    // Audit row: action=TRAVEL_COMMISSION_PROFILE_DUPLICATED + sourceId + newId
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelCommissionProfile',
      action: 'TRAVEL_COMMISSION_PROFILE_DUPLICATED',
      entityId: 99,
      userId: 7,
      tenantId: 1,
    });
    const detailsParsed = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(detailsParsed).toMatchObject({ sourceId: 11, newId: 99, subBrand: 'tmc' });
  });

  test('body override name → uses override (not the "(copy)" suffix)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 100,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Festive 8% boost' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 100, name: 'Festive 8% boost' });
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data.name).toBe('Festive 8% boost');
    // profileType + profileJson still inherit from source verbatim
    expect(callArgs.data.profileType).toBe('flat_percent');
    expect(callArgs.data.profileJson).toBe(sourceRow.profileJson);
  });

  test('body override subBrand → uses override (validates against assertValidSubBrand)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 101,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 101, subBrand: 'rfu' });
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data.subBrand).toBe('rfu');
    // Name still inherits the "(copy)" suffix from source
    expect(callArgs.data.name).toBe('Standard 5% (copy)');
  });

  test('body override subBrand=null → tenant-wide duplicate', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 102,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: null });

    expect(res.status).toBe(201);
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data.subBrand).toBeNull();
  });

  test('invalid subBrand override → 400 INVALID_SUB_BRAND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'not-a-real-brand' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('empty-string name override → 400 MISSING_FIELDS', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('cross-tenant source returns 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/9999/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"], source.subBrand="tmc" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["tmc"], override subBrand="rfu" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED (route is ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelCommissionProfile.create).not.toHaveBeenCalled();
  });

  test('source.isActive=false still duplicates fine (no INVALID_STATE gate; new copy is active)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      ...sourceRow,
      isActive: false,
    });
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 103,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    // Source was archived; the new copy resets isActive=true so it
    // enters the operator's active list.
    expect(res.body.isActive).toBe(true);
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data.isActive).toBe(true);
  });

  test('source with tenant-wide subBrand=null → duplicate stays tenant-wide unless override', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue({
      ...sourceRow,
      subBrand: null,
    });
    prisma.travelCommissionProfile.create.mockImplementation(async (args) => ({
      id: 104,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.subBrand).toBeNull();
    const callArgs = prisma.travelCommissionProfile.create.mock.calls[0][0];
    expect(callArgs.data.subBrand).toBeNull();
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/commission-profiles/not-a-number/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelCommissionProfile.findFirst).not.toHaveBeenCalled();
  });
});
