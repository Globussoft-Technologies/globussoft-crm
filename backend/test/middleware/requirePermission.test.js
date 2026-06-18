/**
 * Unit tests for backend/middleware/requirePermission.js — focuses on
 * the permission resolver contract. The ADMIN runtime shortcut tested in
 * an earlier revision was REMOVED after the matrix-non-authoritative bug
 * surfaced (see header comment in the SUT for the full history). The
 * resolver now treats ADMIN like every other role: its effective
 * permission set is exactly the union of RolePermission rows assigned
 * to it.
 *
 * Mocking strategy mirrors wellnessRole.test.js: prisma is a singleton
 * shared between the SUT and the test via vitest's `inline` config, so
 * we can monkey-patch prisma.userRole.findMany on the real prisma
 * instance and the SUT sees our fake. No prisma DB hits required.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const prisma = require('../../lib/prisma');
const {
  loadUserPermissions,
  clearAllCache,
} = require('../../middleware/requirePermission');

const originalUserRoleFindMany = prisma.userRole.findMany;
const originalUserFindUnique = prisma.user.findUnique;
const originalTenantFindUnique = prisma.tenant.findUnique;
const originalRoleFindFirst = prisma.role.findFirst;
const originalUserRoleFindUnique = prisma.userRole.findUnique;
const originalUserRoleCreate = prisma.userRole.create;

beforeEach(() => {
  clearAllCache();
});

afterEach(() => {
  prisma.userRole.findMany = originalUserRoleFindMany;
  prisma.user.findUnique = originalUserFindUnique;
  prisma.tenant.findUnique = originalTenantFindUnique;
  prisma.role.findFirst = originalRoleFindFirst;
  prisma.userRole.findUnique = originalUserRoleFindUnique;
  prisma.userRole.create = originalUserRoleCreate;
  clearAllCache();
});

describe('loadUserPermissions — matrix is authoritative', () => {
  test('ADMIN with empty grants returns empty set (no runtime shortcut)', async () => {
    // Pins the post-revert contract: if an admin unchecks every box on
    // the ADMIN role in the matrix and saves, the resolver returns an
    // empty set. The matrix UI is the source of truth — the resolver
    // does NOT silently grant anything based on the role's key.
    prisma.userRole.findMany = vi.fn().mockResolvedValue([
      { role: { key: 'ADMIN', permissions: [] } },
    ]);

    const perms = await loadUserPermissions(1, 100);
    expect(perms).toBeInstanceOf(Set);
    expect(perms.size).toBe(0);
  });

  test('ADMIN returns exactly the granted rows', async () => {
    // After ensureRbacOnBoot.grantAllPermissions runs, the ADMIN role
    // has every catalogue key as a RolePermission row. This test
    // simulates a partially-granted ADMIN (e.g. admin unchecked some
    // boxes) and asserts the resolver respects what's there.
    prisma.userRole.findMany = vi.fn().mockResolvedValue([
      {
        role: {
          key: 'ADMIN',
          permissions: [
            { module: 'roles', action: 'read' },
            { module: 'roles', action: 'manage' },
            { module: 'staff', action: 'manage' },
          ],
        },
      },
    ]);

    const perms = await loadUserPermissions(1, 100);
    expect(perms.has('roles.read')).toBe(true);
    expect(perms.has('roles.manage')).toBe(true);
    expect(perms.has('staff.manage')).toBe(true);
    // NOT granted via row → must NOT appear.
    expect(perms.has('my_appointments.read')).toBe(false);
    expect(perms.has('book_appointment.write')).toBe(false);
    expect(perms.has('patients.delete')).toBe(false);
    expect(perms.size).toBe(3);
  });

  test('non-ADMIN role returns ONLY its row-level grants', async () => {
    prisma.userRole.findMany = vi.fn().mockResolvedValue([
      {
        role: {
          key: 'MANAGER',
          permissions: [
            { module: 'reports', action: 'read' },
            { module: 'reports', action: 'export' },
            { module: 'roles', action: 'read' },
          ],
        },
      },
    ]);

    const perms = await loadUserPermissions(1, 100);
    expect(perms.has('reports.read')).toBe(true);
    expect(perms.has('reports.export')).toBe(true);
    expect(perms.has('roles.read')).toBe(true);
    expect(perms.has('roles.manage')).toBe(false);
    expect(perms.has('patients.delete')).toBe(false);
    expect(perms.size).toBe(3);
  });

  test('UNION across multiple roles, dedup via Set semantics', async () => {
    // The schema allows multi-role-per-user via the @@unique([userId,
    // roleId]) constraint (composite, blocks dup pairs, not dup users).
    // The resolver UNIONs all assigned roles' grants.
    prisma.userRole.findMany = vi.fn().mockResolvedValue([
      {
        role: {
          key: 'NURSE',
          permissions: [
            { module: 'patients', action: 'read' },
            { module: 'patients', action: 'update' },
          ],
        },
      },
      {
        role: {
          key: 'TELECALLER',
          permissions: [
            { module: 'leads', action: 'read' },
            { module: 'leads', action: 'write' },
            // Overlap with NURSE — dedup must collapse.
            { module: 'patients', action: 'read' },
          ],
        },
      },
    ]);

    const perms = await loadUserPermissions(1, 100);
    expect(perms.has('patients.read')).toBe(true);
    expect(perms.has('patients.update')).toBe(true);
    expect(perms.has('leads.read')).toBe(true);
    expect(perms.has('leads.write')).toBe(true);
    expect(perms.size).toBe(4);
  });

  test('empty userRoles for non-admin user → empty permission set', async () => {
    // Self-heal only fires for legacy User.role='ADMIN' — a user with
    // some other legacy role and no UserRole rows stays denied.
    prisma.userRole.findMany = vi.fn().mockResolvedValue([]);
    prisma.user.findUnique = vi.fn().mockResolvedValue({
      role: 'USER',
      userType: 'STAFF',
      tenantId: 1,
    });

    const perms = await loadUserPermissions(1, 100);
    expect(perms).toBeInstanceOf(Set);
    expect(perms.size).toBe(0);
  });
});

describe('loadUserPermissions — self-heal for legacy ADMIN with no UserRole rows', () => {
  test('legacy ADMIN with empty grants → provisions + returns full healed set', async () => {
    // Initial userRoles.findMany returns empty (broken state). The
    // self-heal then provisions and re-reads to find the canonical
    // ADMIN role with grants attached.
    let callCount = 0;
    prisma.userRole.findMany = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [];
      // Second call: post-heal, return the provisioned ADMIN role
      return [
        {
          role: {
            key: 'ADMIN',
            permissions: [
              { module: 'roles', action: 'read' },
              { module: 'roles', action: 'manage' },
              { module: 'patients', action: 'read' },
              { module: 'settings', action: 'manage' },
            ],
          },
        },
      ];
    });

    // The self-heal helper looks up User + Tenant, then provisions and
    // assigns. We mock the boundary calls to simulate the heal succeeding.
    prisma.user.findUnique = vi.fn().mockResolvedValue({
      role: 'ADMIN',
      userType: 'STAFF',
      tenantId: 1,
    });
    prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
    prisma.role.findFirst = vi.fn().mockResolvedValue({ id: 42 });
    prisma.userRole.findUnique = vi.fn().mockResolvedValue(null);
    prisma.userRole.create = vi.fn().mockResolvedValue({});

    // Mock the provisioner so we don't actually try to call the real
    // ensureRbacOnBoot script (which would hit other tables we haven't
    // stubbed).
    const ensureRbacOnBootModule = require('../../scripts/ensureRbacOnBoot');
    const originalProvision = ensureRbacOnBootModule.provisionTenantRbac;
    ensureRbacOnBootModule.provisionTenantRbac = vi.fn().mockResolvedValue({});

    try {
      const perms = await loadUserPermissions(1, 100);
      expect(perms).toBeInstanceOf(Set);
      expect(perms.size).toBe(4);
      expect(perms.has('roles.read')).toBe(true);
      expect(perms.has('roles.manage')).toBe(true);
      expect(perms.has('patients.read')).toBe(true);
      expect(perms.has('settings.manage')).toBe(true);
      // Provisioner must have been invoked exactly once
      expect(ensureRbacOnBootModule.provisionTenantRbac).toHaveBeenCalledTimes(1);
      expect(ensureRbacOnBootModule.provisionTenantRbac).toHaveBeenCalledWith(1, {
        vertical: 'wellness',
      });
    } finally {
      ensureRbacOnBootModule.provisionTenantRbac = originalProvision;
    }
  });

  test('legacy MANAGER with empty grants → NO self-heal, stays denied', async () => {
    // Only legacy ADMIN triggers the heal. A manager with empty grants
    // genuinely has no access (matrix is authoritative).
    prisma.userRole.findMany = vi.fn().mockResolvedValue([]);
    prisma.user.findUnique = vi.fn().mockResolvedValue({
      role: 'MANAGER',
      userType: 'STAFF',
      tenantId: 1,
    });

    const ensureRbacOnBootModule = require('../../scripts/ensureRbacOnBoot');
    const originalProvision = ensureRbacOnBootModule.provisionTenantRbac;
    ensureRbacOnBootModule.provisionTenantRbac = vi.fn();

    try {
      const perms = await loadUserPermissions(1, 100);
      expect(perms.size).toBe(0);
      expect(ensureRbacOnBootModule.provisionTenantRbac).not.toHaveBeenCalled();
    } finally {
      ensureRbacOnBootModule.provisionTenantRbac = originalProvision;
    }
  });

  test('OWNER with empty grants → NO self-heal (OWNER bypasses at middleware level)', async () => {
    prisma.userRole.findMany = vi.fn().mockResolvedValue([]);
    prisma.user.findUnique = vi.fn().mockResolvedValue({
      role: 'ADMIN',
      userType: 'OWNER',
      tenantId: null,
    });

    const ensureRbacOnBootModule = require('../../scripts/ensureRbacOnBoot');
    const originalProvision = ensureRbacOnBootModule.provisionTenantRbac;
    ensureRbacOnBootModule.provisionTenantRbac = vi.fn();

    try {
      const perms = await loadUserPermissions(1, 100);
      expect(perms.size).toBe(0);
      expect(ensureRbacOnBootModule.provisionTenantRbac).not.toHaveBeenCalled();
    } finally {
      ensureRbacOnBootModule.provisionTenantRbac = originalProvision;
    }
  });

  test('ADMIN with non-empty grants → NO self-heal (matrix authoritative)', async () => {
    // Pins the matrix-authoritative contract: an admin who has SOME
    // grants but lacks specific ones does NOT trigger the heal — the
    // resolver respects what's in RolePermission rows. The heal only
    // fires when the set is COMPLETELY empty.
    prisma.userRole.findMany = vi.fn().mockResolvedValue([
      {
        role: {
          key: 'ADMIN',
          permissions: [
            { module: 'roles', action: 'read' },
            // intentionally NOT 'patients.delete' — admin opted out
          ],
        },
      },
    ]);
    prisma.user.findUnique = vi.fn().mockResolvedValue({
      role: 'ADMIN',
      userType: 'STAFF',
      tenantId: 1,
    });

    const ensureRbacOnBootModule = require('../../scripts/ensureRbacOnBoot');
    const originalProvision = ensureRbacOnBootModule.provisionTenantRbac;
    ensureRbacOnBootModule.provisionTenantRbac = vi.fn();

    try {
      const perms = await loadUserPermissions(1, 100);
      expect(perms.size).toBe(1);
      expect(perms.has('roles.read')).toBe(true);
      expect(perms.has('patients.delete')).toBe(false);
      expect(ensureRbacOnBootModule.provisionTenantRbac).not.toHaveBeenCalled();
    } finally {
      ensureRbacOnBootModule.provisionTenantRbac = originalProvision;
    }
  });
});
