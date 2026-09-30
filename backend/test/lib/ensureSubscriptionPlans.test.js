import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');

prisma.subscriptionPlan = prisma.subscriptionPlan || {};
prisma.subscriptionPlan.findFirst = vi.fn();
prisma.subscriptionPlan.findMany = vi.fn();
prisma.subscriptionPlan.update = vi.fn();
prisma.subscriptionPlan.updateMany = vi.fn();
prisma.subscriptionPlan.create = vi.fn();

const ensureSubscriptionPlans = requireCJS('../../lib/ensureSubscriptionPlans');

describe('ensureSubscriptionPlans', () => {
  beforeEach(() => {
    prisma.subscriptionPlan.findFirst.mockReset();
    prisma.subscriptionPlan.findMany.mockReset();
    prisma.subscriptionPlan.update.mockReset();
    prisma.subscriptionPlan.updateMany.mockReset();
    prisma.subscriptionPlan.create.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.subscriptionPlan.findFirst
      .mockResolvedValueOnce({ id: 1, name: 'Starter', planKey: 'starter', billingIntervalDays: 30 })
      .mockResolvedValueOnce({ id: 2, name: 'Professional', planKey: 'pro', billingIntervalDays: 30 })
      .mockResolvedValueOnce({ id: 3, name: 'Enterprise', planKey: 'ent', billingIntervalDays: 30 });
    prisma.subscriptionPlan.findMany.mockResolvedValue([
      { id: 1, name: 'Starter', planKey: 'starter', billingIntervalDays: 30 },
      { id: 2, name: 'Professional', planKey: 'pro', billingIntervalDays: 30 },
      { id: 3, name: 'Enterprise', planKey: 'ent', billingIntervalDays: 30 },
      { id: 11, name: 'Starter~m2', planKey: null, billingIntervalDays: 30 },
      { id: 12, name: 'Professional~m2', planKey: null, billingIntervalDays: 30 },
      { id: 13, name: 'Enterprise~m2', planKey: null, billingIntervalDays: 30 },
    ]);
    prisma.subscriptionPlan.updateMany.mockResolvedValue({ count: 3 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('soft-deactivates suffixed duplicate rows without deleting historical plans', async () => {
    await expect(ensureSubscriptionPlans()).resolves.toMatchObject({
      created: 0,
      backfilled: 0,
      deactivated: 3,
    });

    expect(prisma.subscriptionPlan.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionPlan.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12, 13] }, isActive: true },
      data: { isActive: false },
    });
  });

  test('fails open when the cleanup query is unavailable', async () => {
    prisma.subscriptionPlan.findMany.mockRejectedValue(new Error('database unavailable'));

    await expect(ensureSubscriptionPlans()).resolves.toMatchObject({
      created: 0,
      backfilled: 0,
      deactivated: 0,
    });
    expect(console.error).toHaveBeenCalledWith(
      '[ensureSubscriptionPlans] duplicate cleanup failed:',
      'database unavailable',
    );
  });
});
