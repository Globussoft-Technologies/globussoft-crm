ALTER TABLE `PlotBroker`
  ADD COLUMN `pickupLocationIdsJson` TEXT NULL;

ALTER TABLE `BillingPerson`
  ADD COLUMN `pickupLocationIdsJson` TEXT NULL;
