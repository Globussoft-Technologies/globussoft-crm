-- ServicePackage.serviceSessions — per-service session counts.
--
-- A package used to be "the whole bundle, N times": every bundled service ran
-- the same number of times and the price was (sum of base prices) x sessions.
-- Clinics sell the other shape too — 5 sessions made of 3 of one treatment and
-- 2 of another — which the flat multiple cannot express, and which prices
-- differently.
--
-- Stored as JSON keyed by service id ({"10":3,"11":2}) rather than a join
-- table, for the same reason serviceIds is: a package is a PRICED SNAPSHOT,
-- and a service being repriced later must not silently change a package
-- already quoted.
--
-- Non-destructive: one NULLABLE column. NULL reads as the old shape (every
-- service runs `sessions` times), so every existing row keeps its current
-- price and behaviour with no backfill.
ALTER TABLE `ServicePackage`
  ADD COLUMN `serviceSessions` TEXT NULL;
