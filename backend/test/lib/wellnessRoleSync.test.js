// Unit tests for backend/lib/wellnessRoleSync.js
//
// Pins the contract that admin-side RBAC role changes propagate to
// User.wellnessRole on wellness tenants. The bug this protects against:
// Sankar Rathod was promoted to DOCTOR via Roles & Permissions, primaryRole
// flipped correctly, but wellnessRole stayed null so he never appeared in
// /api/wellness/doctors/availability (the Book Appointment dropdown).
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup — see wellnessRoleTypes.test.js
// for the same pattern).

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import sync from '../../lib/wellnessRoleSync.js';

const { syncWellnessRoleFromRbacRoles } = sync;

const CATALOG = [
  { key: 'doctor',       sortOrder: 10 },
  { key: 'professional', sortOrder: 20 },
  { key: 'nurse',        sortOrder: 30 },
  { key: 'stylist',      sortOrder: 40 },
  { key: 'telecaller',   sortOrder: 50 },
  { key: 'helper',       sortOrder: 60 },
];

beforeAll(() => {
  prisma.tenant = { findUnique: vi.fn() };
  prisma.user = { findUnique: vi.fn(), update: vi.fn() };
  prisma.userRole = { findMany: vi.fn() };
  prisma.wellnessRoleType = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  };
});

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
  prisma.userRole.findMany.mockReset();
  prisma.wellnessRoleType.findMany.mockReset();
});

function stubTenant(vertical) {
  prisma.tenant.findUnique.mockResolvedValue({ vertical });
}
function stubUser(tenantId, wellnessRole) {
  prisma.user.findUnique.mockResolvedValue({ tenantId, wellnessRole });
}
function stubAssignments(roleKeys, { tenantId = 1 } = {}) {
  prisma.userRole.findMany.mockResolvedValue(
    roleKeys.map((key, i) => ({
      role: { key, tenantId },
      id: i + 1,
    })),
  );
}
function stubCatalog(rows = CATALOG) {
  prisma.wellnessRoleType.findMany.mockResolvedValue(rows);
}

describe('syncWellnessRoleFromRbacRoles', () => {
  test('returns null and skips writes when tenant is not wellness', async () => {
    stubTenant('generic');
    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 1, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('returns null and skips writes when tenant is travel', async () => {
    stubTenant('travel');
    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 1, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('returns null when userId or tenantId is missing', async () => {
    expect(await syncWellnessRoleFromRbacRoles(prisma, { userId: 0, tenantId: 1 })).toBeNull();
    expect(await syncWellnessRoleFromRbacRoles(prisma, { userId: 1, tenantId: 0 })).toBeNull();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  // THE bug fix — the Sankar Rathod scenario.
  test('derives wellnessRole=doctor when RBAC role is DOCTOR and previous was null', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    stubAssignments(['DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBe('doctor');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { wellnessRole: 'doctor' },
    });
  });

  test('derives wellnessRole=nurse for the NURSE RBAC role (case-insensitive)', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    stubAssignments(['NURSE']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBe('nurse');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { wellnessRole: 'nurse' },
    });
  });

  test('no-op when wellnessRole already matches the assigned RBAC role', async () => {
    stubTenant('wellness');
    stubUser(1, 'doctor');
    stubAssignments(['DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBe('doctor');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('clears stale catalog-derived wellnessRole when RBAC no longer matches', async () => {
    // Dr. Sankar got demoted to RECEPTIONIST — wellnessRole=doctor must clear
    // so he stops appearing in the bookable list.
    stubTenant('wellness');
    stubUser(1, 'doctor');
    stubAssignments(['RECEPTIONIST']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { wellnessRole: null },
    });
  });

  test('leaves wellnessRole alone when no assigned RBAC role maps to catalog AND wellnessRole was already null', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    stubAssignments(['RECEPTIONIST']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('onlyIfEmpty=true skips when wellnessRole is already non-null (preserves admin choice in Staff form)', async () => {
    stubTenant('wellness');
    stubUser(1, 'professional'); // admin manually picked Professional
    stubAssignments(['DOCTOR']);  // RBAC role doesn't match, but skip
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, {
      userId: 7,
      tenantId: 1,
      onlyIfEmpty: true,
    });
    expect(out).toBe('professional');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('onlyIfEmpty=true still derives when wellnessRole is null', async () => {
    // The catalog-fetch-raced-the-save scenario in the Staff Edit modal —
    // frontend sent wellnessRole=null, backend falls back to RBAC.
    stubTenant('wellness');
    stubUser(1, null);
    stubAssignments(['DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, {
      userId: 7,
      tenantId: 1,
      onlyIfEmpty: true,
    });
    expect(out).toBe('doctor');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { wellnessRole: 'doctor' },
    });
  });

  test('empty role set + previously catalog-derived wellnessRole clears it', async () => {
    stubTenant('wellness');
    stubUser(1, 'doctor');
    stubAssignments([]);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { wellnessRole: null },
    });
  });

  test('multi-role user picks the lower-sortOrder catalog match deterministically', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    // User holds both NURSE (sortOrder 30) and DOCTOR (sortOrder 10) —
    // doctor wins because catalog ordering goes lowest-first.
    stubAssignments(['NURSE', 'DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBe('doctor');
  });

  test('ignores roles from a different tenant (defensive)', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    // Hypothetical cross-tenant role bleed — should be filtered out.
    stubAssignments(['DOCTOR'], { tenantId: 99 });
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('returns null when the target user does not exist', async () => {
    stubTenant('wellness');
    prisma.user.findUnique.mockResolvedValue(null);
    stubAssignments(['DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 999, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('returns null when the user belongs to a different tenant (cross-tenant guard)', async () => {
    stubTenant('wellness');
    stubUser(42, null); // user.tenantId=42, but caller asked for tenantId=1
    stubAssignments(['DOCTOR']);
    stubCatalog();

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('honours an inactive catalog entry by excluding it from matches', async () => {
    stubTenant('wellness');
    stubUser(1, null);
    stubAssignments(['DOCTOR']);
    // Tenant has disabled "doctor" — catalog query (which filters isActive=true)
    // returns no doctor row, so no match should be found.
    stubCatalog(CATALOG.filter((r) => r.key !== 'doctor'));

    const out = await syncWellnessRoleFromRbacRoles(prisma, { userId: 7, tenantId: 1 });
    expect(out).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
