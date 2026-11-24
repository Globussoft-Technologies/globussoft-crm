-- Durable Generic CRM dialing queue. Additive and safe for databases where
-- the table was already created manually or by a prior deployment.
CREATE TABLE IF NOT EXISTS `LeadDialJob` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `tenantId` INT NOT NULL,
  `userId` INT NOT NULL,
  `audience` TEXT NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
  `scheduledAt` DATETIME(3) NOT NULL,
  `upperBoundId` INT NOT NULL,
  `cursorId` INT NOT NULL DEFAULT 0,
  `total` INT NOT NULL DEFAULT 0,
  `completed` INT NOT NULL DEFAULT 0,
  `skipped` INT NOT NULL DEFAULT 0,
  `failed` INT NOT NULL DEFAULT 0,
  `activeCallLogId` INT NULL,
  `dispatching` BOOLEAN NOT NULL DEFAULT false,
  `leaseUntil` DATETIME(3) NULL,
  `error` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `LeadDialJob_status_scheduledAt_idx` (`status`, `scheduledAt`),
  INDEX `LeadDialJob_tenantId_status_leaseUntil_idx` (`tenantId`, `status`, `leaseUntil`),
  CONSTRAINT `LeadDialJob_tenantId_fkey`
    FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
