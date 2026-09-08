-- Workflow parity wave — Freshsales-equivalent automation.
--
-- Non-destructive by construction:
--   * 11 ADD COLUMN statements on AutomationRule, every one NULLABLE or
--     NOT NULL WITH AN EXPLICIT DEFAULT, so existing rows backfill silently
--     and `scripts/check-migration-safety.js` raises no NOT_NULL_TRANSITION.
--   * 2 brand-new tables. No column is dropped, narrowed, or made UNIQUE.
--   * The 2 new indexes on AutomationRule are non-unique.
-- Safe to run against a populated production database with no bless marker.
--
-- Design notes (full rationale lives on the models in schema.prisma):
--   • createdById/updatedById are PLAIN INT columns with NO foreign key.
--     Staff churn must never cascade into a tenant's automation, and the
--     engine only needs the id as a fallback requester for create_approval —
--     which referenced `rule.createdById` against a column that never existed.
--   • sortOrder is promoted out of the targetState JSON blob into a real
--     column. Backfilled below from the existing JSON so no tenant's
--     hand-arranged execution order is lost. The engine still falls back to
--     targetState.order for any row this backfill could not parse.
--   • updatedAt is NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE
--     CURRENT_TIMESTAMP(3) to match Prisma's @updatedAt semantics; existing
--     rows adopt the migration timestamp, which is the honest answer (we do
--     not know when they were really last touched).
--   • Every FK on the new tables declares ON DELETE explicitly
--     (check-migration-safety.js requirement).

-- ── AutomationRule: metadata, health counters, ordering, scheduling ──

ALTER TABLE `AutomationRule`
  ADD COLUMN `createdAt`           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `updatedAt`           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ADD COLUMN `createdById`         INT NULL,
  ADD COLUMN `updatedById`         INT NULL,
  ADD COLUMN `lastRunAt`           DATETIME(3) NULL,
  ADD COLUMN `lastError`           TEXT NULL,
  ADD COLUMN `runCount`            INT NOT NULL DEFAULT 0,
  ADD COLUMN `failureCount`        INT NOT NULL DEFAULT 0,
  ADD COLUMN `consecutiveFailures` INT NOT NULL DEFAULT 0,
  ADD COLUMN `autoDisabledAt`      DATETIME(3) NULL,
  ADD COLUMN `sortOrder`           INT NOT NULL DEFAULT 0,
  ADD COLUMN `scheduleConfig`      TEXT NULL,
  ADD COLUMN `nextScheduledAt`     DATETIME(3) NULL;

-- Backfill sortOrder from the legacy targetState JSON so existing tenants
-- keep the execution order they dragged into place. JSON_EXTRACT returns
-- NULL for rows whose targetState is absent, malformed, or has no `order`
-- key; COALESCE leaves those at 0 and the engine's targetState fallback
-- still covers them.
UPDATE `AutomationRule`
   SET `sortOrder` = COALESCE(
         CAST(JSON_UNQUOTE(JSON_EXTRACT(`targetState`, '$.order')) AS SIGNED),
         0)
 WHERE `targetState` IS NOT NULL
   AND JSON_VALID(`targetState`)
   AND JSON_EXTRACT(`targetState`, '$.order') IS NOT NULL;

CREATE INDEX `AutomationRule_tenantId_isActive_triggerType_idx`
    ON `AutomationRule`(`tenantId`, `isActive`, `triggerType`);
CREATE INDEX `AutomationRule_tenantId_sortOrder_idx`
    ON `AutomationRule`(`tenantId`, `sortOrder`);

-- ── WorkflowExecution — real per-action execution log ────────────────
-- Replaces scanning AuditLog rows with entity='AutomationRule'. The
-- (tenantId, ruleId, recordKey) index is what turns "run once per record"
-- from a 500-row scan-and-JSON.parse on every event into an indexed lookup.

CREATE TABLE `WorkflowExecution` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `ruleId`      INT NOT NULL,
  `triggerType` VARCHAR(191) NOT NULL,
  `actionType`  VARCHAR(191) NOT NULL,
  `status`      VARCHAR(191) NOT NULL DEFAULT 'SUCCESS',
  `recordKey`   VARCHAR(191) NULL,
  `contactId`   INT NULL,
  `entityLabel` VARCHAR(191) NULL,
  `error`       TEXT NULL,
  `details`     TEXT NULL,
  `durationMs`  INT NULL,
  `isTest`      BOOLEAN NOT NULL DEFAULT false,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `tenantId`    INT NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `WorkflowExecution_tenantId_ruleId_createdAt_idx` (`tenantId`, `ruleId`, `createdAt`),
  INDEX `WorkflowExecution_tenantId_ruleId_recordKey_idx`  (`tenantId`, `ruleId`, `recordKey`),
  INDEX `WorkflowExecution_tenantId_createdAt_idx`         (`tenantId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WorkflowExecution`
  ADD CONSTRAINT `WorkflowExecution_ruleId_fkey`
  FOREIGN KEY (`ruleId`) REFERENCES `AutomationRule`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WorkflowExecution`
  ADD CONSTRAINT `WorkflowExecution_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── WorkflowScheduledAction — backing store for the `wait` action ────
-- lockedAt/lockedBy mirror SequenceEnrollment's pessimistic lock so two app
-- instances never double-fire the same deferred action.

CREATE TABLE `WorkflowScheduledAction` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `ruleId`      INT NOT NULL,
  `runAt`       DATETIME(3) NOT NULL,
  `status`      VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `triggerType` VARCHAR(191) NOT NULL,
  `actionsJson` TEXT NOT NULL,
  `payloadJson` TEXT NOT NULL,
  `recordKey`   VARCHAR(191) NULL,
  `attempts`    INT NOT NULL DEFAULT 0,
  `lastError`   TEXT NULL,
  `lockedAt`    DATETIME(3) NULL,
  `lockedBy`    VARCHAR(191) NULL,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `tenantId`    INT NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `WorkflowScheduledAction_tenantId_status_runAt_idx` (`tenantId`, `status`, `runAt`),
  INDEX `WorkflowScheduledAction_ruleId_idx`                (`ruleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WorkflowScheduledAction`
  ADD CONSTRAINT `WorkflowScheduledAction_ruleId_fkey`
  FOREIGN KEY (`ruleId`) REFERENCES `AutomationRule`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WorkflowScheduledAction`
  ADD CONSTRAINT `WorkflowScheduledAction_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
