// Unit tests for backend/routes/super_admin_tenant_management.js — thin
// HTTP layer over lib/superAdminTenantManagement.js.
//
// requireSuperAdmin is applied at the server.js mount point, NOT inside this
// router file (confirmed in middleware/superAdminAuth.js + server.js), so
// this test mounts the router directly behind a fake middleware that injects
// req.superAdmin = { username }, mirroring how other route test files in
// this repo inject req.user ahead of a router-under-test.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { Prisma } = requireCJS('@prisma/client');

const {
  mockGetSuperAdminTenantsOverview,
  mockGetSuperAdminRoleLimitsOverview,
  mockSetSuperAdminCustomRoleLimit,
  mockGetSuperAdminTenantDetail,
  mockSuperAdminGrantSubscription,
  mockSuperAdminCancelPlatformSubscription,
  mockGetSuperAdminRevenueSummary,
  mockProvisionTenantRbac,
} = vi.hoisted(() => ({
  mockGetSuperAdminTenantsOverview: vi.fn(),
  mockGetSuperAdminRoleLimitsOverview: vi.fn(),
  mockSetSuperAdminCustomRoleLimit: vi.fn(),
  mockGetSuperAdminTenantDetail: vi.fn(),
  mockSuperAdminGrantSubscription: vi.fn(),
  mockSuperAdminCancelPlatformSubscription: vi.fn(),
  mockGetSuperAdminRevenueSummary: vi.fn(),
  mockProvisionTenantRbac: vi.fn(),
}));

const libPath = requireCJS.resolve('../../lib/superAdminTenantManagement');
require('node:module')._cache[libPath] = {
  id: libPath, filename: libPath, loaded: true,
  exports: {
    getSuperAdminTenantsOverview: mockGetSuperAdminTenantsOverview,
    getSuperAdminRoleLimitsOverview: mockGetSuperAdminRoleLimitsOverview,
    setSuperAdminCustomRoleLimit: mockSetSuperAdminCustomRoleLimit,
    getSuperAdminTenantDetail: mockGetSuperAdminTenantDetail,
    superAdminGrantSubscription: mockSuperAdminGrantSubscription,
    superAdminCancelPlatformSubscription: mockSuperAdminCancelPlatformSubscription,
    getSuperAdminRevenueSummary: mockGetSuperAdminRevenueSummary,
  },
  children: [], paths: [],
};

const rbacPath = requireCJS.resolve('../../scripts/ensureRbacOnBoot');
require('node:module')._cache[rbacPath] = {
  id: rbacPath, filename: rbacPath, loaded: true,
  exports: { provisionTenantRbac: mockProvisionTenantRbac },
  children: [], paths: [],
};

import prisma from '../../lib/prisma.js';
prisma.subscriptionPlan = { findMany: vi.fn() };
prisma.tenant = prisma.tenant || {};
prisma.user = prisma.user || {};
prisma.role = prisma.role || {};
prisma.userRole = prisma.userRole || {};
prisma.webForm = prisma.webForm || {};
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.superAdminAuditLog = prisma.superAdminAuditLog || {};
prisma.tenant.findFirst = vi.fn();
prisma.tenant.findUnique = vi.fn();
prisma.tenant.findMany = vi.fn();
prisma.tenant.count = vi.fn();
prisma.tenant.create = vi.fn();
prisma.tenant.delete = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.user.create = vi.fn();
prisma.role.findFirst = vi.fn();
prisma.role.count = vi.fn();
prisma.userRole.upsert = vi.fn();
prisma.$transaction = vi.fn();
prisma.webForm.findFirst = vi.fn();
prisma.tenantSetting.findFirst = vi.fn();
prisma.tenantSetting.findUnique = vi.fn();
prisma.tenantSetting.updateMany = vi.fn();
prisma.tenantSetting.upsert = vi.fn();
prisma.superAdminAuditLog.create = vi.fn();
prisma.superAdminAuditLog.update = vi.fn();
prisma.superAdminAuditLog.findMany = vi.fn();
prisma.superAdminAuditLog.count = vi.fn();

import express from 'express';
import request from 'supertest';
const tenantManagementRouter = requireCJS('../../routes/super_admin_tenant_management');

function makeApp({ username = 'ops_alice' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.superAdmin = { username };
    next();
  });
  app.use('/api/super-admin/tenant-management', tenantManagementRouter);
  return app;
}

beforeEach(() => {
  mockGetSuperAdminTenantsOverview.mockReset();
  mockGetSuperAdminRoleLimitsOverview.mockReset();
  mockSetSuperAdminCustomRoleLimit.mockReset();
  mockGetSuperAdminTenantDetail.mockReset();
  mockSuperAdminGrantSubscription.mockReset();
  mockSuperAdminCancelPlatformSubscription.mockReset();
  mockGetSuperAdminRevenueSummary.mockReset();
  mockProvisionTenantRbac.mockReset().mockResolvedValue({});
  prisma.subscriptionPlan.findMany.mockReset();
  prisma.tenant.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.tenant.count.mockReset().mockResolvedValue(0);
  prisma.tenant.create.mockReset();
  prisma.tenant.delete.mockReset().mockResolvedValue({ id: 42 });
  prisma.user.findFirst.mockReset();
  prisma.user.create.mockReset();
  prisma.role.findFirst.mockReset();
  prisma.role.count.mockReset();
  prisma.userRole.upsert.mockReset();
  prisma.$transaction.mockReset().mockImplementation((callback) => callback(prisma));
  prisma.webForm.findFirst.mockReset();
  prisma.tenantSetting.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({ id: 1 });
  prisma.superAdminAuditLog.create.mockReset().mockResolvedValue({ id: 901 });
  prisma.superAdminAuditLog.update.mockReset().mockResolvedValue({ id: 901 });
  prisma.superAdminAuditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.superAdminAuditLog.count.mockReset().mockResolvedValue(0);
});

function makeHardDeleteTransaction({ failDelete = false } = {}) {
  const deleteManyCalls = [];
  const organization = { id: 42, name: 'Acme Hard Delete', slug: 'acme-hard-delete' };
  const txTenant = {
    findUnique: vi.fn().mockResolvedValue(organization),
    delete: failDelete
      ? vi.fn().mockRejectedValue(Object.assign(new Error('foreign key blocked'), { code: 'P2003' }))
      : vi.fn().mockResolvedValue({ id: organization.id }),
  };
  const txAudit = { update: vi.fn().mockResolvedValue({ id: 901 }) };
  const tx = new Proxy({ tenant: txTenant, superAdminAuditLog: txAudit }, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property !== 'string') return undefined;
      return {
        deleteMany: vi.fn(async ({ where }) => {
          deleteManyCalls.push({ model: property, where });
          return { count: property === 'contact' ? 2 : 0 };
        }),
      };
    },
  });
  return { tx, txTenant, txAudit, deleteManyCalls, organization };
}

describe('POST /organizations', () => {
  test('rejects an invalid email address before creating anything', async () => {
    const res = await request(makeApp()).post('/api/super-admin/tenant-management/organizations').send({
      organizationName: 'New Org', name: 'Owner', email: 'owner@', password: 'secure123',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMAIL_REQUIRED');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  test('creates a verified organization without an OTP token', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.tenant.findFirst.mockResolvedValue(null);
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValue({ id: 42, name: 'Acme', slug: 'acme', ownerEmail: 'owner@example.com', plan: 'TRIAL', vertical: 'generic' });
    prisma.user.create.mockResolvedValue({ id: 77, email: 'owner@example.com', name: 'Owner', role: 'ADMIN' });
    prisma.role.findFirst.mockResolvedValue({ id: 9 });
    prisma.userRole.upsert.mockResolvedValue({ id: 10 });

    const res = await request(makeApp()).post('/api/super-admin/tenant-management/organizations').send({
      organizationName: 'Acme', name: 'Owner', email: 'OWNER@example.com', password: 'secure123', vertical: 'generic',
    });

    expect(res.status).toBe(201);
    expect(res.body.organization.name).toBe('Acme');
    expect(prisma.tenant.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailVerifiedAt: expect.any(Date) }) }));
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'owner@example.com', emailVerifiedAt: expect.any(Date) }) }));
    expect(mockProvisionTenantRbac).toHaveBeenCalledWith(42, { vertical: 'generic' });
    expect(prisma.userRole.upsert).toHaveBeenCalled();
  });

  test('rolls back both records when owner creation fails inside the transaction', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.tenant.findFirst.mockResolvedValue(null);
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValue({ id: 42 });
    prisma.user.create.mockRejectedValue(new Error('owner insert failed'));

    const res = await request(makeApp()).post('/api/super-admin/tenant-management/organizations').send({
      organizationName: 'Atomic Org', name: 'Owner', email: 'atomic@example.com', password: 'secure123',
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('ORGANIZATION_CREATE_FAILED');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(mockProvisionTenantRbac).not.toHaveBeenCalled();
  });

  test('deletes the new tenant and returns failure when RBAC provisioning fails', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.tenant.findFirst.mockResolvedValue(null);
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValue({ id: 42, name: 'Acme', slug: 'acme', ownerEmail: 'owner@example.com', plan: 'TRIAL', vertical: 'generic' });
    prisma.user.create.mockResolvedValue({ id: 77, email: 'owner@example.com', name: 'Owner', role: 'ADMIN' });
    mockProvisionTenantRbac.mockRejectedValue(new Error('permission seed failed'));

    const res = await request(makeApp()).post('/api/super-admin/tenant-management/organizations').send({
      organizationName: 'Acme', name: 'Owner', email: 'owner@example.com', password: 'secure123',
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('RBAC_PROVISIONING_FAILED');
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  test('rejects an owner email already used in the same CRM vertical', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 1 });
    const res = await request(makeApp()).post('/api/super-admin/tenant-management/organizations').send({
      organizationName: 'New Org', name: 'Owner', email: 'owner@example.com', password: 'secure123',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { email: 'owner@example.com', tenant: { vertical: 'generic' } }, select: { id: true } });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });
});

describe('organization search and deletion', () => {
  test('lists organizations with pagination when no search query is supplied', async () => {
    const organizations = [
      { id: 21, name: 'Northwind', slug: 'northwind', ownerEmail: 'owner@northwind.test', vertical: 'generic' },
      { id: 22, name: 'Southwind', slug: 'southwind', ownerEmail: 'owner@southwind.test', vertical: 'travel' },
    ];
    prisma.tenant.count.mockResolvedValue(63);
    prisma.tenant.findMany.mockResolvedValue(organizations);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/organizations/search?limit=10&offset=20');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ organizations, total: 63, limit: 10, offset: 20 });
    expect(prisma.tenant.count).toHaveBeenCalledWith({ where: {} });
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {},
      take: 10,
      skip: 20,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }));
  });

  test('searches by tenant id and returns the exact organization first', async () => {
    const organization = { id: 7, name: 'Seven Seas', slug: 'seven-seas', ownerEmail: 'owner@seven.test', vertical: 'travel' };
    prisma.tenant.findUnique.mockResolvedValue(organization);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/organizations/search?q=7');

    expect(res.status).toBe(200);
    expect(res.body.organizations[0]).toMatchObject({ id: 7, name: 'Seven Seas' });
    expect(res.body.total).toBe(1);
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  test('requires an exact organization name and a reason before writing an audit request', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 42, name: 'Acme Hard Delete', slug: 'acme-hard-delete' });

    const mismatch = await request(makeApp())
      .post('/api/super-admin/tenant-management/organizations/42/hard-delete')
      .send({ confirmationName: 'Acme', reason: 'Requested by owner' });

    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('CONFIRMATION_MISMATCH');

    const missingReason = await request(makeApp())
      .post('/api/super-admin/tenant-management/organizations/42/hard-delete')
      .send({ confirmationName: 'Acme Hard Delete', reason: '  ' });

    expect(missingReason.status).toBe(400);
    expect(missingReason.body.code).toBe('DELETION_REASON_REQUIRED');
    expect(prisma.superAdminAuditLog.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('protects the platform default organization and records the blocked action', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, name: 'Platform Default', slug: 'platform-default' });

    const res = await request(makeApp({ username: 'ops_bob' }))
      .post('/api/super-admin/tenant-management/organizations/1/hard-delete')
      .send({ confirmationName: 'Platform Default', reason: 'Test protection' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_ORGANIZATION');
    expect(prisma.superAdminAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: 'ops_bob', organizationId: 1, status: 'IN_PROGRESS' }),
    }));
    expect(prisma.superAdminAuditLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', completedAt: expect.any(Date) }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('deletes tenant rows in one transaction and commits a durable success audit entry', async () => {
    const { tx, txTenant, txAudit, deleteManyCalls, organization } = makeHardDeleteTransaction();
    prisma.tenant.findUnique.mockResolvedValue(organization);
    prisma.superAdminAuditLog.create.mockResolvedValue({ id: 901 });
    let transactionOptions;
    prisma.$transaction.mockImplementation(async (callback, options) => {
      transactionOptions = options;
      return callback(tx);
    });

    const res = await request(makeApp({ username: 'ops_bob' }))
      .post('/api/super-admin/tenant-management/organizations/42/hard-delete')
      .send({ confirmationName: organization.name, reason: 'Customer requested account closure' });

    const tenantScopedModelCount = Prisma.dmmf.datamodel.models.filter((model) =>
      model.fields.some((field) => field.name === 'tenantId' && field.kind === 'scalar'),
    ).length;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, auditId: 901, organization: organization.name, deletedRowCount: 2 });
    expect(deleteManyCalls).toHaveLength(tenantScopedModelCount);
    expect(deleteManyCalls.every((call) => call.where.tenantId === 42)).toBe(true);
    expect(txTenant.delete).toHaveBeenCalledWith({ where: { id: 42 } });
    expect(txAudit.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 901 },
      data: expect.objectContaining({ status: 'SUCCEEDED', deletedRowCount: 2, completedAt: expect.any(Date) }),
    }));
    expect(transactionOptions).toMatchObject({ maxWait: 10000, timeout: 120000 });
    expect(prisma.superAdminAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: 'ops_bob', organizationId: 42, reason: 'Customer requested account closure' }),
    }));
  });

  test('marks the platform audit entry failed when the deletion transaction aborts', async () => {
    const { tx, deleteManyCalls, organization } = makeHardDeleteTransaction({ failDelete: true });
    prisma.tenant.findUnique.mockResolvedValue(organization);
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const res = await request(makeApp())
      .post('/api/super-admin/tenant-management/organizations/42/hard-delete')
      .send({ confirmationName: organization.name, reason: 'Test blocked transaction' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('ORGANIZATION_DELETE_FAILED');
    expect(deleteManyCalls.length).toBeGreaterThan(0);
    expect(prisma.superAdminAuditLog.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 901 },
      data: expect.objectContaining({ status: 'FAILED', errorMessage: 'foreign key blocked' }),
    }));
  });
});

describe('GET /organization-audit-log', () => {
  test('filters by organization or actor and paginates the platform audit records', async () => {
    prisma.superAdminAuditLog.findMany.mockResolvedValue([{ id: 901, actor: 'ops_alice', status: 'FAILED' }]);
    prisma.superAdminAuditLog.count.mockResolvedValue(1);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/organization-audit-log?q=Acme&status=FAILED&limit=10&offset=20');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 10, offset: 20, entries: [{ id: 901, status: 'FAILED' }] });
    expect(prisma.superAdminAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'FAILED', OR: expect.arrayContaining([{ organizationName: { contains: 'Acme' } }]) }),
      take: 10,
      skip: 20,
    }));
    expect(prisma.superAdminAuditLog.count).toHaveBeenCalledWith({ where: expect.objectContaining({ status: 'FAILED' }) });
  });
});

describe('PUT /landing-form', () => {
  test('uses the non-stripped siteTenantId and persists one synchronized public selection', async () => {
    prisma.tenant.findFirst.mockResolvedValue({ id: 5 });
    prisma.webForm.findFirst.mockResolvedValue({ id: 9, name: 'Public contact' });

    const res = await request(makeApp())
      .put('/api/super-admin/tenant-management/landing-form')
      .send({ tenantId: 999, siteTenantId: 5, webFormId: 9, emails: ' Owner@Example.com ' });

    expect(res.status).toBe(200);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 5, vertical: 'generic', isActive: true },
    }));
    expect(prisma.webForm.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 9, tenantId: 5, scope: 'generic', isActive: true },
    }));
    expect(prisma.tenantSetting.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'landing.public.config' },
    }));
    const publicWrite = prisma.tenantSetting.upsert.mock.calls.at(-1)[0];
    expect(JSON.parse(publicWrite.create.value)).toEqual({
      tenantId: 5, activeWebFormId: 9, emails: ['owner@example.com'],
    });
  });
});

describe('GET /tenants', () => {
  test('passes query params through and returns the overview', async () => {
    mockGetSuperAdminTenantsOverview.mockResolvedValue({ tenants: [], summary: {}, appliedFilters: {} });

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants?search=acme&from=2026-01-01&to=2026-01-31');

    expect(res.status).toBe(200);
    expect(mockGetSuperAdminTenantsOverview).toHaveBeenCalledWith({ search: 'acme', from: '2026-01-01', to: '2026-01-31' });
  });

  test('500 when the lib function throws', async () => {
    mockGetSuperAdminTenantsOverview.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants');
    expect(res.status).toBe(500);
  });
});

describe('Custom role limits', () => {
  test('GET /role-limits passes the search filter and returns the overview', async () => {
    mockGetSuperAdminRoleLimitsOverview.mockResolvedValue({
      tenants: [{ tenantId: 1, organization: 'Acme', customRoleCount: 2, maxCustomRoles: 5 }],
      summary: { totalTenants: 1 },
    });

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/role-limits?search=acme');

    expect(res.status).toBe(200);
    expect(mockGetSuperAdminRoleLimitsOverview).toHaveBeenCalledWith({ search: 'acme' });
    expect(res.body.tenants[0].maxCustomRoles).toBe(5);
  });

  test('PUT /tenants/:tenantId/role-limit passes null for unlimited and the Super Admin identity', async () => {
    mockSetSuperAdminCustomRoleLimit.mockResolvedValue({
      tenantId: 7,
      organization: 'Wellness Demo',
      customRoleCount: 3,
      maxCustomRoles: null,
    });

    const res = await request(makeApp({ username: 'ops_role_admin' }))
      .put('/api/super-admin/tenant-management/tenants/7/role-limit')
      .send({ maxCustomRoles: null });

    expect(res.status).toBe(200);
    expect(mockSetSuperAdminCustomRoleLimit).toHaveBeenCalledWith({
      tenantId: 7,
      maxCustomRoles: null,
      superAdminUsername: 'ops_role_admin',
    });
  });

  test('PUT /tenants/:tenantId/role-limit requires the setting field', async () => {
    const res = await request(makeApp())
      .put('/api/super-admin/tenant-management/tenants/7/role-limit')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CUSTOM_ROLE_LIMIT_REQUIRED');
    expect(mockSetSuperAdminCustomRoleLimit).not.toHaveBeenCalled();
  });

  test('maps invalid limits and missing tenants to their canonical statuses', async () => {
    const invalid = new Error('bad limit');
    invalid.code = 'INVALID_CUSTOM_ROLE_LIMIT';
    mockSetSuperAdminCustomRoleLimit.mockRejectedValueOnce(invalid);
    const invalidRes = await request(makeApp())
      .put('/api/super-admin/tenant-management/tenants/7/role-limit')
      .send({ maxCustomRoles: -1 });
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.code).toBe('INVALID_CUSTOM_ROLE_LIMIT');

    const missing = new Error('missing tenant');
    missing.code = 'TENANT_NOT_FOUND';
    mockSetSuperAdminCustomRoleLimit.mockRejectedValueOnce(missing);
    const missingRes = await request(makeApp())
      .put('/api/super-admin/tenant-management/tenants/999/role-limit')
      .send({ maxCustomRoles: 5 });
    expect(missingRes.status).toBe(404);
    expect(missingRes.body.code).toBe('TENANT_NOT_FOUND');
  });
});

describe('GET /tenants/:tenantId', () => {
  test('400 on a non-numeric tenant id', async () => {
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TENANT_ID');
    expect(mockGetSuperAdminTenantDetail).not.toHaveBeenCalled();
  });

  test('404 when TENANT_NOT_FOUND is thrown', async () => {
    const err = new Error('Tenant not found');
    err.code = 'TENANT_NOT_FOUND';
    mockGetSuperAdminTenantDetail.mockRejectedValue(err);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  test('200 happy path', async () => {
    mockGetSuperAdminTenantDetail.mockResolvedValue({ tenantId: 1, organization: 'Acme' });
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/1');
    expect(res.status).toBe(200);
    expect(mockGetSuperAdminTenantDetail).toHaveBeenCalledWith(1);
  });
});

describe('GET /plans', () => {
  test('returns active plans ordered by displayOrder', async () => {
    prisma.subscriptionPlan.findMany.mockResolvedValue([{ id: 1, name: 'Pro' }]);
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([{ id: 1, name: 'Pro' }]);
    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith({
      where: { isActive: true }, orderBy: { displayOrder: 'asc' },
    });
  });
});

describe('POST /tenants/:tenantId/subscription/grant', () => {
  test('400 on a non-numeric tenant id', async () => {
    const res = await request(makeApp()).post('/api/super-admin/tenant-management/tenants/abc/subscription/grant').send({});
    expect(res.status).toBe(400);
    expect(mockSuperAdminGrantSubscription).not.toHaveBeenCalled();
  });

  test('threads tenantId, body fields, and the super-admin username through to the lib function', async () => {
    mockSuperAdminGrantSubscription.mockResolvedValue({ id: 10, status: 'ACTIVE' });

    const res = await request(makeApp({ username: 'ops_bob' }))
      .post('/api/super-admin/tenant-management/tenants/5/subscription/grant')
      .send({ planId: 2, reason: 'Comp account', customAmount: 0, customDurationDays: 90 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(mockSuperAdminGrantSubscription).toHaveBeenCalledWith({
      tenantId: 5, planId: 2, superAdminUsername: 'ops_bob', reason: 'Comp account', customAmount: 0, customDurationDays: 90,
    });
  });

  test.each([
    ['INVALID_INPUT', 400],
    ['REASON_REQUIRED', 400],
    ['NO_ADMIN_USER', 400],
    ['PLAN_NOT_FOUND', 404],
  ])('%s maps to %i', async (code, expectedStatus) => {
    const err = new Error('failure');
    err.code = code;
    mockSuperAdminGrantSubscription.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/super-admin/tenant-management/tenants/1/subscription/grant')
      .send({ planId: 1, reason: 'x' });

    expect(res.status).toBe(expectedStatus);
    expect(res.body.code).toBe(code);
  });
});

describe('POST /tenants/:tenantId/subscription/cancel', () => {
  test('threads tenantId, reason, and username through', async () => {
    mockSuperAdminCancelPlatformSubscription.mockResolvedValue({ id: 20, status: 'CANCELLED' });

    const res = await request(makeApp({ username: 'ops_carol' }))
      .post('/api/super-admin/tenant-management/tenants/3/subscription/cancel')
      .send({ reason: 'Fraud hold' });

    expect(res.status).toBe(200);
    expect(mockSuperAdminCancelPlatformSubscription).toHaveBeenCalledWith({
      tenantId: 3, superAdminUsername: 'ops_carol', reason: 'Fraud hold',
    });
  });

  test.each([
    ['REASON_REQUIRED', 400],
    ['NO_ACTIVE_SUBSCRIPTION', 400],
  ])('%s maps to %i', async (code, expectedStatus) => {
    const err = new Error('failure');
    err.code = code;
    mockSuperAdminCancelPlatformSubscription.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/super-admin/tenant-management/tenants/1/subscription/cancel')
      .send({ reason: 'x' });

    expect(res.status).toBe(expectedStatus);
    expect(res.body.code).toBe(code);
  });
});

describe('GET /revenue/summary', () => {
  test('passes date filters through and returns the summary', async () => {
    mockGetSuperAdminRevenueSummary.mockResolvedValue({ totals: {}, monthlyTrend: [], planMix: [], topTenants: [] });

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/revenue/summary?from=2026-01-01&to=2026-01-31');

    expect(res.status).toBe(200);
    expect(mockGetSuperAdminRevenueSummary).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-01-31' });
  });

  test('500 when the lib function throws', async () => {
    mockGetSuperAdminRevenueSummary.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/revenue/summary');
    expect(res.status).toBe(500);
  });
});

describe('tenant page visibility', () => {
  beforeEach(() => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 7,
      name: 'Acme Wellness',
      slug: 'acme-wellness',
      vertical: 'wellness',
      isActive: true,
    });
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ hiddenPaths: ['/wellness/patients'] }),
    });
  });

  test('returns only the Wellness sidebar catalog with enabled state', async () => {
    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/7/page-visibility');

    expect(res.status).toBe(200);
    expect(res.body.vertical).toBe('wellness');
    expect(res.body.pages).toHaveLength(77);
    expect(res.body.hiddenPaths).toEqual(['/wellness/patients']);
    expect(res.body.pages.find((page) => page.path === '/wellness/patients').enabled).toBe(false);
    expect(res.body.pages.find((page) => page.path === '/wellness/calendar').enabled).toBe(true);
    expect(res.body.pages.some((page) => page.path === '/pipeline')).toBe(false);
    expect(res.body.pages.some((page) => page.path === '/forecasting')).toBe(false);
  });

  test('shows standalone Workflows in Generic CRM organization page visibility', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 7,
      name: 'Acme Generic',
      slug: 'acme-generic',
      vertical: 'generic',
      isActive: true,
    });
    prisma.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/7/page-visibility');

    expect(res.status).toBe(200);
    expect(res.body.pages.find((page) => page.path === '/workflows')).toMatchObject({
      label: 'Workflows',
      category: 'Work Management',
      requiredPermissions: [{ module: 'workflows', action: 'read' }],
    });
  });

  test('returns only Travel sidebar pages for Travel organization visibility', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 7,
      name: 'Travel Stall',
      slug: 'travel-stall',
      vertical: 'travel',
      isActive: true,
    });
    prisma.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/api/super-admin/tenant-management/tenants/7/page-visibility');

    expect(res.status).toBe(200);
    expect(res.body.pages).toHaveLength(51);
    expect(res.body.pages.find((page) => page.path === '/travel/quotes/builder')).toMatchObject({
      label: 'Quote Builder',
      category: 'Sales',
      requiredPermissions: [{ module: 'quote_builder', action: 'write' }],
      enabled: true,
    });
    expect(res.body.pages.some((page) => page.path === '/pipeline')).toBe(false);
    expect(res.body.pages.some((page) => page.path === '/forecasting')).toBe(false);
  });

  test('stores hidden paths and records the Super Admin username', async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({ id: 99 });
    const res = await request(makeApp({ username: 'ops_bob' }))
      .put('/api/super-admin/tenant-management/tenants/7/page-visibility')
      .send({ hiddenPaths: ['/wellness/patients'] });

    expect(res.status).toBe(200);
    expect(res.body.hiddenPaths).toEqual(['/wellness/patients']);
    expect(prisma.tenantSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_key: { tenantId: 7, key: 'navigation.hiddenPages' } },
      create: expect.objectContaining({
        tenantId: 7,
        category: 'feature-flag',
        value: expect.stringContaining('ops_bob'),
      }),
    }));
  });

  test('rejects a page from another vertical', async () => {
    const res = await request(makeApp())
      .put('/api/super-admin/tenant-management/tenants/7/page-visibility')
      .send({ hiddenPaths: ['/travel/trips'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGE_PATH');
  });
});
