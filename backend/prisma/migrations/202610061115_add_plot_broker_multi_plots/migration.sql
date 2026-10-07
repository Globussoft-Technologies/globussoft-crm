-- Additive multi-plot assignments for generic CRM plot brokers.
-- The legacy plotSiteId remains the primary plot for backward compatibility.
ALTER TABLE `PlotBroker`
    ADD COLUMN `plotSiteIdsJson` TEXT NULL;

UPDATE `PlotBroker`
SET `plotSiteIdsJson` = JSON_ARRAY(`plotSiteId`)
WHERE `plotSiteId` IS NOT NULL
  AND `plotSiteIdsJson` IS NULL;
