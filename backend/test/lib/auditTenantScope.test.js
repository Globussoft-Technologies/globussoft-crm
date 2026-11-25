import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import auditTenantScope from '../../lib/auditTenantScope.js';

const {
  resolveAuditTenantScope,
  auditTenantWhere,
  loadTenantAuditActors,
  attachTenantAuditActors,
} = auditTenantScope;

beforeAll(() => {
  prisma.tenant = { findUnique: vi.fn() };
  prisma.user = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  prisma.user.findMany.mockReset();
});

describe('audit tenant scope', () => {
  test('resolves only a valid tenant vertical', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'travel' });
    await expect(resolveAuditTenantScope(7)).resolves.toEqual({ tenantId: 7, vertical: 'travel' });
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { vertical: true },
    });
  });

  test('fails closed for invalid tenant ids, missing tenants, and unsupported verticals', async () => {
    await expect(resolveAuditTenantScope(0)).resolves.toBeNull();
    prisma.tenant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ vertical: 'other' });
    await expect(resolveAuditTenantScope(8)).resolves.toBeNull();
    await expect(resolveAuditTenantScope(9)).resolves.toBeNull();
  });

  test('adds both tenant id and vertical to every audit query scope', () => {
    expect(auditTenantWhere({ tenantId: 4, vertical: 'wellness' }, { action: 'CREATE' })).toEqual({
      action: 'CREATE',
      tenantId: 4,
      tenant: { is: { vertical: 'wellness' } },
    });
  });

  test('loads actors only from the current tenant and vertical', async () => {
    const scope = { tenantId: 4, vertical: 'travel' };
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 21, name: 'Travel Admin', email: 'travel@example.test', tenantId: 4, tenant: { vertical: 'travel' } },
      { id: 22, name: 'Foreign Staff', email: 'wellness@example.test', tenantId: 5, tenant: { vertical: 'wellness' } },
    ]);

    const actors = await loadTenantAuditActors([21, 22, 21, null], scope);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [21, 22] },
        tenantId: 4,
        tenant: { is: { vertical: 'travel' } },
      },
      select: {
        id: true,
        name: true,
        email: true,
        tenantId: true,
        tenant: { select: { vertical: true } },
      },
    });
    expect([...actors.values()]).toEqual([
      { id: 21, name: 'Travel Admin', email: 'travel@example.test' },
    ]);
  });

  test('redacts any actor that does not match the resolved tenant scope', () => {
    const rows = [
      { id: 1, userId: 21 },
      { id: 2, userId: 22 },
      { id: 3, userId: null },
    ];
    const actors = new Map([[21, { id: 21, name: 'Travel Admin', email: 'travel@example.test' }]]);
    expect(attachTenantAuditActors(rows, actors)).toEqual([
      { id: 1, userId: 21, user: { id: 21, name: 'Travel Admin', email: 'travel@example.test' } },
      { id: 2, userId: null, user: null },
      { id: 3, userId: null, user: null },
    ]);
  });
});
