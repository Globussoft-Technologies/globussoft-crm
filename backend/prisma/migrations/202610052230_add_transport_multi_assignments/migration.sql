-- Additive multi-assignment storage for generic CRM transport contacts.
-- The legacy pickupLocationId and serviceArea columns remain populated for
-- backward compatibility with already-deployed clients and existing rows.
ALTER TABLE `TransportPerson`
    ADD COLUMN `pickupLocationIdsJson` TEXT NULL,
    ADD COLUMN `plotSiteIdsJson` TEXT NULL,
    ADD COLUMN `serviceAreasJson` TEXT NULL;

UPDATE `TransportPerson`
SET `pickupLocationIdsJson` = JSON_ARRAY(`pickupLocationId`)
WHERE `pickupLocationId` IS NOT NULL
  AND `pickupLocationIdsJson` IS NULL;
