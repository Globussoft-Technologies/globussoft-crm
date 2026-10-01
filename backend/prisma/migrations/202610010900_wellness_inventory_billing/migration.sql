-- Wellness inventory billing snapshots and prescription-ledger provenance.
ALTER TABLE `Drug`
  ADD COLUMN `productCode` VARCHAR(191) NULL,
  ADD COLUMN `salePrice` DOUBLE NULL,
  ADD COLUMN `unit` VARCHAR(191) NULL;

ALTER TABLE `ServiceConsumption`
  ADD COLUMN `sourceType` VARCHAR(191) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN `transactionType` VARCHAR(191) NOT NULL DEFAULT 'Sale',
  ADD COLUMN `unit` VARCHAR(191) NULL,
  ADD COLUMN `productCode` VARCHAR(191) NULL,
  ADD COLUMN `salePrice` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `usageValue` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `drugId` INTEGER NULL,
  ADD COLUMN `prescriptionId` INTEGER NULL,
  ADD COLUMN `prescriptionLine` INTEGER NULL;

CREATE UNIQUE INDEX `ServiceConsumption_tenantId_prescriptionId_prescriptionLine_key`
  ON `ServiceConsumption`(`tenantId`, `prescriptionId`, `prescriptionLine`);

CREATE INDEX `ServiceConsumption_tenantId_drugId_idx`
  ON `ServiceConsumption`(`tenantId`, `drugId`);

ALTER TABLE `ServiceConsumption`
  ADD CONSTRAINT `ServiceConsumption_drugId_fkey`
    FOREIGN KEY (`drugId`) REFERENCES `Drug`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `ServiceConsumption_prescriptionId_fkey`
    FOREIGN KEY (`prescriptionId`) REFERENCES `Prescription`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
