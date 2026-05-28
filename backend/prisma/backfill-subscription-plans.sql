-- Backfill the new SubscriptionPlan columns (planKey, displayOrder, popular,
-- accentColor, cta, featuresLabel, pricing) on the 3 existing rows so the
-- public /pricing page renders correctly after the schema change.
--
-- Run from the backend folder against the local MySQL on port 3307:
--   mysql -h 127.0.0.1 -P 3307 -u <user> -p crm < prisma/backfill-subscription-plans.sql
--
-- Or paste contents into any MySQL client connected to the `crm` database.
-- The UPDATEs are idempotent — safe to re-run.

UPDATE SubscriptionPlan
SET
  planKey       = 'starter',
  displayOrder  = 0,
  popular       = 0,
  accentColor   = '#4f46e5',
  cta           = 'Start Free Trial',
  featuresLabel = 'Includes',
  pricing       = JSON_OBJECT(
    'usd', JSON_OBJECT('annual', 6,   'monthly', 8,   'yearAnnualLabel', '$72 /user/year',   'yearMonthlyLabel', '$96 /user/year'),
    'inr', JSON_OBJECT('annual', 499, 'monthly', 649, 'yearAnnualLabel', '₹5,988 /user/year', 'yearMonthlyLabel', '₹7,788 /user/year')
  )
WHERE name = 'Starter';

UPDATE SubscriptionPlan
SET
  planKey       = 'pro',
  displayOrder  = 1,
  popular       = 1,
  accentColor   = '#7c3aed',
  cta           = 'Start Free Trial',
  featuresLabel = 'Everything in Starter, plus',
  pricing       = JSON_OBJECT(
    'usd', JSON_OBJECT('annual', 18,     'monthly', 22,     'yearAnnualLabel', '$216 /user/year',    'yearMonthlyLabel', '$264 /user/year'),
    'inr', JSON_OBJECT('annual', '1,499', 'monthly', '1,899', 'yearAnnualLabel', '₹17,988 /user/year', 'yearMonthlyLabel', '₹22,788 /user/year')
  )
WHERE name = 'Professional';

UPDATE SubscriptionPlan
SET
  planKey       = 'ent',
  displayOrder  = 2,
  popular       = 0,
  accentColor   = '#d97706',
  cta           = 'Contact Sales',
  featuresLabel = 'Everything in Professional, plus',
  pricing       = JSON_OBJECT(
    'usd', JSON_OBJECT('annual', 29,     'monthly', 36,     'yearAnnualLabel', '$348 /user/year',    'yearMonthlyLabel', '$432 /user/year'),
    'inr', JSON_OBJECT('annual', '2,499', 'monthly', '2,999', 'yearAnnualLabel', '₹29,988 /user/year', 'yearMonthlyLabel', '₹35,988 /user/year')
  )
WHERE name = 'Enterprise';
