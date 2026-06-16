/**
 * Tests for backend/lib/rolePermissionVersions.js.
 *
 * Pins:
 *   • canonicalisePermissions deduplicates + sorts deterministically
 *   • snapshotRolePermissions increments versionNumber per role
 *   • ensureInitialSnapshot is idempotent
 *   • hydratePermissions tolerates corrupt JSON without throwing
 *
 * Mocks prisma surfaces.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.rolePermissionVersion = {
  findFirst: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
};
prisma.rolePermission = prisma.rolePermission || { findMany: vi.fn() };
prisma.rolePermission.findMany = vi.fn();

import {
  canonicalisePermissions,
  ensureInitialSnapshot,
  snapshotRolePermissions,
  listRolePermissionVersions,
  getRolePermissionVersion,
} from '../../lib/rolePermissionVersions.js';

beforeEach(() => {
  prisma.rolePermissionVersion.findFirst.mockReset();
  prisma.rolePermissionVersion.create.mockReset();
  prisma.rolePermissionVersion.findMany.mockReset();
  prisma.rolePermissionVersion.findUnique.mockReset();
  prisma.rolePermission.findMany.mockReset();
});

describe('canonicalisePermissions', () => {
  it('sorts by module, then action', () => {
    const out = canonicalisePermissions([
      { module: 'roles', action: 'manage' },
      { module: 'contacts', action: 'write' },
      { module: 'contacts', action: 'read' },
    ]);
    expect(out).toEqual([
      { module: 'contacts', action: 'read' },
      { module: 'contacts', action: 'write' },
      { module: 'roles', action: 'manage' },
    ]);
  });

  it('deduplicates module.action pairs', () => {
    const out = canonicalisePermissions([
      { module: 'contacts', action: 'read' },
      { module: 'contacts', action: 'read' },
    ]);
    expect(out.length).toBe(1);
  });

  it('drops malformed entries', () => {
    const out = canonicalisePermissions([
      { module: 'contacts', action: 'read' },
      null,
      undefined,
      {},
      { module: 'contacts' },
      { action: 'read' },
    ]);
    expect(out.length).toBe(1);
  });

  it('returns [] for non-array input', () => {
    expect(canonicalisePermissions(null)).toEqual([]);
    expect(canonicalisePermissions(undefined)).toEqual([]);
    expect(canonicalisePermissions('contacts.read')).toEqual([]);
  });
});

describe('snapshotRolePermissions', () => {
  it('writes versionNumber = (max + 1) for the role', async () => {
    prisma.rolePermissionVersion.findFirst.mockResolvedValueOnce({ versionNumber: 7 });
    prisma.rolePermissionVersion.create.mockResolvedValueOnce({ id: 42, versionNumber: 8 });

    const row = await snapshotRolePermissions({
      roleId: 100,
      permissions: [{ module: 'contacts', action: 'read' }],
      changedById: 1,
    });
    expect(row).toEqual({ id: 42, versionNumber: 8 });

    const createArgs = prisma.rolePermissionVersion.create.mock.calls[0][0];
    expect(createArgs.data.roleId).toBe(100);
    expect(createArgs.data.versionNumber).toBe(8);
    expect(createArgs.data.changeType).toBe('UPDATE');
    expect(createArgs.data.permissionCount).toBe(1);
    expect(JSON.parse(createArgs.data.permissionsJson)).toEqual([
      { module: 'contacts', action: 'read' },
    ]);
  });

  it('starts at version 1 when no prior versions exist', async () => {
    prisma.rolePermissionVersion.findFirst.mockResolvedValueOnce(null);
    prisma.rolePermissionVersion.create.mockResolvedValueOnce({ id: 1, versionNumber: 1 });

    const row = await snapshotRolePermissions({
      roleId: 100,
      permissions: [{ module: 'contacts', action: 'read' }],
    });
    expect(row.versionNumber).toBe(1);
  });

  it('passes changeType=RESTORE and restoredFromVersionId through', async () => {
    prisma.rolePermissionVersion.findFirst.mockResolvedValueOnce({ versionNumber: 5 });
    prisma.rolePermissionVersion.create.mockResolvedValueOnce({ id: 99, versionNumber: 6 });

    await snapshotRolePermissions({
      roleId: 100,
      permissions: [],
      changeType: 'RESTORE',
      restoredFromVersionId: 42,
      note: 'Manual restore',
    });
    const args = prisma.rolePermissionVersion.create.mock.calls[0][0];
    expect(args.data.changeType).toBe('RESTORE');
    expect(args.data.restoredFromVersionId).toBe(42);
    expect(args.data.note).toBe('Manual restore');
  });

  it('truncates note to 500 chars', async () => {
    prisma.rolePermissionVersion.findFirst.mockResolvedValueOnce(null);
    prisma.rolePermissionVersion.create.mockResolvedValueOnce({ id: 1, versionNumber: 1 });

    await snapshotRolePermissions({
      roleId: 100,
      permissions: [],
      note: 'x'.repeat(600),
    });
    const args = prisma.rolePermissionVersion.create.mock.calls[0][0];
    expect(args.data.note.length).toBe(500);
  });
});

describe('ensureInitialSnapshot', () => {
  it('writes an INITIAL row when no version exists', async () => {
    prisma.rolePermissionVersion.findFirst
      // ensureInitialSnapshot existence check
      .mockResolvedValueOnce(null)
      // snapshotRolePermissions max-version lookup
      .mockResolvedValueOnce(null);
    prisma.rolePermission.findMany.mockResolvedValueOnce([
      { module: 'contacts', action: 'read' },
    ]);
    prisma.rolePermissionVersion.create.mockResolvedValueOnce({ id: 1, versionNumber: 1 });

    const r = await ensureInitialSnapshot({ roleId: 100 });
    expect(r).toEqual({ id: 1, versionNumber: 1 });
    const args = prisma.rolePermissionVersion.create.mock.calls[0][0];
    expect(args.data.changeType).toBe('INITIAL');
    expect(args.data.note).toMatch(/pre-history/i);
  });

  it('is idempotent — returns null if a version already exists', async () => {
    prisma.rolePermissionVersion.findFirst.mockResolvedValueOnce({ id: 1 });
    const r = await ensureInitialSnapshot({ roleId: 100 });
    expect(r).toBeNull();
    expect(prisma.rolePermissionVersion.create).not.toHaveBeenCalled();
  });
});

describe('listRolePermissionVersions', () => {
  it('hydrates the permissions array from the JSON column', async () => {
    prisma.rolePermissionVersion.findMany.mockResolvedValueOnce([
      {
        id: 2,
        roleId: 100,
        versionNumber: 2,
        permissionCount: 2,
        changeType: 'UPDATE',
        restoredFromVersionId: null,
        changedAt: new Date(),
        note: null,
        changedBy: { id: 7, name: 'Yasin', email: 'y@x' },
        permissionsJson: JSON.stringify([
          { module: 'contacts', action: 'read' },
          { module: 'roles', action: 'manage' },
        ]),
      },
    ]);
    const out = await listRolePermissionVersions({ roleId: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].permissions).toEqual([
      { module: 'contacts', action: 'read' },
      { module: 'roles', action: 'manage' },
    ]);
    expect(out[0].changedBy.name).toBe('Yasin');
  });

  it('returns [] when permissionsJson is corrupt', async () => {
    prisma.rolePermissionVersion.findMany.mockResolvedValueOnce([
      {
        id: 1,
        roleId: 100,
        versionNumber: 1,
        permissionCount: 0,
        changeType: 'INITIAL',
        restoredFromVersionId: null,
        changedAt: new Date(),
        note: null,
        changedBy: null,
        permissionsJson: 'not-json',
      },
    ]);
    const out = await listRolePermissionVersions({ roleId: 100 });
    expect(out[0].permissions).toEqual([]);
  });
});

describe('getRolePermissionVersion', () => {
  it('returns null when roleId does not match', async () => {
    prisma.rolePermissionVersion.findUnique.mockResolvedValueOnce({
      id: 1,
      roleId: 999,
      versionNumber: 1,
      permissionsJson: '[]',
      changeType: 'INITIAL',
      restoredFromVersionId: null,
      changedAt: new Date(),
      note: null,
      changedBy: null,
      permissionCount: 0,
    });
    const r = await getRolePermissionVersion({ versionId: 1, roleId: 100 });
    expect(r).toBeNull();
  });

  it('returns the hydrated row when roleId matches', async () => {
    prisma.rolePermissionVersion.findUnique.mockResolvedValueOnce({
      id: 1,
      roleId: 100,
      versionNumber: 1,
      permissionsJson: JSON.stringify([{ module: 'roles', action: 'manage' }]),
      changeType: 'INITIAL',
      restoredFromVersionId: null,
      changedAt: new Date(),
      note: 'Initial',
      changedBy: null,
      permissionCount: 1,
    });
    const r = await getRolePermissionVersion({ versionId: 1, roleId: 100 });
    expect(r).not.toBeNull();
    expect(r.permissions).toEqual([{ module: 'roles', action: 'manage' }]);
  });
});
