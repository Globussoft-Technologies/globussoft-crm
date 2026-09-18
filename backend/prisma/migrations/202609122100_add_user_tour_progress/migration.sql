ALTER TABLE `Tenant`
  ADD COLUMN `productToursEnabled` BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE `UserTourProgress` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `preferencesJson` TEXT NOT NULL,
  `progressJson` LONGTEXT NOT NULL,
  `progressResetAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `UserTourProgress_tenantId_userId_key`(`tenantId`, `userId`),
  INDEX `UserTourProgress_tenantId_idx`(`tenantId`),
  INDEX `UserTourProgress_userId_idx`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserTourProgress`
  ADD CONSTRAINT `UserTourProgress_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `UserTourProgress`
  ADD CONSTRAINT `UserTourProgress_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
