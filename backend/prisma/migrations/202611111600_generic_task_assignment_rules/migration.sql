ALTER TABLE `Task`
  ADD COLUMN `createdById` INTEGER NULL;

CREATE INDEX `Task_tenantId_createdById_idx` ON `Task`(`tenantId`, `createdById`);

ALTER TABLE `Task`
  ADD CONSTRAINT `Task_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
