-- Per-Product sales report — imported snapshots (ProductSalesImport +
-- ProductSalesImportRow).
--
-- The live source for the /wellness/reports "Per Product" tab is POS
-- (SaleLineItem where lineType='PRODUCT' on a COMPLETED Sale). These two
-- tables hold the CSV/XLSX product-sales exports a clinic brings over from
-- the PMS it is migrating off, so the tab has history before POS does.
--
-- Non-destructive: two new tables, no existing column or row is touched.
--
-- ProductSalesImport is one uploaded file covering one operator-declared
-- period (the export files carry no date column, so the period cannot be
-- inferred). Its rollup columns are denormalised sums of its rows so the
-- imports list renders without aggregating.
--
-- ProductSalesImportRow.productId is a best-effort catalogue match resolved
-- once at import time, deliberately NOT a foreign key — a historical
-- snapshot must keep resolving after the Product row is renamed or deleted.
CREATE TABLE `ProductSalesImport` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `tenantId`     INT NOT NULL DEFAULT 1,
  `fileName`     VARCHAR(191) NULL,
  `periodStart`  DATETIME(3) NOT NULL,
  `periodEnd`    DATETIME(3) NOT NULL,
  `note`         TEXT NULL,
  `rowCount`     INT NOT NULL DEFAULT 0,
  `productCount` INT NOT NULL DEFAULT 0,
  `grossSales`   DOUBLE NOT NULL DEFAULT 0,
  `discount`     DOUBLE NOT NULL DEFAULT 0,
  `netSales`     DOUBLE NOT NULL DEFAULT 0,
  `tax`          DOUBLE NOT NULL DEFAULT 0,
  `totalSales`   DOUBLE NOT NULL DEFAULT 0,
  `importedBy`   INT NULL,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ProductSalesImport_tenantId_periodStart_periodEnd_idx` (`tenantId`, `periodStart`, `periodEnd`),
  INDEX `ProductSalesImport_tenantId_createdAt_idx` (`tenantId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductSalesImportRow` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `tenantId`     INT NOT NULL DEFAULT 1,
  `importId`     INT NOT NULL,
  `productName`  VARCHAR(191) NOT NULL,
  `hsnCode`      VARCHAR(191) NULL,
  `productId`    INT NULL,
  `productCount` INT NOT NULL DEFAULT 0,
  `grossSales`   DOUBLE NOT NULL DEFAULT 0,
  `discount`     DOUBLE NOT NULL DEFAULT 0,
  `netSales`     DOUBLE NOT NULL DEFAULT 0,
  `tax`          DOUBLE NOT NULL DEFAULT 0,
  `totalSales`   DOUBLE NOT NULL DEFAULT 0,

  INDEX `ProductSalesImportRow_tenantId_importId_idx` (`tenantId`, `importId`),
  INDEX `ProductSalesImportRow_tenantId_productName_idx` (`tenantId`, `productName`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductSalesImport`
  ADD CONSTRAINT `ProductSalesImport_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProductSalesImportRow`
  ADD CONSTRAINT `ProductSalesImportRow_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProductSalesImportRow`
  ADD CONSTRAINT `ProductSalesImportRow_importId_fkey`
  FOREIGN KEY (`importId`) REFERENCES `ProductSalesImport`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
