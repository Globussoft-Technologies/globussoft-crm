// SubscriptionPlan catalog hygiene helpers.
//
// The public pricing catalog is platform-wide and has three canonical plans.
// Older/live data can contain renamed copies such as "Starter~m2" or
// "Starter-m2". Those rows must remain in the database when referenced by a
// historical Subscription, but they must not remain active in the catalog.

const CANONICAL_PLANS = Object.freeze([
  { key: 'starter', name: 'starter' },
  { key: 'pro', name: 'professional' },
  { key: 'ent', name: 'enterprise' },
]);

const CANONICAL_BY_KEY = new Map(CANONICAL_PLANS.map((plan) => [plan.key, plan]));
const CANONICAL_BY_NAME = new Map(CANONICAL_PLANS.map((plan) => [plan.name, plan]));

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalForPlan(plan) {
  const byKey = CANONICAL_BY_KEY.get(normalized(plan?.planKey));
  if (byKey) return byKey;
  return CANONICAL_BY_NAME.get(normalized(plan?.name)) || null;
}

function suffixedCanonicalForPlan(plan) {
  const match = normalized(plan?.name).match(/^(starter|professional|enterprise)\s*[~-]m\d+$/i);
  return match ? CANONICAL_BY_NAME.get(match[1].toLowerCase()) || null : null;
}

function sameBillingInterval(left, right) {
  return (left?.billingIntervalDays ?? null) === (right?.billingIntervalDays ?? null);
}

function isSuffixedDuplicatePlan(plan, plans) {
  const canonical = suffixedCanonicalForPlan(plan);
  if (!canonical) return false;

  return plans.some((candidate) => (
    candidate !== plan &&
    canonicalForPlan(candidate) === canonical &&
    sameBillingInterval(candidate, plan)
  ));
}

/**
 * Return active catalog rows safe for public pricing display.
 *
 * This is intentionally narrow: only the known suffixed copies of the three
 * canonical plans are removed. Custom owner-created plans remain untouched.
 * Duplicate stable plan keys are also collapsed defensively; planKey is
 * declared unique in Prisma, but this protects the response during legacy DB
 * drift or an incomplete schema sync.
 */
function filterDuplicatePlans(plans) {
  if (!Array.isArray(plans)) return [];

  const seenKeys = new Set();
  return plans.filter((plan) => {
    if (isSuffixedDuplicatePlan(plan, plans)) return false;

    const key = normalized(plan?.planKey);
    if (!key) return true;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
}

function getSuffixedDuplicatePlanIds(plans) {
  if (!Array.isArray(plans)) return [];
  return plans
    .filter((plan) => isSuffixedDuplicatePlan(plan, plans))
    .map((plan) => plan.id)
    .filter((id) => Number.isInteger(id));
}

module.exports = {
  filterDuplicatePlans,
  getSuffixedDuplicatePlanIds,
  isSuffixedDuplicatePlan,
};
