CREATE TABLE `TravelInvoiceSequence` (
  `tenantId` INTEGER NOT NULL,
  `year` INTEGER NOT NULL,
  `lastSerial` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`tenantId`, `year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the allocator from canonical historical invoice numbers. Custom
-- participant/sub-brand formats are deliberately excluded.
INSERT INTO `TravelInvoiceSequence` (`tenantId`, `year`, `lastSerial`, `createdAt`, `updatedAt`)
SELECT
  `tenantId`,
  CAST(SUBSTRING(`invoiceNum`, 6, 4) AS UNSIGNED),
  MAX(CAST(SUBSTRING_INDEX(`invoiceNum`, '-', -1) AS UNSIGNED)),
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `TravelInvoice`
WHERE `invoiceNum` REGEXP '^TINV-[0-9]{4}-[0-9]+$'
GROUP BY `tenantId`, CAST(SUBSTRING(`invoiceNum`, 6, 4) AS UNSIGNED);

ALTER TABLE `TravelInvoiceSequence`
  ADD CONSTRAINT `TravelInvoiceSequence_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
