/**
 * Tests for backend/lib/rbacLockoutGuard.js.
 *
 * Pins the four scenarios the RBAC hardening spec requires:
 *
 *   Scenario 1 — Only one RBAC administrator exists; stripping their
 *                critical perms is rejected (count drops to 0).
 *   Scenario 2 — Two RBAC administrators; stripping one is allowed
 *                (count still >= 1).
 *   Scenario 5 — Deactivated users don't count toward recovery
 *                capacity (they can't log in to recover).
 *
 *   plus
 *
 *   • Roles missing roles.read (the actual tester scenario — page
 *     hides) are flagged even when roles.manage is still present.
 *   • Inactive roles are excluded from the effective set.
 *
 * Mocks prisma.user.findMany so the suite stays pure-unit. The
 * route-level test (test/routes/roles-lockout-versions.test.js)
 * exercises the live integration shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();

import { simulateAdminCount, checkLockout, getCriticalPermissions, intersectCritical } from '../../lib/rbacLockoutGuard.js';

const ADMIN_ROLE_ID = 100;
const NON_ADMIN_ROLE_ID = 200;

function mockUsers(rows) {
  prisma.user.findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  prisma.user.findMany.mockReset();
});

describe('getCriticalPermissions', () => {
  it('returns the spec-pinned roles.read + roles.manage pair', () => {
    const list = getCriticalPermissions();
    const keys = list.map((p) => `${p.module}.${p.action}`).sort();
    expect(keys).toEqual(['roles.manage', 'roles.read']);
  });

  it('returns a defensive copy (caller mutations don\'t leak)', () => {
    const a = getCriticalPermissions();
    a.push({ module: 'evil', action: 'all' });
    const b = getCriticalPermissions();
    expect(b.length).toBe(2);
  });
});

describe('intersectCritical', () => {
  it('returns the subset of proposed perms overlapping the critical set', () => {
    const proposed = [
      { module: 'contacts', action: 'read' },
      { module: 'roles', action: 'manage' },
    ];
    const r = intersectCritical(proposed);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ module: 'roles', action: 'manage' });
  });

  it('returns empty when no overlap', () => {
    expect(intersectCritical([{ module: 'contacts', action: 'read' }])).toEqual([]);
  });
});

describe('simulateAdminCount — Scenario 1 (single admin)', () => {
  it('rejects when stripping critical perms from the only admin role', async () => {
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
                { module: 'contacts', action: 'read' },
              ],
            },
          },
        ],
      },
    ]);

    // Propose stripping critical perms → leaves admin user with no critical
    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [{ module: 'contacts', action: 'read' }],
    });
    expect(result.count).toBe(0);
    expect(result.qualifyingUserIds).toEqual([]);
  });

  it('accepts when the proposed set keeps critical perms', async () => {
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
              ],
            },
          },
        ],
      },
    ]);

    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [
        { module: 'roles', action: 'read' },
        { module: 'roles', action: 'manage' },
        { module: 'contacts', action: 'read' },
      ],
    });
    expect(result.count).toBe(1);
    expect(result.qualifyingUserIds).toEqual([1]);
  });
});

describe('simulateAdminCount — Scenario 2 (two admins)', () => {
  it('allows when a second admin still retains critical perms (via different role)', async () => {
    // user 1 has the role being edited; user 2 has a SEPARATE role
    // that already carries critical perms.
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
              ],
            },
          },
        ],
      },
      {
        id: 2,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: NON_ADMIN_ROLE_ID,
            role: {
              id: NON_ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
                { module: 'contacts', action: 'read' },
              ],
            },
          },
        ],
      },
    ]);

    // Strip critical from ADMIN_ROLE_ID. User 2's other role still
    // grants them.
    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [{ module: 'contacts', action: 'read' }],
    });
    expect(result.count).toBe(1);
    expect(result.qualifyingUserIds).toEqual([2]);
  });
});

describe('simulateAdminCount — Scenario 5 (deactivated users excluded)', () => {
  it('does not count deactivated users toward recovery capacity', async () => {
    // findMany is called with deactivatedAt: null filter — so the
    // mock would receive only active users. Here we simulate the
    // filtered result: zero rows because the only admin user is
    // deactivated.
    mockUsers([]);

    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [
        { module: 'roles', action: 'read' },
        { module: 'roles', action: 'manage' },
      ],
    });
    expect(result.count).toBe(0);
    // Verify the query asked for non-deactivated users only
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deactivatedAt: null }),
      }),
    );
  });
});

describe('simulateAdminCount — partial critical sets', () => {
  it('rejects when only roles.manage remains (the actual tester scenario)', async () => {
    // Tester removed roles.read; roles.manage was still present.
    // The role's holders can still mutate but can't see the page.
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'manage' },
                { module: 'contacts', action: 'read' },
              ],
            },
          },
        ],
      },
    ]);

    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [
        { module: 'roles', action: 'manage' },
        { module: 'contacts', action: 'read' },
      ],
    });
    expect(result.count).toBe(0);
  });
});

describe('simulateAdminCount — inactive role is ignored', () => {
  it('does NOT count perms from an inactive role assigned to a user', async () => {
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: NON_ADMIN_ROLE_ID,
            role: {
              id: NON_ADMIN_ROLE_ID,
              isActive: false, // disabled role
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
              ],
            },
          },
        ],
      },
    ]);

    const result = await simulateAdminCount({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [{ module: 'roles', action: 'read' }],
    });
    expect(result.count).toBe(0);
  });
});

describe('checkLockout — structured response', () => {
  it('returns null when at least one user retains critical perms', async () => {
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
              ],
            },
          },
        ],
      },
    ]);
    const r = await checkLockout({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [
        { module: 'roles', action: 'read' },
        { module: 'roles', action: 'manage' },
      ],
    });
    expect(r).toBeNull();
  });

  it('returns 409 envelope with the spec-pinned error string', async () => {
    mockUsers([
      {
        id: 1,
        deactivatedAt: null,
        userRoles: [
          {
            roleId: ADMIN_ROLE_ID,
            role: {
              id: ADMIN_ROLE_ID,
              isActive: true,
              permissions: [
                { module: 'roles', action: 'read' },
                { module: 'roles', action: 'manage' },
              ],
            },
          },
        ],
      },
    ]);
    const r = await checkLockout({
      tenantId: 11,
      roleId: ADMIN_ROLE_ID,
      proposedPermissions: [],
    });
    expect(r).not.toBeNull();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(
      'This change would remove RBAC administration access from all active users.',
    );
    expect(r.body.code).toBe('LOCKOUT_PREVENTED');
    expect(r.body.criticalPermissions).toEqual(['roles.read', 'roles.manage']);
    expect(r.body.qualifyingUserCount).toBe(0);
  });
});
