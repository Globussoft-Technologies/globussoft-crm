CREATE TABLE `PlotCommission` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL,
  `plotBookingId` INTEGER NOT NULL,
  `paymentId` INTEGER NOT NULL,
  `plotBrokerId` INTEGER NOT NULL,
  `contactId` INTEGER NOT NULL,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'INR',
  `commissionPercent` DECIMAL(5, 2) NOT NULL,
  `eligibleAmount` DECIMAL(15, 2) NOT NULL,
  `commissionAmount` DECIMAL(15, 2) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'EARNED',
  `approvedByUserId` INTEGER NULL,
  `approvedAt` DATETIME(3) NULL,
  `paidByUserId` INTEGER NULL,
  `paidAt` DATETIME(3) NULL,
  `reversedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `PlotCommission_tenantId_paymentId_plotBrokerId_key`(`tenantId`, `paymentId`, `plotBrokerId`),
  INDEX `PlotCommission_tenantId_plotBookingId_createdAt_idx`(`tenantId`, `plotBookingId`, `createdAt`),
  INDEX `PlotCommission_tenantId_plotBrokerId_status_idx`(`tenantId`, `plotBrokerId`, `status`),
  INDEX `PlotCommission_tenantId_status_createdAt_idx`(`tenantId`, `status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve the same calculation rule for successful plot payments that were
-- recorded before this ledger existed. Rates are snapshotted from the Sales
-- Executive currently assigned to the booking; non-Generic tenants are
-- intentionally excluded.
INSERT INTO `PlotCommission` (
  `tenantId`, `plotBookingId`, `paymentId`, `plotBrokerId`, `contactId`,
  `currency`, `commissionPercent`, `eligibleAmount`, `commissionAmount`,
  `status`, `createdAt`, `updatedAt`
)
SELECT
  payment.`tenantId`, booking.`id`, payment.`id`, booking.`plotBrokerId`, booking.`contactId`,
  payment.`currency`, COALESCE(broker.`commissionPercent`, 10), ROUND(booking.`totalAmount`, 2),
  ROUND(booking.`totalAmount` * COALESCE(broker.`commissionPercent`, 10) / 100, 2),
  'EARNED', COALESCE(payment.`paidAt`, payment.`createdAt`), CURRENT_TIMESTAMP(3)
FROM `Payment` payment
INNER JOIN `Tenant` tenant
  ON tenant.`id` = payment.`tenantId` AND LOWER(tenant.`vertical`) = 'generic'
INNER JOIN `PlotBooking` booking
  ON booking.`tenantId` = payment.`tenantId`
  AND booking.`id` = CAST(JSON_UNQUOTE(JSON_EXTRACT(
    IF(JSON_VALID(payment.`metadata`), payment.`metadata`, '{}'), '$.plotBookingId'
  )) AS UNSIGNED)
INNER JOIN `PlotBroker` broker
  ON broker.`tenantId` = payment.`tenantId` AND broker.`id` = booking.`plotBrokerId`
WHERE payment.`status` = 'SUCCESS'
  AND JSON_UNQUOTE(JSON_EXTRACT(
    IF(JSON_VALID(payment.`metadata`), payment.`metadata`, '{}'), '$.kind'
  )) = 'plot-booking-payment'
  AND COALESCE(broker.`commissionPercent`, 10) > 0
  AND payment.`id` = (
    SELECT MIN(firstPayment.`id`)
    FROM `Payment` firstPayment
    WHERE firstPayment.`tenantId` = payment.`tenantId`
      AND firstPayment.`status` = 'SUCCESS'
      AND JSON_UNQUOTE(JSON_EXTRACT(
        IF(JSON_VALID(firstPayment.`metadata`), firstPayment.`metadata`, '{}'), '$.kind'
      )) = 'plot-booking-payment'
      AND JSON_UNQUOTE(JSON_EXTRACT(
        IF(JSON_VALID(firstPayment.`metadata`), firstPayment.`metadata`, '{}'), '$.plotBookingId'
      )) = JSON_UNQUOTE(JSON_EXTRACT(
        IF(JSON_VALID(payment.`metadata`), payment.`metadata`, '{}'), '$.plotBookingId'
      ))
  )
ON DUPLICATE KEY UPDATE `paymentId` = VALUES(`paymentId`);
