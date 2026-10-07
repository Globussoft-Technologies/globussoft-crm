-- Generic CRM pickup locations and plot/site inventory.
CREATE TABLE `PickupLocation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `address` TEXT NOT NULL,
    `googleMapsLink` TEXT NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `tenantId` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PickupLocation_tenantId_isActive_idx`(`tenantId`, `isActive`),
    INDEX `PickupLocation_tenantId_name_idx`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlotSite` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `referenceCode` VARCHAR(191) NULL,
    `area` VARCHAR(191) NULL,
    `price` DECIMAL(15, 2) NULL,
    `availability` VARCHAR(191) NOT NULL DEFAULT 'AVAILABLE',
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `pickupLocationId` INTEGER NULL,
    `tenantId` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlotSite_tenantId_availability_isActive_idx`(`tenantId`, `availability`, `isActive`),
    INDEX `PlotSite_tenantId_pickupLocationId_idx`(`tenantId`, `pickupLocationId`),
    INDEX `PlotSite_tenantId_referenceCode_idx`(`tenantId`, `referenceCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PickupLocation`
    ADD CONSTRAINT `PickupLocation_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PlotSite`
    ADD CONSTRAINT `PlotSite_pickupLocationId_fkey`
    FOREIGN KEY (`pickupLocationId`) REFERENCES `PickupLocation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `PlotSite_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
