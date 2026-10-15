ALTER TABLE `SalesTeam`
  ADD COLUMN `managerId` INTEGER NULL,
  ADD INDEX `SalesTeam_managerId_idx`(`managerId`);

ALTER TABLE `SalesTeam`
  ADD CONSTRAINT `SalesTeam_managerId_fkey`
  FOREIGN KEY (`managerId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
