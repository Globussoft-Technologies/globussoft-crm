-- Preserve appointment calling for the canonical wellness roles when the
-- legacy role gate is replaced by explicit appointments.ai_call and
-- appointments.manual_call grants. Restrict the data migration to wellness
-- tenants so generic and travel permission matrices remain unchanged.
-- The NOT EXISTS predicate makes this safe to replay.
INSERT INTO `RolePermission` (`roleId`, `module`, `action`)
SELECT
  `r`.`id`,
  'appointments',
  `callMode`.`action`
FROM `Role` AS `r`
INNER JOIN `Tenant` AS `t`
  ON `t`.`id` = `r`.`tenantId`
CROSS JOIN (
  SELECT 'ai_call' AS `action`
  UNION ALL
  SELECT 'manual_call' AS `action`
) AS `callMode`
WHERE `t`.`vertical` = 'wellness'
  AND `r`.`key` IN ('ADMIN', 'MANAGER', 'RECEPTIONIST', 'TELECALLER')
  AND NOT EXISTS (
    SELECT 1
    FROM `RolePermission` AS `existing`
    WHERE `existing`.`roleId` = `r`.`id`
      AND `existing`.`module` = 'appointments'
      AND `existing`.`action` = `callMode`.`action`
  );
