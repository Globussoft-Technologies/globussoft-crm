CREATE TABLE `TravelTallyLedgerGroup` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `subBrand` VARCHAR(50) NULL,
  `groupName` VARCHAR(120) NOT NULL,
  `parentGroup` VARCHAR(120) NULL,
  `nature` VARCHAR(30) NOT NULL DEFAULT 'OTHER',
  `source` VARCHAR(20) NOT NULL DEFAULT 'USER',
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `syncStatus` VARCHAR(30) NOT NULL DEFAULT 'NOT_CONNECTED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelTallyLedgerGroup_tenantId_subBrand_groupName_key` (`tenantId`, `subBrand`, `groupName`),
  INDEX `TravelTallyLedgerGroup_tenantId_status_idx` (`tenantId`, `status`),
  CONSTRAINT `TravelTallyLedgerGroup_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
