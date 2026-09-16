-- Private documents uploaded by an authenticated TMC parent. Files remain in
-- the configured private object store; this table records their owner-scoped
-- metadata and the opaque storage locator used to mint short-lived URLs.
CREATE TABLE `TmcParentDocument` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `parentContactId` INTEGER NOT NULL,
  `tripId` INTEGER NULL,
  `documentType` VARCHAR(191) NOT NULL,
  `filename` VARCHAR(191) NOT NULL,
  `fileUrl` TEXT NOT NULL,
  `fileSize` INTEGER NULL,
  `mimeType` VARCHAR(191) NULL,
  `storage` VARCHAR(191) NULL,
  `storageKey` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'in_review',
  `notes` TEXT NULL,
  `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `TmcParentDocument_tenantId_parentContactId_createdAt_idx`(`tenantId`, `parentContactId`, `createdAt`),
  INDEX `TmcParentDocument_tenantId_tripId_idx`(`tenantId`, `tripId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TmcParentDocument`
  ADD CONSTRAINT `TmcParentDocument_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
