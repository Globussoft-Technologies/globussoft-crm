-- ServicePackage — saleable bundles of wellness services sold as N sessions.
--
-- Before this table the wellness "package builder" was a pricing calculator
-- that explicitly created no record ("Packages are computed on the fly"), so
-- a package could not be listed to a customer, priced consistently twice, or
-- bought. Admins now save named packages; the customer catalog lists the
-- public ones.
--
-- Non-destructive: new table only, no existing column or row is touched.
--
-- `serviceIds` is a JSON array of Service ids rather than a join table on
-- purpose: a package is a PRICED SNAPSHOT, and a service later being renamed,
-- repriced or retired must not silently mutate a package already quoted to a
-- customer. `grossPrice` and `price` are stored for the same reason.
CREATE TABLE `ServicePackage` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(191) NOT NULL,
  `description`     TEXT NULL,
  `serviceIds`      TEXT NOT NULL,
  `sessions`        INT NOT NULL DEFAULT 6,
  `discountPercent` INT NOT NULL DEFAULT 0,
  `grossPrice`      DOUBLE NOT NULL DEFAULT 0,
  `price`           DOUBLE NOT NULL DEFAULT 0,
  `currency`        VARCHAR(191) NOT NULL DEFAULT 'INR',
  `isActive`        BOOLEAN NOT NULL DEFAULT true,
  `isPublic`        BOOLEAN NOT NULL DEFAULT false,
  `tenantId`        INT NOT NULL DEFAULT 1,
  `createdBy`       INT NULL,
  `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3) NOT NULL,

  INDEX `ServicePackage_tenantId_isActive_idx` (`tenantId`, `isActive`),
  INDEX `ServicePackage_tenantId_isPublic_isActive_idx` (`tenantId`, `isPublic`, `isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ServicePackage`
  ADD CONSTRAINT `ServicePackage_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
