-- Add the per-contact Callified dial lease used to prevent duplicate calls.
ALTER TABLE `Contact`
  ADD COLUMN `callifiedDialLeaseUntil` DATETIME(3) NULL;
