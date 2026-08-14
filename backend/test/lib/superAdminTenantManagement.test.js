// Unit tests for backend/lib/superAdminTenantManagement.js — Super Admin
// tenant/subscription management + combined revenue analytics.
//
// Covers the CRM-platform subscription (SubscriptionPlan/Subscription) side,
// which had zero Super Admin tooling before this file. AI credit management
// itself is NOT re-tested here (owned by lib/aiProviderManagement.js); this
// suite mocks aiProviderManagement.getTenantAiState as an external dependency.
//
// Mocking strategy mirrors test/lib/aiGateway.test.js: no vi.mock, direct
// require('node:module')._cache[...] injection for the CJS-required sibling
// libs (aiProviderManagement, audit), plus direct field monkey-patching on
// the imported prisma singleton.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { mockGetTenantAiState, mockWriteAudit } = vi.hoisted(() => ({
  mockGetTenantAiState: vi.fn(),
  mockWriteAudit: vi.fn().mockResolvedValue(undefined),
}));

const aiProviderManagementPath = requireCJS.resolve('../../lib/aiProviderManagement');
require('node:module')._cache[aiProviderManagementPath] = {
  id: aiProviderManagementPath, filename: aiProviderManagementPath, loaded: true,
  exports: { getTenantAiState: mockGetTenantAiState },
  children: [], paths: [],
};

const auditPath = requireCJS.resolve('../../lib/audit');
require('node:module')._cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: { writeAudit: mockWriteAudit },
  children: [], paths: [],
};

const {
  getSuperAdminTenantsOverview,
  getSuperAdminTenantDetail,
  superAdminGrantSubscription,
  superAdminCancelPlatformSubscription,
  getSuperAdminRevenueSummary,
} = requireCJS('../../lib/superAdminTenantManagement.js');

const DEFAULT_AI_STATE = {
  resolverAccess: 'none',
  byokConfigured: false,
  byok: null,
  creditWallet: { balanceTokens: 0, totalPurchasedTokens: 0, totalUsedTokens: 0, percentRemaining: 0, percentUsed: 0 },
  activeSubscription: null,
};

beforeEach(() => {
  prisma.tenant = { findMany: vi.fn(), findUnique: vi.fn() };
  prisma.user = { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() };
  prisma.subscription = { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  prisma.subscriptionPlan = { findUnique: vi.fn(), findMany: vi.fn() };
  prisma.aiCreditOrder = { findMany: vi.fn() };
  prisma.notification = { createMany: vi.fn().mockResolvedValue({ count: 0 }) };

  mockGetTenantAiState.mockReset();
  mockGetTenantAiState.mockResolvedValue({ ...DEFAULT_AI_STATE });
  mockWriteAudit.mockReset();
  mockWriteAudit.mockResolvedValue(undefined);
});

function tenantRow(overrides = {}) {
  return {
    id: 1, name: 'Acme Travel', slug: 'acme', ownerEmail: 'owner@acme.com',
    isActive: true, createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function subRow(overrides = {}) {
  return {
    id: 1, tenantId: 1, userId: 7, planId: 1, planName: 'Pro', status: 'ACTIVE',
    amount: 999, currency: 'INR', billingIntervalDays: 30,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-02-01'), renewalDate: new Date('2026-02-01'),
    razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1',
    features: null, createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

// ─── getSuperAdminTenantsOverview ──────────────────────────────────────────

describe('getSuperAdminTenantsOverview', () => {
  test('lists tenants with platform subscription + AI snapshot + lifetime revenue', async () => {
    prisma.tenant.findMany.mockResolvedValue([tenantRow()]);
    prisma.subscription.findMany.mockResolvedValue([{ tenantId: 1, amount: 999 }]); // paid revenue rollup
    prisma.subscription.findFirst.mockResolvedValue(subRow());
    prisma.aiCreditOrder.findMany.mockResolvedValue([{ tenantId: 1, amount: 500 }]);
    mockGetTenantAiState.mockResolvedValue({
      ...DEFAULT_AI_STATE,
      resolverAccess: 'crm-managed',
      creditWallet: { balanceTokens: 100, totalPurchasedTokens: 1000, totalUsedTokens: 900, percentRemaining: 10, percentUsed: 90 },
    });

    const result = await getSuperAdminTenantsOverview({});

    expect(result.tenants).toHaveLength(1);
    const row = result.tenants[0];
    expect(row.tenantId).toBe(1);
    expect(row.platformSubscription.planName).toBe('Pro');
    expect(row.platformSubscription.isManualGrant).toBe(false);
    expect(row.aiAccess.resolverAccess).toBe('crm-managed');
    expect(row.aiAccess.balanceTokens).toBe(100);
    expect(row.lifetimeRevenue).toBe(1499); // 999 (platform) + 500 (AI)
    expect(result.summary.totalTenants).toBe(1);
    expect(result.summary.activePlatformSubs).toBe(1);
    expect(result.summary.activeAiSubs).toBe(1);
    expect(result.summary.totalLifetimeRevenue).toBe(1499);
  });

  test('a manually-granted subscription (no razorpayPaymentId) is flagged and excluded from revenue', async () => {
    prisma.tenant.findMany.mockResolvedValue([tenantRow()]);
    // revenue rollup query filters razorpayPaymentId:{not:null} — a manual
    // grant would never be returned by that query in the first place.
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.subscription.findFirst.mockResolvedValue(subRow({ razorpayOrderId: null, razorpayPaymentId: null }));
    prisma.aiCreditOrder.findMany.mockResolvedValue([]);

    const result = await getSuperAdminTenantsOverview({});

    expect(result.tenants[0].platformSubscription.isManualGrant).toBe(true);
    expect(result.tenants[0].lifetimeRevenue).toBe(0);
  });

  test('search filters by organization name, slug, owner email, or tenant id', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      tenantRow({ id: 1, name: 'Acme Travel', slug: 'acme', ownerEmail: 'owner@acme.com' }),
      tenantRow({ id: 2, name: 'Globex Wellness', slug: 'globex', ownerEmail: 'owner@globex.com' }),
    ]);
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.aiCreditOrder.findMany.mockResolvedValue([]);

    const result = await getSuperAdminTenantsOverview({ search: 'globex' });

    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].organization).toBe('Globex Wellness');
  });

  test('tenant with no platform subscription returns platformSubscription: null', async () => {
    prisma.tenant.findMany.mockResolvedValue([tenantRow()]);
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.aiCreditOrder.findMany.mockResolvedValue([]);

    const result = await getSuperAdminTenantsOverview({});

    expect(result.tenants[0].platformSubscription).toBeNull();
  });
});

// ─── getSuperAdminTenantDetail ──────────────────────────────────────────────

describe('getSuperAdminTenantDetail', () => {
  test('throws TENANT_NOT_FOUND for a missing tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(getSuperAdminTenantDetail(999)).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });

  test('happy path: aggregates users, subscription history, AI orders, and revenue totals (paid rows only)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(tenantRow());
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Jane', email: 'jane@acme.com', role: 'ADMIN', userType: 'OWNER', subscriptionStatus: 'ACTIVE', createdAt: new Date() },
    ]);
    prisma.subscription.findMany.mockResolvedValue([
      subRow({ id: 1, amount: 999, razorpayPaymentId: 'pay_1' }),
      subRow({ id: 2, amount: 500, razorpayOrderId: null, razorpayPaymentId: null, status: 'CANCELLED' }), // manual grant, excluded from revenue
    ]);
    prisma.aiCreditOrder.findMany.mockResolvedValue([
      { id: 1, planId: 1, amount: 300, currency: 'INR', creditTokens: 300000, status: 'PAID', createdAt: new Date(), paidAt: new Date() },
      { id: 2, planId: 1, amount: 200, currency: 'INR', creditTokens: 200000, status: 'PENDING', createdAt: new Date(), paidAt: null },
    ]);

    const detail = await getSuperAdminTenantDetail(1);

    expect(detail.tenantId).toBe(1);
    expect(detail.users).toHaveLength(1);
    expect(detail.platformSubscriptions).toHaveLength(2);
    expect(detail.platformSubscriptions[1].isManualGrant).toBe(true);
    expect(detail.aiOrders).toHaveLength(2);
    expect(detail.revenue.platformTotal).toBe(999); // manual grant excluded
    expect(detail.revenue.aiTotal).toBe(300); // pending order excluded
    expect(detail.revenue.combinedTotal).toBe(1299);
  });
});

// ─── superAdminGrantSubscription ────────────────────────────────────────────

describe('superAdminGrantSubscription', () => {
  const plan = { id: 1, name: 'Pro', price: 999, currency: 'INR', billingIntervalDays: 30, features: null };
  const adminUser = { id: 7, tenantId: 1, role: 'ADMIN' };

  test('validation: requires tenantId, planId, and a non-empty reason', async () => {
    await expect(superAdminGrantSubscription({ planId: 1, reason: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(superAdminGrantSubscription({ tenantId: 1, reason: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(superAdminGrantSubscription({ tenantId: 1, planId: 1, reason: '   ' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  test('throws PLAN_NOT_FOUND for an unknown plan', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
    await expect(
      superAdminGrantSubscription({ tenantId: 1, planId: 99, reason: 'comp account' }),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  test('throws NO_ADMIN_USER when the tenant has no ADMIN user to attach the subscription to', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      superAdminGrantSubscription({ tenantId: 1, planId: 1, reason: 'comp account' }),
    ).rejects.toMatchObject({ code: 'NO_ADMIN_USER' });
  });

  test('happy path: cancels prior ACTIVE subscription, creates new one, updates user, audits, notifies', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
    prisma.user.findFirst.mockResolvedValue(adminUser);
    const previousActive = subRow({ id: 5, status: 'ACTIVE' });
    prisma.subscription.findFirst.mockResolvedValue(previousActive);
    prisma.subscription.update.mockResolvedValue({ ...previousActive, status: 'CANCELLED' });
    const created = subRow({ id: 10, razorpayOrderId: null, razorpayPaymentId: null });
    prisma.subscription.create.mockResolvedValue(created);
    prisma.user.update.mockResolvedValue({ ...adminUser, subscriptionStatus: 'ACTIVE' });
    prisma.user.findMany.mockResolvedValue([{ id: 7 }]); // notifyTenantAdmins lookup

    const result = await superAdminGrantSubscription({
      tenantId: 1, planId: 1, superAdminUsername: 'ops_alice', reason: 'Comp account per sales agreement',
    });

    expect(result).toEqual(created);
    // Prior ACTIVE subscription superseded, not queued.
    expect(prisma.subscription.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { status: 'CANCELLED' } });
    // New row created with no Razorpay identifiers (manual grant marker).
    const createArg = prisma.subscription.create.mock.calls[0][0].data;
    expect(createArg.razorpayOrderId).toBeNull();
    expect(createArg.razorpayPaymentId).toBeNull();
    expect(createArg.userId).toBe(7);
    expect(createArg.amount).toBe(999);
    expect(createArg.status).toBe('ACTIVE');
    // User activated + trial cleared, mirroring verify-payment's behavior.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { subscriptionStatus: 'ACTIVE', trialEndsAt: null },
    });
    // Audited with reason + performer + linkage to the superseded subscription.
    expect(mockWriteAudit).toHaveBeenCalledWith(
      'Subscription', 'SUPER_ADMIN_GRANT', 10, null, 1,
      expect.objectContaining({ reason: 'Comp account per sales agreement', performedBySuperAdmin: 'ops_alice', planId: 1, previousSubscriptionId: 5 }),
    );
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('honors customAmount and customDurationDays overrides', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
    prisma.user.findFirst.mockResolvedValue(adminUser);
    prisma.subscription.findFirst.mockResolvedValue(null); // no prior active
    prisma.subscription.create.mockResolvedValue(subRow({ id: 11 }));
    prisma.user.update.mockResolvedValue({});
    prisma.user.findMany.mockResolvedValue([]);

    await superAdminGrantSubscription({
      tenantId: 1, planId: 1, reason: 'Custom comp deal', customAmount: 0, customDurationDays: 45,
    });

    const createArg = prisma.subscription.create.mock.calls[0][0].data;
    expect(createArg.amount).toBe(0);
    expect(createArg.billingIntervalDays).toBe(45);
    // endDate is ~45 days after startDate.
    const days = (createArg.endDate.getTime() - createArg.startDate.getTime()) / 86400000;
    expect(Math.round(days)).toBe(45);
  });

  test('when there is no prior ACTIVE subscription, nothing is cancelled', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
    prisma.user.findFirst.mockResolvedValue(adminUser);
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.subscription.create.mockResolvedValue(subRow({ id: 12 }));
    prisma.user.update.mockResolvedValue({});
    prisma.user.findMany.mockResolvedValue([]);

    await superAdminGrantSubscription({ tenantId: 1, planId: 1, reason: 'First-time comp' });

    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledWith(
      'Subscription', 'SUPER_ADMIN_GRANT', 12, null, 1,
      expect.objectContaining({ previousSubscriptionId: null }),
    );
  });
});

// ─── superAdminCancelPlatformSubscription ──────────────────────────────────

describe('superAdminCancelPlatformSubscription', () => {
  test('requires a non-empty reason', async () => {
    await expect(
      superAdminCancelPlatformSubscription({ tenantId: 1, reason: '' }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  test('throws NO_ACTIVE_SUBSCRIPTION when nothing is active', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(
      superAdminCancelPlatformSubscription({ tenantId: 1, reason: 'Fraud hold' }),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_SUBSCRIPTION' });
  });

  test('happy path: cancels, audits, notifies, and marks users CANCELLED when no coverage remains', async () => {
    const active = subRow({ id: 20, status: 'ACTIVE' });
    prisma.subscription.findFirst
      .mockResolvedValueOnce(active) // lookup the active row
      .mockResolvedValueOnce(null); // remainingCoverage check — none left
    prisma.subscription.update.mockResolvedValue({ ...active, status: 'CANCELLED' });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValue([{ id: 7 }]);

    const result = await superAdminCancelPlatformSubscription({
      tenantId: 1, superAdminUsername: 'ops_bob', reason: 'Duplicate account cleanup',
    });

    expect(result.status).toBe('CANCELLED');
    expect(mockWriteAudit).toHaveBeenCalledWith(
      'Subscription', 'SUPER_ADMIN_CANCEL', 20, null, 1,
      expect.objectContaining({ reason: 'Duplicate account cleanup', performedBySuperAdmin: 'ops_bob' }),
    );
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, subscriptionStatus: 'ACTIVE' }, data: { subscriptionStatus: 'CANCELLED' },
    });
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
  });

  test('does NOT touch User.subscriptionStatus when other coverage remains (e.g. a queued SCHEDULED row)', async () => {
    const active = subRow({ id: 21, status: 'ACTIVE' });
    const scheduled = subRow({ id: 22, status: 'SCHEDULED' });
    prisma.subscription.findFirst
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(scheduled); // remaining coverage found
    prisma.subscription.update.mockResolvedValue({ ...active, status: 'CANCELLED' });
    prisma.user.findMany.mockResolvedValue([]);

    await superAdminCancelPlatformSubscription({ tenantId: 1, reason: 'Downgrade' });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

// ─── getSuperAdminRevenueSummary ────────────────────────────────────────────

describe('getSuperAdminRevenueSummary', () => {
  test('sums platform + AI revenue, computes MRR from ACTIVE subs only, builds monthly trend/plan mix/top tenants', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([
        { tenantId: 1, amount: 999, createdAt: new Date('2026-01-15'), tenant: { name: 'Acme' } },
        { tenantId: 2, amount: 499, createdAt: new Date('2026-02-10'), tenant: { name: 'Globex' } },
      ]) // paidSubs
      .mockResolvedValueOnce([
        { amount: 999, billingIntervalDays: 30, planName: 'Pro' },
        { amount: 4990, billingIntervalDays: 365, planName: 'Enterprise' },
      ]); // activeSubs
    prisma.aiCreditOrder.findMany.mockResolvedValue([
      { tenantId: 1, amount: 300, paidAt: new Date('2026-01-20'), tenant: { name: 'Acme' } },
    ]);

    const summary = await getSuperAdminRevenueSummary({});

    expect(summary.totals.platformRevenue).toBe(1498);
    expect(summary.totals.aiRevenue).toBe(300);
    expect(summary.totals.combinedRevenue).toBe(1798);
    // MRR: 999 (30-day plan, no normalization needed) + 4990*(30/365) ≈ 410.27
    expect(summary.totals.currentPlatformMRR).toBeCloseTo(999 + (4990 * 30) / 365, 2);

    expect(summary.monthlyTrend).toEqual([
      { month: '2026-01', platformRevenue: 999, aiRevenue: 300, totalRevenue: 1299 },
      { month: '2026-02', platformRevenue: 499, aiRevenue: 0, totalRevenue: 499 },
    ]);

    expect(summary.planMix).toEqual(
      expect.arrayContaining([{ planName: 'Pro', count: 1 }, { planName: 'Enterprise', count: 1 }]),
    );

    expect(summary.topTenants[0]).toEqual({ tenantId: 1, tenantName: 'Acme', revenue: 1299 });
    expect(summary.topTenants[1]).toEqual({ tenantId: 2, tenantName: 'Globex', revenue: 499 });
  });

  test('manually-granted subscriptions (razorpayPaymentId null) never reach this function\'s revenue sums — query-level exclusion', async () => {
    // The revenue query itself filters razorpayPaymentId:{not:null}, so a
    // manual grant is never in the paidSubs result set to begin with.
    prisma.subscription.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.aiCreditOrder.findMany.mockResolvedValue([]);

    const summary = await getSuperAdminRevenueSummary({});

    expect(summary.totals.platformRevenue).toBe(0);
    expect(summary.totals.combinedRevenue).toBe(0);
    const subCallArg = prisma.subscription.findMany.mock.calls[0][0];
    expect(subCallArg.where.razorpayPaymentId).toEqual({ not: null });
    const aiCallArg = prisma.aiCreditOrder.findMany.mock.calls[0][0];
    expect(aiCallArg.where.status).toBe('PAID');
  });

  test('applies from/to date filters to both platform and AI revenue queries', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.aiCreditOrder.findMany.mockResolvedValue([]);

    await getSuperAdminRevenueSummary({ from: '2026-01-01', to: '2026-01-31' });

    const subCallArg = prisma.subscription.findMany.mock.calls[0][0];
    expect(subCallArg.where.createdAt.gte).toBeInstanceOf(Date);
    expect(subCallArg.where.createdAt.lte).toBeInstanceOf(Date);
    const aiCallArg = prisma.aiCreditOrder.findMany.mock.calls[0][0];
    expect(aiCallArg.where.paidAt.gte).toBeInstanceOf(Date);
    expect(aiCallArg.where.paidAt.lte).toBeInstanceOf(Date);
  });
});
