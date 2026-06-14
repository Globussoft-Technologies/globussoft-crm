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

// ─────────────────────────────────────────────────────────────────────────
// W4.A G099 — Admin extension endpoints (versions / revert / copy-from / upload)
// ─────────────────────────────────────────────────────────────────────────
//
// upload is multipart/form-data with multer disk-write side-effects — we
// don't exercise the disk path in unit tests (covered by the dedicated
// brandAssetValidation.test.js + the e2e spec); here we pin:
//   - GET /:id/versions returns descending version list for same
//     (tenantId, subBrand) tuple
//   - POST /:id/revert/:version creates a NEW version copying source
//     asset fields + auto-activates with demotion
//   - POST /:id/copy-from/:sourceId creates a draft (isActive=false)
//     version copying source asset fields
//   - 404 on missing source version / source kit
//   - non-ADMIN 403 on revert + copy-from
describe('GET /api/brand-kits/:id/versions', () => {
  test('returns descending version list for same (tenantId, subBrand) tuple', async () => {
    prisma.brandKit.findFirst.mockResolvedValueOnce({ id: 50, subBrand: 'tmc' }); // anchor
    prisma.brandKit.findMany.mockResolvedValueOnce([
      { id: 52, tenantId: 1, subBrand: 'tmc', version: 3, isActive: true },
      { id: 51, tenantId: 1, subBrand: 'tmc', version: 2, isActive: false },
      { id: 50, tenantId: 1, subBrand: 'tmc', version: 1, isActive: false },
    ]);

    const res = await request(makeApp())
      .get('/api/brand-kits/50/versions')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(prisma.brandKit.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, subBrand: 'tmc' },
      orderBy: { version: 'desc' },
    });
  });

  test('cross-tenant anchor returns 404', async () => {
    prisma.brandKit.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .get('/api/brand-kits/9999/versions')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/brand-kits/abc/versions')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});

describe('POST /api/brand-kits/:id/revert/:version', () => {
  test('creates new version copying source asset fields + auto-activates with demotion', async () => {
    // anchor lookup → returns subBrand context
    prisma.brandKit.findFirst.mockResolvedValueOnce({ id: 60, subBrand: 'tmc' });
    // source version lookup → v2 with one set of asset values
    prisma.brandKit.findFirst.mockResolvedValueOnce({
      id: 60,
      tenantId: 1,
      subBrand: 'tmc',
      version: 2,
      primaryColor: '#265855',
      logoUrl: 'https://cdn.example/old-logo.png',
      tagline: 'Old tagline',
      // Extended G089 fields populated to confirm carry-through
      wordmarkUrl: 'https://cdn.example/wordmark.svg',
      supportEmail: 'support@old.example',
    });
    // latest-version lookup inside tx → v5 (next slot = 6)
    prisma.brandKit.findFirst.mockResolvedValueOnce({ version: 5 });
    prisma.brandKit.updateMany.mockResolvedValue({ count: 1 });
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 99,
      tenantId: 1,
      subBrand: 'tmc',
      version: args.data.version,
      isActive: args.data.isActive,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/brand-kits/60/revert/2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 99,
      version: 6,
      isActive: true,
      primaryColor: '#265855',
      logoUrl: 'https://cdn.example/old-logo.png',
      tagline: 'Old tagline',
      wordmarkUrl: 'https://cdn.example/wordmark.svg',
      supportEmail: 'support@old.example',
    });
    // Demotion of any existing active row fired for the same scope.
    expect(prisma.brandKit.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, subBrand: 'tmc', isActive: true },
      data: { isActive: false },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('returns 404 SOURCE_VERSION_NOT_FOUND when revert target version missing', async () => {
    prisma.brandKit.findFirst
      .mockResolvedValueOnce({ id: 60, subBrand: 'tmc' }) // anchor
      .mockResolvedValueOnce(null); // no source version

    const res = await request(makeApp())
      .post('/api/brand-kits/60/revert/99')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SOURCE_VERSION_NOT_FOUND' });
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
  });

  test('non-ADMIN returns 403', async () => {
    const res = await request(makeApp())
      .post('/api/brand-kits/60/revert/2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/brand-kits/:id/copy-from/:sourceId', () => {
  test('creates draft (isActive=false) version copying source asset fields', async () => {
    // anchor lookup
    prisma.brandKit.findFirst.mockResolvedValueOnce({ id: 70, subBrand: 'travelstall' });
    // source kit lookup
    prisma.brandKit.findFirst.mockResolvedValueOnce({
      id: 50,
      tenantId: 1,
      subBrand: 'tmc',
      version: 3,
      primaryColor: '#265855',
      logoUrl: 'https://cdn.example/tmc-logo.png',
      missionStatement: 'Empower learners',
      socialLinksJson: '[{"network":"instagram","url":"https://ig/tmc"}]',
    });
    // latest version for destination tuple
    prisma.brandKit.findFirst.mockResolvedValueOnce({ version: 1 });
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 200,
      tenantId: 1,
      subBrand: 'travelstall',
      version: args.data.version,
      isActive: args.data.isActive,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/brand-kits/70/copy-from/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 200,
      subBrand: 'travelstall',
      version: 2,
      isActive: false, // draft — NOT auto-activated
      primaryColor: '#265855',
      logoUrl: 'https://cdn.example/tmc-logo.png',
      missionStatement: 'Empower learners',
      socialLinksJson: '[{"network":"instagram","url":"https://ig/tmc"}]',
    });
    // copy-from does NOT auto-demote — the draft is created in non-active state.
    expect(prisma.brandKit.updateMany).not.toHaveBeenCalled();
  });

  test('returns 404 SOURCE_NOT_FOUND when source kit missing', async () => {
    prisma.brandKit.findFirst
      .mockResolvedValueOnce({ id: 70, subBrand: 'travelstall' }) // anchor
      .mockResolvedValueOnce(null); // no source kit

    const res = await request(makeApp())
      .post('/api/brand-kits/70/copy-from/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
  });

  test('non-ADMIN returns 403', async () => {
    const res = await request(makeApp())
      .post('/api/brand-kits/70/copy-from/50')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.brandKit.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/brand-kits/upload — multer-gated', () => {
  test('rejects without assetType', async () => {
    // Multer's memoryStorage path doesn't exercise without a real
    // multipart body; supertest .attach() drives the multer parse.
    const res = await request(makeApp())
      .post('/api/brand-kits/upload')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'tiny.png',
        contentType: 'image/png',
      });

    // No assetType in form → 400 INVALID_ASSET_TYPE.
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ASSET_TYPE' });
  });

  test('non-ADMIN returns 403', async () => {
    const res = await request(makeApp())
      .post('/api/brand-kits/upload')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .field('assetType', 'logo');
    expect(res.status).toBe(403);
  });
});

describe('G089 — extended branding fields round-trip on POST /api/brand-kits', () => {
  test('all FR-3.1.a-g fields flow through to prisma.create.data', async () => {
    prisma.brandKit.findFirst.mockResolvedValue(null);
    prisma.brandKit.create.mockImplementation(async (args) => ({
      id: 300,
      tenantId: 1,
      ...args.data,
    }));

    const payload = {
      subBrand: 'tmc',
      // FR-3.1.a — wordmark + hero
      wordmarkUrl: 'https://cdn.example/wordmark.svg',
      heroUrl: 'https://cdn.example/hero.jpg',
      // FR-3.1.b — status badges
      successBadge: '#22c55e',
      warningBadge: '#f59e0b',
      // FR-3.1.c — typography slots
      headingFontFamily: 'Cardo, serif',
      headingFontUrl: 'https://fonts.googleapis.com/css2?family=Cardo',
      bodyFontFamily: 'Inter, sans-serif',
      bodyFontUrl: 'https://fonts.googleapis.com/css2?family=Inter',
      codeFontFamily: 'JetBrains Mono',
      codeFontUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono',
      // FR-3.1.d — CMYK
      cmykPrimary: '90,40,50,40',
      cmykSecondary: '0,50,60,10',
      cmykAccent: '20,30,80,5',
      // FR-3.1.e — invoice / email
      signatureTemplate: '<p>--<br/>{{name}}<br/>{{email}}</p>',
      headerImageUrl: 'https://cdn.example/invoice-header.png',
      footerText: 'GST 27ABCDE1234F1Z5 · CIN U63040MH2018PTC305555',
      invoiceStampUrl: 'https://cdn.example/stamp.png',
      // FR-3.1.f — portal / microsite copy
      missionStatement: 'Plan curriculum-aligned school trips',
      // FR-3.1.g — contact
      supportEmail: 'help@tmc.example',
      supportPhone: '+91-9999999999',
      socialLinksJson: '[{"network":"instagram","url":"https://ig/tmc"}]',
    };

    const res = await request(makeApp())
      .post('/api/brand-kits')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(payload);

    expect(res.status).toBe(201);
    const createArg = prisma.brandKit.create.mock.calls[0][0].data;
    expect(createArg.wordmarkUrl).toBe('https://cdn.example/wordmark.svg');
    expect(createArg.heroUrl).toBe('https://cdn.example/hero.jpg');
    expect(createArg.successBadge).toBe('#22c55e');
    expect(createArg.warningBadge).toBe('#f59e0b');
    expect(createArg.headingFontFamily).toBe('Cardo, serif');
    expect(createArg.bodyFontFamily).toBe('Inter, sans-serif');
    expect(createArg.codeFontFamily).toBe('JetBrains Mono');
    expect(createArg.cmykPrimary).toBe('90,40,50,40');
    expect(createArg.cmykSecondary).toBe('0,50,60,10');
    expect(createArg.cmykAccent).toBe('20,30,80,5');
    expect(createArg.signatureTemplate).toContain('{{name}}');
    expect(createArg.headerImageUrl).toBe('https://cdn.example/invoice-header.png');
    expect(createArg.footerText).toContain('GST 27ABCDE1234F1Z5');
    expect(createArg.invoiceStampUrl).toBe('https://cdn.example/stamp.png');
    expect(createArg.missionStatement).toBe('Plan curriculum-aligned school trips');
    expect(createArg.supportEmail).toBe('help@tmc.example');
    expect(createArg.supportPhone).toBe('+91-9999999999');
    expect(createArg.socialLinksJson).toContain('instagram');
  });
});
