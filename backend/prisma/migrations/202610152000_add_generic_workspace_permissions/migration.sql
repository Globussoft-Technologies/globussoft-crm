-- Register the three workspace capabilities for existing generic ADMIN roles.
-- Individual staff access is derived from each user's active operational
-- profile at runtime; do not grant a workspace to a shared role merely because
-- one member of that role has transport, site-visit, or billing work.
INSERT INTO `RolePermission` (`roleId`, `module`, `action`)
SELECT `r`.`id`, `workspace`.`module`, `permissionAction`.`action`
FROM `Role` AS `r`
INNER JOIN `Tenant` AS `t` ON `t`.`id` = `r`.`tenantId`
CROSS JOIN (
  SELECT 'transport_workspace' AS `module` UNION ALL
  SELECT 'broker_workspace' UNION ALL
  SELECT 'billing_workspace'
) AS `workspace`
CROSS JOIN (
  SELECT 'read' AS `action` UNION ALL
  SELECT 'update'
) AS `permissionAction`
WHERE `t`.`vertical` = 'generic'
  AND `r`.`key` = 'ADMIN'
  AND NOT EXISTS (
  SELECT 1
  FROM `RolePermission` AS `existing`
  WHERE `existing`.`roleId` = `r`.`id`
    AND `existing`.`module` = `workspace`.`module`
    AND `existing`.`action` = `permissionAction`.`action`
);
