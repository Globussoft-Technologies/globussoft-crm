CREATE TABLE `WebFormFolder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tenantId` INTEGER NOT NULL,
    `scope` VARCHAR(191) NOT NULL DEFAULT 'generic',
    `name` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WebFormFolder_tenantId_scope_name_key`(`tenantId`, `scope`, `name`),
    INDEX `WebFormFolder_tenantId_scope_idx`(`tenantId`, `scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WebForm`
    ADD COLUMN `folderId` INTEGER NULL,
    ADD INDEX `WebForm_tenantId_scope_folderId_idx`(`tenantId`, `scope`, `folderId`);

ALTER TABLE `WebFormFolder`
    ADD CONSTRAINT `WebFormFolder_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WebForm`
    ADD CONSTRAINT `WebForm_folderId_fkey` FOREIGN KEY (`folderId`) REFERENCES `WebFormFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
