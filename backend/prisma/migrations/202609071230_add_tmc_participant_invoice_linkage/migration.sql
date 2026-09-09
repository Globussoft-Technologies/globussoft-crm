ALTER TABLE `TravelInvoice`
  ADD COLUMN `tripId` INTEGER NULL,
  ADD COLUMN `participantId` INTEGER NULL;

CREATE INDEX `TravelInvoice_tenantId_tripId_participantId_idx`
  ON `TravelInvoice`(`tenantId`, `tripId`, `participantId`);
