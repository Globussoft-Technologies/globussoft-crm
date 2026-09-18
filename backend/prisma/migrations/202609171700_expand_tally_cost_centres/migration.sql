ALTER TABLE `TravelTallyCostCentre`
  MODIFY `itineraryId` INTEGER NULL,
  ADD COLUMN `sourceType` VARCHAR(30) NOT NULL DEFAULT 'ITINERARY',
  ADD COLUMN `sourceId` INTEGER NULL,
  ADD COLUMN `tmcTripId` INTEGER NULL,
  ADD COLUMN `quoteId` INTEGER NULL;

UPDATE `TravelTallyCostCentre`
SET `sourceType` = 'ITINERARY', `sourceId` = `itineraryId`
WHERE `sourceId` IS NULL;

ALTER TABLE `TravelTallyCostCentre`
  MODIFY `sourceId` INTEGER NOT NULL,
  ADD UNIQUE INDEX `TravelTallyCostCentre_tmcTripId_key` (`tmcTripId`),
  ADD UNIQUE INDEX `TravelTallyCostCentre_quoteId_key` (`quoteId`),
  ADD UNIQUE INDEX `TravelTallyCostCentre_tenantId_sourceType_sourceId_key` (`tenantId`, `sourceType`, `sourceId`),
  ADD CONSTRAINT `TravelTallyCostCentre_tmcTripId_fkey` FOREIGN KEY (`tmcTripId`) REFERENCES `TmcTrip` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `TravelTallyCostCentre_quoteId_fkey` FOREIGN KEY (`quoteId`) REFERENCES `TravelQuote` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
