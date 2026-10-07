-- Persist each transport person's driver-side progress independently for
-- every assigned customer / pickup / drop combination.
ALTER TABLE `TransportPerson`
    ADD COLUMN `assignmentStatusJson` TEXT NULL;
