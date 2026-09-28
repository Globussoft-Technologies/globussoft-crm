-- Travel/TMC meeting forms, their public booking attempts, serialized slot
-- claims, and tenant-owned encrypted Zoom connection values.
CREATE TABLE `TravelMeetingForm` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `subBrand` VARCHAR(191) NOT NULL DEFAULT 'tmc',
  `name` VARCHAR(191) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `publicKey` VARCHAR(191) NOT NULL,
  `apiKeyHash` VARCHAR(191) NOT NULL,
  `hostUserId` INTEGER NOT NULL,
  `durationMins` INTEGER NOT NULL DEFAULT 30,
  `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Kolkata',
  `slotIntervalMins` INTEGER NOT NULL DEFAULT 30,
  `bufferBeforeMins` INTEGER NOT NULL DEFAULT 0,
  `bufferAfterMins` INTEGER NOT NULL DEFAULT 0,
  `minimumNoticeMins` INTEGER NOT NULL DEFAULT 120,
  `bookingHorizonDays` INTEGER NOT NULL DEFAULT 60,
  `maxBookingsPerDay` INTEGER NULL,
  `allowedStartDate` DATETIME(3) NULL,
  `allowedEndDate` DATETIME(3) NULL,
  `weeklyHoursJson` TEXT NOT NULL,
  `dateOverridesJson` TEXT NULL,
  `blackoutDatesJson` TEXT NULL,
  `fieldsJson` TEXT NOT NULL,
  `allowedOriginsJson` TEXT NULL,
  `calendarProvider` VARCHAR(191) NOT NULL DEFAULT 'google',
  `createZoom` BOOLEAN NOT NULL DEFAULT true,
  `embedFontFamily` VARCHAR(191) NOT NULL DEFAULT 'Inter',
  `emailSubject` VARCHAR(191) NOT NULL DEFAULT 'Your Conversation with TMC is Confirmed',
  `emailBody` LONGTEXT NOT NULL,
  `emailLogoUrl` TEXT NULL,
  `confirmationMessage` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TravelMeetingForm_publicKey_key`(`publicKey`),
  UNIQUE INDEX `TravelMeetingForm_tenantId_slug_key`(`tenantId`, `slug`),
  INDEX `TravelMeetingForm_tenantId_subBrand_isActive_idx`(`tenantId`, `subBrand`, `isActive`),
  INDEX `TravelMeetingForm_tenantId_hostUserId_idx`(`tenantId`, `hostUserId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelMeetingBooking` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `meetingFormId` INTEGER NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `confirmationToken` VARCHAR(191) NOT NULL,
  `contactName` VARCHAR(191) NOT NULL,
  `designation` VARCHAR(191) NULL,
  `institution` VARCHAR(191) NULL,
  `city` VARCHAR(191) NULL,
  `contactEmail` VARCHAR(191) NOT NULL,
  `contactPhone` VARCHAR(191) NULL,
  `scheduledAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NOT NULL,
  `timezone` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PROCESSING',
  `meetingType` VARCHAR(191) NOT NULL DEFAULT 'ZOOM',
  `zoomMeetingId` VARCHAR(191) NULL,
  `meetingUrl` TEXT NULL,
  `calendarProvider` VARCHAR(191) NULL,
  `calendarEventId` VARCHAR(191) NULL,
  `contactId` INTEGER NULL,
  `diagnosticId` INTEGER NULL,
  `source` VARCHAR(191) NOT NULL DEFAULT 'Talk to an Expert',
  `customFieldsJson` TEXT NULL,
  `emailStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `emailChannel` VARCHAR(191) NULL,
  `emailMessageId` INTEGER NULL,
  `failureCode` VARCHAR(191) NULL,
  `failureMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TravelMeetingBooking_confirmationToken_key`(`confirmationToken`),
  UNIQUE INDEX `TravelMeetingBooking_tenantId_meetingFormId_idempotencyKey_key`(`tenantId`, `meetingFormId`, `idempotencyKey`),
  INDEX `TravelMeetingBooking_tenantId_meetingFormId_scheduledAt_idx`(`tenantId`, `meetingFormId`, `scheduledAt`),
  INDEX `TravelMeetingBooking_tenantId_contactId_idx`(`tenantId`, `contactId`),
  INDEX `TravelMeetingBooking_tenantId_status_idx`(`tenantId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelMeetingSlot` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `meetingFormId` INTEGER NOT NULL,
  `bookingId` INTEGER NOT NULL,
  `scheduledAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `TravelMeetingSlot_bookingId_key`(`bookingId`),
  UNIQUE INDEX `TravelMeetingSlot_tenantId_meetingFormId_scheduledAt_key`(`tenantId`, `meetingFormId`, `scheduledAt`),
  INDEX `TravelMeetingSlot_tenantId_meetingFormId_endsAt_idx`(`tenantId`, `meetingFormId`, `endsAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelMeetingZoomCredential` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `accountId` TEXT NOT NULL,
  `clientId` TEXT NOT NULL,
  `clientSecret` TEXT NOT NULL,
  `zoomHostUserId` VARCHAR(191) NOT NULL DEFAULT 'me',
  `status` VARCHAR(191) NOT NULL DEFAULT 'CONNECTED',
  `verifiedAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `TravelMeetingZoomCredential_tenantId_key`(`tenantId`),
  INDEX `TravelMeetingZoomCredential_tenantId_status_idx`(`tenantId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TravelMeetingForm`
  ADD CONSTRAINT `TravelMeetingForm_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TravelMeetingBooking`
  ADD CONSTRAINT `TravelMeetingBooking_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TravelMeetingBooking_meetingFormId_fkey`
  FOREIGN KEY (`meetingFormId`) REFERENCES `TravelMeetingForm`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TravelMeetingSlot`
  ADD CONSTRAINT `TravelMeetingSlot_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TravelMeetingSlot_meetingFormId_fkey`
  FOREIGN KEY (`meetingFormId`) REFERENCES `TravelMeetingForm`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TravelMeetingZoomCredential`
  ADD CONSTRAINT `TravelMeetingZoomCredential_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
