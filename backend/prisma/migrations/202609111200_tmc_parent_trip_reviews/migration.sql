-- TMC parent reviews share the TravelTripReview admin surface but target a
-- TmcTrip rather than an Itinerary. Existing itinerary reviews are unchanged.
ALTER TABLE `TravelTripReview`
  MODIFY `itineraryId` INTEGER NULL;

ALTER TABLE `TravelTripReview`
  ADD COLUMN `tmcTripId` INTEGER NULL;

CREATE UNIQUE INDEX `TravelTripReview_tenantId_tmcTripId_contactId_key`
  ON `TravelTripReview`(`tenantId`, `tmcTripId`, `contactId`);

CREATE INDEX `TravelTripReview_tenantId_tmcTripId_idx`
  ON `TravelTripReview`(`tenantId`, `tmcTripId`);
