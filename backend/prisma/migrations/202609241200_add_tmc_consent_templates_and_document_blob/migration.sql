-- Store parent-uploaded document bytes in the tenant database when private
-- object storage is unavailable, and allow the URL to be absent in that mode.
ALTER TABLE `TmcParentDocument`
  MODIFY `fileUrl` TEXT NULL,
  ADD COLUMN `fileBlob` MEDIUMBLOB NULL AFTER `fileUrl`;

-- Tenant-scoped source PDFs used to generate the correct consent form for
-- day-trip, domestic, and international TMC workflows.
CREATE TABLE `TmcConsentTemplate` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `tripType` VARCHAR(191) NOT NULL,
  `filename` VARCHAR(191) NOT NULL,
  `mimeType` VARCHAR(191) NOT NULL,
  `fileSize` INTEGER NOT NULL,
  `fileBlob` MEDIUMBLOB NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TmcConsentTemplate_tenantId_tripType_key`(`tenantId`, `tripType`),
  INDEX `TmcConsentTemplate_tenantId_tripType_idx`(`tenantId`, `tripType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TmcConsentTemplate`
  ADD CONSTRAINT `TmcConsentTemplate_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
