// @ts-check
/**
 * Unit tests for backend/routes/tenants.js — pins the tenant admin surface
 * (current-tenant read/update + tenant-scoped user list/invite).
 *
 * Why this file exists
 * ────────────────────
 * routes/tenants.js is the per-tenant self-service control panel: every
 * authenticated user can read their own tenant's metadata + user list,
 * and ADMINs can update tenant settings + invite new users. There was
 * NO vitest coverage before this file — the only signal came from the
 * deploy gate's API spec layer, which doesn't pin the route-level RBAC
 * shapes or the bcrypt + Prisma seam.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /current happy-path → 200 with the current tenant row (looked
 *      up by req.user.tenantId).
 *   2. GET /current → 404 when the tenant row is missing (e.g. soft-deleted
 *      tenant whose JWTs are still in flight).
 *   3. GET /current → 500 INTERNAL when Prisma throws.
 *   4. PUT /current happy-path (ADMIN) → 200 with the updated row; only
 *      the whitelisted fields (name, plan, ownerEmail, isActive,
 *      emailRetention) reach Prisma.
 *   5. PUT /current ADMIN-only — USER → 403 RBAC_DENIED.
 *   6. PUT /current ADMIN-only — MANAGER → 403 RBAC_DENIED (only ADMIN
 *      passes — verifyRole(['ADMIN']) is strict).
 *   7. PUT /current emailRetention coerced to boolean — '0' and 'false'
 *      strings become true (truthy) per the `!!` semantics the route
 *      ships; only falsy primitives become false.
 *   8. PUT /current Prisma error → 500 INTERNAL.
 *   9. GET /users happy-path → 200 with the current tenant's users; the
 *      where-clause is { tenantId: req.user.tenantId } (no cross-tenant
 *      leak), and the select strips password.
 *  10. GET /users → 500 on Prisma error.
 *  11. POST /users happy-path (ADMIN) → 201 with the created user (no
 *      password in the response), password is bcrypt-hashed, role defaults
 *      to USER when omitted, and tenantId is forced to req.user.tenantId.
 *  12. POST /users → 400 when email missing.
 *  13. POST /users → 400 when password missing.
 *  14. POST /users → 400 when email already exists.
 *  15. POST /users ADMIN-only — USER → 403 RBAC_DENIED.
 *  16. POST /users → 500 on Prisma error.
 *
 * Pattern mirrors backend/test/routes/admin.test.js — prisma singleton
 * monkey-patch + bypass verifyToken with a passthrough so we don't have
 * to mint JWTs; verifyRole stays REAL so the RBAC denials are end-to-end.
 *
 * #937 defensive eventBus mock — the router doesn't directly emit events
 * today, but the defensive mock prevents any indirect emission (via
 * stripDangerous middleware hooks etc) from hitting a real cron tick.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// #937 defensive eventBus mock — applied BEFORE the router require so the
// router's transitive deps capture the mocked surface.
const eb = requireCJS('../../lib/eventBus');
eb.emitEvent = vi.fn().mockResolvedValue(undefined);

// Auth middleware bypass — let req.user populate from the fake middleware
// in makeApp(). verifyRole stays REAL so we exercise the role-gate end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — replace the lazy $extends-proxy delegates
// for tenant + user with bare vi.fn() surfaces. The route only touches
// these two delegates.
prisma.tenant = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
prisma.user = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  // Schema-drift compat: User.email is composite-unique with tenantId
  // (@@unique([email, tenantId])), so the tenants route uses findFirst
  // for the email duplicate check. The existing tests mock findUnique;
  // findFirst delegates so per-test mockResolvedValue calls keep working.
  findFirst: vi.fn(),
  create: vi.fn(),
};

import express from 'express';
import request from 'supertest';

const tenantsRouter = requireCJS('../../routes/tenants');

/**
 * Build a fresh express app with a fake auth-context middleware so the
 * router sees req.user. Default role ADMIN; override to USER or MANAGER
 * to exercise the verifyRole(['ADMIN']) denial path.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/tenants', tenantsRouter);
  return app;
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.update.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.user.create.mockReset();
  // After reset, wire findFirst → findUnique so existing per-test
  // findUnique.mockResolvedValue calls cover both code paths.
  prisma.user.findFirst.mockImplementation((...args) => prisma.user.findUnique(...args));
});

// ── GET /current ──────────────────────────────────────────────────────

describe('GET /api/tenants/current', () => {
  test('happy path: returns the current tenant row keyed by req.user.tenantId', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 42,
      name: 'Acme Corp',
      plan: 'enterprise',
      ownerEmail: 'owner@acme.test',
      isActive: true,
      vertical: 'generic',
    });

    const res = await request(makeApp({ tenantId: 42 })).get('/api/tenants/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 42,
      name: 'Acme Corp',
      plan: 'enterprise',
      ownerEmail: 'owner@acme.test',
      isActive: true,
    });
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  test('404 when the tenant row is missing', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 999 })).get('/api/tenants/current');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('Prisma error → 500', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(makeApp()).get('/api/tenants/current');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── PUT /current ──────────────────────────────────────────────────────

describe('PUT /api/tenants/current', () => {
  test('happy path (ADMIN): only whitelisted fields reach Prisma.update', async () => {
    prisma.tenant.update.mockResolvedValue({
      id: 42,
      name: 'Acme Renamed',
      plan: 'pro',
      ownerEmail: 'newowner@acme.test',
      isActive: true,
      emailRetention: true,
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .put('/api/tenants/current')
      .send({
        name: 'Acme Renamed',
        plan: 'pro',
        ownerEmail: 'newowner@acme.test',
        isActive: true,
        emailRetention: true,
        // Non-whitelisted fields MUST NOT reach Prisma.
        id: 999,
        vertical: 'wellness',
        secret: 'pwn',
      });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Renamed');
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.tenant.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 42 });
    // Whitelisted fields present.
    expect(updateCall.data).toMatchObject({
      name: 'Acme Renamed',
      plan: 'pro',
      ownerEmail: 'newowner@acme.test',
      isActive: true,
      emailRetention: true,
    });
    // Non-whitelisted fields ABSENT.
    expect(updateCall.data.id).toBeUndefined();
    expect(updateCall.data.vertical).toBeUndefined();
    expect(updateCall.data.secret).toBeUndefined();
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .put('/api/tenants/current')
      .send({ name: 'pwn' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('MANAGER role → 403 RBAC_DENIED (verifyRole strict to ADMIN)', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .put('/api/tenants/current')
      .send({ name: 'pwn' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  test('emailRetention coerced via !! — truthy strings become true', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 1, emailRetention: true });

    // Per route: `data.emailRetention = !!emailRetention` — '0' / 'false'
    // are NON-EMPTY STRINGS so they're truthy in JS. The route is
    // documenting "client must send a real boolean / falsy primitive,
    // not a stringified one". Pin the current behaviour so a future
    // refactor (e.g. JSON.parse the value) is a deliberate choice.
    const res = await request(makeApp())
      .put('/api/tenants/current')
      .send({ emailRetention: 'false' });

    expect(res.status).toBe(200);
    expect(prisma.tenant.update.mock.calls[0][0].data.emailRetention).toBe(true);
  });

  test('emailRetention coerced via !! — false stays false', async () => {
    prisma.tenant.update.mockResolvedValue({ id: 1, emailRetention: false });

    const res = await request(makeApp())
      .put('/api/tenants/current')
      .send({ emailRetention: false });

    expect(res.status).toBe(200);
    expect(prisma.tenant.update.mock.calls[0][0].data.emailRetention).toBe(false);
  });

  test('Prisma error → 500', async () => {
    prisma.tenant.update.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(makeApp())
      .put('/api/tenants/current')
      .send({ name: 'newname' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── GET /users ────────────────────────────────────────────────────────

describe('GET /api/tenants/users', () => {
  test('returns users scoped to req.user.tenantId; password field is NOT selected', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 1, email: 'a@x.test', name: 'Alice', role: 'ADMIN', createdAt: new Date('2026-01-01') },
      { id: 2, email: 'b@x.test', name: 'Bob', role: 'USER', createdAt: new Date('2026-01-02') },
    ]);

    const res = await request(makeApp({ tenantId: 7 })).get('/api/tenants/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ id: 1, email: 'a@x.test', role: 'ADMIN' });

    // Cross-tenant guard: only this tenant's userIds reach Prisma.
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7 },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    // Password is NOT in the select; defense-in-depth assert.
    const selectArg = prisma.user.findMany.mock.calls[0][0].select;
    expect(selectArg.password).toBeUndefined();
  });

  test('Prisma error → 500', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(makeApp()).get('/api/tenants/users');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── POST /users ───────────────────────────────────────────────────────

describe('POST /api/tenants/users', () => {
  test('happy path (ADMIN): 201, bcrypt-hashed password, role defaults USER, tenantId forced', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data, select }) => ({
      id: 101,
      email: data.email,
      name: data.name,
      role: data.role,
      createdAt: new Date('2026-05-26T00:00:00Z'),
    }));

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/tenants/users')
      .send({
        email: 'newuser@acme.test',
        name: 'New User',
        password: 'plaintext-secret',
        // role omitted → defaults to USER per route.
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 101,
      email: 'newuser@acme.test',
      name: 'New User',
      role: 'USER',
    });
    // Password MUST NOT appear in the response body.
    expect(res.body.password).toBeUndefined();

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.user.create.mock.calls[0][0];
    // tenantId is forced to req.user.tenantId — NOT taken from body.
    expect(createArg.data.tenantId).toBe(42);
    // Role defaulted to USER when omitted.
    expect(createArg.data.role).toBe('USER');
    // Password is bcrypt-hashed — never the plaintext.
    expect(createArg.data.password).not.toBe('plaintext-secret');
    expect(createArg.data.password).toMatch(/^\$2[aby]\$\d+\$/);
  });

  test('honours explicit role (e.g. MANAGER) when supplied', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 102,
      email: 'mgr@acme.test',
      name: 'Manager',
      role: 'MANAGER',
      createdAt: new Date(),
    });

    const res = await request(makeApp())
      .post('/api/tenants/users')
      .send({
        email: 'mgr@acme.test',
        name: 'Manager',
        password: 'pw',
        role: 'MANAGER',
      });

    expect(res.status).toBe(201);
    expect(prisma.user.create.mock.calls[0][0].data.role).toBe('MANAGER');
  });

  test('400 when email missing', async () => {
    const res = await request(makeApp())
      .post('/api/tenants/users')
      .send({ password: 'pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*password/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('400 when password missing', async () => {
    const res = await request(makeApp())
      .post('/api/tenants/users')
      .send({ email: 'x@y.test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*password/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('400 when email already exists', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'taken@x.test',
    });

    const res = await request(makeApp())
      .post('/api/tenants/users')
      .send({ email: 'taken@x.test', password: 'pw' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/tenants/users')
      .send({ email: 'a@b.test', password: 'pw' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('Prisma error during create → 500', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(makeApp())
      .post('/api/tenants/users')
      .send({ email: 'x@y.test', password: 'pw' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});
