-- Additive Phase 1 deposit-distribution ledger. Existing plot/payment tables
-- are intentionally untouched; all new records are tenant-scoped.

CREATE TABLE `PayoutPartner` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `partnerType` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `mobile` VARCHAR(191) NULL,
  `email` VARCHAR(191) NULL,
  `pan` VARCHAR(191) NULL,
  `gstin` VARCHAR(191) NULL,
  `bankAccountCiphertext` TEXT NULL,
  `bankAccountLast4` VARCHAR(191) NULL,
  `ifsc` VARCHAR(191) NULL,
  `bankVerified` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  `plotBrokerId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `PayoutPartner_tenantId_partnerType_status_idx`(`tenantId`, `partnerType`, `status`),
  INDEX `PayoutPartner_tenantId_mobile_idx`(`tenantId`, `mobile`),
  INDEX `PayoutPartner_tenantId_plotBrokerId_idx`(`tenantId`, `plotBrokerId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutPartner_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlotOwnership` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotSiteId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NOT NULL,
  `ownershipBp` INTEGER NOT NULL,
  `askedPricePaise` BIGINT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PlotOwnership_tenantId_plotSiteId_payoutPartnerId_key`(`tenantId`, `plotSiteId`, `payoutPartnerId`),
  INDEX `PlotOwnership_tenantId_plotSiteId_idx`(`tenantId`, `plotSiteId`),
  INDEX `PlotOwnership_tenantId_payoutPartnerId_idx`(`tenantId`, `payoutPartnerId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PlotOwnership_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutCommissionRule` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NOT NULL,
  `plotSiteId` INTEGER NULL,
  `ruleType` VARCHAR(191) NOT NULL,
  `rateBp` INTEGER NOT NULL DEFAULT 0,
  `flatPaise` BIGINT NOT NULL DEFAULT 0,
  `paidFrom` VARCHAR(191) NOT NULL DEFAULT 'COMPANY_MARGIN',
  `effectiveFrom` DATETIME(3) NULL,
  `effectiveTo` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `PayoutCommissionRule_tenantId_payoutPartnerId_plotSiteId_idx`(`tenantId`, `payoutPartnerId`, `plotSiteId`),
  INDEX `PayoutCommissionRule_tenantId_effectiveFrom_effectiveTo_idx`(`tenantId`, `effectiveFrom`, `effectiveTo`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutCommissionRule_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutSettings` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `scopeKey` VARCHAR(191) NOT NULL DEFAULT 'TENANT',
  `pricingModel` VARCHAR(191) NOT NULL DEFAULT 'MARKUP',
  `splitMethod` VARCHAR(191) NOT NULL DEFAULT 'PRO_RATA',
  `companyMarkupBp` INTEGER NOT NULL DEFAULT 0,
  `cpCapBp` INTEGER NOT NULL DEFAULT 0,
  `floorMarginPaise` BIGINT NOT NULL DEFAULT 0,
  `companyCommissionBp` INTEGER NOT NULL DEFAULT 100,
  `holdTrigger` VARCHAR(191) NOT NULL DEFAULT 'AGREEMENT_SIGNED',
  `holdValue` VARCHAR(191) NOT NULL DEFAULT 'AGREEMENT_SIGNED',
  `ownerRelease` VARCHAR(191) NOT NULL DEFAULT 'ON_VERIFY',
  `dualApprovalThresholdPaise` BIGINT NOT NULL DEFAULT 5000000,
  `allowCustomSplit` BOOLEAN NOT NULL DEFAULT false,
  `maxTotalCommissionBp` INTEGER NOT NULL DEFAULT 1000,
  `reraEnabled` BOOLEAN NOT NULL DEFAULT false,
  `reraEscrowLabel` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PayoutSettings_tenantId_scopeKey_key`(`tenantId`, `scopeKey`),
  INDEX `PayoutSettings_tenantId_pricingModel_splitMethod_idx`(`tenantId`, `pricingModel`, `splitMethod`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutSettings_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BookingPricingSnapshot` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `plotSiteId` INTEGER NOT NULL,
  `contactId` INTEGER NOT NULL,
  `ownerPartnerIdsJson` TEXT NULL,
  `channelPartnerId` INTEGER NULL,
  `brokerPartnerId` INTEGER NULL,
  `basePricePaise` BIGINT NOT NULL,
  `listPricePaise` BIGINT NOT NULL,
  `finalPricePaise` BIGINT NOT NULL,
  `cpMarkupPaise` BIGINT NOT NULL DEFAULT 0,
  `brokerCommissionPaise` BIGINT NOT NULL DEFAULT 0,
  `cpCommissionPaise` BIGINT NOT NULL DEFAULT 0,
  `pricingModel` VARCHAR(191) NOT NULL,
  `splitMethod` VARCHAR(191) NOT NULL,
  `splitMode` VARCHAR(191) NOT NULL DEFAULT 'CONFIGURED',
  `bookingStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING_SPLIT_APPROVAL',
  `holdTrigger` VARCHAR(191) NOT NULL,
  `ownerRelease` VARCHAR(191) NOT NULL,
  `rulesJson` TEXT NULL,
  `createdByUserId` INTEGER NOT NULL,
  `approvedByUserId` INTEGER NULL,
  `approvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `BookingPricingSnapshot_tenantId_plotBookingId_key`(`tenantId`, `plotBookingId`),
  INDEX `BookingPricingSnapshot_tenantId_bookingStatus_updatedAt_idx`(`tenantId`, `bookingStatus`, `updatedAt`),
  INDEX `BookingPricingSnapshot_tenantId_plotSiteId_createdAt_idx`(`tenantId`, `plotSiteId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `BookingPricingSnapshot_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentReceipt` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `bookingSnapshotId` INTEGER NULL,
  `amountPaise` BIGINT NOT NULL,
  `mode` VARCHAR(191) NOT NULL,
  `referenceNo` VARCHAR(191) NULL,
  `receivedOn` DATETIME(3) NOT NULL,
  `proofDocumentId` INTEGER NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'RECORDED',
  `receivedInAccount` VARCHAR(191) NULL,
  `createdByUserId` INTEGER NOT NULL,
  `verifiedByUserId` INTEGER NULL,
  `verifiedAt` DATETIME(3) NULL,
  `paymentId` INTEGER NULL,
  `rejectionReason` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PaymentReceipt_tenantId_mode_referenceNo_key`(`tenantId`, `mode`, `referenceNo`),
  INDEX `PaymentReceipt_tenantId_plotBookingId_status_receivedOn_idx`(`tenantId`, `plotBookingId`, `status`, `receivedOn`),
  INDEX `PaymentReceipt_tenantId_paymentId_idx`(`tenantId`, `paymentId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PaymentReceipt_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DistributionLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `paymentReceiptId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NULL,
  `partyType` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `grossPaise` BIGINT NOT NULL,
  `tdsBp` INTEGER NOT NULL DEFAULT 0,
  `tdsPaise` BIGINT NOT NULL DEFAULT 0,
  `gstBp` INTEGER NOT NULL DEFAULT 0,
  `gstPaise` BIGINT NOT NULL DEFAULT 0,
  `netPaise` BIGINT NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING_HOLD',
  `holdUntil` DATETIME(3) NULL,
  `approvedByUserId` INTEGER NULL,
  `approvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DistributionLine_tenantId_paymentReceiptId_partyType_payoutPartnerId_kind_key`(`tenantId`, `paymentReceiptId`, `partyType`, `payoutPartnerId`, `kind`),
  INDEX `DistributionLine_tenantId_plotBookingId_status_createdAt_idx`(`tenantId`, `plotBookingId`, `status`, `createdAt`),
  INDEX `DistributionLine_tenantId_payoutPartnerId_status_idx`(`tenantId`, `payoutPartnerId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `DistributionLine_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Payout` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NOT NULL,
  `totalNetPaise` BIGINT NOT NULL,
  `utr` VARCHAR(191) NOT NULL,
  `paidOn` DATETIME(3) NOT NULL,
  `bankProofDocumentId` INTEGER NULL,
  `advicePdfDocumentId` INTEGER NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PAID',
  `acknowledgedAt` DATETIME(3) NULL,
  `disputedAt` DATETIME(3) NULL,
  `disputeReason` TEXT NULL,
  `createdByUserId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `Payout_tenantId_utr_key`(`tenantId`, `utr`),
  INDEX `Payout_tenantId_payoutPartnerId_paidOn_idx`(`tenantId`, `payoutPartnerId`, `paidOn`),
  PRIMARY KEY (`id`),
  CONSTRAINT `Payout_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `payoutId` INTEGER NOT NULL,
  `distributionLineId` INTEGER NOT NULL,
  `amountPaise` BIGINT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `PayoutLine_distributionLineId_key`(`distributionLineId`),
  INDEX `PayoutLine_tenantId_payoutId_idx`(`tenantId`, `payoutId`),
  INDEX `PayoutLine_tenantId_distributionLineId_idx`(`tenantId`, `distributionLineId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutLine_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutDocument` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `fileUrl` VARCHAR(191) NOT NULL,
  `fileName` VARCHAR(191) NULL,
  `mimeType` VARCHAR(191) NULL,
  `sizeBytes` INTEGER NULL,
  `uploadedByUserId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `PayoutDocument_tenantId_kind_createdAt_idx`(`tenantId`, `kind`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutDocument_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `IdempotencyRecord` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `scope` VARCHAR(191) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `statusCode` INTEGER NOT NULL,
  `responseJson` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `IdempotencyRecord_tenantId_scope_key_key`(`tenantId`, `scope`, `key`),
  INDEX `IdempotencyRecord_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `IdempotencyRecord_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BookingPricingSnapshot`
  ADD COLUMN `customSplitJson` LONGTEXT NULL,
  ADD COLUMN `lockedAt` DATETIME(3) NULL,
  ADD COLUMN `cancelledAt` DATETIME(3) NULL,
  ADD COLUMN `cancellationReason` TEXT NULL;

ALTER TABLE `PaymentReceipt`
  ADD COLUMN `installmentNumber` INTEGER NULL;

ALTER TABLE `DistributionLine`
  ADD COLUMN `financeApprovedByUserId` INTEGER NULL,
  ADD COLUMN `financeApprovedAt` DATETIME(3) NULL,
  ADD COLUMN `managerApprovedByUserId` INTEGER NULL,
  ADD COLUMN `managerApprovedAt` DATETIME(3) NULL;

ALTER TABLE `Payout`
  ADD COLUMN `grossNetPaise` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `clawbackPaise` BIGINT NOT NULL DEFAULT 0;

CREATE TABLE `PayoutClawback` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NOT NULL,
  `distributionLineId` INTEGER NULL,
  `originalPayoutId` INTEGER NULL,
  `recoveredPayoutId` INTEGER NULL,
  `amountPaise` BIGINT NOT NULL,
  `recoveredPaise` BIGINT NOT NULL DEFAULT 0,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING_RECOVERY',
  `reason` TEXT NULL,
  `recoveredAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `PayoutClawback_tenantId_payoutPartnerId_status_idx`(`tenantId`, `payoutPartnerId`, `status`),
  INDEX `PayoutClawback_tenantId_plotBookingId_status_idx`(`tenantId`, `plotBookingId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutClawback_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutConfirmation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `payoutId` INTEGER NOT NULL,
  `payoutPartnerId` INTEGER NOT NULL,
  `mobile` VARCHAR(191) NOT NULL,
  `otpHash` VARCHAR(191) NOT NULL,
  `publicTokenHash` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `sentAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `verifiedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PayoutConfirmation_payoutId_key`(`payoutId`),
  UNIQUE INDEX `PayoutConfirmation_publicTokenHash_key`(`publicTokenHash`),
  INDEX `PayoutConfirmation_tenantId_payoutPartnerId_status_idx`(`tenantId`, `payoutPartnerId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PayoutConfirmation_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
