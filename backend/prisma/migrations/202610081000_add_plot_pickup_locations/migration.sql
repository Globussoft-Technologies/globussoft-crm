ALTER TABLE `PlotSite`
  ADD COLUMN `pickupLocationIdsJson` TEXT NULL;

UPDATE `PlotSite`
SET `pickupLocationIdsJson` = CONCAT('[', `pickupLocationId`, ']')
WHERE `pickupLocationId` IS NOT NULL;
