import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.subscription = prisma.subscription || {};
prisma.subscription.findFirst = vi.fn();

const { resolveSubscriptionAccess } = requireCJS('../../lib/subscriptionAccess');

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.subscription.findFirst.mockReset();
});

describe('resolveSubscriptionAccess', () => {
  test('returns ACTIVE when a current subscription covers the tenant even if the user row is stale', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      subscriptionStatus: 'EXPIRED',
      trialEndsAt: new Date('2026-06-01T00:00:00Z'),
    });
    prisma.subscription.findFirst.mockResolvedValue({
      id: 42,
      status: 'ACTIVE',
      startDate: new Date('2026-07-01T00:00:00Z'),
      endDate: new Date('2026-08-01T00:00:00Z'),
    });

    const user = { userId: 7, tenantId: 1 };
    const state = await resolveSubscriptionAccess(user);

    expect(state.subscriptionStatus).toBe('ACTIVE');
    expect(state.hasActiveCoverage).toBe(true);
    expect(user.subscriptionStatus).toBe('ACTIVE');
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        status: { in: ['ACTIVE', 'SCHEDULED'] },
        startDate: { lte: expect.any(Date) },
        endDate: { gt: expect.any(Date) },
      },
      orderBy: [
        { endDate: 'desc' },
        { startDate: 'desc' },
      ],
    });
  });

  test('returns TRIAL when the trial is still valid and no subscription coverage exists', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      subscriptionStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    const state = await resolveSubscriptionAccess({ userId: 7, tenantId: 1 });

    expect(state.subscriptionStatus).toBe('TRIAL');
    expect(state.hasActiveCoverage).toBe(false);
    expect(state.daysRemaining).toBeGreaterThan(0);
  });

  test('returns EXPIRED when the user row is ACTIVE but no current coverage exists', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      subscriptionStatus: 'ACTIVE',
      trialEndsAt: null,
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    const state = await resolveSubscriptionAccess({ userId: 7, tenantId: 1 });

    expect(state.subscriptionStatus).toBe('EXPIRED');
    expect(state.hasActiveCoverage).toBe(false);
  });
});
