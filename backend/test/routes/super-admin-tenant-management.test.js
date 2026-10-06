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

const {
  mockGetSuperAdminTenantsOverview,
  mockGetSuperAdminTenantDetail,
  mockSuperAdminGrantSubscription,
  mockSuperAdminCancelPlatformSubscription,
  mockGetSuperAdminRevenueSummary,
  mockProvisionTenantRbac,
} = vi.hoisted(() => ({
  mockGetSuperAdminTenantsOverview: vi.fn(),
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
prisma.tenant.findFirst = vi.fn();
prisma.tenant.findUnique = vi.fn();
prisma.tenant.create = vi.fn();
prisma.tenant.delete = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.user.create = vi.fn();
prisma.role.findFirst = vi.fn();
prisma.userRole.upsert = vi.fn();
prisma.$transaction = vi.fn();
prisma.webForm.findFirst = vi.fn();
prisma.tenantSetting.findFirst = vi.fn();
prisma.tenantSetting.findUnique = vi.fn();
prisma.tenantSetting.updateMany = vi.fn();
prisma.tenantSetting.upsert = vi.fn();

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
  mockGetSuperAdminTenantDetail.mockReset();
  mockSuperAdminGrantSubscription.mockReset();
  mockSuperAdminCancelPlatformSubscription.mockReset();
  mockGetSuperAdminRevenueSummary.mockReset();
  mockProvisionTenantRbac.mockReset().mockResolvedValue({});
  prisma.subscriptionPlan.findMany.mockReset();
  prisma.tenant.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.create.mockReset();
  prisma.tenant.delete.mockReset().mockResolvedValue({ id: 42 });
  prisma.user.findFirst.mockReset();
  prisma.user.create.mockReset();
  prisma.role.findFirst.mockReset();
  prisma.userRole.upsert.mockReset();
  prisma.$transaction.mockReset().mockImplementation((callback) => callback(prisma));
  prisma.webForm.findFirst.mockReset();
  prisma.tenantSetting.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({ id: 1 });
});

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
