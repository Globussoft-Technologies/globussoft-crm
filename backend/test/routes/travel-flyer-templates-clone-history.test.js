// @ts-check
/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice 20 — clone-history endpoint tests.
 *
 * Pins the contract for the new per-source clone feed:
 *   GET /api/travel/flyer-templates/:id/clone-history
 *
 * The endpoint reads AuditLog rows where entity='TravelFlyerTemplate' and
 * action='TRAVEL_FLYER_TEMPLATE_DUPLICATED' (the action the slice 6
 * duplicate handler writes), then filters POST-parse on the `details`
 * JSON column to keep only rows whose `sourceId` / `clonedFromId` /
 * `parentId` matches the source template id. The three-name fallback is
 * intentional — sister modules emit the parent id under varying field
 * names; the endpoint accepts any of them so the per-source view stays
 * accurate without lockstep refactors.
 *
 * What's pinned
 * -------------
 *   - 404 TEMPLATE_NOT_FOUND when source missing (cross-tenant or absent)
 *   - 403 SUB_BRAND_DENIED when caller can't read source.subBrand
 *   - 400 INVALID_ID on non-numeric :id
 *   - Happy path: 2 audit rows with details.sourceId=:id → 2 history entries
 *     chronological (default at:asc)
 *   - Empty: 0 matching audit rows → 200 with {totalClones: 0, history: []}
 *     (defensive — NOT 404)
 *   - Filter accuracy: audit row whose sourceId != :id is excluded
 *   - Field-name drift defence: details.clonedFromId and details.parentId
 *     also recognised as the parent reference
 *   - Limit clamp: default 100, ?limit=999 caps at 500
 *   - Defensive: malformed details JSON → row skipped (no 500)
 *   - Read-only: no audit row written
 *
 * Pattern mirrors travel-flyer-templates.test.js — patch prisma BEFORE
 * requiring the router, drive with real HS256 JWTs against the dev fallback
 * secret. verifyToken + requireTravelTenant + sub-brand gate all run.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelFlyerTemplate = prisma.travelFlyerTemplate || {};
prisma.travelFlyerTemplate.findFirst = vi.fn();
prisma.travelFlyerTemplate.findMany = prisma.travelFlyerTemplate.findMany || vi.fn();
prisma.travelFlyerTemplate.count = prisma.travelFlyerTemplate.count || vi.fn();
prisma.travelFlyerTemplate.create = prisma.travelFlyerTemplate.create || vi.fn();
prisma.travelFlyerTemplate.update = prisma.travelFlyerTemplate.update || vi.fn();
prisma.travelFlyerTemplate.delete = prisma.travelFlyerTemplate.delete || vi.fn();
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
  findMany: vi.fn().mockResolvedValue([]),
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
const templatesRouter = requireCJS('../../routes/travel_flyer_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', templatesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const SOURCE_ID = 808;
const sourceTemplate = {
  id: SOURCE_ID,
  tenantId: 1,
  name: 'Diwali Family Combo (source)',
  subBrand: null,
  paletteJson: '{}',
  layoutJson: '[]',
  assetsJson: null,
  isActive: true,
  notes: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelFlyerTemplate.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel/flyer-templates/:id/clone-history (slice 20)', () => {
  test('404 TEMPLATE_NOT_FOUND when source missing', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/9999/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant id resolves to 404 (findFirst returns null for wrong tenantId)', async () => {
    // Mock simulates the tenant-scoped findFirst behaviour — caller is
    // tenant 1, source belongs to tenant 2, so findFirst returns null.
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    // Verify the findFirst where clause includes tenantId scope.
    const call = prisma.travelFlyerTemplate.findFirst.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.id).toBe(SOURCE_ID);
  });

  test('403 SUB_BRAND_DENIED when source.subBrand is not in caller access set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...sourceTemplate,
      subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_ID on non-numeric :id (no prisma read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/not-a-number/clone-history')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('happy path: 2 audit rows with details.sourceId=:id → returns 2 entries chronological', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      // Oldest first (asc default)
      {
        id: 11,
        createdAt: new Date('2026-05-02T08:00:00Z'),
        userId: 9,
        entityId: 901,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 901, subBrand: 'rfu' }),
      },
      {
        id: 12,
        createdAt: new Date('2026-05-03T12:00:00Z'),
        userId: 10,
        entityId: 902,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 902, subBrand: null }),
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe(SOURCE_ID);
    expect(res.body.totalClones).toBe(2);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0]).toMatchObject({
      at: '2026-05-02T08:00:00.000Z',
      clonedById: 9,
      newTemplateId: 901,
    });
    expect(res.body.history[0].details).toEqual({ sourceId: SOURCE_ID, newId: 901, subBrand: 'rfu' });
    expect(res.body.history[1]).toMatchObject({
      at: '2026-05-03T12:00:00.000Z',
      clonedById: 10,
      newTemplateId: 902,
    });

    // Verify the AuditLog where clause pins the duplicate action.
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.entity).toBe('TravelFlyerTemplate');
    expect(call.where.action).toBe('TRAVEL_FLYER_TEMPLATE_DUPLICATED');
    expect(call.orderBy).toEqual({ createdAt: 'asc' });
  });

  test('empty history: 0 matching audit rows → 200 with empty array (not 404)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      templateId: SOURCE_ID,
      totalClones: 0,
      history: [],
    });
  });

  test('per-source filter: audit row whose details.sourceId != :id is excluded', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      // Different parent — should be filtered out.
      {
        id: 50,
        createdAt: new Date('2026-05-02T08:00:00Z'),
        userId: 9,
        entityId: 950,
        details: JSON.stringify({ sourceId: 999, newId: 950 }),
      },
      // Matches our source.
      {
        id: 51,
        createdAt: new Date('2026-05-03T08:00:00Z'),
        userId: 9,
        entityId: 951,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 951 }),
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalClones).toBe(1);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].newTemplateId).toBe(951);
  });

  test('field-name drift defence: clonedFromId / parentId also recognised as parent ref', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      // Using clonedFromId convention
      {
        id: 60,
        createdAt: new Date('2026-05-02T08:00:00Z'),
        userId: 9,
        entityId: 960,
        details: JSON.stringify({ clonedFromId: SOURCE_ID, newId: 960 }),
      },
      // Using parentId convention
      {
        id: 61,
        createdAt: new Date('2026-05-03T08:00:00Z'),
        userId: 10,
        entityId: 961,
        details: JSON.stringify({ parentId: SOURCE_ID, newId: 961 }),
      },
      // Using sourceId (today's emit)
      {
        id: 62,
        createdAt: new Date('2026-05-04T08:00:00Z'),
        userId: 11,
        entityId: 962,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 962 }),
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalClones).toBe(3);
    const ids = res.body.history.map((h) => h.newTemplateId);
    expect(ids).toEqual([960, 961, 962]);
  });

  test('limit clamp: ?limit=2 narrows; ?limit=999 caps at 500', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    // Build 5 matching rows.
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 1, createdAt: new Date('2026-05-01T08:00:00Z'), userId: 1, entityId: 1001, details: JSON.stringify({ sourceId: SOURCE_ID, newId: 1001 }) },
      { id: 2, createdAt: new Date('2026-05-02T08:00:00Z'), userId: 1, entityId: 1002, details: JSON.stringify({ sourceId: SOURCE_ID, newId: 1002 }) },
      { id: 3, createdAt: new Date('2026-05-03T08:00:00Z'), userId: 1, entityId: 1003, details: JSON.stringify({ sourceId: SOURCE_ID, newId: 1003 }) },
      { id: 4, createdAt: new Date('2026-05-04T08:00:00Z'), userId: 1, entityId: 1004, details: JSON.stringify({ sourceId: SOURCE_ID, newId: 1004 }) },
      { id: 5, createdAt: new Date('2026-05-05T08:00:00Z'), userId: 1, entityId: 1005, details: JSON.stringify({ sourceId: SOURCE_ID, newId: 1005 }) },
    ]);

    const res1 = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history?limit=2`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res1.status).toBe(200);
    expect(res1.body.history).toHaveLength(2);

    // Now verify the >500 case caps at 500 — the fetchTake passed to Prisma
    // should be take*4 capped at 2000, so we assert via the prisma call args.
    prisma.auditLog.findMany.mockClear();
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res2 = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history?limit=999`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res2.status).toBe(200);
    // The clamp means internal `take` becomes 500, so fetchTake = 2000.
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.take).toBe(2000);
  });

  test('defensive: malformed details JSON → row skipped (no 500)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      // Malformed
      {
        id: 70,
        createdAt: new Date('2026-05-02T08:00:00Z'),
        userId: 9,
        entityId: 970,
        details: '{ this is not json',
      },
      // Valid
      {
        id: 71,
        createdAt: new Date('2026-05-03T08:00:00Z'),
        userId: 9,
        entityId: 971,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 971 }),
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalClones).toBe(1);
    expect(res.body.history[0].newTemplateId).toBe(971);
  });

  test('?orderBy=at:desc reverses Prisma orderBy direction', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history?orderBy=at:desc`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?from / ?to ISO bounds thread into prisma createdAt where clause', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeTruthy();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });

  test('NO audit row written by this read-only endpoint', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 80,
        createdAt: new Date('2026-05-02T08:00:00Z'),
        userId: 9,
        entityId: 980,
        details: JSON.stringify({ sourceId: SOURCE_ID, newId: 980 }),
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/flyer-templates/${SOURCE_ID}/clone-history`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
