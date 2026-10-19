ALTER TABLE `TravelSupplierPayable`
  ADD COLUMN `tripId` INTEGER NULL,
  ADD INDEX `TravelSupplierPayable_tripId_idx`(`tripId`);

ALTER TABLE `TravelSupplierPayable`
  ADD CONSTRAINT `TravelSupplierPayable_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
