/**
 * Regression tests for backend/scripts/ensureRbacOnBoot.js  pins the
 * vertical-aware role provisioning contract.
 *
 * Critical guarantee: wellness clinical roles (DOCTOR, NURSE,
 * RECEPTIONIST, TELECALLER) must NEVER be auto-created on a travel
 * or generic tenant. The seeder gates these on
 * `if (vertical === 'wellness')`  without this test, a refactor
 * could silently drop the gate and start polluting non-wellness
 * tenants with empty clinical-role rows (the exact bug the user
 * found on tenant id=11 / Travel Stall).
 *
 * What we mock:
 *   - prisma  all role / rolePermission / userRole / tenant / user
 *     ops are mocked. The test never touches a real DB.
 *
 * What we assert:
 *   - vertical = 'travel'    only ADMIN, MANAGER, USER, CUSTOMER created
 *   - vertical = 'generic'   same
 *   - vertical = 'wellness'  ADMIN + MANAGER + USER + CUSTOMER +
 *                             DOCTOR + NURSE + RECEPTIONIST + TELECALLER
 *
 * Why it's a regression test, not an integration test:
 *   - The bug we're guarding against is structural (gate accidentally
 *     removed). A mock-prisma unit test is enough  we just need to
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
  // roleWidget might be absent (RoleWidget table optional)  the seeder
  // wraps in try/catch so an error here doesn't crash; return a stub.
  mockPrisma.roleWidget.create.mockResolvedValue({});
});

function createdRoleKeys() {
  return mockPrisma.role.create.mock.calls.map((call) => call[0].data.key);
}

describe('provisionTenantRbac - vertical-aware role provisioning', () => {
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
    // should fail closed  no wellness leakage, just the four baseline
    // roles + the COMMON catalog perms for ADMIN.
    await provisionTenantRbac(3, { vertical: 'made-up-vertical' });

    const keys = createdRoleKeys();
    for (const cliniKey of WELLNESS_CLINICAL_KEYS) {
      expect(keys).not.toContain(cliniKey);
    }
  });

  test('null vertical (no opts) defaults to generic and skips wellness clinical roles', async () => {
    // Caller doesn't pass opts  provisioner falls back to looking up
    // tenant.vertical in the DB. Mock returns null vertical  treated as
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

  test('fresh wellness caller roles receive both appointment call modes', async () => {
    await provisionTenantRbac(9, { vertical: 'wellness' });

    const createdRoles = new Map(
      mockPrisma.role.create.mock.calls.map((call, index) => [call[0].data.key, 100 + index]),
    );

    for (const roleKey of ['ADMIN', 'MANAGER', 'RECEPTIONIST', 'TELECALLER']) {
      const roleId = createdRoles.get(roleKey);
      const grants = mockPrisma.rolePermission.create.mock.calls
        .filter((call) => call[0].data.roleId === roleId)
        .map((call) => `${call[0].data.module}.${call[0].data.action}`);

      expect(grants, `${roleKey} should receive AI calling`).toContain('appointments.ai_call');
      expect(grants, `${roleKey} should receive manual calling`).toContain('appointments.manual_call');
    }
  });

  test('fresh generic and travel roles do not receive wellness call modes', async () => {
    for (const [tenantId, vertical] of [[10, 'generic'], [11, 'travel']]) {
      vi.clearAllMocks();
      let idSeq = 100;
      mockPrisma.role.findFirst.mockResolvedValue(null);
      mockPrisma.rolePermission.findFirst.mockResolvedValue(null);
      mockPrisma.userRole.findUnique.mockResolvedValue(null);
      mockPrisma.userRole.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.role.create.mockImplementation(({ data }) => Promise.resolve({ id: idSeq++, ...data }));
      mockPrisma.rolePermission.create.mockResolvedValue({});
      mockPrisma.userRole.create.mockResolvedValue({});
      mockPrisma.roleWidget.create.mockResolvedValue({});

      await provisionTenantRbac(tenantId, { vertical });

      const grants = mockPrisma.rolePermission.create.mock.calls
        .map((call) => `${call[0].data.module}.${call[0].data.action}`);
      expect(grants).not.toContain('appointments.ai_call');
      expect(grants).not.toContain('appointments.manual_call');
    }
  });

  test('legacy opts.isWellness === true behaves like vertical = wellness', async () => {
    // Back-compat: the older auth.js signup path passes `{ isWellness }`.
    // provisionTenantRbac maps true  'wellness'. The clinical roles
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
  // (the role-aware widget dashboard)  preserves the existing wellness
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

describe('ADMIN permission backfill', () => {
  // Generic and travel ADMIN are full-access system roles. Existing roles are
  // additively synchronized so newly-catalogued modules appear after deploy;
  // wellness keeps the seed-on-creation contract so clinic-specific role
  // customization remains untouched.

  test('existing travel ADMIN receives the current travel catalog', async () => {
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

    const adminPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    const grants = adminPermCreates.map(
      (call) => `${call[0].data.module}.${call[0].data.action}`,
    );
    expect(grants).toContain('diagnostics.read');
    expect(grants).toContain('itineraries.read');
    expect(grants).toContain('itinerary_templates.read');
    expect(grants).toContain('passport.manage');
    expect(grants).not.toContain('patients.read');
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
      'No new creates when all permissions already exist - boot is idempotent',
    ).toHaveLength(0);
  });

  test('existing wellness ADMIN remains seed-on-creation only', async () => {
    // Wellness roles remain customizable across restarts. This also proves the
    // travel repair does not broaden the boot sync to every vertical.
    const PRE_EXISTING_ADMIN_ID = 777;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      if (where.key === 'ADMIN') {
        return Promise.resolve({ id: PRE_EXISTING_ADMIN_ID, tenantId: where.tenantId, key: 'ADMIN', isSystem: true });
      }
      return Promise.resolve(null);
    });

    await provisionTenantRbac(101, { vertical: 'wellness' });

    // No permission grants should be issued for the existing ADMIN.
    const adminPermCalls = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(
      adminPermCalls,
      'Existing wellness ADMIN should not receive permission grants on boot',
    ).toHaveLength(0);
  });

  test('FRESH ADMIN (first-creation) receives the vertical-filtered catalog', async () => {
    // Default mocks (beforeEach): findFirst returns null  ADMIN takes the create branch.
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

// 
// MANAGER permission persistence  same seed-on-creation-only contract
// 

describe('MANAGER permission backfill - seed-on-creation only', () => {
  function managerIdFromCalls() {
    const call = mockPrisma.role.create.mock.calls.find(
      (c) => c[0].data.key === 'MANAGER',
    );
    return call ? 100 + mockPrisma.role.create.mock.calls.indexOf(call) : null;
  }

  test('fresh MANAGER receives vertical-filtered preset on first creation', async () => {
    await provisionTenantRbac(200, { vertical: 'travel' });

    const managerId = managerIdFromCalls();
    expect(managerId, 'MANAGER should be created on first run').not.toBeNull();

    const managerPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === managerId,
    );
    expect(managerPermCreates.length).toBeGreaterThan(0);
  });

  test('fresh generic MANAGER receives generic page grants without delete access', async () => {
    await provisionTenantRbac(202, { vertical: 'generic' });

    const managerId = managerIdFromCalls();
    const grants = mockPrisma.rolePermission.create.mock.calls
      .filter((call) => call[0].data.roleId === managerId)
      .map((call) => `${call[0].data.module}.${call[0].data.action}`);

    expect(grants).toContain('cpq.read');
    expect(grants).toContain('web_forms.write');
    expect(grants).toContain('calendar.update');
    expect(grants).toContain('forecasting.read');
    expect(grants).toContain('quotas.read');
    expect(grants).toContain('sequences.read');
    expect(grants).toContain('settings.read');
    expect(grants).not.toContain('cpq.delete');
    expect(grants).not.toContain('patients.read');
    expect(grants).not.toContain('itineraries.read');
  });

  test('generic manager additions do not leak through shared module names', async () => {
    await provisionTenantRbac(203, { vertical: 'wellness' });

    const managerId = managerIdFromCalls();
    const grants = mockPrisma.rolePermission.create.mock.calls
      .filter((call) => call[0].data.roleId === managerId)
      .map((call) => `${call[0].data.module}.${call[0].data.action}`);

    expect(grants).not.toContain('calendar.update');
    expect(grants).not.toContain('forecasting.read');
    expect(grants).not.toContain('sequences.read');
    expect(grants).not.toContain('settings.read');
  });

  test('existing MANAGER does NOT receive grants on subsequent boot', async () => {
    const PRE_EXISTING_MANAGER_ID = 555;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      if (where.key === 'MANAGER') {
        return Promise.resolve({
          id: PRE_EXISTING_MANAGER_ID,
          tenantId: where.tenantId,
          key: 'MANAGER',
          name: 'Manager',
          isSystem: false,
          userType: 'STAFF',
        });
      }
      return Promise.resolve(null);
    });

    await provisionTenantRbac(201, { vertical: 'travel' });

    const createdKeys = createdRoleKeys();
    expect(createdKeys).not.toContain('MANAGER');

    const managerPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_MANAGER_ID,
    );
    expect(
      managerPermCreates,
      'Existing MANAGER should NOT receive permission grants on subsequent boot',
    ).toHaveLength(0);
  });
});
