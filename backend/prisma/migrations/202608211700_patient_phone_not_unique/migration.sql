-- Patient.(tenantId, normalizedPhone): UNIQUE -> plain index.
--
-- #401 added this as a DB-level dedup gate against the "same patient created
-- N times by overlapping intake flows" inflation pattern. Product decision
-- reverses it: several patients in one clinic legitimately share a phone
-- number (a couple, a parent booking for a child, one household landline),
-- and the constraint blocked a booking or a profile save in those cases.
--
-- Non-destructive: no rows or columns are touched. Relaxing UNIQUE to a plain
-- index can never fail on existing data — every set that satisfied the unique
-- constraint also satisfies the weaker one. Reversing this later WOULD need a
-- backfill + merge first (see scripts/backfill-patient-normalized-phone.js).
--
-- The index itself is retained: the application-level dedup lookups, the
-- reminder engines, and the Callified dialer all query on this pair.
--
-- Consequence: the P2002 -> HTTP 409 DUPLICATE_PHONE path in the intake
-- routes can no longer fire. Dedup returns to application-level best-effort,
-- as it was before #401.
DROP INDEX `Patient_tenantId_normalizedPhone_key` ON `Patient`;

CREATE INDEX `Patient_tenantId_normalizedPhone_idx` ON `Patient`(`tenantId`, `normalizedPhone`);
