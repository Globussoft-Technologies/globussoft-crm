ALTER TABLE `Role`
    ADD COLUMN `isCustom` BOOLEAN NOT NULL DEFAULT false,
    ADD INDEX `Role_tenantId_isCustom_isActive_idx`(`tenantId`, `isCustom`, `isActive`);
