CREATE TABLE `TravelTallyVoucherType` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `subBrand` VARCHAR(50) NULL,
  `name` VARCHAR(60) NOT NULL,
  `numberingMode` VARCHAR(20) NOT NULL DEFAULT 'AUTO',
  `prefix` VARCHAR(30) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelTallyVoucherType_tenantId_subBrand_name_key` (`tenantId`, `subBrand`, `name`),
  INDEX `TravelTallyVoucherType_tenantId_status_idx` (`tenantId`, `status`),
  CONSTRAINT `TravelTallyVoucherType_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelTallyPaymentAccount` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `subBrand` VARCHAR(50) NULL,
  `mode` VARCHAR(30) NOT NULL,
  `accountName` VARCHAR(120) NOT NULL,
  `ledgerId` INTEGER NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelTallyPaymentAccount_tenantId_subBrand_mode_accountName_key` (`tenantId`, `subBrand`, `mode`, `accountName`),
  INDEX `TravelTallyPaymentAccount_tenantId_mode_status_idx` (`tenantId`, `mode`, `status`),
  CONSTRAINT `TravelTallyPaymentAccount_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelTallyPaymentAccount_ledgerId_fkey` FOREIGN KEY (`ledgerId`) REFERENCES `TravelTallyLedger` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelTallyTaxMaster` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `subBrand` VARCHAR(50) NULL,
  `taxName` VARCHAR(120) NOT NULL,
  `taxType` VARCHAR(20) NOT NULL,
  `ledgerId` INTEGER NULL,
  `rate` DECIMAL(8,3) NOT NULL,
  `calculationBasis` VARCHAR(30) NOT NULL DEFAULT 'TAXABLE_VALUE',
  `applicability` VARCHAR(255) NULL,
  `effectiveFrom` DATETIME(3) NULL,
  `effectiveTo` DATETIME(3) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelTallyTaxMaster_tenantId_subBrand_taxName_taxType_key` (`tenantId`, `subBrand`, `taxName`, `taxType`),
  INDEX `TravelTallyTaxMaster_tenantId_taxType_status_idx` (`tenantId`, `taxType`, `status`),
  CONSTRAINT `TravelTallyTaxMaster_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelTallyTaxMaster_ledgerId_fkey` FOREIGN KEY (`ledgerId`) REFERENCES `TravelTallyLedger` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
