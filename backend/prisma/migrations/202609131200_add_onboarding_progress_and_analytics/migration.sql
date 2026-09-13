ALTER TABLE `UserTourProgress`
  ADD COLUMN `checklistJson` TEXT NULL,
  ADD COLUMN `dismissedAnnouncementsJson` TEXT NULL;

CREATE TABLE `OnboardingEvent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `eventType` VARCHAR(40) NOT NULL,
  `featureKey` VARCHAR(100) NULL,
  `tourKey` VARCHAR(100) NULL,
  `stepKey` VARCHAR(100) NULL,
  `reason` VARCHAR(80) NULL,
  `sessionId` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `OnboardingEvent_tenantId_eventType_createdAt_idx` (`tenantId`, `eventType`, `createdAt`),
  INDEX `OnboardingEvent_tenantId_tourKey_eventType_idx` (`tenantId`, `tourKey`, `eventType`),
  INDEX `OnboardingEvent_userId_createdAt_idx` (`userId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `OnboardingEvent_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `OnboardingEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
