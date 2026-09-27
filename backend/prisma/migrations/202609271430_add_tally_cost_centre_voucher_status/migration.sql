ALTER TABLE `TravelTallyCostCentre`
  ADD COLUMN `voucherSyncStatus` VARCHAR(30) NULL,
  ADD COLUMN `lastVoucherSyncAt` DATETIME(3) NULL;
