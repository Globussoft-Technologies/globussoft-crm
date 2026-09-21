-- Generic CRM shared pipeline stages.
-- Existing PipelineStage ids are preserved. Generic CRM uses this join table;
-- Wellness and Travel keep their existing tenant-wide PipelineStage behavior.

CREATE TABLE `PipelineStageAssignment` (
  `pipelineId` INTEGER NOT NULL,
  `stageId` INTEGER NOT NULL,
  `tenantId` INTEGER NOT NULL,
  `position` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`pipelineId`, `stageId`),
  INDEX `PipelineStageAssignment_tenantId_pipelineId_position_idx` (`tenantId`, `pipelineId`, `position`),
  INDEX `PipelineStageAssignment_stageId_position_idx` (`stageId`, `position`),
  INDEX `PipelineStageAssignment_pipelineId_position_idx` (`pipelineId`, `position`),
  CONSTRAINT `PipelineStageAssignment_pipelineId_fkey`
    FOREIGN KEY (`pipelineId`) REFERENCES `Pipeline`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PipelineStageAssignment_stageId_fkey`
    FOREIGN KEY (`stageId`) REFERENCES `PipelineStage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PipelineStageAssignment_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Before this migration PipelineStage was tenant-wide for every vertical.
-- Assign every existing Generic stage to every existing pipeline in the same
-- tenant, preserving exactly what Generic users saw before pipeline-specific
-- assignments were introduced. Wellness and Travel rows are excluded.
INSERT INTO `PipelineStageAssignment` (`pipelineId`, `stageId`, `tenantId`, `position`)
SELECT p.`id`, ps.`id`, p.`tenantId`, ps.`position`
FROM `Pipeline` p
JOIN `Tenant` t ON t.`id` = p.`tenantId`
JOIN `PipelineStage` ps ON ps.`tenantId` = p.`tenantId`
WHERE t.`vertical` = 'generic'
ON DUPLICATE KEY UPDATE `position` = VALUES(`position`);
