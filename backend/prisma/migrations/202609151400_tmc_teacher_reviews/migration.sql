CREATE TABLE `TmcTripTeacherReview` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `tripId` INTEGER NOT NULL,
  `teacherContactId` INTEGER NOT NULL,
  `reportDate` DATETIME(3) NOT NULL,
  `institution` VARCHAR(191) NOT NULL,
  `tourDestination` VARCHAR(191) NOT NULL,
  `coordinator` VARCHAR(191) NOT NULL,
  `grade` VARCHAR(191) NOT NULL,
  `travelRating` VARCHAR(191) NOT NULL,
  `foodRating` VARCHAR(191) NOT NULL,
  `activitiesRating` VARCHAR(191) NOT NULL,
  `careSupportRating` VARCHAR(191) NOT NULL,
  `overallRating` VARCHAR(191) NOT NULL,
  `feedback` TEXT NULL,
  `studentCount` INTEGER NOT NULL DEFAULT 0,
  `staffCount` INTEGER NOT NULL DEFAULT 0,
  `totalPassengers` INTEGER NOT NULL DEFAULT 0,
  `signature` VARCHAR(191) NOT NULL,
  `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TmcTripTeacherReview_tenantId_tripId_teacherContactId_key`(`tenantId`, `tripId`, `teacherContactId`),
  INDEX `TmcTripTeacherReview_tenantId_submittedAt_idx`(`tenantId`, `submittedAt`),
  INDEX `TmcTripTeacherReview_tenantId_tripId_idx`(`tenantId`, `tripId`),
  INDEX `TmcTripTeacherReview_tenantId_teacherContactId_idx`(`tenantId`, `teacherContactId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TmcTripTeacherReview`
  ADD CONSTRAINT `TmcTripTeacherReview_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcTripTeacherReview_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TmcTripTeacherReview_teacherContactId_fkey`
  FOREIGN KEY (`teacherContactId`) REFERENCES `Contact`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
