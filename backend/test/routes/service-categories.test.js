// @ts-check
/**
 * Unit tests for backend/routes/service_categories.js — pins the wellness
 * ServiceCategory taxonomy CRUD contract.
 *
 * Why this file exists (regression class)
 * ───────────────────────────────────────
 *   routes/service_categories.js is 142 LOC of tenant-scoped CRUD that
 *   feeds the wellness service form's category picker AND backs the
 *   /api/wellness/service-categories surface mirrored on
 *   /api/wellness/product-categories (routes/inventory.js). Pre-this-test,
 *   ZERO direct vitest coverage existed for the route — drift on validation
 *   codes (NAME_REQUIRED / PARENT_NOT_FOUND / PARENT_SELF_REFERENCE /
 *   DUPLICATE_NAME), the P2002→409 mapping, or the tenant-scope where-clause
 *   would only surface via the e2e suite (slow + non-isolated).
 *
 * Auth model
 * ──────────
 *   - GET /  → any authenticated tenant user (picker reads list).
 *   - POST/PUT/DELETE → verifyWellnessRole(['admin', 'manager']) gate.
 *
 *   The wellnessRole middleware is replaced via require-cache injection with
 *   a configurable shim that lets each test steer the req.user surface
 *   (tenantId / role / wellnessRole) without booting Prisma. Auth-gate
 *   denial paths are covered by backend/test/middleware/wellnessRole.test.js;
 *   here we exercise the ROUTE logic on top of a pass-through.
 *
 * What this file pins (10 cases)
 * ──────────────────────────────
 *   1.  GET /  → tenant-scoped findMany, ordered by (displayOrder, name),
 *       includes _count.{services, children}, returns array
 *   2.  GET /?isActive=true  → where.isActive narrowed
 *   3.  POST /  missing name → 400 NAME_REQUIRED
 *   4.  POST /  with name only → 201 + writeAudit("ServiceCategory","CREATE")
 *   5.  POST /  with parentId not in tenant → 400 PARENT_NOT_FOUND
 *   6.  POST /  P2002 collision → 409 DUPLICATE_NAME
 *   7.  PUT /:id  cross-tenant → 404 (existing.findFirst returns null)
 *   8.  PUT /:id  parentId === id → 400 PARENT_SELF_REFERENCE
 *   9.  DELETE /:id  happy path → 204 + writeAudit DELETE
 *   10. DELETE /:id  cross-tenant → 404
 *   11. PUT /:id  invalid numeric id (NaN) → 400 invalid id
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/voyagr.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, replace middleware/wellnessRole
 *   (loaded via require-cache injection) with a configurable pass-through, and
 *   patch lib/audit.writeAudit in the require cache to assert action/details
 *   without a live audit chain. Drive via supertest. No real DB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch lib/audit in require cache BEFORE router require ─────────────
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const diffFieldsMock = vi.fn((before, after, keys) => {
  const out = {};
  for (const k of keys) {
    if (before?.[k] !== after?.[k]) out[k] = { from: before?.[k], to: after?.[k] };
  }
  return out;
});
const auditPath = requireCJS.resolve('../../lib/audit.js');
Module._cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    writeAudit: writeAuditMock,
    diffFields: diffFieldsMock,
    canonicalize: (x) => x,
    computeHash: () => 'h',
    genesisFor: () => 'g',
    backfillTenantChain: async () => ({}),
  },
};

// ── Patch middleware/wellnessRole as a configurable pass-through ───────
//
// The route uses verifyWellnessRole(['admin','manager']) factory. We replace
// the FACTORY so it returns a middleware that copies our shared state onto
// req.user. Tests can mutate authState before each call.
const authState = {
  authenticated: true, // when false, middleware returns 401
  tenantId: 7,
  userId: 4,
  role: 'ADMIN',
  wellnessRole: null,
};
const wellnessRolePath = requireCJS.resolve('../../middleware/wellnessRole.js');
Module._cache[wellnessRolePath] = {
  id: wellnessRolePath,
  filename: wellnessRolePath,
  loaded: true,
  exports: {
    verifyWellnessRole: (_allowed) => (req, res, next) => {
      if (!authState.authenticated) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      req.user = {
        userId: authState.userId,
        tenantId: authState.tenantId,
        role: authState.role,
        wellnessRole: authState.wellnessRole,
      };
      next();
    },
  },
};

// ── Prisma singleton patching — BEFORE the router is required ──────────
prisma.serviceCategory = prisma.serviceCategory || {};
prisma.serviceCategory.findMany = vi.fn();
prisma.serviceCategory.findFirst = vi.fn();
prisma.serviceCategory.create = vi.fn();
prisma.serviceCategory.update = vi.fn();
prisma.serviceCategory.delete = vi.fn();

import express from 'express';
import request from 'supertest';

const router = requireCJS('../../routes/service_categories');

function makeApp() {
  const app = express();
  app.use(express.json());
  // Inject the same baseline req.user the auth shim installs onto the OPEN
  // GET route (which has no middleware-applied gate) so tenantWhere works.
  app.use((req, _res, next) => {
    req.user = {
      userId: authState.userId,
      tenantId: authState.tenantId,
      role: authState.role,
      wellnessRole: authState.wellnessRole,
    };
    next();
  });
  app.use('/api/wellness/service-categories', router);
  return app;
}

beforeEach(() => {
  prisma.serviceCategory.findMany.mockReset();
  prisma.serviceCategory.findFirst.mockReset();
  prisma.serviceCategory.create.mockReset();
  prisma.serviceCategory.update.mockReset();
  prisma.serviceCategory.delete.mockReset();
  writeAuditMock.mockReset().mockResolvedValue(undefined);
  diffFieldsMock.mockClear();

  authState.authenticated = true;
  authState.tenantId = 7;
  authState.userId = 4;
  authState.role = 'ADMIN';
  authState.wellnessRole = null;
});

describe('GET /api/wellness/service-categories', () => {
  test('returns tenant-scoped array ordered by (displayOrder, name) with _count include', async () => {
    const rows = [
      { id: 1, name: 'Skin', displayOrder: 0, isActive: true, _count: { services: 3, children: 1 } },
      { id: 2, name: 'Hair', displayOrder: 1, isActive: true, _count: { services: 5, children: 0 } },
    ];
    prisma.serviceCategory.findMany.mockResolvedValueOnce(rows);
    const app = makeApp();

    const res = await request(app).get('/api/wellness/service-categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);

    expect(prisma.serviceCategory.findMany).toHaveBeenCalledOnce();
    const args = prisma.serviceCategory.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 7 });
    expect(args.orderBy).toEqual([{ displayOrder: 'asc' }, { name: 'asc' }]);
    expect(args.include).toEqual({ _count: { select: { services: true, children: true } } });
  });

  test('?isActive=true narrows the where clause', async () => {
    prisma.serviceCategory.findMany.mockResolvedValueOnce([]);
    const app = makeApp();

    const res = await request(app).get('/api/wellness/service-categories?isActive=true');

    expect(res.status).toBe(200);
    const args = prisma.serviceCategory.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 7, isActive: true });
  });
});

describe('POST /api/wellness/service-categories — validation', () => {
  test('missing name → 400 NAME_REQUIRED', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/wellness/service-categories').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name is required', code: 'NAME_REQUIRED' });
    expect(prisma.serviceCategory.create).not.toHaveBeenCalled();
  });

  test('empty/whitespace name → 400 NAME_REQUIRED', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/wellness/service-categories')
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
  });

  test('parentId not in tenant → 400 PARENT_NOT_FOUND', async () => {
    prisma.serviceCategory.findFirst.mockResolvedValueOnce(null); // parent lookup
    const app = makeApp();

    const res = await request(app)
      .post('/api/wellness/service-categories')
      .send({ name: 'SubCat', parentId: 999 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'parentId does not exist in this tenant',
      code: 'PARENT_NOT_FOUND',
    });
    expect(prisma.serviceCategory.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/wellness/service-categories — happy path', () => {
  test('valid name → 201 + tenantId stamped + writeAudit CREATE', async () => {
    prisma.serviceCategory.create.mockResolvedValueOnce({
      id: 42,
      name: 'Skin',
      parentId: null,
      displayOrder: 0,
      isActive: true,
      tenantId: 7,
    });
    const app = makeApp();

    const res = await request(app)
      .post('/api/wellness/service-categories')
      .send({ name: 'Skin' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    expect(res.body.name).toBe('Skin');

    expect(prisma.serviceCategory.create).toHaveBeenCalledOnce();
    const data = prisma.serviceCategory.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(7);
    expect(data.name).toBe('Skin');
    expect(data.parentId).toBeNull();
    expect(data.displayOrder).toBe(0);
    expect(data.isActive).toBe(true);

    // Audit log surface
    expect(writeAuditMock).toHaveBeenCalledOnce();
    const [entity, action, entityId, userId, tenantId, details] =
      writeAuditMock.mock.calls[0];
    expect(entity).toBe('ServiceCategory');
    expect(action).toBe('CREATE');
    expect(entityId).toBe(42);
    expect(userId).toBe(4);
    expect(tenantId).toBe(7);
    expect(details.name).toBe('Skin');
  });

  test('P2002 unique-constraint collision → 409 DUPLICATE_NAME', async () => {
    const err = new Error('Unique constraint failed');
    err.code = 'P2002';
    prisma.serviceCategory.create.mockRejectedValueOnce(err);
    const app = makeApp();

    const res = await request(app)
      .post('/api/wellness/service-categories')
      .send({ name: 'Skin' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'category name already exists in this tenant',
      code: 'DUPLICATE_NAME',
    });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/wellness/service-categories/:id', () => {
  test('cross-tenant id (findFirst returns null) → 404', async () => {
    prisma.serviceCategory.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();

    const res = await request(app)
      .put('/api/wellness/service-categories/123')
      .send({ name: 'Whatever' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Service category not found' });

    // findFirst was called with tenantWhere (tenantId scoped)
    const where = prisma.serviceCategory.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(7);
    expect(where.id).toBe(123);
    expect(prisma.serviceCategory.update).not.toHaveBeenCalled();
  });

  test('parentId === id (self-reference) → 400 PARENT_SELF_REFERENCE', async () => {
    prisma.serviceCategory.findFirst.mockResolvedValueOnce({ id: 5, name: 'Hair' });
    const app = makeApp();

    const res = await request(app)
      .put('/api/wellness/service-categories/5')
      .send({ parentId: 5 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'category cannot be its own parent',
      code: 'PARENT_SELF_REFERENCE',
    });
    expect(prisma.serviceCategory.update).not.toHaveBeenCalled();
  });

  test('invalid numeric id (NaN) → 400 invalid id', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/wellness/service-categories/not-a-number')
      .send({ name: 'X' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid id' });
    expect(prisma.serviceCategory.findFirst).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/wellness/service-categories/:id', () => {
  test('happy path → 204 + writeAudit DELETE + prisma.delete invoked', async () => {
    prisma.serviceCategory.findFirst.mockResolvedValueOnce({ id: 11, name: 'Botox' });
    prisma.serviceCategory.delete.mockResolvedValueOnce({ id: 11 });
    const app = makeApp();

    const res = await request(app).delete('/api/wellness/service-categories/11');

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(prisma.serviceCategory.delete).toHaveBeenCalledOnce();
    expect(prisma.serviceCategory.delete.mock.calls[0][0]).toEqual({ where: { id: 11 } });

    expect(writeAuditMock).toHaveBeenCalledOnce();
    const [entity, action, entityId, userId, tenantId, details] =
      writeAuditMock.mock.calls[0];
    expect(entity).toBe('ServiceCategory');
    expect(action).toBe('DELETE');
    expect(entityId).toBe(11);
    expect(userId).toBe(4);
    expect(tenantId).toBe(7);
    expect(details.name).toBe('Botox');
  });

  test('cross-tenant id (findFirst returns null) → 404 + no delete', async () => {
    prisma.serviceCategory.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();

    const res = await request(app).delete('/api/wellness/service-categories/99');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Service category not found' });
    expect(prisma.serviceCategory.delete).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  test('invalid numeric id (NaN) → 400 invalid id + no findFirst', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/wellness/service-categories/abc');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid id' });
    expect(prisma.serviceCategory.findFirst).not.toHaveBeenCalled();
  });
});

describe('Auth gate — POST/PUT/DELETE rejected when wellnessRole shim refuses', () => {
  test('unauthenticated → 401 from shim before route handler runs', async () => {
    authState.authenticated = false;
    const app = makeApp();

    const res = await request(app)
      .post('/api/wellness/service-categories')
      .send({ name: 'Skin' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(prisma.serviceCategory.create).not.toHaveBeenCalled();
  });
});
