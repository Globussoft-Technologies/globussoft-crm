-- Prescription validity — how long a prescribed course is meant to last.
--
-- Captured at prescribing time so the renewal workflow has something to remind
-- against: "your prescription lapses in 7 days, want a repeat?".
--
-- Non-destructive: two NULLABLE columns + one index on an existing table. No
-- existing column is altered, no row is rewritten, no default is backfilled.
-- Every pre-existing prescription keeps NULL = "no stated validity", and
-- nothing downstream may read NULL as expired.
--
--   validityDays : what the clinician entered (e.g. 30). Kept verbatim as the
--                  record of intent — a later amendment to `drugs` must not
--                  silently rewrite how long the doctor said the course runs.
--   validUntil   : createdAt + validityDays, computed server-side. STORED
--                  rather than derived on read specifically so the reminder
--                  sweep can do an indexed range scan; the equivalent
--                  DATE_ADD(createdAt, INTERVAL validityDays DAY) in a WHERE
--                  clause cannot use an index and would table-scan.

ALTER TABLE `Prescription`
  ADD COLUMN `validityDays` INT NULL,
  ADD COLUMN `validUntil`   DATETIME(3) NULL;

-- Leading tenantId keeps the reminder sweep tenant-scoped before the range
-- predicate on validUntil.
CREATE INDEX `Prescription_tenantId_validUntil_idx`
  ON `Prescription` (`tenantId`, `validUntil`);
