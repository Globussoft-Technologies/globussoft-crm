-- Generic CRM transport contacts and plot broker assignments.
CREATE TABLE `TransportPerson` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `alternatePhone` VARCHAR(191) NULL,
    `vehicleType` VARCHAR(191) NULL,
    `vehicleNumber` VARCHAR(191) NULL,
    `serviceArea` TEXT NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `pickupLocationId` INTEGER NULL,
    `tenantId` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TransportPerson_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `TransportPerson_tenantId_name_idx`(`tenantId`, `name`),
    INDEX `TransportPerson_tenantId_pickupLocationId_idx`(`tenantId`, `pickupLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlotBroker` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `agency` VARCHAR(191) NULL,
    `commissionPercent` DECIMAL(5, 2) NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `plotSiteId` INTEGER NULL,
    `tenantId` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlotBroker_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `PlotBroker_tenantId_name_idx`(`tenantId`, `name`),
    INDEX `PlotBroker_tenantId_plotSiteId_idx`(`tenantId`, `plotSiteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TransportPerson`
    ADD CONSTRAINT `TransportPerson_pickupLocationId_fkey`
    FOREIGN KEY (`pickupLocationId`) REFERENCES `PickupLocation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `TransportPerson_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PlotBroker`
    ADD CONSTRAINT `PlotBroker_plotSiteId_fkey`
    FOREIGN KEY (`plotSiteId`) REFERENCES `PlotSite`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `PlotBroker_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
