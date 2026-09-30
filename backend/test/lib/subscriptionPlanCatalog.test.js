import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  filterDuplicatePlans,
  getSuffixedDuplicatePlanIds,
} = requireCJS('../../lib/subscriptionPlanCatalog');

describe('subscriptionPlanCatalog', () => {
  test('removes known suffixed canonical duplicates while preserving canonical and custom plans', () => {
    const plans = [
      { id: 1, name: 'Starter', planKey: 'starter', billingIntervalDays: 30 },
      { id: 2, name: 'Starter~m2', planKey: null, billingIntervalDays: 30 },
      { id: 3, name: 'Professional', planKey: 'pro', billingIntervalDays: 30 },
      { id: 4, name: 'Professional-m2', planKey: null, billingIntervalDays: 30 },
      { id: 5, name: 'Enterprise', planKey: 'ent', billingIntervalDays: 30 },
      { id: 6, name: 'Enterprise~m2', planKey: null, billingIntervalDays: 30 },
      { id: 7, name: 'Startup Plus~m2', planKey: 'startup-plus', billingIntervalDays: 30 },
    ];

    expect(filterDuplicatePlans(plans).map((plan) => plan.id)).toEqual([1, 3, 5, 7]);
    expect(getSuffixedDuplicatePlanIds(plans)).toEqual([2, 4, 6]);
  });

  test('does not remove a suffixed row when its canonical plan is absent or has another billing interval', () => {
    const plans = [
      { id: 10, name: 'Starter~m2', planKey: null, billingIntervalDays: 30 },
      { id: 11, name: 'Starter', planKey: 'starter', billingIntervalDays: 365 },
    ];

    expect(filterDuplicatePlans(plans).map((plan) => plan.id)).toEqual([10, 11]);
    expect(getSuffixedDuplicatePlanIds(plans)).toEqual([]);
  });

  test('collapses duplicate stable plan keys defensively', () => {
    const plans = [
      { id: 20, name: 'Starter', planKey: 'starter', billingIntervalDays: 30 },
      { id: 21, name: 'Starter copy', planKey: 'starter', billingIntervalDays: 30 },
      { id: 22, name: 'Custom', planKey: null, billingIntervalDays: 30 },
    ];

    expect(filterDuplicatePlans(plans).map((plan) => plan.id)).toEqual([20, 22]);
  });
});
