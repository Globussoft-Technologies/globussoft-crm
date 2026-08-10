ALTER TABLE `VisaApplication`
  ADD COLUMN `tripId` INTEGER NULL,
  ADD COLUMN `participantId` INTEGER NULL;

CREATE INDEX `VisaApplication_tripId_idx` ON `VisaApplication`(`tripId`);
CREATE INDEX `VisaApplication_participantId_idx` ON `VisaApplication`(`participantId`);

ALTER TABLE `VisaApplication`
  ADD CONSTRAINT `VisaApplication_tripId_fkey`
  FOREIGN KEY (`tripId`) REFERENCES `TmcTrip`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VisaApplication_participantId_fkey`
  FOREIGN KEY (`participantId`) REFERENCES `TripParticipant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
