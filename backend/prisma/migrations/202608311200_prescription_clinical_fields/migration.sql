-- Prescription: structured clinical narrative fields.
--
-- Chief Complaint / Diagnosis / Investigations / Advice were previously
-- PARSED out of the free-text `instructions` column by scanning it for
-- "Chief Complaint:"-style line prefixes. That reader exists because
-- prescriptions migrated from Zylu carried those sections inline — but no
-- code in this CRM ever wrote them, so on every natively-written
-- prescription all four rendered as an em dash with no way to fill them.
--
-- Non-destructive: four ADD COLUMNs, every one NULLable with no default and
-- no backfill. Existing rows keep NULL and the read path falls back to the
-- legacy parser for them, so Zylu-imported narrative keeps displaying
-- exactly as it does today. Nothing is dropped, narrowed or made unique.

ALTER TABLE `Prescription`
  ADD COLUMN `chiefComplaint` TEXT NULL,
  ADD COLUMN `diagnosis`      TEXT NULL,
  ADD COLUMN `investigations` TEXT NULL,
  ADD COLUMN `advice`         TEXT NULL;
