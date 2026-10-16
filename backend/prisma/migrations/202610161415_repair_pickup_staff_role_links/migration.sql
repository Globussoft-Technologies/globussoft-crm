-- Repair logins created by the pickup/plot staff pages before canonical-role
-- preference was enforced. Those creates selected the first role with the
-- workspace permission, which could be ADMIN or USER. Only repair STAFF rows
-- whose legacy role is USER and which have exactly one active operational
-- profile; multi-workspace staff intentionally keep their existing RBAC role.

UPDATE `UserRole` AS `ur`
INNER JOIN `User` AS `u` ON `u`.`id` = `ur`.`userId`
INNER JOIN `TransportPerson` AS `tp`
  ON `tp`.`userId` = `u`.`id` AND `tp`.`isActive` = true
INNER JOIN `Role` AS `current_role`
  ON `current_role`.`id` = `ur`.`roleId` AND `current_role`.`tenantId` = `u`.`tenantId`
  AND `current_role`.`key` = 'USER' AND `current_role`.`isCustom` = false
INNER JOIN `Tenant` AS `tenant`
  ON `tenant`.`id` = `u`.`tenantId` AND `tenant`.`vertical` = 'generic'
INNER JOIN `Role` AS `target`
  ON `target`.`tenantId` = `u`.`tenantId`
  AND `target`.`key` = 'TRANSPORT_PERSON'
  AND `target`.`isActive` = true
LEFT JOIN `PlotBroker` AS `pb`
  ON `pb`.`userId` = `u`.`id` AND `pb`.`isActive` = true
LEFT JOIN `BillingPerson` AS `bp`
  ON `bp`.`userId` = `u`.`id` AND `bp`.`isActive` = true
SET `ur`.`roleId` = `target`.`id`, `ur`.`assignedAt` = NOW()
WHERE `u`.`userType` = 'STAFF'
  AND `u`.`role` = 'USER'
  AND `pb`.`id` IS NULL
  AND `bp`.`id` IS NULL
  AND `ur`.`roleId` <> `target`.`id`;

UPDATE `UserRole` AS `ur`
INNER JOIN `User` AS `u` ON `u`.`id` = `ur`.`userId`
INNER JOIN `PlotBroker` AS `pb`
  ON `pb`.`userId` = `u`.`id` AND `pb`.`isActive` = true
INNER JOIN `Role` AS `current_role`
  ON `current_role`.`id` = `ur`.`roleId` AND `current_role`.`tenantId` = `u`.`tenantId`
  AND `current_role`.`key` = 'USER' AND `current_role`.`isCustom` = false
INNER JOIN `Tenant` AS `tenant`
  ON `tenant`.`id` = `u`.`tenantId` AND `tenant`.`vertical` = 'generic'
INNER JOIN `Role` AS `target`
  ON `target`.`tenantId` = `u`.`tenantId`
  AND `target`.`key` IN ('BROOKER', 'BROKER')
  AND `target`.`isActive` = true
LEFT JOIN `TransportPerson` AS `tp`
  ON `tp`.`userId` = `u`.`id` AND `tp`.`isActive` = true
LEFT JOIN `BillingPerson` AS `bp`
  ON `bp`.`userId` = `u`.`id` AND `bp`.`isActive` = true
SET `ur`.`roleId` = `target`.`id`, `ur`.`assignedAt` = NOW()
WHERE `u`.`userType` = 'STAFF'
  AND `u`.`role` = 'USER'
  AND `tp`.`id` IS NULL
  AND `bp`.`id` IS NULL
  AND `ur`.`roleId` <> `target`.`id`;

UPDATE `UserRole` AS `ur`
INNER JOIN `User` AS `u` ON `u`.`id` = `ur`.`userId`
INNER JOIN `BillingPerson` AS `bp`
  ON `bp`.`userId` = `u`.`id` AND `bp`.`isActive` = true
INNER JOIN `Role` AS `current_role`
  ON `current_role`.`id` = `ur`.`roleId` AND `current_role`.`tenantId` = `u`.`tenantId`
  AND `current_role`.`key` = 'USER' AND `current_role`.`isCustom` = false
INNER JOIN `Tenant` AS `tenant`
  ON `tenant`.`id` = `u`.`tenantId` AND `tenant`.`vertical` = 'generic'
INNER JOIN `Role` AS `target`
  ON `target`.`tenantId` = `u`.`tenantId`
  AND `target`.`key` = 'BILLING'
  AND `target`.`isActive` = true
LEFT JOIN `TransportPerson` AS `tp`
  ON `tp`.`userId` = `u`.`id` AND `tp`.`isActive` = true
LEFT JOIN `PlotBroker` AS `pb`
  ON `pb`.`userId` = `u`.`id` AND `pb`.`isActive` = true
SET `ur`.`roleId` = `target`.`id`, `ur`.`assignedAt` = NOW()
WHERE `u`.`userType` = 'STAFF'
  AND `u`.`role` = 'USER'
  AND `tp`.`id` IS NULL
  AND `pb`.`id` IS NULL
  AND `ur`.`roleId` <> `target`.`id`;
