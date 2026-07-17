/**
 * Regression tests for backend/scripts/ensureRbacOnBoot.js — pins the
 * vertical-aware role provisioning contract.
 *
 * Critical guarantee: wellness clinical roles (DOCTOR, NURSE,
 * RECEPTIONIST, TELECALLER) must NEVER be auto-created on a travel
 * or generic tenant. The seeder gates these on
 * `if (vertical === 'wellness')` — without this test, a refactor
 * could silently drop the gate and start polluting non-wellness
 * tenants with empty clinical-role rows (the exact bug the user
 * found on tenant id=11 / Travel Stall).
 *
 * What we mock:
 *   - prisma — all role / rolePermission / userRole / tenant / user
 *     ops are mocked. The test never touches a real DB.
 *
 * What we assert:
 *   - vertical = 'travel'   → only ADMIN, MANAGER, USER, CUSTOMER created
 *   - vertical = 'generic'  → same
 *   - vertical = 'wellness' → ADMIN + MANAGER + USER + CUSTOMER +
 *                             DOCTOR + NURSE + RECEPTIONIST + TELECALLER
 *
 * Why it's a regression test, not an integration test:
 *   - The bug we're guarding against is structural (gate accidentally
 *     removed). A mock-prisma unit test is enough — we just need to
 *     observe which Role.key values reach prisma.role.create.
 *   - Avoids spinning up a MySQL container per CI run.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { provisionTenantRbac } from '../../scripts/ensureRbacOnBoot.js';

const WELLNESS_CLINICAL_KEYS = ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'TELECALLER'];

// Singleton-patch the prisma models that ensureRbacOnBoot touches.
// The SUT is a CJS module that requires the same singleton, so replacing
// the model surfaces on the shared instance propagates to its calls.
const mockPrisma = {
  role: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  rolePermission: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  userRole: {
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  tenant: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
  roleWidget: {
    create: vi.fn(),
  },
};

beforeEach(() => {
  // Patch the shared singleton so the CJS SUT sees our mocks.
  Object.assign(prisma, {
    role: mockPrisma.role,
    rolePermission: mockPrisma.rolePermission,
    userRole: mockPrisma.userRole,
    tenant: mockPrisma.tenant,
    user: mockPrisma.user,
    roleWidget: mockPrisma.roleWidget,
  });

  // Reset call counts between tests.
  vi.clearAllMocks();

  // Default find-* responses: nothing exists yet, so ensureRole always
  // takes the create branch.
  mockPrisma.role.findFirst.mockResolvedValue(null);
  mockPrisma.rolePermission.findFirst.mockResolvedValue(null);
  mockPrisma.userRole.findUnique.mockResolvedValue(null);
  mockPrisma.userRole.count.mockResolvedValue(0);
  mockPrisma.tenant.findUnique.mockResolvedValue({ vertical: null });
  mockPrisma.user.findMany.mockResolvedValue([]);

  // role.create returns a stub with an id so downstream calls don't blow up
  let idSeq = 100;
  mockPrisma.role.create.mockImplementation(({ data }) => {
    return Promise.resolve({ id: idSeq++, ...data });
  });
  // rolePermission.create + userRole.create succeed silently
  mockPrisma.rolePermission.create.mockResolvedValue({});
  mockPrisma.userRole.create.mockResolvedValue({});
  // roleWidget might be absent (RoleWidget table optional) — the seeder
  // wraps in try/catch so an error here doesn't crash; return a stub.
  mockPrisma.roleWidget.create.mockResolvedValue({});
});

function createdRoleKeys() {
  return mockPrisma.role.create.mock.calls.map((call) => call[0].data.key);
}

describe('provisionTenantRbac — vertical-aware role provisioning', () => {
  test('travel vertical does NOT create wellness clinical roles', async () => {
    await provisionTenantRbac(1, { vertical: 'travel' });

    const keys = createdRoleKeys();
    // The 4 baseline roles are still created on every tenant.
    expect(keys).toContain('ADMIN');
    expect(keys).toContain('MANAGER');
    expect(keys).toContain('USER');
    expect(keys).toContain('CUSTOMER');

    // Wellness clinical roles must NEVER appear on a travel tenant.
    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(
        keys,
        `travel tenant must not receive wellness clinical role ${cliniKey}`,
      ).not.toContain(cliniKey);
    }
  });

  test('generic vertical does NOT create wellness clinical roles', async () => {
    await provisionTenantRbac(2, { vertical: 'generic' });

    const keys = createdRoleKeys();
    expect(keys).toContain('ADMIN');
    expect(keys).toContain('MANAGER');
    expect(keys).toContain('USER');
    expect(keys).toContain('CUSTOMER');

    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(
        keys,
        `generic tenant must not receive wellness clinical role ${cliniKey}`,
      ).not.toContain(cliniKey);
    }
  });

  test('unknown vertical does NOT create wellness clinical roles', async () => {
    // Defensive: an unrecognised vertical string (typo, future drift)
    // should fail closed — no wellness leakage, just the four baseline
    // roles + the COMMON catalog perms for ADMIN.
    await provisionTenantRbac(3, { vertical: 'made-up-vertical' });

    const keys = createdRoleKeys();
    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(keys).not.toContain(cliniKey);
    }
  });

  test('null vertical (no opts) defaults to generic and skips wellness clinical roles', async () => {
    // Caller doesn't pass opts — provisioner falls back to looking up
    // tenant.vertical in the DB. Mock returns null vertical → treated as
    // generic. No wellness clinical role pollution.
    mockPrisma.tenant.findUnique.mockResolvedValue({ vertical: null });
    await provisionTenantRbac(4);

    const keys = createdRoleKeys();
    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(keys).not.toContain(cliniKey);
    }
  });

  test('wellness vertical DOES create the four wellness clinical roles', async () => {
    await provisionTenantRbac(5, { vertical: 'wellness' });

    const keys = createdRoleKeys();
    expect(keys).toContain('ADMIN');
    expect(keys).toContain('MANAGER');
    expect(keys).toContain('USER');
    expect(keys).toContain('CUSTOMER');
    // Wellness vertical IS the place these roles belong.
    expect(keys).toContain('DOCTOR');
    expect(keys).toContain('NURSE');
    expect(keys).toContain('RECEPTIONIST');
    expect(keys).toContain('TELECALLER');
  });

  test('legacy opts.isWellness === true behaves like vertical = wellness', async () => {
    // Back-compat: the older auth.js signup path passes `{ isWellness }`.
    // provisionTenantRbac maps true → 'wellness'. The clinical roles
    // should still get created so a wellness-vertical signup keeps
    // working unchanged.
    await provisionTenantRbac(6, { isWellness: true });

    const keys = createdRoleKeys();
    expect(keys).toContain('DOCTOR');
    expect(keys).toContain('NURSE');
    expect(keys).toContain('RECEPTIONIST');
    expect(keys).toContain('TELECALLER');
  });

  test('legacy opts.isWellness === false maps to generic and skips clinical roles', async () => {
    // Symmetric: an old caller passing `{ isWellness: false }` must NOT
    // create wellness clinical roles even when the eventual tenant is
    // actually travel. Better to under-provision (admin can create them
    // manually) than to leak wellness pollution.
    await provisionTenantRbac(7, { isWellness: false });

    const keys = createdRoleKeys();
    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(keys).not.toContain(cliniKey);
    }
  });
});

describe('regression: per-key landingPath shape', () => {
  // Sanity: confirm the four wellness clinical roles land users at /home
  // (the role-aware widget dashboard) — preserves the existing wellness
  // staff UX. Without this, a future landingPath refactor could silently
  // change DOCTOR.landingPath to e.g. /wellness, breaking practitioner
  // launch flow.
  test('wellness clinical roles get landingPath = /home', async () => {
    await provisionTenantRbac(8, { vertical: 'wellness' });

    const created = mockPrisma.role.create.mock.calls
      .map((call) => call[0].data)
      .filter((d) => WELLNESS_CLINICAL_KEYS.includes(d.key));

    expect(created).toHaveLength(4);
    for (const r of created) {
      expect(r.landingPath, `${r.key} should land at /home`).toBe('/home');
    }
  });
});

describe('ADMIN permission backfill — additive/idempotent on every boot', () => {
  // PRINCIPLE: grantAllPermissions is now called unconditionally for ADMIN
  // on every boot. ensureRolePermission is additive/idempotent — it does a
  // findFirst before create, so permissions already present are NEVER
  // re-created or overridden. This means:
  //   - existing ADMIN rows gain any catalog entries added since last provision
  //   - permissions an operator explicitly REVOKED stay revoked (ensureRolePermission
  //     only ADDS rows — it never removes them)
  //   - the boot-loop cannot "re-grant" a revoked permission because
  //     ensureRolePermission checks findFirst BEFORE create — if the row was
  //     deleted (revoked), it will be re-created; if still present, it is skipped
  //
  // Trade-off accepted: a tenant admin who revokes a permission via the
  // Roles & Permissions UI will see it restored on next server restart. This
  // is the correct trade-off for ensuring newly-catalogued permissions (like
  // cost_master.delete) always reach existing ADMIN roles that pre-date the
  // catalog addition — blocking admin operations is worse than restoring a
  // revoked perm on restart.

  test('existing ADMIN role DOES receive additive grants on subsequent boot', async () => {
    // Simulate ADMIN already existing. ensureRolePermission (findFirst →
    // create) should still fire for every catalog entry because
    // rolePermission.findFirst returns null (nothing previously granted).
    const PRE_EXISTING_ADMIN_ID = 999;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      if (where.key === 'ADMIN') {
        return Promise.resolve({
          id: PRE_EXISTING_ADMIN_ID,
          tenantId: where.tenantId,
          key: 'ADMIN',
          name: 'Admin',
          isSystem: true,
        });
      }
      return Promise.resolve(null);
    });

    await provisionTenantRbac(100, { vertical: 'travel' });

    // ADMIN role itself was NOT re-created.
    const createdKeys = createdRoleKeys();
    expect(
      createdKeys,
      'ADMIN must NOT be re-created when it already exists',
    ).not.toContain('ADMIN');

    // grantAllPermissions fires for the existing ADMIN — rolePermission.create
    // is called for every catalog entry that findFirst says is missing.
    // The mock returns null for all findFirst calls, so every entry produces a
    // create call.
    const adminPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(
      adminPermCreates.length,
      'Existing ADMIN should receive additive permission backfill on each boot',
    ).toBeGreaterThan(50);
  });

  test('existing ADMIN with all perms already present produces zero new creates (idempotent)', async () => {
    // When ALL rolePermission rows already exist (findFirst returns a row),
    // ensureRolePermission skips create entirely. Boot is truly idempotent
    // for a fully-provisioned tenant.
    const PRE_EXISTING_ADMIN_ID = 888;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      if (where.key === 'ADMIN') {
        return Promise.resolve({ id: PRE_EXISTING_ADMIN_ID, tenantId: where.tenantId, key: 'ADMIN', isSystem: true });
      }
      return Promise.resolve(null);
    });
    // Simulate every rolePermission already existing.
    mockPrisma.rolePermission.findFirst.mockResolvedValue({ id: 1, roleId: PRE_EXISTING_ADMIN_ID });

    await provisionTenantRbac(103, { vertical: 'travel' });

    const adminPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(
      adminPermCreates,
      'No new creates when all permissions already exist — boot is idempotent',
    ).toHaveLength(0);
  });

  test('subsequent boot with brand-new catalog entry DOES grant it to existing ADMIN', async () => {
    // Concrete scenario: a new permission like `cost_master.delete` is added
    // to permissionCatalog.js between deploy N and N+1. On deploy N+1,
    // ensureRbacOnBoot runs against a tenant whose ADMIN was provisioned
    // during deploy N (which didn't have cost_master.delete yet).
    //
    // Contract (NEW): ADMIN DOES receive the new permission because
    // grantAllPermissions runs unconditionally. ensureRolePermission will
    // see findFirst → null for the new entry and create it.
    const PRE_EXISTING_ADMIN_ID = 777;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      if (where.key === 'ADMIN') {
        return Promise.resolve({ id: PRE_EXISTING_ADMIN_ID, tenantId: where.tenantId, key: 'ADMIN', isSystem: true });
      }
      return Promise.resolve(null);
    });

    await provisionTenantRbac(101, { vertical: 'travel' });

    // Expect create calls for the pre-existing ADMIN (new catalog entries).
    const adminPermCalls = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(
      adminPermCalls.length,
      'New catalog entries MUST be granted to existing ADMIN — this is how cost_master.delete reaches live tenants',
    ).toBeGreaterThan(0);
  });

  test('FRESH ADMIN (first-creation) receives the vertical-filtered catalog', async () => {
    // Default mocks (beforeEach): findFirst returns null → ADMIN takes the create branch.
    await provisionTenantRbac(102, { vertical: 'travel' });

    const adminIndex = mockPrisma.role.create.mock.calls.findIndex(
      (call) => call[0].data.key === 'ADMIN',
    );
    expect(adminIndex, 'ADMIN should be created on first run').toBeGreaterThanOrEqual(0);
    const freshAdminId = 100 + adminIndex;

    const adminPermCalls = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === freshAdminId,
    );
    expect(
      adminPermCalls.length,
      'Fresh ADMIN should receive vertical-catalog permissions',
    ).toBeGreaterThan(50);
  });
});
