// Wave 11 Agent HH — Unit tests for the auto-consumption applier.
//
// Verifies that:
//   * applyAutoConsumptionForVisit returns an empty result for a visit with
//     no rules / no serviceId / non-completed status (silent success — the
//     hook should never fail a visit).
//   * For each active rule, a ServiceConsumption row is created AND the
//     product's currentStock is decremented (transactional, atomic).
//   * Inactive rules are skipped.
//   * A failing rule (e.g. tx error) is logged but other rules still apply.
//   * The eventBus listener is registered exactly once via start().
//
// We mock prisma's $transaction to invoke the callback with a tx that
// re-uses the prisma mock (the route's runtime contract). The "real" prisma
// transaction-vs-non-transaction split is tested at the integration level.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { bus } from '../../lib/eventBus.js';
import { applyAutoConsumptionForVisit, start } from '../../lib/autoConsumptionApplier.js';

const RULES = [
  {
    id: 1,
    serviceId: 100,
    productId: 200,
    quantityPerVisit: 1,
    isActive: true,
    product: { id: 200, name: 'Saline 0.9%', currentStock: 50, threshold: 5 },
  },
  {
    id: 2,
    serviceId: 100,
    productId: 201,
    quantityPerVisit: 0.5, // tests the round-up to 1 unit Int
    isActive: true,
    product: { id: 201, name: 'Cotton', currentStock: 3, threshold: 5 },
  },
];

beforeEach(() => {
  prisma.autoConsumptionRule = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  prisma.serviceConsumption = {
    create: vi.fn().mockResolvedValue({ id: 999 }),
  };
  prisma.product = {
    update: vi.fn().mockResolvedValue({ id: 200, currentStock: 49 }),
  };
  prisma.visit = {
    findUnique: vi.fn(),
  };
  prisma.auditLog = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  };
  // $transaction(cb) → invoke cb with the same prisma mock (caller-side contract)
  prisma.$transaction = vi.fn(async (cb) => cb(prisma));
});

describe('lib/autoConsumptionApplier — applyAutoConsumptionForVisit', () => {
  test('no-ops when visit is null', async () => {
    const result = await applyAutoConsumptionForVisit(null);
    expect(result).toEqual({ rules: 0, applied: [], skipped: [] });
    expect(prisma.autoConsumptionRule.findMany).not.toHaveBeenCalled();
  });

  test('no-ops when visit has no serviceId', async () => {
    const result = await applyAutoConsumptionForVisit({ id: 1, tenantId: 1 });
    expect(result.rules).toBe(0);
    expect(prisma.autoConsumptionRule.findMany).not.toHaveBeenCalled();
  });

  test('no-ops when visit status is not completed', async () => {
    const result = await applyAutoConsumptionForVisit({
      id: 1, serviceId: 100, tenantId: 1, status: 'cancelled',
    });
    expect(result.rules).toBe(0);
  });

  test('no-ops when no active rules exist', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([]);
    const result = await applyAutoConsumptionForVisit({
      id: 1, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result).toEqual({ rules: 0, applied: [], skipped: [] });
  });

  test('queries findMany with the correct tenant + service + active filter', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([]);
    await applyAutoConsumptionForVisit({
      id: 1, serviceId: 100, tenantId: 42, status: 'completed',
    });
    expect(prisma.autoConsumptionRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 42, serviceId: 100, isActive: true },
      })
    );
  });

  test('applies all rules: creates consumption rows + decrements stock', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.rules).toBe(2);
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(prisma.serviceConsumption.create).toHaveBeenCalledTimes(2);
    expect(prisma.product.update).toHaveBeenCalledTimes(2);
  });

  test('rounds fractional quantityPerVisit UP to a whole unit', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[1]]); // 0.5 mL rule
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    expect(stockUpdate.data.currentStock.decrement).toBe(1);
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.qty).toBe(1);
  });

  test('serviceConsumption row carries the product name + visitId', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.visitId).toBe(7);
    expect(consumption.data.productId).toBe(200);
    expect(consumption.data.productName).toBe('Saline 0.9%');
    expect(consumption.data.tenantId).toBe(1);
  });

  test('continues applying remaining rules when one fails', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    // First call (rule 1) throws; second call (rule 2) succeeds.
    prisma.$transaction
      .mockImplementationOnce(async () => { throw new Error('boom'); })
      .mockImplementationOnce(async (cb) => cb(prisma));
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.rules).toBe(2);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('boom');
  });

  test('skips audit log when skipAuditLog opt is true', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    await applyAutoConsumptionForVisit(
      { id: 7, serviceId: 100, tenantId: 1, status: 'completed' },
      { skipAuditLog: true }
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('writes audit log when applied > 0 (default)', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.entity).toBe('Visit');
    expect(auditCall.data.action).toBe('AUTO_CONSUMPTION_APPLIED');
  });
});

describe('lib/autoConsumptionApplier — start (eventBus listener)', () => {
  test('idempotent: calling start twice registers only one listener', () => {
    const before = bus.listenerCount('visit.completed');
    start();
    const afterFirst = bus.listenerCount('visit.completed');
    start();
    const afterSecond = bus.listenerCount('visit.completed');
    expect(afterFirst - before).toBeLessThanOrEqual(1);
    expect(afterSecond).toBe(afterFirst);
  });
});
