/**
 * Unit tests for backend/lib/portalPermissions.js — patient-portal RBAC
 * resolver.
 *
 * Pins the contract that:
 *   - getCustomerRolePermissions returns the union of RolePermission
 *     rows on the tenant's CUSTOMER role.
 *   - requirePortalPermission 401s when req.patient is missing
 *     id/tenantId, 403s when the permission isn't granted, next()s when
 *     it is.
 *   - clearCustomerRoleCache invalidates the per-tenant cached set.
 *   - Catalog validation rejects unknown (module, action) pairs at
 *     middleware-factory creation time.
 *
 * Mocks the prisma singleton via monkey-patch (same pattern as
 * roleResolution.test.js + eventBus.test.js).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  requirePortalPermission,
  getCustomerRolePermissions,
  loadCustomerRolePermissions,
  clearCustomerRoleCache,
  _CACHE,
} from '../../lib/portalPermissions.js';

beforeEach(() => {
  prisma.role = prisma.role || {};
  prisma.role.findFirst = vi.fn();
  clearCustomerRoleCache(null); // wipe between tests
});

describe('loadCustomerRolePermissions', () => {
  test('returns empty Set when no CUSTOMER role exists for the tenant', async () => {
    prisma.role.findFirst.mockResolvedValueOnce(null);
    const perms = await loadCustomerRolePermissions(99);
    expect(perms).toBeInstanceOf(Set);
    expect(perms.size).toBe(0);
  });

  test('returns a Set of "module.action" strings unioning the role grants', async () => {
    prisma.role.findFirst.mockResolvedValueOnce({
      id: 7,
      permissions: [
        { module: 'my_prescriptions', action: 'read' },
        { module: 'appointments', action: 'read' },
        { module: 'services', action: 'read' },
      ],
    });
    const perms = await loadCustomerRolePermissions(1);
    expect(perms.has('my_prescriptions.read')).toBe(true);
    expect(perms.has('appointments.read')).toBe(true);
    expect(perms.has('services.read')).toBe(true);
    expect(perms.has('patients.read')).toBe(false);
  });

  test('scopes the lookup by tenantId + key=CUSTOMER', async () => {
    prisma.role.findFirst.mockResolvedValueOnce({ id: 7, permissions: [] });
    await loadCustomerRolePermissions(42);
    expect(prisma.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 42, key: 'CUSTOMER' },
      }),
    );
  });
});

describe('getCustomerRolePermissions caching', () => {
  test('caches by tenantId for 30s and hits the DB only once on repeat calls', async () => {
    prisma.role.findFirst.mockResolvedValue({
      id: 7,
      permissions: [{ module: 'my_prescriptions', action: 'read' }],
    });

    const a = await getCustomerRolePermissions(1);
    const b = await getCustomerRolePermissions(1);
    expect(a).toBe(b); // same Set reference — served from cache
    expect(prisma.role.findFirst).toHaveBeenCalledTimes(1);
  });

  test('clearCustomerRoleCache(tenantId) drops the entry so the next call re-reads', async () => {
    prisma.role.findFirst.mockResolvedValue({
      id: 7,
      permissions: [{ module: 'my_prescriptions', action: 'read' }],
    });
    await getCustomerRolePermissions(1);
    clearCustomerRoleCache(1);
    await getCustomerRolePermissions(1);
    expect(prisma.role.findFirst).toHaveBeenCalledTimes(2);
  });

  test('clearCustomerRoleCache(null) wipes the whole cache', async () => {
    prisma.role.findFirst.mockResolvedValue({ id: 7, permissions: [] });
    await getCustomerRolePermissions(1);
    await getCustomerRolePermissions(2);
    expect(_CACHE.size).toBe(2);
    clearCustomerRoleCache(null);
    expect(_CACHE.size).toBe(0);
  });
});

describe('requirePortalPermission middleware', () => {
  function mkRes() {
    return {
      statusCode: 200,
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
  }

  test('throws at factory time when the (module, action) is not in the catalog', () => {
    expect(() => requirePortalPermission('not_a_real_module', 'read')).toThrow(
      /Invalid permission/,
    );
  });

  test('401s when req.patient is missing entirely', async () => {
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = {};
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s when req.patient.tenantId is missing (token never plumbed tenant through)', async () => {
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = { patient: { id: 1 } }; // no tenantId
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  test('403s with PORTAL_RBAC_DENIED when the tenant CUSTOMER role lacks the permission', async () => {
    prisma.role.findFirst.mockResolvedValueOnce({
      id: 7,
      permissions: [{ module: 'appointments', action: 'read' }], // no my_prescriptions
    });
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = { patient: { id: 1, tenantId: 1 } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PORTAL_RBAC_DENIED');
    expect(res.body.required).toBe('my_prescriptions.read');
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when the tenant has no CUSTOMER role at all (fail-closed default)', async () => {
    prisma.role.findFirst.mockResolvedValueOnce(null);
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = { patient: { id: 1, tenantId: 99 } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('next()s when the tenant CUSTOMER role grants the permission', async () => {
    prisma.role.findFirst.mockResolvedValueOnce({
      id: 7,
      permissions: [{ module: 'my_prescriptions', action: 'read' }],
    });
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = { patient: { id: 1, tenantId: 1 } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  test('fails closed (403) if the DB lookup throws', async () => {
    prisma.role.findFirst.mockRejectedValueOnce(new Error('db down'));
    const mw = requirePortalPermission('my_prescriptions', 'read');
    const req = { patient: { id: 1, tenantId: 1 } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PORTAL_PERMISSION_CHECK_FAILED');
    expect(next).not.toHaveBeenCalled();
  });
});
