// Backfill the 3 existing SubscriptionPlan rows with the new columns
// (planKey, displayOrder, popular, accentColor, cta, featuresLabel, pricing)
// so /pricing renders correctly after the schema change without nuking
// everything else via a full reseed.
//
// Usage (from backend/):
//   node prisma/backfill-plans.js
//
// Safe to run multiple times — UPDATE is idempotent.

const prisma = require('../lib/prisma');

const ROWS = [
  {
    name: 'Starter',
    planKey: 'starter',
    displayOrder: 0,
    popular: false,
    accentColor: '#4f46e5',
    cta: 'Start Free Trial',
    featuresLabel: 'Includes',
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
    pricing: {
      usd: { annual: 29, monthly: 36, yearAnnualLabel: '$348 /user/year', yearMonthlyLabel: '$432 /user/year' },
      inr: { annual: '2,499', monthly: '2,999', yearAnnualLabel: '₹29,988 /user/year', yearMonthlyLabel: '₹35,988 /user/year' },
    },
  },
];

async function main() {
  // Use raw SQL — keeps the script working even when the running backend
  // holds a lock on the Prisma client that prevents `prisma generate` from
  // rewriting the type-safe client. The DB schema is already up-to-date
  // (via `prisma db push`); these UPDATEs operate against the live columns.
  for (const r of ROWS) {
    const pricingJson = JSON.stringify(r.pricing);
    const rows = await prisma.$executeRaw`
      UPDATE SubscriptionPlan
      SET planKey       = ${r.planKey},
          displayOrder  = ${r.displayOrder},
          popular       = ${r.popular ? 1 : 0},
          accentColor   = ${r.accentColor},
          cta           = ${r.cta},
          featuresLabel = ${r.featuresLabel},
          pricing       = ${pricingJson}
      WHERE name = ${r.name}
    `;
    console.log(`  ${r.name}: ${rows} row(s) updated`);
  }
  console.log('\nDone. Restart the backend so the regenerated Prisma client picks up the new columns.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
