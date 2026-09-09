CREATE TABLE `TravelTallyCostCentre` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `itineraryId` INTEGER NOT NULL,
  `code` VARCHAR(80) NOT NULL,
  `name` VARCHAR(180) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `syncStatus` VARCHAR(30) NOT NULL DEFAULT 'NOT_CONNECTED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelTallyCostCentre_itineraryId_key` (`itineraryId`),
  UNIQUE INDEX `TravelTallyCostCentre_tenantId_code_key` (`tenantId`, `code`),
  INDEX `TravelTallyCostCentre_tenantId_status_idx` (`tenantId`, `status`),
  CONSTRAINT `TravelTallyCostCentre_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelTallyCostCentre_itineraryId_fkey` FOREIGN KEY (`itineraryId`) REFERENCES `Itinerary` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
