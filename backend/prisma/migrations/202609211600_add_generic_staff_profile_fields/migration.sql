ALTER TABLE `User`
  ADD COLUMN `jobTitle` VARCHAR(191) NULL,
  ADD COLUMN `workNumber` VARCHAR(191) NULL,
  ADD COLUMN `reportingToId` INTEGER NULL,
  ADD COLUMN `defaultPipelineId` INTEGER NULL,
  ADD INDEX `User_reportingToId_idx`(`reportingToId`),
  ADD INDEX `User_defaultPipelineId_idx`(`defaultPipelineId`),
  ADD CONSTRAINT `User_reportingToId_fkey`
    FOREIGN KEY (`reportingToId`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `User_defaultPipelineId_fkey`
    FOREIGN KEY (`defaultPipelineId`) REFERENCES `Pipeline`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
