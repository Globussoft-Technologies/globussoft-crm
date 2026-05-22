/**
 * Unit tests for backend/lib/roleResolution.js — resolvePrimaryRole.
 *
 * Mocks the prisma singleton via monkey-patch (same pattern as
 * eventBus.test.js and slaBreachEngine.test.js). The SUT's `require`
 * path resolves to the same prisma singleton vitest's inline config
 * shares with this test file.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { resolvePrimaryRole } from '../../lib/roleResolution.js';

beforeEach(() => {
  prisma.userRole = prisma.userRole || {};
  prisma.role = prisma.role || {};
  prisma.userRole.findFirst = vi.fn();
  prisma.role.findFirst = vi.fn();
});

describe('resolvePrimaryRole', () => {
  test('returns null when user is null', async () => {
    expect(await resolvePrimaryRole(null)).toBeNull();
  });

  test('returns null when user lacks an id', async () => {
    expect(await resolvePrimaryRole({ role: 'ADMIN', tenantId: 1 })).toBeNull();
  });

  test('returns the role from a UserRole join row when one exists', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce({
      id: 99,
      userId: 7,
      role: {
        id: 42,
        key: 'TELECALLER',
        name: 'Telecaller',
        landingPath: '/wellness/telecaller',
      },
    });

    const result = await resolvePrimaryRole({
      id: 7,
      role: 'USER',
      tenantId: 1,
    });

    expect(result).toEqual({
      id: 42,
      key: 'TELECALLER',
      name: 'Telecaller',
      landingPath: '/wellness/telecaller',
    });
    expect(prisma.userRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7 },
        orderBy: { assignedAt: 'desc' },
      }),
    );
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
  });

  test('treats UserRole.role.landingPath empty/null as null on output', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce({
      id: 1,
      userId: 7,
      role: { id: 5, key: 'USER', name: 'User', landingPath: null },
    });

    const result = await resolvePrimaryRole({
      id: 7,
      role: 'USER',
      tenantId: 1,
    });

    expect(result).toEqual({
      id: 5,
      key: 'USER',
      name: 'User',
      landingPath: null,
    });
  });

  test('falls back to legacy User.role string lookup when no UserRole row', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce(null);
    prisma.role.findFirst.mockResolvedValueOnce({
      id: 17,
      key: 'ADMIN',
      name: 'Admin',
      landingPath: '/dashboard',
    });

    const result = await resolvePrimaryRole({
      id: 7,
      role: 'ADMIN',
      tenantId: 1,
    });

    expect(result).toEqual({
      id: 17,
      key: 'ADMIN',
      name: 'Admin',
      landingPath: '/dashboard',
    });
    expect(prisma.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, key: 'ADMIN' },
      }),
    );
  });

  test('returns null when no UserRole row and legacy role string doesnt match', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce(null);
    prisma.role.findFirst.mockResolvedValueOnce(null);

    const result = await resolvePrimaryRole({
      id: 7,
      role: 'SOMETHING_UNKNOWN',
      tenantId: 1,
    });

    expect(result).toBeNull();
  });

  test('returns null when no UserRole row and user has no legacy role or no tenant', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce(null);

    expect(
      await resolvePrimaryRole({ id: 7, role: null, tenantId: 1 }),
    ).toBeNull();
    expect(
      await resolvePrimaryRole({ id: 7, role: 'ADMIN', tenantId: null }),
    ).toBeNull();
  });

  test('swallows prisma errors and returns null (login must not break on stale schema)', async () => {
    // Most likely real-world cause: landingPath column missing because
    // `prisma db push` hasn't been run after pulling the landingPath
    // schema change. The helper should NOT propagate that error to the
    // /auth/login route handler — auth would 500 and the user couldn't
    // log in. Instead, return null and let the frontend fall back to
    // vertical-default routing.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.userRole.findFirst.mockRejectedValueOnce(
      new Error("Unknown column 'Role.landingPath' in 'field list'"),
    );

    const result = await resolvePrimaryRole({
      id: 7,
      role: 'ADMIN',
      tenantId: 1,
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to resolve primary role'),
    );
    warnSpy.mockRestore();
  });
});
