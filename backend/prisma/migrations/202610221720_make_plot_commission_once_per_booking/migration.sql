-- A plot sale earns commission once. Keep the earliest ledger entry for each
-- booking and remove payment-by-payment duplicates before changing the key.
DELETE duplicateCommission
FROM `PlotCommission` duplicateCommission
INNER JOIN `PlotCommission` firstCommission
  ON firstCommission.`tenantId` = duplicateCommission.`tenantId`
  AND firstCommission.`plotBookingId` = duplicateCommission.`plotBookingId`
  AND firstCommission.`id` < duplicateCommission.`id`;

ALTER TABLE `PlotCommission`
  DROP INDEX `PlotCommission_tenantId_paymentId_plotBrokerId_key`,
  ADD UNIQUE INDEX `PlotCommission_tenantId_plotBookingId_key`(`tenantId`, `plotBookingId`);
