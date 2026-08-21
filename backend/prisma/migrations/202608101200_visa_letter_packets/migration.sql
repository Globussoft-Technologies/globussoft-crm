CREATE TABLE `VisaLetterTemplate` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `code` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `documentType` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `contentHtml` LONGTEXT NOT NULL,
  `requiredFieldsJson` TEXT NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdById` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `VisaLetterTemplate_tenantId_code_version_key` (`tenantId`, `code`, `version`),
  INDEX `VisaLetterTemplate_tenantId_code_isActive_idx` (`tenantId`, `code`, `isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VisaLetterGeneration` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `visaApplicationId` INTEGER NOT NULL,
  `tripId` INTEGER NOT NULL,
  `participantId` INTEGER NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATED',
  `generatedById` INTEGER NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sentAt` DATETIME(3) NULL,
  `dataSnapshotJson` LONGTEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `VisaLetterGeneration_tenantId_visaApplicationId_createdAt_idx` (`tenantId`, `visaApplicationId`, `createdAt`),
  INDEX `VisaLetterGeneration_tenantId_participantId_idx` (`tenantId`, `participantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VisaLetterDocument` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `generationId` INTEGER NOT NULL,
  `visaApplicationId` INTEGER NOT NULL,
  `tripId` INTEGER NOT NULL,
  `participantId` INTEGER NOT NULL,
  `templateId` INTEGER NOT NULL,
  `templateCode` VARCHAR(191) NOT NULL,
  `templateVersion` INTEGER NOT NULL,
  `documentType` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATED',
  `generatedFileUrl` TEXT NOT NULL,
  `generatedFileKey` VARCHAR(191) NOT NULL,
  `generatedFileStorage` VARCHAR(191) NOT NULL,
  `generatedFileName` VARCHAR(191) NOT NULL,
  `signedFileUrl` TEXT NULL,
  `signedFileKey` VARCHAR(191) NULL,
  `signedFileStorage` VARCHAR(191) NULL,
  `signedFileName` VARCHAR(191) NULL,
  `generatedDataSnapshotJson` LONGTEXT NOT NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sentAt` DATETIME(3) NULL,
  `signedUploadedAt` DATETIME(3) NULL,
  `signedUploadedByContactId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `VisaLetterDocument_tenantId_visaApplicationId_status_idx` (`tenantId`, `visaApplicationId`, `status`),
  INDEX `VisaLetterDocument_generationId_idx` (`generationId`),
  INDEX `VisaLetterDocument_participantId_idx` (`participantId`),
  INDEX `VisaLetterDocument_templateId_idx` (`templateId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VisaLetterTemplate`
  ADD CONSTRAINT `VisaLetterTemplate_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `VisaLetterGeneration`
  ADD CONSTRAINT `VisaLetterGeneration_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterGeneration_visaApplicationId_fkey`
  FOREIGN KEY (`visaApplicationId`) REFERENCES `VisaApplication`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterGeneration_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterGeneration_participantId_fkey`
  FOREIGN KEY (`participantId`) REFERENCES `TripParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `VisaLetterDocument`
  ADD CONSTRAINT `VisaLetterDocument_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterDocument_generationId_fkey`
  FOREIGN KEY (`generationId`) REFERENCES `VisaLetterGeneration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterDocument_visaApplicationId_fkey`
  FOREIGN KEY (`visaApplicationId`) REFERENCES `VisaApplication`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterDocument_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterDocument_participantId_fkey`
  FOREIGN KEY (`participantId`) REFERENCES `TripParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaLetterDocument_templateId_fkey`
  FOREIGN KEY (`templateId`) REFERENCES `VisaLetterTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
