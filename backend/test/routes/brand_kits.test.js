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

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 37)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors the slim-shape contract pinned in slices 1-36. The default (no
// ?fields) path continues to return the full row including every visual
// asset column (logoUrl + logoDarkUrl + faviconUrl + the five color
// columns + fontFamily + fontUrl + tagline). The ?fields=summary path
// forwards a slim Prisma `select` keeping only the chrome columns —
// id + subBrand + version + isActive + updatedAt — so list/picker UI can
// fetch a narrow payload without dragging the heavy asset blobs across
// the wire (or off the DB row). Anything other than the exact string
// "summary" is treated as default (no `select` key forwarded).
describe('GET /api/brand-kits?fields=summary — slim-shape opt-in', () => {
  test('omitted ?fields returns full row with every visual asset (no select forwarded)', async () => {
    prisma.brandKit.findMany.mockResolvedValue([
      {
        id: 1,
        tenantId: 1,
        subBrand: 'tmc',
        version: 3,
        isActive: true,
        logoUrl: 'https://cdn.example/logo.png',
        logoDarkUrl: 'https://cdn.example/logo-dark.png',
        faviconUrl: 'https://cdn.example/favicon.ico',
        primaryColor: '#265855',
        secondaryColor: '#CD9481',
        accentColor: '#F0E6D2',
        bgColor: '#FFFFFF',
        textColor: '#1A1A1A',
        fontFamily: 'Inter, sans-serif',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Inter',
        tagline: 'Travel beyond ordinary',
        createdBy: 7,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-15T00:00:00Z'),
      },
    ]);
    prisma.brandKit.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.brandKits[0].logoUrl).toBe('https://cdn.example/logo.png');
    expect(res.body.brandKits[0].primaryColor).toBe('#265855');
    expect(res.body.brandKits[0].fontFamily).toBe('Inter, sans-serif');
    expect(res.body.brandKits[0].tagline).toBe('Travel beyond ordinary');
    // No `select` key forwarded — full-row default path.
    const arg = prisma.brandKit.findMany.mock.calls[0][0];
    expect(arg.select).toBeUndefined();
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual([{ subBrand: 'asc' }, { version: 'desc' }]);
  });

  test('?fields=summary forwards select with id+subBrand+version+isActive+updatedAt only', async () => {
    prisma.brandKit.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', version: 3, isActive: true, updatedAt: new Date('2026-01-15T00:00:00Z') },
      { id: 2, subBrand: 'rfu', version: 1, isActive: false, updatedAt: new Date('2026-01-10T00:00:00Z') },
    ]);
    prisma.brandKit.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/brand-kits?fields=summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.brandKits).toHaveLength(2);
    expect(res.body.total).toBe(2);
    const arg = prisma.brandKit.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      subBrand: true,
      version: true,
      isActive: true,
      updatedAt: true,
    });
    // Heavy visual-asset columns MUST NOT be present in select.
    expect(arg.select.logoUrl).toBeUndefined();
    expect(arg.select.logoDarkUrl).toBeUndefined();
    expect(arg.select.faviconUrl).toBeUndefined();
    expect(arg.select.primaryColor).toBeUndefined();
    expect(arg.select.secondaryColor).toBeUndefined();
    expect(arg.select.accentColor).toBeUndefined();
    expect(arg.select.bgColor).toBeUndefined();
    expect(arg.select.textColor).toBeUndefined();
    expect(arg.select.fontFamily).toBeUndefined();
    expect(arg.select.fontUrl).toBeUndefined();
    expect(arg.select.tagline).toBeUndefined();
    expect(arg.select.tenantId).toBeUndefined();
    expect(arg.select.createdAt).toBeUndefined();
    expect(arg.select.createdBy).toBeUndefined();
    // where + orderBy unchanged from default path.
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual([{ subBrand: 'asc' }, { version: 'desc' }]);
  });

  test('?fields=summary composes with ?subBrand + ?isActive filters — slim + narrow', async () => {
    prisma.brandKit.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', version: 3, isActive: true, updatedAt: new Date('2026-01-15T00:00:00Z') },
    ]);
    prisma.brandKit.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/brand-kits?fields=summary&subBrand=tmc&isActive=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const arg = prisma.brandKit.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 1, subBrand: 'tmc', isActive: true });
    expect(arg.select).toEqual({
      id: true,
      subBrand: true,
      version: true,
      isActive: true,
      updatedAt: true,
    });
    // The count() call uses the same where but NEVER a select — counts are
    // intrinsically slim.
    const countArg = prisma.brandKit.count.mock.calls[0][0];
    expect(countArg.select).toBeUndefined();
    expect(countArg.where).toEqual({ tenantId: 1, subBrand: 'tmc', isActive: true });
  });

  test('?fields=full (anything not exactly "summary") falls back to default full-row shape', async () => {
    prisma.brandKit.findMany.mockResolvedValue([]);
    prisma.brandKit.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/brand-kits?fields=full')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const arg = prisma.brandKit.findMany.mock.calls[0][0];
    // Exact-string gate: only "summary" trips the slim branch.
    expect(arg.select).toBeUndefined();
  });

  test('?fields=SUMMARY (uppercase) is treated as default — case-sensitive gate', async () => {
    prisma.brandKit.findMany.mockResolvedValue([]);
    prisma.brandKit.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/brand-kits?fields=SUMMARY')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const arg = prisma.brandKit.findMany.mock.calls[0][0];
    // The gate is `req.query.fields === "summary"` (case-sensitive). Pin
    // the contract so a future refactor to .toLowerCase() shows up as a
    // deliberate spec edit, not a silent behaviour change.
    expect(arg.select).toBeUndefined();
  });
});
