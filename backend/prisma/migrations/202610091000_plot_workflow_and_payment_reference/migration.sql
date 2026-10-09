ALTER TABLE `BillingPerson` ADD COLUMN `assignmentPairsJson` TEXT NULL;

ALTER TABLE `TransportPerson` ADD COLUMN `assignmentPairsJson` TEXT NULL;
ALTER TABLE `PlotBroker` ADD COLUMN `assignmentPairsJson` TEXT NULL;

CREATE TABLE `PlotBooking` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `bookingNumber` VARCHAR(191) NOT NULL,
  `tenantId` INTEGER NOT NULL,
  `contactId` INTEGER NOT NULL,
  `customerPickupId` INTEGER NULL,
  `plotSiteId` INTEGER NOT NULL,
  `transportPersonId` INTEGER NULL,
  `plotBrokerId` INTEGER NULL,
  `billingPersonId` INTEGER NULL,
  `invoiceId` INTEGER NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PLOT_RESERVED',
  `paymentStatus` VARCHAR(191) NOT NULL DEFAULT 'UNPAID',
  `totalAmount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
  `amountPaid` DECIMAL(15, 2) NOT NULL DEFAULT 0,
  `balance` DECIMAL(15, 2) NOT NULL DEFAULT 0,
  `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `soldAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PlotBooking_bookingNumber_key`(`bookingNumber`),
  INDEX `PlotBooking_tenantId_contactId_updatedAt_idx`(`tenantId`, `contactId`, `updatedAt`),
  INDEX `PlotBooking_tenantId_plotSiteId_status_idx`(`tenantId`, `plotSiteId`, `status`),
  INDEX `PlotBooking_tenantId_billingPersonId_status_idx`(`tenantId`, `billingPersonId`, `status`),
  INDEX `PlotBooking_tenantId_invoiceId_idx`(`tenantId`, `invoiceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlotInvoiceItem` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `invoiceId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NULL,
  `itemType` VARCHAR(191) NOT NULL DEFAULT 'PLOT',
  `itemId` INTEGER NULL,
  `description` VARCHAR(191) NOT NULL,
  `quantity` DECIMAL(12, 2) NOT NULL DEFAULT 1,
  `unitPrice` DECIMAL(15, 2) NOT NULL,
  `amount` DECIMAL(15, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `PlotInvoiceItem_tenantId_invoiceId_idx`(`tenantId`, `invoiceId`),
  INDEX `PlotInvoiceItem_tenantId_plotBookingId_idx`(`tenantId`, `plotBookingId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlotWorkflowEvent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NULL,
  `contactId` INTEGER NOT NULL,
  `plotSiteId` INTEGER NULL,
  `stage` VARCHAR(191) NOT NULL,
  `eventType` VARCHAR(191) NOT NULL,
  `label` VARCHAR(191) NOT NULL,
  `fromStatus` VARCHAR(191) NULL,
  `toStatus` VARCHAR(191) NULL,
  `actorUserId` INTEGER NULL,
  `metadataJson` TEXT NULL,
  `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `PlotWorkflowEvent_tenantId_contactId_occurredAt_idx`(`tenantId`, `contactId`, `occurredAt`),
  INDEX `PlotWorkflowEvent_tenantId_plotBookingId_occurredAt_idx`(`tenantId`, `plotBookingId`, `occurredAt`),
  INDEX `PlotWorkflowEvent_tenantId_eventType_occurredAt_idx`(`tenantId`, `eventType`, `occurredAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Invoice`
  ADD COLUMN `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
  ADD COLUMN `amountPaid` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `balance` DOUBLE NOT NULL DEFAULT 0;

UPDATE `Invoice` SET `balance` = `amount` WHERE `status` <> 'PAID';
UPDATE `Invoice` SET `amountPaid` = `amount`, `balance` = 0 WHERE `status` = 'PAID';

ALTER TABLE `PlotInvoiceItem`
  ADD CONSTRAINT `PlotInvoiceItem_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PlotInvoiceItem_plotBookingId_fkey` FOREIGN KEY (`plotBookingId`) REFERENCES `PlotBooking`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PlotWorkflowEvent`
  ADD CONSTRAINT `PlotWorkflowEvent_plotBookingId_fkey` FOREIGN KEY (`plotBookingId`) REFERENCES `PlotBooking`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Payment` ADD COLUMN `plotPaymentReference` VARCHAR(128) NULL;
CREATE UNIQUE INDEX `Payment_tenantId_plotPaymentReference_key` ON `Payment` (`tenantId`, `plotPaymentReference`);
