/**
 * Tests for the requireAnyPermission helper added to
 * backend/middleware/requirePermission.js.
 *
 * The helper is the OR-gate that lets the /settings Role Recovery
 * section reach the existing roles read/restore endpoints via
 * `settings.manage` when `roles.read` / `roles.manage` are missing.
 * These tests pin:
 *
 *   1. Validation at creation time (empty list / unknown perm throws)
 *   2. OWNER short-circuits without DB lookup
 *   3. User with EITHER perm passes
 *   4. User with NEITHER perm gets 403 RBAC_DENIED + the requiredAny array
 *   5. CUSTOMER userType denied by default (matches requirePermission)
 *
 * Mocks the cache-loaded user permission set via stubbing the module's
 * getUserPermissions export — same shape as the helper's internal call.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch getUserPermissions inside the module BEFORE the helper is
// constructed. The helper closes over the module-local
// getUserPermissions; reassigning it via the exports surface won't
// affect the closure, so we replace the module-cache entry's compiled
// function reference instead.
const permMod = requireCJS('../../middleware/requirePermission');
let stubUserPerms = new Set();

// Re-bind the module's internal getUserPermissions reference. The
// helper is defined inside the module so reassigning here doesn't
// reach the closure — instead we exploit that the test's mocked
// prisma (set up below) returns the seed perm set via the real
// loadUserPermissions path.
//
// Strategy: stub prisma.userRole.findMany so loadUserPermissions
// hits a deterministic result. Reset PERMISSION_CACHE between tests.
import prisma from '../../lib/prisma.js';
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();

beforeEach(() => {
  permMod.clearAllCache();
  prisma.userRole.findMany.mockReset();
  stubUserPerms = new Set();
});

function makeReqRes({ user, perms }) {
  // Seed the cache directly to control the OR-gate's lookup result
  // without going through Prisma. The cache key is `${tenantId}::${userId}`
  // and the value shape is { permissions: Set<string>, timestamp: number }.
  if (user && perms) {
    permMod.PERMISSION_CACHE.set(`${user.tenantId}::${user.userId}`, {
      permissions: new Set(perms),
      timestamp: Date.now(),
    });
  }
  const req = { user };
  const res = {
    _status: 200,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      this._body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('requireAnyPermission — validation at creation time', () => {
  test('throws on empty list', () => {
    expect(() => permMod.requireAnyPermission([])).toThrow(/non-empty array/);
    expect(() => permMod.requireAnyPermission(null)).toThrow(/non-empty array/);
    expect(() => permMod.requireAnyPermission(undefined)).toThrow(/non-empty array/);
  });

  test('throws on missing module/action', () => {
    expect(() =>
      permMod.requireAnyPermission([{ module: 'roles' }]),
    ).toThrow(/needs \{module, action\}/);
    expect(() =>
      permMod.requireAnyPermission([{ action: 'read' }]),
    ).toThrow(/needs \{module, action\}/);
  });

  test('throws on unknown permission key', () => {
    expect(() =>
      permMod.requireAnyPermission([{ module: 'made_up', action: 'read' }]),
    ).toThrow(/Invalid permission/);
  });

  test('accepts a valid OR pair', () => {
    expect(() =>
      permMod.requireAnyPermission([
        { module: 'roles', action: 'read' },
        { module: 'settings', action: 'manage' },
      ]),
    ).not.toThrow();
  });
});

describe('requireAnyPermission — short-circuits', () => {
  test('OWNER passes without DB lookup', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 1, tenantId: 11, isOwner: true, userType: 'OWNER' },
      perms: [],
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(200);
  });
});

describe('requireAnyPermission — perm match semantics', () => {
  test('user with first perm only → passes', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 1, tenantId: 11, isOwner: false, userType: 'STAFF' },
      perms: ['roles.read'],
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('user with second perm only → passes (the lockout-recovery path)', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 1, tenantId: 11, isOwner: false, userType: 'STAFF' },
      perms: ['settings.manage', 'contacts.read'],
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('user with both perms → passes', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 1, tenantId: 11, isOwner: false, userType: 'STAFF' },
      perms: ['roles.read', 'settings.manage'],
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('user with NEITHER → 403 RBAC_DENIED carrying the OR pair', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 1, tenantId: 11, isOwner: false, userType: 'STAFF' },
      perms: ['contacts.read'],
    });
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('RBAC_DENIED');
    expect(res._body.requiredAny).toEqual(['roles.read', 'settings.manage']);
  });
});

describe('requireAnyPermission — userType policy', () => {
  test('CUSTOMER userType denied unless every perm is customer-safe', async () => {
    // settings.manage is NOT in CUSTOMER_SAFE_PERMISSIONS, so a
    // CUSTOMER with the OR-pair below is denied at the userType gate,
    // BEFORE the perm lookup.
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
      { module: 'settings', action: 'manage' },
    ]);
    const { req, res, next } = makeReqRes({
      user: { userId: 99, tenantId: 11, isOwner: false, userType: 'CUSTOMER' },
      perms: ['settings.manage'],
    });
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('CUSTOMER_ACCESS_DENIED');
  });

  test('missing user context → 401', async () => {
    const mw = permMod.requireAnyPermission([
      { module: 'roles', action: 'read' },
    ]);
    const { req, res, next } = makeReqRes({ user: undefined });
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});
