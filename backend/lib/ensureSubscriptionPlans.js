// Self-healing subscription-plan bootstrap.
//
// Called once during backend startup (from server.js). Guarantees the
// canonical 3 plans (Starter / Professional / Enterprise) exist in the
// SubscriptionPlan table so a fresh install / a wiped DB / a partial seed
// always lands with a usable /pricing catalog — no manual seed step
// required.
//
// Idempotent: if a row with the same planKey already exists, it is LEFT
// ALONE. The Owner's edits via the in-app Manage Plans UI must persist
// across restarts; this bootstrap never overwrites a present plan.
//
// Legacy row recovery: if a plan exists by (name, billingIntervalDays)
// but its planKey is null (rows created before the multi-currency upgrade
// landed), it is updated in place to set planKey so subsequent lookups
// match. Still no overwrite of pricing/features.

const prisma = require('./prisma');

const CANONICAL_PLANS = [
  {
    name: 'Starter',
    planKey: 'starter',
    displayOrder: 0,
    popular: false,
    accentColor: '#4f46e5',
    cta: 'Start Free Trial',
    featuresLabel: 'Includes',
    price: 499,
    currency: 'INR',
    billingIntervalDays: 30,
    description: 'For startups & SMBs seeking efficient pipeline management.',
    features: [
      'Contact, Account & Deal Management',
      'Contact Lifecycle Stages',
      'Built-in Chat, Email & Phone',
      'Email Templates & Tracking',
      'Custom Fields & Kanban Views',
      'Basic Workflows (20)',
      'Visual Sales Pipeline',
      'Product Catalog',
      'Curated Reports & Dashboards',
      'Slack Integration & Marketplace',
      'Mobile App & 24×5 Support',
    ],
    pricing: {
      usd: { annual: 6, monthly: 8, yearAnnualLabel: '$72 /user/year', yearMonthlyLabel: '$96 /user/year' },
      inr: { annual: 499, monthly: 649, yearAnnualLabel: '₹5,988 /user/year', yearMonthlyLabel: '₹7,788 /user/year' },
    },
  },
  {
    name: 'Professional',
    planKey: 'pro',
    displayOrder: 1,
    popular: true,
    accentColor: '#7c3aed',
    cta: 'Start Free Trial',
    featuresLabel: 'Everything in Starter, plus',
    price: 1499,
    currency: 'INR',
    billingIntervalDays: 30,
    description: 'For growing teams needing AI, automation & multi-pipeline.',
    features: [
      'AI-Powered Contact Scoring',
      'Multiple Sales Pipelines',
      'Sales Sequences & Automation',
      'Territory Management',
      'Auto-assignment Rules',
      'AI Email Writing & Enhancement',
      'Deal Insights by AI',
      'Advanced Workflows (50)',
      'Custom Reports & Dashboards',
      'Account Hierarchy & BYOC',
    ],
    pricing: {
      usd: { annual: 18, monthly: 22, yearAnnualLabel: '$216 /user/year', yearMonthlyLabel: '$264 /user/year' },
      inr: { annual: '1,499', monthly: '1,899', yearAnnualLabel: '₹17,988 /user/year', yearMonthlyLabel: '₹22,788 /user/year' },
    },
  },
  {
    name: 'Enterprise',
    planKey: 'ent',
    displayOrder: 2,
    popular: false,
    accentColor: '#d97706',
    cta: 'Contact Sales',
    featuresLabel: 'Everything in Professional, plus',
    price: 2499,
    currency: 'INR',
    billingIntervalDays: 30,
    description: 'For large teams needing customization, governance & AI forecasting.',
    features: [
      'Custom Modules',
      'AI Forecasting Insights',
      'Field-level Permissions',
      'Sandbox Environment',
      'Audit Logs & Compliance',
      'Auto Profile Enrichment',
      'Deal Teams & Advanced Metrics',
      '5,000 Bulk Emails/user/day',
      '100 GB Storage/user',
      'Dedicated Account Manager',
      'Priority 24×7 Support',
    ],
    pricing: {
      usd: { annual: 29, monthly: 36, yearAnnualLabel: '$348 /user/year', yearMonthlyLabel: '$432 /user/year' },
      inr: { annual: '2,499', monthly: '2,999', yearAnnualLabel: '₹29,988 /user/year', yearMonthlyLabel: '₹35,988 /user/year' },
    },
  },
];

async function ensureSubscriptionPlans() {
  let created = 0;
  let backfilled = 0;
  let skipped = 0;

  for (const plan of CANONICAL_PLANS) {
    // First match by planKey (the post-upgrade canonical lookup); fall back
    // to (name, billingIntervalDays) which is the legacy compound unique.
    const existing = await prisma.subscriptionPlan.findFirst({
      where: {
        OR: [
          { planKey: plan.planKey },
          { name: plan.name, billingIntervalDays: plan.billingIntervalDays },
        ],
      },
    });

    if (existing) {
      // Legacy row from a pre-upgrade seed — planKey is null. Backfill
      // ONLY the planKey so future lookups go straight to the OR branch's
      // first leg. Pricing / features / popularity stay whatever the owner
      // (or the original seed) left them as.
      if (!existing.planKey) {
        await prisma.subscriptionPlan.update({
          where: { id: existing.id },
          data: { planKey: plan.planKey },
        });
        backfilled++;
      } else {
        skipped++;
      }
      continue;
    }

    await prisma.subscriptionPlan.create({
      data: {
        ...plan,
        features: JSON.stringify(plan.features),
        pricing: JSON.stringify(plan.pricing),
        isActive: true,
      },
    });
    created++;
  }

  if (created || backfilled) {
    console.log(`[ensureSubscriptionPlans] created=${created} backfilled=${backfilled} skipped=${skipped}`);
  }
  return { created, backfilled, skipped };
}

module.exports = ensureSubscriptionPlans;
