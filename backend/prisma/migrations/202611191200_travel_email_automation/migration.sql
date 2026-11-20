CREATE TABLE `TravelEmailTemplate` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `subBrand` VARCHAR(50) NULL,
  `eventKey` VARCHAR(100) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `TravelEmailTemplate_tenant_event_brand_active_idx` (`tenantId`, `eventKey`, `subBrand`, `isActive`),
  INDEX `TravelEmailTemplate_tenant_updated_idx` (`tenantId`, `updatedAt`),
  CONSTRAINT `TravelEmailTemplate_tenantId_travel_automation_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelEmailSequence` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `subBrand` VARCHAR(50) NULL,
  `name` VARCHAR(160) NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `TravelEmailSequence_tenant_brand_active_idx` (`tenantId`, `subBrand`, `isActive`),
  CONSTRAINT `TravelEmailSequence_tenantId_travel_automation_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelEmailSequenceStep` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `sequenceId` INTEGER NOT NULL,
  `templateId` INTEGER NOT NULL,
  `position` INTEGER NOT NULL,
  `delayMinutes` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TravelEmailSequenceStep_sequence_position_key` (`sequenceId`, `position`),
  INDEX `TravelEmailSequenceStep_template_idx` (`templateId`),
  CONSTRAINT `TravelEmailSequenceStep_sequenceId_travel_automation_fkey` FOREIGN KEY (`sequenceId`) REFERENCES `TravelEmailSequence` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelEmailSequenceStep_templateId_travel_automation_fkey` FOREIGN KEY (`templateId`) REFERENCES `TravelEmailTemplate` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelEmailEnrollment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `sequenceId` INTEGER NOT NULL,
  `contactId` INTEGER NULL,
  `eventKey` VARCHAR(100) NOT NULL,
  `recipientEmail` VARCHAR(255) NOT NULL,
  `currentStep` INTEGER NOT NULL DEFAULT 0,
  `status` VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  `nextRun` DATETIME(3) NULL,
  `eventPayloadJson` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `TravelEmailEnrollment_tenant_status_nextRun_idx` (`tenantId`, `status`, `nextRun`),
  INDEX `TravelEmailEnrollment_tenant_contact_created_idx` (`tenantId`, `contactId`, `createdAt`),
  CONSTRAINT `TravelEmailEnrollment_tenantId_travel_automation_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelEmailEnrollment_sequenceId_travel_automation_fkey` FOREIGN KEY (`sequenceId`) REFERENCES `TravelEmailSequence` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TravelEmailDeliveryLog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `sequenceId` INTEGER NULL,
  `enrollmentId` INTEGER NULL,
  `stepId` INTEGER NULL,
  `templateId` INTEGER NULL,
  `contactId` INTEGER NULL,
  `eventKey` VARCHAR(100) NOT NULL,
  `recipientEmail` VARCHAR(255) NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `status` VARCHAR(30) NOT NULL,
  `provider` VARCHAR(50) NULL,
  `providerMessageId` VARCHAR(255) NULL,
  `errorMessage` TEXT NULL,
  `sentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `TravelEmailDeliveryLog_tenant_created_idx` (`tenantId`, `createdAt`),
  INDEX `TravelEmailDeliveryLog_tenant_status_created_idx` (`tenantId`, `status`, `createdAt`),
  INDEX `TravelEmailDeliveryLog_tenant_event_contact_idx` (`tenantId`, `eventKey`, `contactId`),
  CONSTRAINT `TravelEmailDeliveryLog_tenantId_travel_automation_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `TravelEmailDeliveryLog_sequenceId_travel_automation_fkey` FOREIGN KEY (`sequenceId`) REFERENCES `TravelEmailSequence` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `TravelEmailDeliveryLog_enrollmentId_travel_automation_fkey` FOREIGN KEY (`enrollmentId`) REFERENCES `TravelEmailEnrollment` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `TravelEmailDeliveryLog_templateId_travel_automation_fkey` FOREIGN KEY (`templateId`) REFERENCES `TravelEmailTemplate` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
