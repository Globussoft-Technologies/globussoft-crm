ALTER TABLE `Invoice`
  ADD COLUMN `patientId` INT NULL,
  ADD COLUMN `customerName` VARCHAR(191) NULL,
  ADD COLUMN `customerPhone` VARCHAR(191) NULL,
  ADD COLUMN `customerEmail` VARCHAR(191) NULL,
  ADD COLUMN `customerAddress` TEXT NULL,
  ADD COLUMN `gstin` VARCHAR(15) NULL,
  ADD COLUMN `billingAddress` TEXT NULL,
  ADD COLUMN `shippingAddress` TEXT NULL,
  ADD COLUMN `paymentMode` VARCHAR(32) NULL,
  ADD COLUMN `lineItemsJson` TEXT NULL;

CREATE INDEX `Invoice_tenantId_patientId_idx` ON `Invoice`(`tenantId`, `patientId`);
