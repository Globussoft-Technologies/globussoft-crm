CREATE INDEX `TravelQuote_tenantId_itineraryId_idx`
  ON `TravelQuote`(`tenantId`, `itineraryId`);

ALTER TABLE `TravelQuote`
  ADD CONSTRAINT `TravelQuote_itineraryId_fkey`
  FOREIGN KEY (`itineraryId`) REFERENCES `Itinerary`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `TravelSupplierPayable`
  ADD COLUMN `itineraryId` INTEGER NULL;

CREATE INDEX `TravelSupplierPayable_tenantId_itineraryId_idx`
  ON `TravelSupplierPayable`(`tenantId`, `itineraryId`);

ALTER TABLE `TravelSupplierPayable`
  ADD CONSTRAINT `TravelSupplierPayable_itineraryId_fkey`
  FOREIGN KEY (`itineraryId`) REFERENCES `Itinerary`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `TravelPurchaseOrder`
  ADD COLUMN `tripId` INTEGER NULL;

CREATE INDEX `TravelPurchaseOrder_tenantId_tripId_idx`
  ON `TravelPurchaseOrder`(`tenantId`, `tripId`);

ALTER TABLE `TravelPurchaseOrder`
  ADD CONSTRAINT `TravelPurchaseOrder_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
