ALTER TABLE `SalesTeam`
  ADD COLUMN `createdById` INTEGER NULL,
  ADD COLUMN `updatedById` INTEGER NULL,
  ADD INDEX `SalesTeam_createdById_idx`(`createdById`),
  ADD INDEX `SalesTeam_updatedById_idx`(`updatedById`),
  ADD CONSTRAINT `SalesTeam_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesTeam_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `User`
  ADD COLUMN `jobTitle` VARCHAR(191) NULL,
  ADD COLUMN `workNumber` VARCHAR(191) NULL,
  ADD COLUMN `reportingToId` INTEGER NULL,
  ADD COLUMN `defaultPipelineId` INTEGER NULL;
