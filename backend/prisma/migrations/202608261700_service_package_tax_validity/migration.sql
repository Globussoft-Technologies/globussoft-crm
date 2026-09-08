-- ServicePackage — tax, post-purchase validity and a sell-by date.
--
-- All three are commercial terms the builder previously could not express: a
-- package had a price but no GST slab, no answer to "how long do I have to
-- use my 6 sessions", and no way to stop being sold after a season ends.
--
-- Non-destructive and additive:
--   taxPercent   NOT NULL DEFAULT 0  → existing packages read as "No tax",
--                                     which is what they were before.
--   validityDays NULL                → no expiry, the current behaviour.
--   sellByDate   NULL                → sellable indefinitely, ditto.
--
-- taxPercent is DOUBLE rather than an enum so a GST slab change is a data
-- edit. It applies ON TOP of `price` at sale time (same convention as the
-- appointment GST in routes/wellness.js) — the stored `price` stays pre-tax
-- so a slab change never rewrites a package already quoted to a customer.
ALTER TABLE `ServicePackage`
  ADD COLUMN `taxPercent`   DOUBLE      NOT NULL DEFAULT 0,
  ADD COLUMN `validityDays` INT         NULL,
  ADD COLUMN `sellByDate`   DATETIME(3) NULL;
