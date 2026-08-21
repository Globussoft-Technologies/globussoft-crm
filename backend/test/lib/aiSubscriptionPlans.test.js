import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import singletonPrisma from '../../lib/prisma.js';
import aiSubscriptionPlans from '../../lib/aiSubscriptionPlans.js';

beforeAll(() => {
  singletonPrisma.aiSubscriptionPlan = {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  };
  singletonPrisma.aiSubscriptionPlanKey = {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  };
  singletonPrisma.aiManagedApiKey = {
    findMany: vi.fn(),
  };
  singletonPrisma.aiTenantSubscription = {
    findMany: vi.fn(),
  };
  singletonPrisma.aiCreditOrder = {
    findMany: vi.fn(),
  };
  singletonPrisma.aiCreditWallet = {
    findMany: vi.fn(),
  };
  singletonPrisma.user = {
    findMany: vi.fn(),
  };
  singletonPrisma.llmCallLog = {
    findMany: vi.fn(),
  };
  singletonPrisma.aiCreditTransaction = {
    findMany: vi.fn(),
  };
  singletonPrisma.$transaction = vi.fn();
});

beforeEach(() => {
  singletonPrisma.aiSubscriptionPlan.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiSubscriptionPlan.findUnique.mockReset().mockResolvedValue(null);
  singletonPrisma.aiSubscriptionPlan.create.mockReset().mockImplementation((args) =>
    Promise.resolve({ id: 1, ...args.data, planKeys: [], createdAt: new Date(), updatedAt: new Date() }),
  );
  singletonPrisma.aiSubscriptionPlan.update.mockReset().mockImplementation((args) =>
    Promise.resolve({ id: args.where.id, ...args.data, createdAt: new Date(), updatedAt: new Date() }),
  );
  singletonPrisma.aiSubscriptionPlanKey.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  singletonPrisma.aiSubscriptionPlanKey.createMany.mockReset().mockResolvedValue({ count: 0 });
  singletonPrisma.aiManagedApiKey.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiTenantSubscription.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiCreditOrder.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiCreditWallet.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.user.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.aiCreditTransaction.findMany.mockReset().mockResolvedValue([]);
  singletonPrisma.$transaction.mockReset().mockImplementation((fn) => fn(singletonPrisma));
});

function validPlan(overrides = {}) {
  return {
    name: 'Starter',
    price: 499,
    creditTokens: 100000,
    currency: 'INR',
    billingCycle: 'monthly',
    ...overrides,
  };
}

describe('aiSubscriptionPlans', () => {
  test('createPlan rejects disabled or unknown managed API keys', async () => {
    singletonPrisma.aiManagedApiKey.findMany.mockResolvedValueOnce([
      { id: 1, isEnabled: true },
      { id: 2, isEnabled: false },
    ]);

    await expect(
      aiSubscriptionPlans.createPlan(validPlan({ apiKeys: [{ keyId: 1 }, { keyId: 2 }, { keyId: 99 }] })),
    ).rejects.toMatchObject({
      code: 'INVALID_PLAN_INPUT',
      message: 'apiKeys include disabled or unknown key id(s): 2, 99',
    });
    expect(singletonPrisma.aiSubscriptionPlan.create).not.toHaveBeenCalled();
  });

  test('createPlan dedupes keys before creating plan-key rows', async () => {
    singletonPrisma.aiManagedApiKey.findMany.mockResolvedValueOnce([{ id: 7, isEnabled: true }]);
    singletonPrisma.aiSubscriptionPlan.create.mockImplementationOnce((args) =>
      Promise.resolve({ id: 11, ...args.data, planKeys: [], createdAt: new Date(), updatedAt: new Date() }),
    );

    await aiSubscriptionPlans.createPlan(validPlan({ apiKeys: [{ keyId: 7 }, { keyId: 7 }] }));

    expect(singletonPrisma.aiSubscriptionPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          planKeys: { create: [{ keyId: 7, isEnabled: true }] },
        }),
      }),
    );
  });

  test('updatePlan validates replacement API keys inside the transaction', async () => {
    singletonPrisma.aiManagedApiKey.findMany.mockResolvedValueOnce([{ id: 3, isEnabled: false }]);

    await expect(aiSubscriptionPlans.updatePlan(5, { apiKeys: [{ keyId: 3 }] })).rejects.toHaveProperty(
      'code',
      'INVALID_PLAN_INPUT',
    );
    expect(singletonPrisma.aiSubscriptionPlan.update).not.toHaveBeenCalled();
    expect(singletonPrisma.aiSubscriptionPlanKey.deleteMany).not.toHaveBeenCalled();
  });

  test('getPlanSubscriberAnalytics returns purchaser emails and tenant usage for a plan', async () => {
    const paidAt = new Date('2026-08-01T10:00:00Z');
    singletonPrisma.aiSubscriptionPlan.findUnique.mockResolvedValueOnce({
      id: 4,
      name: 'Silver',
      description: null,
      price: 10,
      currency: 'INR',
      billingCycle: 'monthly',
      creditTokens: 5000000,
      fairUsagePolicy: null,
      featureRestrictions: null,
      validityDays: 1,
      isActive: true,
      displayOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    singletonPrisma.aiTenantSubscription.findMany.mockResolvedValueOnce([
      {
        id: 9,
        tenantId: 2,
        planId: 4,
        status: 'ACTIVE',
        startDate: paidAt,
        endDate: null,
        tenant: { id: 2, name: 'Acme Clinic', slug: 'acme', ownerEmail: 'owner@acme.test', isActive: true },
      },
    ]);
    singletonPrisma.aiCreditOrder.findMany.mockResolvedValueOnce([
      { id: 12, tenantId: 2, purchasedByUserId: 22, amount: 10, currency: 'INR', creditTokens: 5000000, paidAt, createdAt: paidAt },
    ]);
    singletonPrisma.aiCreditWallet.findMany.mockResolvedValueOnce([
      { id: 1, tenantId: 2, balanceTokens: 4000000, totalPurchasedTokens: 5000000, totalUsedTokens: 1000000 },
    ]);
    singletonPrisma.user.findMany.mockResolvedValueOnce([
      { id: 22, tenantId: 2, email: 'buyer@acme.test', name: 'Buyer' },
    ]);
    singletonPrisma.llmCallLog.findMany.mockResolvedValueOnce([
      { tenantId: 2, provider: 'openai', model: 'gpt-4o-mini', task: 'lead-scoring', status: 'success', promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimate: 0.001, stub: false, createdAt: new Date('2026-08-02T10:00:00Z') },
      { tenantId: 2, provider: 'openai', model: 'gpt-4o-mini', task: 'lead-scoring', status: 'success', promptTokens: 1, completionTokens: 1, totalTokens: 2, costEstimate: 0, stub: true, createdAt: new Date('2026-08-02T10:05:00Z') },
    ]);
    singletonPrisma.aiCreditTransaction.findMany.mockResolvedValueOnce([
      { tenantId: 2, type: 'USAGE', tokens: -150 },
      { tenantId: 2, type: 'PURCHASE', tokens: 5000000 },
    ]);

    const out = await aiSubscriptionPlans.getPlanSubscriberAnalytics(4);

    expect(out.totals.subscribers).toBe(1);
    expect(out.totals.calls).toBe(1);
    expect(out.subscribers[0].clientEmails).toEqual(['owner@acme.test', 'buyer@acme.test']);
    expect(out.subscribers[0].credits.percentRemaining).toBe(80);
    expect(out.subscribers[0].usage.tokens).toBe(150);
    expect(out.subscribers[0].ledger.usageTokens).toBe(150);
  });
});
