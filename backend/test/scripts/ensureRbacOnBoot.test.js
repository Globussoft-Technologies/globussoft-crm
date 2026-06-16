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

const WELLNESS_CLINICAL_KEYS = ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'TELECALLER'];

// Mock prisma. Each prisma collection is a fresh vi.fn so each test
// gets independent call tracking.
//
// All find-* return null/empty so ensureRole / ensureRolePermission /
// ensureUserRole are forced into the "create" branch — that's the
// branch we want to observe.
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

vi.mock('../../lib/prisma', () => ({ default: mockPrisma, ...mockPrisma }));

// Re-import after the mock is in place. Using dynamic import so the
// vi.mock above is honored.
let provisionTenantRbac;

beforeEach(async () => {
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

  // Now import after mocks are wired
  const mod = await import('../../scripts/ensureRbacOnBoot.js');
  provisionTenantRbac = mod.provisionTenantRbac;
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

describe('"Admin is not magic" — no auto-grant on subsequent boots', () => {
  // PRINCIPLE: per the user-facing contract ("new catalog permissions
  // must NOT automatically grant to existing Admin"), the seeder's
  // `if (adminCreated)` gate is load-bearing. On a subsequent boot
  // where the ADMIN role row already exists in the DB:
  //   - ensureRole returns `wasCreated: false`
  //   - grantAllPermissions is NEVER called
  //   - no rolePermission rows are written for ADMIN
  //
  // The bug we guard against: a refactor that drops the gate (calling
  // grantAllPermissions unconditionally on every boot) would silently
  // re-grant every catalog permission to ADMIN on every server restart
  // — including permissions an operator explicitly REVOKED via the
  // Roles & Permissions UI. This would (a) destroy operator
  // customization on every deploy, and (b) auto-grant newly-added
  // catalog entries to existing Admins, violating "Admin is not
  // magic."
  //
  // Strategy: mock prisma.role.findFirst to return a pre-existing
  // ADMIN row. Run provisionTenantRbac. Assert NO rolePermission.create
  // calls happen for ADMIN (id 999 in the mock setup below).

  test('existing ADMIN role does NOT receive grants on subsequent boot', async () => {
    // Override find-* defaults: simulate ADMIN already exists.
    // First call returns the pre-existing ADMIN row; subsequent calls
    // (MANAGER, USER, CUSTOMER + wellness roles) return null so they
    // take the create branch. This mirrors a real boot where ADMIN
    // was provisioned in a prior run but other roles may or may not
    // exist yet.
    const PRE_EXISTING_ADMIN_ID = 999;
    let findCallCount = 0;
    mockPrisma.role.findFirst.mockImplementation(({ where }) => {
      findCallCount++;
      if (where.key === 'ADMIN') {
        return Promise.resolve({
          id: PRE_EXISTING_ADMIN_ID,
          tenantId: where.tenantId,
          key: 'ADMIN',
          name: 'Admin',
          isSystem: true,
        });
      }
      // All other roles: null → take the create branch
      return Promise.resolve(null);
    });

    await provisionTenantRbac(100, { vertical: 'travel' });

    // ADMIN role itself was NOT created (find-first returned existing row).
    const createdKeys = createdRoleKeys();
    expect(
      createdKeys,
      'ADMIN must NOT be re-created when it already exists',
    ).not.toContain('ADMIN');

    // CRITICAL: zero rolePermission.create calls for the pre-existing
    // ADMIN's roleId. Without the if(adminCreated) gate, the seeder
    // would call grantAllPermissions(adminRole.id) which iterates
    // every catalog entry — that would produce ~150+ rolePermission.create
    // calls all with roleId=999.
    const adminPermCreates = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(
      adminPermCreates,
      'No new permissions should auto-grant to pre-existing ADMIN',
    ).toHaveLength(0);
  });

  test('subsequent boot with brand-new catalog entry does NOT grant it to existing ADMIN', async () => {
    // Concrete scenario: imagine a new permission `customer_portal.read`
    // is added to permissionCatalog.js between deploy N and N+1.
    // On deploy N+1, ensureRbacOnBoot runs against a tenant whose
    // ADMIN was provisioned during deploy N.
    //
    // Contract: ADMIN does NOT receive `customer_portal.read` from
    // the boot loop. The tenant admin must explicitly grant it via
    // the Roles & Permissions UI.
    //
    // We don't need to literally add a catalog entry mid-test —
    // the boot loop's behaviour is generic: when ADMIN already
    // exists, grantAllPermissions is skipped entirely. So if it
    // skips ALL grants, it skips a hypothetical new one too.

    const PRE_EXISTING_ADMIN_ID = 777;
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

    await provisionTenantRbac(101, { vertical: 'travel' });

    // No rolePermission.create call should target the pre-existing
    // ADMIN — regardless of which module.action we'd query for.
    const adminPermCalls = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === PRE_EXISTING_ADMIN_ID,
    );
    expect(adminPermCalls).toHaveLength(0);
  });

  test('FRESH ADMIN (first-creation) STILL receives the vertical-filtered catalog', async () => {
    // Counterpart: confirm the gate's "yes" branch still fires.
    // First-creation ADMIN should receive grantAllPermissions(adminRole.id,
    // vertical), which iterates the vertical-filtered catalog and
    // produces rolePermission.create calls for every module.action.
    //
    // Without this counterpart test, an over-eager refactor could
    // accidentally ALWAYS skip grantAllPermissions (breaking new
    // tenants) and the previous tests would still pass.

    // Default mocks (set by beforeEach): findFirst returns null → ADMIN
    // takes the create branch.
    await provisionTenantRbac(102, { vertical: 'travel' });

    // Locate the role.create call for ADMIN. The mock's id sequence
    // starts at 100 (set in beforeEach) and increments per role.create
    // call. ADMIN is the first role the seeder creates, so its id is
    // 100 + adminIndex (which should be 0). Compute explicitly rather
    // than hardcoding so the test stays correct if the seeder ever
    // reorders role creation.
    const adminIndex = mockPrisma.role.create.mock.calls.findIndex(
      (call) => call[0].data.key === 'ADMIN',
    );
    expect(adminIndex, 'ADMIN should be created on first run').toBeGreaterThanOrEqual(0);
    const freshAdminId = 100 + adminIndex;

    // rolePermission.create should fire many times for this freshAdminId
    // (one per catalog module.action). If zero, the "yes" branch is
    // broken.
    const adminPermCalls = mockPrisma.rolePermission.create.mock.calls.filter(
      (call) => call[0].data.roleId === freshAdminId,
    );
    expect(
      adminPermCalls.length,
      'Fresh ADMIN should receive vertical-catalog permissions',
    ).toBeGreaterThan(50);
  });
});
