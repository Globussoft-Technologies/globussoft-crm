ALTER TABLE `TravelQuote`
  ADD COLUMN `assignedToUserId` INTEGER NULL;

CREATE INDEX `TravelQuote_tenantId_assignedToUserId_idx`
  ON `TravelQuote`(`tenantId`, `assignedToUserId`);

ALTER TABLE `TravelQuote`
  ADD CONSTRAINT `TravelQuote_assignedToUserId_fkey`
  FOREIGN KEY (`assignedToUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
