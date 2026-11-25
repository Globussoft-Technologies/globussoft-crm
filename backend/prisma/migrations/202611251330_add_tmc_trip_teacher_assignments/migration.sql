CREATE TABLE `TmcTripTeacherAssignment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `tripId` INTEGER NOT NULL,
  `teacherContactId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `TmcTripTeacherAssignment_tenantId_tripId_teacherContactId_key`(`tenantId`, `tripId`, `teacherContactId`),
  INDEX `TmcTripTeacherAssignment_tenantId_teacherContactId_idx`(`tenantId`, `teacherContactId`),
  INDEX `TmcTripTeacherAssignment_tenantId_tripId_idx`(`tenantId`, `tripId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `TmcTripTeacherAssignment` (`tenantId`, `tripId`, `teacherContactId`)
SELECT `tenantId`, `id`, `teacherContactId`
FROM `TmcTrip`
WHERE `teacherContactId` IS NOT NULL;

ALTER TABLE `TmcTripTeacherAssignment`
  ADD CONSTRAINT `TmcTripTeacherAssignment_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcTripTeacherAssignment_tripId_fkey`
    FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcTripTeacherAssignment_teacherContactId_fkey`
    FOREIGN KEY (`teacherContactId`) REFERENCES `Contact`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
