ALTER TABLE `Tenant`
  ADD COLUMN `organizationNameKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `Tenant_organizationNameKey_key`
  ON `Tenant`(`organizationNameKey`);

CREATE TABLE `GenericImportHistory` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `fileName` VARCHAR(191) NOT NULL,
  `inserted` INTEGER NOT NULL DEFAULT 0,
  `updated` INTEGER NOT NULL DEFAULT 0,
  `skipped` INTEGER NOT NULL DEFAULT 0,
  `errors` INTEGER NOT NULL DEFAULT 0,
  `contacts` JSON NULL,
  `completedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `GenericImportHistory_tenantId_completedAt_idx` (`tenantId`, `completedAt`),
  CONSTRAINT `GenericImportHistory_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
