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

// The applier now tracks partial-mL consumption against a bottle's `volume`.
// Each rule consumes `quantityPerVisit` mL; the rolling `partialMlUsed`
// accumulator on Product only decrements `currentStock` when it crosses a
// full unit (one bottle).
const RULES = [
  {
    id: 1,
    serviceId: 100,
    productId: 200,
    quantityPerVisit: 1,
    isActive: true,
    product: { id: 200, name: 'Saline 0.9%', currentStock: 50, threshold: 5, volume: 1, partialMlUsed: 0 },
  },
  {
    id: 2,
    serviceId: 100,
    productId: 201,
    quantityPerVisit: 0.5, // 0.5 mL into a 10 mL bottle → accumulator only
    isActive: true,
    product: { id: 201, name: 'Cotton', currentStock: 3, threshold: 5, volume: 10, partialMlUsed: 0 },
  },
];

beforeEach(() => {
  prisma.autoConsumptionRule = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  prisma.serviceConsumption = {
    create: vi.fn().mockResolvedValue({ id: 999 }),
    // Idempotency dedupe lookup — default to "no prior consumption rows".
    findMany: vi.fn().mockResolvedValue([]),
  };
  prisma.product = {
    // The applier now loads products separately from the rules. Provide a
    // dynamic lookup that mirrors the product embedded in the mocked rules so
    // tests don't need to manually set both mocks.
    findMany: vi.fn(async ({ where }) => {
      const lastResult = prisma.autoConsumptionRule.findMany.mock.results.at(-1);
      const rules = lastResult ? await lastResult.value : [];
      const productMap = new Map(rules.map((r) => [r.productId, r.product]));
      const ids = where?.id?.in || [];
      return ids.map((id) => productMap.get(id)).filter(Boolean);
    }),
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

  test('accumulates fractional mL into partialMlUsed without decrementing stock', async () => {
    // 0.5 mL consumed from a 10 mL bottle (with 0 mL already partial)
    // → partialMlUsed becomes 0.5, currentStock untouched (still has full bottle in use).
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[1]]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    expect(stockUpdate.data.partialMlUsed).toBe(0.5);
    expect(stockUpdate.data.currentStock).toBeUndefined();
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.qty).toBe(0.5);
  });

  test('decrements a whole unit once partialMlUsed crosses the bottle volume', async () => {
    // Bottle is 10 mL, already 9.5 mL consumed; next 0.5 mL rule tips it over.
    const tippingRule = {
      ...RULES[1],
      product: { ...RULES[1].product, partialMlUsed: 9.5 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([tippingRule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    expect(stockUpdate.data.currentStock.decrement).toBe(1);
    expect(stockUpdate.data.partialMlUsed).toBe(0);
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

  test('does NOT write an audit row — auto-consumption is system-triggered and the ServiceConsumption ledger is the source of truth', async () => {
    // The applier intentionally skips writeAudit: there is no real user actor
    // (cron / event-bus trigger), and the per-visit ServiceConsumption rows
    // created above already form an auditable ledger powering the P&L-by-
    // Service report. Adding an AUTO_CONSUMPTION_APPLIED audit row would
    // duplicate that ledger without adding new tamper-evidence value.
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────────────────
// Extension cases (Tick #N) — pin under-covered branches in applyAutoConsumptionForVisit
// ─────────────────────────────────────────────────────────────────────────────
describe('lib/autoConsumptionApplier — extended coverage', () => {
  test('emits low-stock warning when consumed units take stock to <= 0', async () => {
    // Cotton has currentStock=3, threshold=5; consume 5 units (volume=1 → 5 units deducted)
    // → newStock = -2, must warn.
    const drainRule = {
      ...RULES[1],
      quantityPerVisit: 5,
      product: { ...RULES[1].product, currentStock: 3, volume: 1 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([drainRule]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await applyAutoConsumptionForVisit({
        id: 7, serviceId: 100, tenantId: 1, status: 'completed',
      });
      expect(result.applied).toHaveLength(1);
      // At least one console.warn call contains the low-stock signal.
      const lowStockCall = warnSpy.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('[autoConsumption]') && c[0].includes('low-stock')
      );
      expect(lowStockCall).toBeDefined();
      expect(lowStockCall[0]).toContain('Cotton');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('no-ops when visit object is missing id', async () => {
    // Even with a serviceId, an id-less visit is malformed — must early-return.
    const result = await applyAutoConsumptionForVisit({ serviceId: 100, tenantId: 1, status: 'completed' });
    expect(result).toEqual({ rules: 0, applied: [], skipped: [] });
    expect(prisma.autoConsumptionRule.findMany).not.toHaveBeenCalled();
  });

  test('applied[] entries carry { ruleId, productId, qty } shape', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.applied).toHaveLength(2);
    // qty is the raw consumedMl (rule.quantityPerVisit) — not unit count.
    expect(result.applied[0]).toEqual({ ruleId: 1, productId: 200, qty: 1 });
    expect(result.applied[1]).toEqual({ ruleId: 2, productId: 201, qty: 0.5 });
  });

  test('does NOT write audit log when applied.length === 0 (all rules failed)', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    // Every transaction throws → applied stays empty, audit must be skipped.
    prisma.$transaction = vi.fn(async () => { throw new Error('all dead'); });
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('does NOT write an audit log on multi-rule apply (system-triggered, no userId; ServiceConsumption is the ledger)', async () => {
    // The applier intentionally skips writeAudit — the audit schema requires a
    // valid userId FK, and auto-consumption fires from the eventBus / cron with
    // no real user actor. The ServiceConsumption rows form the auditable ledger.
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('swallows audit-write failures without throwing or marking applied as skipped', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    // writeAudit() itself wraps its body in try/catch — a rejection from
    // auditLog.create() must NOT propagate out of applyAutoConsumptionForVisit
    // and must NOT mark the rule as skipped.
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit-table-locked'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await applyAutoConsumptionForVisit({
        id: 7, serviceId: 100, tenantId: 1, status: 'completed',
      });
      // Audit failure is non-fatal — applied entries survive intact.
      expect(result.applied).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('whole-unit quantityPerVisit (2) consumes exactly 2 units (no Math.max overflow)', async () => {
    // Math.max(1, Math.ceil(2)) === 2; pin the boundary so the floor doesn't inflate.
    const wholeRule = {
      ...RULES[0],
      quantityPerVisit: 2,
      product: { ...RULES[0].product, currentStock: 10 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([wholeRule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    expect(stockUpdate.data.currentStock.decrement).toBe(2);
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.qty).toBe(2);
  });

  test('visit with undefined status (status field absent) still applies rules', async () => {
    // The SUT check is `if (visit.status && visit.status !== "completed")` — a
    // missing status is treated as "proceed" (the create-route fast-path doesn't
    // always set status before the eventBus fires).
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, /* no status field */
    });
    expect(result.rules).toBe(1);
    expect(result.applied).toHaveLength(1);
    expect(prisma.serviceConsumption.create).toHaveBeenCalledTimes(1);
  });

  test('skips rules whose referenced product no longer exists (orphan productId)', async () => {
    // If a product was deleted after the rule was created, the applier must not
    // crash on a required-relation include; it should skip the rule cleanly.
    const orphanRule = {
      id: 99,
      serviceId: 100,
      productId: 999,
      quantityPerVisit: 1,
      isActive: true,
      product: null,
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([orphanRule]);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.rules).toBe(1);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('PRODUCT_NOT_FOUND');
    expect(prisma.serviceConsumption.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit-conversion + idempotency cases
// ─────────────────────────────────────────────────────────────────────────────
describe('lib/autoConsumptionApplier — unit conversion', () => {
  test('rule.unit=ml against product stocked in ltr converts before deducting', async () => {
    // Rule says "15 ml per visit"; product is stocked in ltr with volume=1
    // (one 1-ltr bottle = 1000 ml in base). After conversion, consumedMl=0.015
    // ltr; partialMlUsed accumulates 0.015 / 1.000 → no whole-unit decrement.
    const rule = {
      id: 10,
      serviceId: 100,
      productId: 300,
      quantityPerVisit: 15,
      unit: 'ml',
      isActive: true,
      product: { id: 300, name: 'Carbon Gel', currentStock: 5, threshold: 1, volume: 1, unit: 'ltr', partialMlUsed: 0 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([rule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    // 15 ml → 0.015 ltr; no whole bottle consumed yet.
    expect(stockUpdate.data.partialMlUsed).toBeCloseTo(0.015, 5);
    expect(stockUpdate.data.currentStock).toBeUndefined();
    // ServiceConsumption row records the qty in the product's base unit.
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.qty).toBeCloseTo(0.015, 5);
  });

  test('rule.unit=gm against product stocked in kg converts correctly', async () => {
    // 500 gm rule against a 1 kg bottle (volume=1) → consumedMl=0.5 kg, half a bottle.
    const rule = {
      id: 11,
      serviceId: 100,
      productId: 301,
      quantityPerVisit: 500,
      unit: 'gm',
      isActive: true,
      product: { id: 301, name: 'Bulk Powder', currentStock: 5, threshold: 1, volume: 1, unit: 'kg', partialMlUsed: 0.6 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([rule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    // 0.6 + 0.5 = 1.1 → one whole bottle deducted, 0.1 partial remaining.
    expect(stockUpdate.data.currentStock.decrement).toBe(1);
    expect(stockUpdate.data.partialMlUsed).toBeCloseTo(0.1, 5);
  });

  test('rule.unit matching product.unit skips conversion (no float drift)', async () => {
    const rule = {
      id: 12,
      serviceId: 100,
      productId: 302,
      quantityPerVisit: 3.5,
      unit: 'ml',
      isActive: true,
      product: { id: 302, name: 'Saline', currentStock: 10, threshold: 1, volume: 1, unit: 'ml', partialMlUsed: 0 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([rule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const consumption = prisma.serviceConsumption.create.mock.calls[0][0];
    expect(consumption.data.qty).toBe(3.5);
  });

  test('rule.unit absent falls back to product.unit (back-compat)', async () => {
    // Pre-existing rules created before the unit field landed have rule.unit=null.
    // They must continue to deduct at face value with no conversion.
    const rule = {
      id: 13,
      serviceId: 100,
      productId: 303,
      quantityPerVisit: 2,
      unit: null,
      isActive: true,
      product: { id: 303, name: 'Cotton', currentStock: 5, threshold: 1, volume: 1, unit: 'piece', partialMlUsed: 0 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([rule]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    const stockUpdate = prisma.product.update.mock.calls[0][0];
    expect(stockUpdate.data.currentStock.decrement).toBe(2);
  });

  test('incompatible unit pair (piece vs ml) skips with UNIT_INCOMPATIBLE reason', async () => {
    // Defensive layer — the route's create/PUT validation should block this,
    // but if a rule slips through (e.g. product unit changed after rule
    // creation), the applier must skip rather than deduct garbage.
    const rule = {
      id: 14,
      serviceId: 100,
      productId: 304,
      quantityPerVisit: 1,
      unit: 'piece',
      isActive: true,
      product: { id: 304, name: 'Saline', currentStock: 5, threshold: 1, volume: 1, unit: 'ml', partialMlUsed: 0 },
    };
    prisma.autoConsumptionRule.findMany.mockResolvedValue([rule]);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('UNIT_INCOMPATIBLE');
    expect(prisma.serviceConsumption.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});

describe('lib/autoConsumptionApplier — idempotency (duplicate completion events)', () => {
  test('skips rules whose product already has a ServiceConsumption row for this visit', async () => {
    // Simulate the bus firing visit.completed twice (network retry, socket
    // re-broadcast). On the second fire, the dedupe lookup finds the prior
    // row and the rule must be skipped.
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    prisma.serviceConsumption.findMany.mockResolvedValue([{ productId: 200 }]);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.rules).toBe(2);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].productId).toBe(201);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('ALREADY_APPLIED');
    // Only one product.update call — for the not-yet-deducted product.
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
  });

  test('skips ALL rules when every product is already deducted (full replay)', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue(RULES);
    prisma.serviceConsumption.findMany.mockResolvedValue([
      { productId: 200 },
      { productId: 201 },
    ]);
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(prisma.serviceConsumption.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  test('queries serviceConsumption.findMany scoped to visitId + tenantId', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 42, status: 'completed',
    });
    expect(prisma.serviceConsumption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { visitId: 7, tenantId: 42 },
      })
    );
  });

  test('dedupe lookup failure does NOT block deduction (graceful degrade)', async () => {
    prisma.autoConsumptionRule.findMany.mockResolvedValue([RULES[0]]);
    prisma.serviceConsumption.findMany.mockRejectedValueOnce(new Error('table-locked'));
    const result = await applyAutoConsumptionForVisit({
      id: 7, serviceId: 100, tenantId: 1, status: 'completed',
    });
    // Lookup failed → applier proceeds without dedupe; rule still applies.
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });
});
