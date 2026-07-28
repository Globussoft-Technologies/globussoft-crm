-- Passport identity linking layer for verified travel passports.
-- Safe/additive: all new FKs on existing tables are nullable.

CREATE TABLE `PassportIdentity` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `tenantId` INT NOT NULL DEFAULT 1,
  `contactId` INT NULL,
  `normalizedPassportNumber` VARCHAR(191) NULL,
  `passportNumber` VARCHAR(191) NULL,
  `fullName` VARCHAR(191) NULL,
  `normalizedFullName` VARCHAR(191) NULL,
  `dateOfBirth` DATETIME(3) NULL,
  `phoneNormalized` VARCHAR(191) NULL,
  `nationality` VARCHAR(191) NULL,
  `passportExpiry` DATETIME(3) NULL,
  `confidenceJson` TEXT NULL,
  `sourceType` VARCHAR(191) NOT NULL,
  `sourceId` INT NOT NULL,
  `verifiedAt` DATETIME(3) NULL,
  `verifiedById` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `PassportIdentity_tenantId_normalizedPassportNumber_key` (`tenantId`, `normalizedPassportNumber`),
  KEY `PassportIdentity_tenantId_contactId_idx` (`tenantId`, `contactId`),
  KEY `PassportIdentity_name_dob_phone_idx` (`tenantId`, `normalizedFullName`, `dateOfBirth`, `phoneNormalized`),
  KEY `PassportIdentity_verifiedById_idx` (`verifiedById`),
  CONSTRAINT `PassportIdentity_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PassportIdentity_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `Contact` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PassportIdentity_verifiedById_fkey` FOREIGN KEY (`verifiedById`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TripParticipant`
  ADD COLUMN `passportIdentityId` INT NULL,
  ADD KEY `TripParticipant_passportIdentityId_idx` (`passportIdentityId`),
  ADD CONSTRAINT `TripParticipant_passportIdentityId_fkey` FOREIGN KEY (`passportIdentityId`) REFERENCES `PassportIdentity` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CustomerTraveller`
  ADD COLUMN `passportIdentityId` INT NULL,
  ADD KEY `CustomerTraveller_passportIdentityId_idx` (`passportIdentityId`),
  ADD CONSTRAINT `CustomerTraveller_passportIdentityId_fkey` FOREIGN KEY (`passportIdentityId`) REFERENCES `PassportIdentity` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `VisaApplication`
  ADD COLUMN `passportIdentityId` INT NULL,
  ADD KEY `VisaApplication_passportIdentityId_idx` (`passportIdentityId`),
  ADD CONSTRAINT `VisaApplication_passportIdentityId_fkey` FOREIGN KEY (`passportIdentityId`) REFERENCES `PassportIdentity` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
