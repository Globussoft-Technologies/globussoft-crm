-- Backfill the new generic-only page permissions without changing wellness or
-- travel role matrices. ADMIN receives the complete module action set;
-- MANAGER receives non-destructive actions for operational page modules plus
-- read access to legacy manager pages that are now permission-enforced.
INSERT INTO `RolePermission` (`roleId`, `module`, `action`)
SELECT `r`.`id`, `pagePermission`.`module`, `permissionAction`.`action`
FROM `Role` AS `r`
INNER JOIN `Tenant` AS `t` ON `t`.`id` = `r`.`tenantId`
CROSS JOIN (
  SELECT 'cpq' AS `module`, 1 AS `managerGrant` UNION ALL
  SELECT 'playbooks', 1 UNION ALL
  SELECT 'territories', 1 UNION ALL
  SELECT 'live_chat', 1 UNION ALL
  SELECT 'support', 1 UNION ALL
  SELECT 'sla', 1 UNION ALL
  SELECT 'social', 1 UNION ALL
  SELECT 'field_permissions', 0 UNION ALL
  SELECT 'sandbox', 0 UNION ALL
  SELECT 'document_templates', 1 UNION ALL
  SELECT 'custom_objects', 0 UNION ALL
  SELECT 'lead_scoring', 1 UNION ALL
  SELECT 'deal_insights', 1 UNION ALL
  SELECT 'calendar', 1 UNION ALL
  SELECT 'ab_tests', 1 UNION ALL
  SELECT 'booking_pages', 1 UNION ALL
  SELECT 'web_forms', 1
) AS `pagePermission`
CROSS JOIN (
  SELECT 'read' AS `action` UNION ALL
  SELECT 'write' UNION ALL
  SELECT 'update' UNION ALL
  SELECT 'delete'
) AS `permissionAction`
WHERE `t`.`vertical` = 'generic'
  AND `r`.`key` IN ('ADMIN', 'MANAGER')
  AND (
    `r`.`key` = 'ADMIN'
    OR (
      `r`.`key` = 'MANAGER'
      AND `pagePermission`.`managerGrant` = 1
      AND `permissionAction`.`action` <> 'delete'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `RolePermission` AS `existing`
    WHERE `existing`.`roleId` = `r`.`id`
      AND `existing`.`module` = `pagePermission`.`module`
      AND `existing`.`action` = `permissionAction`.`action`
  );

-- These modules already existed in the shared catalog, but legacy generic
-- managers reached their pages through role-only guards. Preserve exactly
-- that read access now that role and permission checks are both enforced.
INSERT INTO `RolePermission` (`roleId`, `module`, `action`)
SELECT `r`.`id`, `managerPage`.`module`, 'read'
FROM `Role` AS `r`
INNER JOIN `Tenant` AS `t` ON `t`.`id` = `r`.`tenantId`
CROSS JOIN (
  SELECT 'forecasting' AS `module` UNION ALL
  SELECT 'quotas' UNION ALL
  SELECT 'sequences' UNION ALL
  SELECT 'settings'
) AS `managerPage`
WHERE `t`.`vertical` = 'generic'
  AND `r`.`key` = 'MANAGER'
  AND NOT EXISTS (
    SELECT 1
    FROM `RolePermission` AS `existing`
    WHERE `existing`.`roleId` = `r`.`id`
      AND `existing`.`module` = `managerPage`.`module`
      AND `existing`.`action` = 'read'
  );
