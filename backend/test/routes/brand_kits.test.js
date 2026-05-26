// @ts-check
/**
 * PRD_TRAVEL_PER_SUBBRAND_BRANDING DD-5.2 — BrandKit CRUD scaffold tests.
 *
 * Pins the contract for the operator-facing brand-kit surface added to
 * backend/routes/brand_kits.js. BrandKit landed at commit 5060dda (tick
 * #95) with a (tenantId, subBrand, version) composite unique and an
 * isActive flag with "one active version per (tenantId, subBrand)"
 * semantics — every activation must atomically demote any prior active
 * row for the same tuple.
 *
 * What's pinned
 * -------------
 *   - POST   /api/brand-kits        201 happy-path with auto-assigned
 *           version=1 and isActive=false default.
 *   - POST   /api/brand-kits        isActive=true demotes any prior active
 *           row for same (tenantId, subBrand) — via prisma.$transaction.
 *   - POST   /api/brand-kits        second create for same (tenantId,
 *           subBrand) auto-assigns version=2.
 *   - GET    /api/brand-kits/active/:subBrand  returns the active kit or null.
 *   - PUT    /api/brand-kits/:id    flipping isActive=true demotes priors.
 *   - DELETE /api/brand-kits/:id    204 when isActive=false; 422 when
 *           isActive=true (active kits are locked).
 *   - GET    /api/brand-kits/:id    404 on cross-tenant lookup.
 *   - POST   /api/brand-kits        403 from non-ADMIN.
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router. We stub $transaction with the standard "run the callback with
 * the same prisma client" shape so transactional reads/writes resolve
 * against the same mock surface.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.brandKit = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
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

// $transaction stub: when called with a callback, invoke it with the
// prisma singleton itself so all tx.* calls hit the same vi.fn() mocks.
// When called with an array of promises, Promise.all them (rare here).
prisma.$transaction = vi.fn().mockImplementation(async (arg) => {
  if (typeof arg === 'function') return arg(prisma);
  if (Array.isArray(arg)) return Promise.all(arg);
  return arg;
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const brandKitsRouter = requireCJS('../../routes/brand_kits');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/brand-kits', brandKitsRouter);
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
  prisma.brandKit.findMany.mockReset();
  prisma.brandKit.findFirst.mockReset();
  prisma.brandKit.count.mockReset();
  prisma.brandKit.create.mockReset();
  prisma.brandKit.update.mockReset();
  prisma.brandKit.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.brandKit.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.$transaction.mockClear();
});

describe('POST /api/brand-kits', () => {
  test('happy path returns 201 with auto-assigned version=1 and isActive=false default', async () => {
    // No prior row exists — auto-version should fall back to 1.
    prisma.brandKit.findFirst.mockResolvedValue(null);
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 11,
      tenantId: 1,
      subBrand: 'tmc',
      version: args.data.version,
      isActive: args.data.isActive,
      logoUrl: args.data.logoUrl || null,
      primaryColor: args.data.primaryColor || null,
      createdBy: args.data.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        primaryColor: '#265855',
        logoUrl: 'https://cdn.example/logo.png',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 11,
      subBrand: 'tmc',
      version: 1,
      isActive: false,
      primaryColor: '#265855',
      logoUrl: 'https://cdn.example/logo.png',
    });
    // Confirm tenantId came from req.user, not body.
    expect(prisma.brandKit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          version: 1,
          isActive: false,
          createdBy: 7,
        }),
      }),
    );
    // Audit row written.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    // No demotion call since isActive defaulted false.
    expect(prisma.brandKit.updateMany).not.toHaveBeenCalled();
  });

  test('isActive=true atomically demotes any prior active kit for same (tenantId, subBrand)', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({ version: 3 }); // latest existing
    prisma.brandKit.updateMany.mockResolvedValue({ count: 1 }); // one prior active was demoted
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 22,
      tenantId: 1,
      subBrand: 'tmc',
      version: args.data.version,
      isActive: args.data.isActive,
      createdBy: args.data.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc', isActive: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 22, version: 4, isActive: true });
    // Demotion fired on the same (tenantId, subBrand) scope.
    expect(prisma.brandKit.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, subBrand: 'tmc', isActive: true },
      data: { isActive: false },
    });
    // Whole thing ran in a transaction.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('second create for same (tenantId, subBrand) auto-assigns version=2', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({ version: 1 }); // one prior row exists
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 33,
      tenantId: 1,
      subBrand: 'rfu',
      version: args.data.version,
      isActive: args.data.isActive,
      createdBy: args.data.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    expect(prisma.brandKit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2, subBrand: 'rfu' }),
      }),
    );
  });

  test('rejects invalid subBrand with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'garbage' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(res.body.error).toMatch(/tmc/);
    expect(res.body.error).toMatch(/rfu/);
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
  });

  test('non-ADMIN POST returns 403', async () => {
    // verifyRole consults the JWT, not prisma.user. A USER token must
    // be rejected before any prisma write happens.
    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ subBrand: 'tmc' });

    expect(res.status).toBe(403);
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
    expect(prisma.brandKit.updateMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/brand-kits/active/:subBrand', () => {
  test('returns the active brand kit when one exists', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      id: 55, tenantId: 1, subBrand: 'tmc', version: 4, isActive: true,
      primaryColor: '#265855',
    });
    const res = await request(makeApp())
      .get('/api/brand-kits/active/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      brandKit: expect.objectContaining({ id: 55, subBrand: 'tmc', version: 4, isActive: true }),
    });
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, subBrand: 'tmc', isActive: true },
      }),
    );
  });

  test('returns { brandKit: null } when no active kit exists', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/brand-kits/active/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brandKit: null });
  });
});

describe('PUT /api/brand-kits/:id', () => {
  test('flipping isActive=true demotes any other active kit for the same (tenantId, subBrand)', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      id: 77, tenantId: 1, subBrand: 'tmc', version: 5, isActive: false,
    });
    prisma.brandKit.updateMany.mockResolvedValue({ count: 1 });
    prisma.brandKit.update.mockResolvedValue({
      id: 77, tenantId: 1, subBrand: 'tmc', version: 5, isActive: true,
    });

    const res = await request(makeApp())
      .put('/api/brand-kits/77')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ isActive: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 77, isActive: true });
    // Demotion targeted same scope AND excluded the row being promoted.
    expect(prisma.brandKit.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        subBrand: 'tmc',
        isActive: true,
        id: { not: 77 },
      },
      data: { isActive: false },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('rejects subBrand changes with 400 SUB_BRAND_IMMUTABLE', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      id: 88, tenantId: 1, subBrand: 'tmc', version: 2, isActive: false,
    });
    const res = await request(makeApp())
      .put('/api/brand-kits/88')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_IMMUTABLE' });
    expect(prisma.brandKit.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/brand-kits/:id', () => {
  test('returns 204 + audit when kit is isActive=false', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      id: 99, tenantId: 1, subBrand: 'tmc', version: 1, isActive: false,
    });
    prisma.brandKit.delete.mockResolvedValue({ id: 99 });

    // Audit MUST fire before prisma.delete.
    const callOrder = [];
    prisma.auditLog.create.mockImplementation(async (args) => {
      callOrder.push('audit');
      return { id: 1, ...args };
    });
    prisma.brandKit.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return { id: 99 };
    });

    const res = await request(makeApp())
      .delete('/api/brand-kits/99')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(callOrder).toEqual(['audit', 'delete']);

    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'BrandKit',
      action: 'DELETE',
      entityId: 99,
      userId: 7,
      tenantId: 1,
    });
  });

  test('returns 422 ACTIVE_KIT_LOCKED when kit is isActive=true', async () => {
    prisma.brandKit.findFirst.mockResolvedValue({
      id: 100, tenantId: 1, subBrand: 'tmc', version: 4, isActive: true,
    });
    const res = await request(makeApp())
      .delete('/api/brand-kits/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'ACTIVE_KIT_LOCKED' });
    expect(prisma.brandKit.delete).not.toHaveBeenCalled();
    // No audit row for a refused delete.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 (no delete or audit fire)', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/brand-kits/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(prisma.brandKit.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/brand-kits/:id', () => {
  test('cross-tenant returns 404', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/brand-kits/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.brandKit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});
