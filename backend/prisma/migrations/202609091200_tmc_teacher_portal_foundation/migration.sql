ALTER TABLE `Contact`
  ADD COLUMN `portalRole` VARCHAR(191) NULL DEFAULT 'CUSTOMER';

ALTER TABLE `TmcTrip`
  ADD COLUMN `teacherContactId` INTEGER NULL;

CREATE INDEX `Contact_portalRole_idx` ON `Contact`(`portalRole`);
CREATE INDEX `TmcTrip_tenantId_teacherContactId_idx` ON `TmcTrip`(`tenantId`, `teacherContactId`);

ALTER TABLE `TmcTrip`
  ADD CONSTRAINT `TmcTrip_teacherContactId_fkey`
  FOREIGN KEY (`teacherContactId`) REFERENCES `Contact`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `TmcParentTrip` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `parentContactId` INTEGER NOT NULL,
  `teacherContactId` INTEGER NOT NULL,
  `tripId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TmcParentTrip_tenantId_parentContactId_tripId_key`(`tenantId`, `parentContactId`, `tripId`),
  INDEX `TmcParentTrip_tenantId_teacherContactId_idx`(`tenantId`, `teacherContactId`),
  INDEX `TmcParentTrip_tenantId_tripId_idx`(`tenantId`, `tripId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TmcParentTrip`
  ADD CONSTRAINT `TmcParentTrip_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcParentTrip_parentContactId_fkey`
  FOREIGN KEY (`parentContactId`) REFERENCES `Contact`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcParentTrip_teacherContactId_fkey`
  FOREIGN KEY (`teacherContactId`) REFERENCES `Contact`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcParentTrip_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
