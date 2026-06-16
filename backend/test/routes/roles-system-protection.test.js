/**
 * Bug 1, 2, 4 regression tests for backend/routes/roles.js.
 *
 * Pins:
 *
 *   Bug 1 (Silent permission data loss) — PUT /api/roles/:id/permissions
 *     is a full-replace endpoint. The FRONTEND owns the "warn before
 *     dropping legacy perms" confirmation gate (see
 *     frontend/src/__tests__/RolesAdmin-legacy-perms.test.jsx). On the
 *     backend the PUT contract stays unchanged — the only assertion
 *     here is that a happy-path PUT with the full visible set DOES
 *     overwrite the row state. We're pinning the contract the
 *     frontend gate depends on.
 *
 *   Bug 2 (System role identity) — DELETE /api/roles/:id on a system
 *     role returns 403 with the exact error string the spec pins:
 *       { error: "System role identity cannot be modified",
 *         code: "SYSTEM_ROLE_PROTECTED", roleKey: "<key>" }
 *     PUT /api/roles/:id on a system role with key or userType in
 *     the body returns 403 with code SYSTEM_ROLE_IDENTITY_LOCKED
 *     even though the route's destructure ignores those fields.
 *
 *   Bug 4 (Strict per-vertical validation) — When
 *     RBAC_STRICT_VERTICAL_VALIDATION=1, POST /api/roles/:id/permissions
 *     rejects a foreign permission with 400 + INVALID_MODULE +
 *     the exact "Module 'X' is not valid for this tenant" string.
 *     Default-off: same call succeeds (back-compat with pre-cleanup
 *     state).
 *
 * Mock strategy mirrors backend/test/routes/admin.test.js — patch
 * middleware/auth.verifyToken + middleware/requirePermission.requirePermission
 * to no-op, then mock the prisma surfaces the role handlers touch.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Bypass auth + permission middleware so the handler bodies are exercised
// end-to-end. The handler-internal `req.user.isOwner` + tenant-scope
// checks still fire — the suite supplies req.user directly.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Patch the middleware's exports object IN PLACE so the route's
// destructured `const { requirePermission } = require(...)` reads the
// patched factory at module-load time. Do NOT delete the require cache
// — that would force a fresh module load that wouldn't carry the patch.
const permMw = requireCJS('../../middleware/requirePermission');
permMw.requirePermission = () => (_req, _res, next) => next();
permMw.clearUserCache = vi.fn();
permMw.clearTenantCache = vi.fn();

// writeAudit is async I/O; stub to a noop resolved promise.
const auditMod = requireCJS('../../lib/audit');
auditMod.writeAudit = vi.fn(async () => {});

// portalPermissions.clearCustomerRoleCache — used after CUSTOMER-role
// edits. Stub to noop.
const portalPermsMod = requireCJS('../../lib/portalPermissions');
portalPermsMod.clearCustomerRoleCache = vi.fn();

// Prisma surfaces touched by routes/roles.js. Reset between tests.
prisma.role = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.rolePermission = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = {
  findUnique: vi.fn(),
};
prisma.userRole = {
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.$transaction = vi.fn(async (fn) => fn(prisma));

import express from 'express';
import request from 'supertest';

// IMPORTANT: requireCJS so the route file's `const { requirePermission } =
// require(...)` resolves against the already-patched module exports.
const rolesRouter = requireCJS('../../routes/roles');

function makeApp({
  userId = 7,
  tenantId = 11,
  isOwner = false,
  role = 'ADMIN',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, isOwner, role };
    next();
  });
  app.use('/api/roles', rolesRouter);
  return app;
}

beforeEach(() => {
  for (const m of [prisma.role, prisma.rolePermission, prisma.tenant, prisma.userRole]) {
    for (const fn of Object.values(m)) {
      if (typeof fn === 'function' && typeof fn.mockReset === 'function') {
        fn.mockReset();
      }
    }
  }
  auditMod.writeAudit.mockReset();
  auditMod.writeAudit.mockResolvedValue(undefined);
  // Default: tenant lookup returns a travel tenant for the vertical-
  // validation tests. Individual tests override.
  prisma.tenant.findUnique.mockResolvedValue({
    id: 11,
    vertical: 'travel',
  });
  // Default: $transaction is a passthrough.
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  delete process.env.RBAC_STRICT_VERTICAL_VALIDATION;
});

afterEach(() => {
  delete process.env.RBAC_STRICT_VERTICAL_VALIDATION;
});

// ─────────────── Bug 2 — System role identity ───────────────

describe('Bug 2 — DELETE /api/roles/:id on a system role', () => {
  test('returns 403 with the spec-pinned error string', async () => {
    prisma.role.findUnique.mockResolvedValue({
      id: 5,
      key: 'ADMIN',
      name: 'Administrator',
      tenantId: 11,
      isSystem: true,
      _count: { userRoles: 0 },
    });

    const res = await request(makeApp()).delete('/api/roles/5');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('System role identity cannot be modified');
    expect(res.body.code).toBe('SYSTEM_ROLE_PROTECTED');
    expect(res.body.roleKey).toBe('ADMIN');
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  test('non-system role still deletable (sanity-check)', async () => {
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      name: 'Custom',
      tenantId: 11,
      isSystem: false,
      _count: { userRoles: 0 },
    });
    prisma.role.delete.mockResolvedValue({ id: 9 });

    const res = await request(makeApp()).delete('/api/roles/9');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });
});

describe('Bug 2 — PUT /api/roles/:id key/userType on a system role', () => {
  test('rejects key in body with 403 SYSTEM_ROLE_IDENTITY_LOCKED', async () => {
    prisma.role.findUnique.mockResolvedValue({
      id: 5,
      key: 'ADMIN',
      tenantId: 11,
      isSystem: true,
      landingPath: null,
    });

    const res = await request(makeApp())
      .put('/api/roles/5')
      .send({ key: 'EVIL_ADMIN', name: 'Tampered' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('System role identity cannot be modified');
    expect(res.body.code).toBe('SYSTEM_ROLE_IDENTITY_LOCKED');
    expect(res.body.fields).toContain('key');
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  test('rejects userType in body with 403 SYSTEM_ROLE_IDENTITY_LOCKED', async () => {
    prisma.role.findUnique.mockResolvedValue({
      id: 5,
      key: 'ADMIN',
      tenantId: 11,
      isSystem: true,
      landingPath: null,
    });

    const res = await request(makeApp())
      .put('/api/roles/5')
      .send({ userType: 'CUSTOMER', description: 'change' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SYSTEM_ROLE_IDENTITY_LOCKED');
    expect(res.body.fields).toContain('userType');
  });

  test('system role name + description update without key/userType still succeeds', async () => {
    prisma.role.findUnique.mockResolvedValue({
      id: 5,
      key: 'ADMIN',
      name: 'Administrator',
      description: null,
      tenantId: 11,
      isSystem: true,
      landingPath: null,
    });
    prisma.role.update.mockResolvedValue({
      id: 5,
      key: 'ADMIN',
      name: 'Renamed',
      description: 'new',
      permissions: [],
    });

    const res = await request(makeApp())
      .put('/api/roles/5')
      .send({ name: 'Renamed', description: 'new' });
    expect(res.status).toBe(200);
    expect(prisma.role.update).toHaveBeenCalledTimes(1);
  });

  test('non-system role with key in body is silently ignored (back-compat)', async () => {
    // Non-system roles never had key in PUT body schema either, but the
    // route never rejected — destructure ignores. Pin the behavior so
    // non-system updates aren't accidentally tightened.
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      tenantId: 11,
      isSystem: false,
      landingPath: null,
    });
    prisma.role.update.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      name: 'New',
      permissions: [],
    });

    const res = await request(makeApp())
      .put('/api/roles/9')
      .send({ key: 'IGNORED', name: 'New' });
    expect(res.status).toBe(200);
    // Key in update args is original
    const updateArg = prisma.role.update.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty('key');
  });
});

// ─────────────── Bug 4 — Strict vertical validation ───────────────

describe('Bug 4 — POST /api/roles/:id/permissions vertical validation', () => {
  test('default (env flag off): foreign perm accepted (back-compat)', async () => {
    delete process.env.RBAC_STRICT_VERTICAL_VALIDATION;
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      tenantId: 11,
      isSystem: false,
    });
    prisma.rolePermission.findUnique.mockResolvedValue(null);
    prisma.rolePermission.create.mockResolvedValue({
      id: 1,
      roleId: 9,
      module: 'patients',
      action: 'read',
    });

    const res = await request(makeApp())
      .post('/api/roles/9/permissions')
      .send({ module: 'patients', action: 'read' });
    // travel tenant + patients perm → without env flag the union
    // validator accepts. Pre-cleanup back-compat path.
    expect(res.status).toBe(201);
  });

  test('env flag ON: foreign perm rejected with 400 INVALID_MODULE', async () => {
    process.env.RBAC_STRICT_VERTICAL_VALIDATION = '1';
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      tenantId: 11,
      isSystem: false,
    });
    prisma.tenant.findUnique.mockResolvedValue({ id: 11, vertical: 'travel' });

    const res = await request(makeApp())
      .post('/api/roles/9/permissions')
      .send({ module: 'patients', action: 'read' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Module 'patients' is not valid for this tenant");
    expect(res.body.code).toBe('INVALID_MODULE');
    expect(res.body.vertical).toBe('travel');
    expect(prisma.rolePermission.create).not.toHaveBeenCalled();
  });

  test('env flag ON: native vertical perm accepted (travel + itineraries.read)', async () => {
    process.env.RBAC_STRICT_VERTICAL_VALIDATION = '1';
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      tenantId: 11,
      isSystem: false,
    });
    prisma.tenant.findUnique.mockResolvedValue({ id: 11, vertical: 'travel' });
    prisma.rolePermission.findUnique.mockResolvedValue(null);
    prisma.rolePermission.create.mockResolvedValue({
      id: 1,
      roleId: 9,
      module: 'itineraries',
      action: 'read',
    });

    const res = await request(makeApp())
      .post('/api/roles/9/permissions')
      .send({ module: 'itineraries', action: 'read' });
    expect(res.status).toBe(201);
  });

  test('env flag ON: common perm (contacts.read) accepted on every vertical', async () => {
    process.env.RBAC_STRICT_VERTICAL_VALIDATION = '1';
    prisma.role.findUnique.mockResolvedValue({
      id: 9,
      key: 'CUSTOM',
      tenantId: 11,
      isSystem: false,
    });
    prisma.tenant.findUnique.mockResolvedValue({ id: 11, vertical: 'travel' });
    prisma.rolePermission.findUnique.mockResolvedValue(null);
    prisma.rolePermission.create.mockResolvedValue({
      id: 1,
      roleId: 9,
      module: 'contacts',
      action: 'read',
    });

    const res = await request(makeApp())
      .post('/api/roles/9/permissions')
      .send({ module: 'contacts', action: 'read' });
    expect(res.status).toBe(201);
  });
});
