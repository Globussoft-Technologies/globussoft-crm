INSERT INTO `Role` (
  `tenantId`, `key`, `name`, `description`, `isSystem`, `isActive`,
  `userType`, `dataScope`, `landingPath`, `createdAt`, `updatedAt`
)
SELECT
  tenant.`id`,
  'BILLING',
  'Billing Department',
  'Handles interested plot customers from invoice preparation through payment completion',
  false,
  true,
  'STAFF',
  'ALL',
  '/home',
  NOW(),
  NOW()
FROM `Tenant` tenant
WHERE tenant.`vertical` = 'generic'
  AND NOT EXISTS (
    SELECT 1
    FROM `Role` existing
    WHERE existing.`tenantId` = tenant.`id`
      AND existing.`key` = 'BILLING'
  );
