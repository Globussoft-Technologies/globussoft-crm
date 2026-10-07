-- Customer self-registration historically created only a User identity for
-- Generic CRM tenants. Transport-person and plot-broker assignment pickers
-- use Contact rows, so backfill one Customer contact for every active generic
-- customer account that does not already have one.
INSERT INTO `Contact` (
  `name`,
  `email`,
  `phone`,
  `status`,
  `source`,
  `tenantId`,
  `createdAt`,
  `updatedAt`
)
SELECT
  `u`.`name`,
  `u`.`email`,
  `u`.`phone`,
  'Customer',
  'Customer Registration',
  `u`.`tenantId`,
  NOW(),
  NOW()
FROM `User` AS `u`
INNER JOIN `Tenant` AS `t` ON `t`.`id` = `u`.`tenantId`
WHERE `u`.`userType` = 'CUSTOMER'
  AND `u`.`deactivatedAt` IS NULL
  AND `t`.`vertical` = 'generic'
  AND NOT EXISTS (
    SELECT 1
    FROM `Contact` AS `c`
    WHERE `c`.`tenantId` = `u`.`tenantId`
      AND `c`.`email` = `u`.`email`
      AND `c`.`status` = 'Customer'
      AND `c`.`deletedAt` IS NULL
  );
