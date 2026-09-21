-- Generic CRM shared pipeline stages.
-- Existing PipelineStage ids are preserved. The legacy pipelineId column is
-- retained for Wellness/Travel compatibility; Generic uses this join table.

-- The nullable legacy relation is retained so existing Wellness/Travel data
-- and API behavior remain intact while Generic CRM moves to assignments.
ALTER TABLE `PipelineStage`
  ADD COLUMN `pipelineId` INTEGER NULL,
  ADD INDEX `PipelineStage_tenantId_pipelineId_position_idx` (`tenantId`, `pipelineId`, `position`),
  ADD CONSTRAINT `PipelineStage_pipelineId_fkey`
    FOREIGN KEY (`pipelineId`) REFERENCES `Pipeline`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `PipelineStageAssignment` (
  `pipelineId` INTEGER NOT NULL,
  `stageId` INTEGER NOT NULL,
  `position` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`pipelineId`, `stageId`),
  INDEX `PipelineStageAssignment_stageId_position_idx` (`stageId`, `position`),
  INDEX `PipelineStageAssignment_pipelineId_position_idx` (`pipelineId`, `position`),
  CONSTRAINT `PipelineStageAssignment_pipelineId_fkey`
    FOREIGN KEY (`pipelineId`) REFERENCES `Pipeline`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PipelineStageAssignment_stageId_fkey`
    FOREIGN KEY (`stageId`) REFERENCES `PipelineStage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Migrate existing Generic CRM pipeline ownership into reusable assignments.
INSERT INTO `PipelineStageAssignment` (`pipelineId`, `stageId`, `position`)
SELECT ps.`pipelineId`, ps.`id`, ps.`position`
FROM `PipelineStage` ps
JOIN `Pipeline` p ON p.`id` = ps.`pipelineId`
JOIN `Tenant` t ON t.`id` = p.`tenantId`
WHERE ps.`pipelineId` IS NOT NULL AND t.`vertical` = 'generic'
ON DUPLICATE KEY UPDATE `position` = VALUES(`position`);

-- Generic stages are now shared entities. Clear only their legacy direct
-- ownership so deleting a Generic pipeline cannot delete a shared stage.
UPDATE `PipelineStage` ps
JOIN `Pipeline` p ON p.`id` = ps.`pipelineId`
JOIN `Tenant` t ON t.`id` = p.`tenantId`
SET ps.`pipelineId` = NULL
WHERE t.`vertical` = 'generic';
