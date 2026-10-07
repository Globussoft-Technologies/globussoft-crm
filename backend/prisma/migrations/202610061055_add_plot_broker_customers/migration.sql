-- Additive customer assignments for generic CRM plot brokers.
-- IDs are validated against tenant-owned Contact rows before storage.
ALTER TABLE `PlotBroker`
    ADD COLUMN `customerIdsJson` TEXT NULL;
