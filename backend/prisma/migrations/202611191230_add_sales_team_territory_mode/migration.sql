ALTER TABLE `SalesTeam`
  ADD COLUMN `territoryMode` VARCHAR(191) NOT NULL DEFAULT 'individual',
  ADD COLUMN `territoryId` INT NULL;
