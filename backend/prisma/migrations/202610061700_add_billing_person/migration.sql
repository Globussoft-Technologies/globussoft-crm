CREATE TABLE `BillingPerson` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `userId` INTEGER NULL,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `BillingPerson_userId_key`(`userId`),
  INDEX `BillingPerson_tenantId_isActive_idx`(`tenantId`, `isActive`),
  INDEX `BillingPerson_tenantId_name_idx`(`tenantId`, `name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BillingPerson`
  ADD CONSTRAINT `BillingPerson_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `BillingPerson_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
