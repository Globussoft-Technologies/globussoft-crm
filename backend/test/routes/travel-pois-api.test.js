// @ts-check
/**
 * backend/routes/travel_pois.js — Inline Add-POI rep-suggest +
 * pendingApproval queue contract pin (Wave 18 slice S12, PRD
 * TRAVEL_ITINERARY_UPGRADES FR-3.7).
 *
 * What's pinned
 * -------------
 *   - POST /api/travel/pois (USER+)
 *       happy path creates with pendingApproval=true, externalSource
 *         'operator', tenantId from req.user (NEVER body)
 *       audit-log emitted (poi.suggested)
 *       validation: missing name -> 400 MISSING_FIELDS
 *       validation: missing category -> 400 MISSING_FIELDS
 *       validation: missing destinationSlug -> 400 MISSING_FIELDS
 *       validation: out-of-range latitude -> 400 INVALID_COORD
 *       validation: out-of-range longitude -> 400 INVALID_COORD
 *       no Authorization -> 401
 *
 *   - GET /api/travel/pois/pending (ADMIN+MANAGER)
 *       returns only pendingApproval=true rows scoped to caller tenant
 *       paging: ?limit + ?offset honored
 *       USER role -> 403 RBAC_DENIED
 *       MANAGER role allowed (200)
 *
 *   - POST /api/travel/pois/:id/approve (ADMIN only)
 *       flips pendingApproval to false; tenant-scoped
 *       MANAGER role -> 403 RBAC_DENIED (approve is ADMIN-only)
 *       cross-tenant returns 404 POI_NOT_FOUND
 *       invalid id -> 400 INVALID_ID
 *       audit-log emitted (poi.approved)
 *
 *   - POST /api/travel/pois/:id/reject (ADMIN only)
 *       hard-deletes the row; tenant-scoped
 *       MANAGER role -> 403 RBAC_DENIED
 *       cross-tenant returns 404
 *       audit-log emitted (poi.rejected)
 *
 * Pinned auth chain:
 *   POST /                          verifyToken
 *   GET  /pending                   verifyToken -> verifyRole(['ADMIN','MANAGER'])
 *   POST /:id/approve               verifyToken -> verifyRole(['ADMIN'])
 *   POST /:id/reject                verifyToken -> verifyRole(['ADMIN'])
 *
 * Pattern mirrors backend/test/routes/travel-engine-weights.test.js (T15):
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router so the router's CJS require binds to the spies; mint JWTs with
 * the same dev fallback secret; full guard chain runs end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelPoi = {
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// Spy on writeAudit so the suggest/approve/reject pins are testable
// without exercising the real hash-chain writer. The router uses CJS
// `require('../lib/audit')`, which bypasses vitest's ESM module
// interception — so we patch the audit module's exports object DIRECTLY
// before requiring the router. This relies on Node's CJS module cache
// returning the same exports object reference to both us and the router.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const auditModule = requireCJS('../../lib/audit');
const writeAuditSpy = vi.fn().mockResolvedValue(undefined);
auditModule.writeAudit = (...args) => writeAuditSpy(...args);

const poisRouter = requireCJS('../../routes/travel_pois');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/pois', poisRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function validSuggestBody(overrides = {}) {
  return {
    name: 'Hidden Beach Cove',
    category: 'natural',
    latitude: 15.5,
    longitude: 73.8,
    destinationSlug: 'goa',
    country: 'IN',
    descriptionShort: 'A serene cove on Anjuna stretch',
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelPoi.create.mockReset();
  prisma.travelPoi.findMany.mockReset();
  prisma.travelPoi.count.mockReset();
  prisma.travelPoi.findFirst.mockReset();
  prisma.travelPoi.update.mockReset();
  prisma.travelPoi.delete.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  writeAuditSpy.mockReset().mockResolvedValue(undefined);
});

// ────────────────────────────────────────────────────────────────────
// POST / — rep suggests a POI
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/pois — rep suggest', () => {
  test('happy path — creates row with pendingApproval=true + tenant from token', async () => {
    prisma.travelPoi.create.mockImplementation(async ({ data }) => ({
      id: 42,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 1 })}`)
      .send(validSuggestBody());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      tenantId: 1,
      pendingApproval: true,
      externalSource: 'operator',
      name: 'Hidden Beach Cove',
      category: 'natural',
      latitude: 15.5,
      longitude: 73.8,
      destinationSlug: 'goa',
      country: 'IN',
    });
    // tenantId comes from token, NOT body. externalId is a UUID.
    const createCall = prisma.travelPoi.create.mock.calls[0][0];
    expect(createCall.data.tenantId).toBe(1);
    expect(createCall.data.pendingApproval).toBe(true);
    expect(createCall.data.externalSource).toBe('operator');
    expect(typeof createCall.data.externalId).toBe('string');
    expect(createCall.data.externalId.length).toBeGreaterThan(8);
  });

  test('tenantId from req.user — body.tenantId IGNORED', async () => {
    prisma.travelPoi.create.mockImplementation(async ({ data }) => ({
      id: 43,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    // Body claims tenantId=99 but route reads from token tenantId=1.
    await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 1 })}`)
      .send({ ...validSuggestBody(), tenantId: 99 });

    const createCall = prisma.travelPoi.create.mock.calls[0][0];
    expect(createCall.data.tenantId).toBe(1);
    expect(createCall.data.tenantId).not.toBe(99);
  });

  test('audit-log emitted on suggest with field NAMES + tenant scope', async () => {
    prisma.travelPoi.create.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Hidden Beach Cove',
      category: 'natural',
      destinationSlug: 'goa',
    });

    await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER', { userId: 7, tenantId: 1 })}`)
      .send(validSuggestBody());

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy).toHaveBeenCalledWith(
      'TravelPoi',
      'poi.suggested',
      50,
      7,
      1,
      expect.objectContaining({
        name: 'Hidden Beach Cove',
        category: 'natural',
        destinationSlug: 'goa',
        externalSource: 'operator',
      }),
    );
  });

  test('validation — missing name -> 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validSuggestBody({ name: undefined }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelPoi.create).not.toHaveBeenCalled();
  });

  test('validation — missing category -> 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validSuggestBody({ category: undefined }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelPoi.create).not.toHaveBeenCalled();
  });

  test('validation — missing destinationSlug -> 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validSuggestBody({ destinationSlug: undefined }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('validation — latitude > 90 -> 400 INVALID_COORD', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validSuggestBody({ latitude: 95 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_COORD' });
  });

  test('validation — longitude > 180 -> 400 INVALID_COORD', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validSuggestBody({ longitude: 200 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_COORD' });
  });

  test('missing Authorization -> 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois')
      .send(validSuggestBody());
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /pending — ADMIN+MANAGER queue
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/pois/pending', () => {
  test('returns only pendingApproval=true rows, tenant-scoped', async () => {
    const rows = [
      { id: 1, tenantId: 1, name: 'Cove', pendingApproval: true, createdAt: new Date() },
    ];
    prisma.travelPoi.findMany.mockResolvedValue(rows);
    prisma.travelPoi.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/pois/pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.pending).toHaveLength(1);

    // Pinned where clause — pendingApproval + tenant scope.
    const findCall = prisma.travelPoi.findMany.mock.calls[0][0];
    expect(findCall.where).toEqual({ pendingApproval: true, tenantId: 1 });
    expect(findCall.orderBy).toEqual({ createdAt: 'desc' });

    const countCall = prisma.travelPoi.count.mock.calls[0][0];
    expect(countCall.where).toEqual({ pendingApproval: true, tenantId: 1 });
  });

  test('cross-tenant — tenant 2 caller scopes WHERE to tenant 2', async () => {
    prisma.travelPoi.findMany.mockResolvedValue([]);
    prisma.travelPoi.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/pois/pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);

    const findCall = prisma.travelPoi.findMany.mock.calls[0][0];
    expect(findCall.where.tenantId).toBe(2);
  });

  test('paging — ?limit and ?offset honored, capped at 200', async () => {
    prisma.travelPoi.findMany.mockResolvedValue([]);
    prisma.travelPoi.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/pois/pending?limit=10&offset=5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    let findCall = prisma.travelPoi.findMany.mock.calls[0][0];
    expect(findCall.take).toBe(10);
    expect(findCall.skip).toBe(5);

    // Cap at 200.
    prisma.travelPoi.findMany.mockClear();
    await request(makeApp())
      .get('/api/travel/pois/pending?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    findCall = prisma.travelPoi.findMany.mock.calls[0][0];
    expect(findCall.take).toBe(200);
  });

  test('MANAGER role allowed (200)', async () => {
    prisma.travelPoi.findMany.mockResolvedValue([]);
    prisma.travelPoi.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/travel/pois/pending')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
  });

  test('USER role denied with 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel/pois/pending')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelPoi.findMany).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /:id/approve — ADMIN only
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/pois/:id/approve', () => {
  test('happy path — flips pendingApproval to false, tenant-scoped', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'Cove',
      category: 'natural',
      destinationSlug: 'goa',
      pendingApproval: true,
    });
    prisma.travelPoi.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      tenantId: 1,
      name: 'Cove',
      pendingApproval: false,
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/pois/5/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    expect(res.body.pendingApproval).toBe(false);

    // findFirst pinned to tenant scope.
    expect(prisma.travelPoi.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
    const updateCall = prisma.travelPoi.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 5 });
    expect(updateCall.data).toEqual({ pendingApproval: false });
  });

  test('audit-log emitted on approve', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue({
      id: 6,
      tenantId: 1,
      name: 'Cove',
      category: 'natural',
      destinationSlug: 'goa',
    });
    prisma.travelPoi.update.mockResolvedValue({ id: 6, pendingApproval: false });

    await request(makeApp())
      .post('/api/travel/pois/6/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 9, tenantId: 1 })}`);

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy).toHaveBeenCalledWith(
      'TravelPoi',
      'poi.approved',
      6,
      9,
      1,
      expect.objectContaining({ name: 'Cove', category: 'natural' }),
    );
  });

  test('cross-tenant — POI exists in tenant 1, ADMIN of tenant 2 sees 404', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue(null); // tenant-2 scope -> miss

    const res = await request(makeApp())
      .post('/api/travel/pois/5/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'POI_NOT_FOUND' });
    expect(prisma.travelPoi.update).not.toHaveBeenCalled();
  });

  test('invalid id -> 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois/not-a-number/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('MANAGER role denied — approve is ADMIN-only', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois/5/approve')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelPoi.findFirst).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /:id/reject — ADMIN only
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/pois/:id/reject', () => {
  test('happy path — hard-deletes the row, tenant-scoped', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue({
      id: 7,
      tenantId: 1,
      name: 'Cove',
      category: 'natural',
      destinationSlug: 'goa',
    });
    prisma.travelPoi.delete.mockResolvedValue({ id: 7 });

    const res = await request(makeApp())
      .post('/api/travel/pois/7/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 7 });
    expect(prisma.travelPoi.findFirst).toHaveBeenCalledWith({
      where: { id: 7, tenantId: 1 },
    });
    expect(prisma.travelPoi.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('audit-log emitted on reject', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue({
      id: 8,
      tenantId: 1,
      name: 'Cove',
      category: 'natural',
      destinationSlug: 'goa',
    });
    prisma.travelPoi.delete.mockResolvedValue({ id: 8 });

    await request(makeApp())
      .post('/api/travel/pois/8/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 11, tenantId: 1 })}`);

    expect(writeAuditSpy).toHaveBeenCalledWith(
      'TravelPoi',
      'poi.rejected',
      8,
      11,
      1,
      expect.objectContaining({ name: 'Cove', category: 'natural' }),
    );
  });

  test('cross-tenant -> 404', async () => {
    prisma.travelPoi.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/pois/9/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);

    expect(res.status).toBe(404);
    expect(prisma.travelPoi.delete).not.toHaveBeenCalled();
  });

  test('MANAGER role denied — reject is ADMIN-only', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois/9/reject')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });

  test('USER role denied', async () => {
    const res = await request(makeApp())
      .post('/api/travel/pois/9/reject')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });
});
