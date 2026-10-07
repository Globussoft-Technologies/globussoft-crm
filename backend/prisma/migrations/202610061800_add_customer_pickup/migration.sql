CREATE TABLE `CustomerPickup` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `contactId` INTEGER NOT NULL,
  `pickupAddress` TEXT NOT NULL,
  `sourceTranscriptId` VARCHAR(191) NULL,
  `sourceExcerpt` TEXT NULL,
  `capturedByUserId` INTEGER NULL,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `CustomerPickup_tenantId_contactId_key`(`tenantId`, `contactId`),
  INDEX `CustomerPickup_tenantId_updatedAt_idx`(`tenantId`, `updatedAt`),
  INDEX `CustomerPickup_contactId_idx`(`contactId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CustomerPickup`
  ADD CONSTRAINT `CustomerPickup_contactId_fkey`
  FOREIGN KEY (`contactId`) REFERENCES `Contact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CustomerPickup`
  ADD CONSTRAINT `CustomerPickup_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
