-- Doctor double-booking guard — index the conflict lookup.
--
-- Every booking, reschedule and assign-doctor asks "what else does this doctor
-- hold around this time", and the Assign Doctor dropdown asks it for every
-- practitioner at once. Without this index each of those scans the tenant's
-- entire visit history.
--
-- Non-destructive: index only. No column or row is touched.
-- Leading tenantId matches the project's tenant-isolation index convention.

CREATE INDEX `Visit_tenantId_doctorId_visitDate_idx`
  ON `Visit` (`tenantId`, `doctorId`, `visitDate`);
