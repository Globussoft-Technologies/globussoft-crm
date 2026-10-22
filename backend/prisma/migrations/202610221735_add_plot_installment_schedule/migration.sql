CREATE TABLE `PlotInstallment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `contactId` INTEGER NOT NULL,
  `sequenceNumber` INTEGER NOT NULL,
  `frequency` VARCHAR(191) NOT NULL,
  `dueDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(15, 2) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PLANNED',
  `paymentId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `PlotInstallment_tenantId_plotBookingId_sequenceNumber_key`(`tenantId`, `plotBookingId`, `sequenceNumber`),
  INDEX `PlotInstallment_tenantId_contactId_status_idx`(`tenantId`, `contactId`, `status`),
  INDEX `PlotInstallment_tenantId_dueDate_status_idx`(`tenantId`, `dueDate`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
