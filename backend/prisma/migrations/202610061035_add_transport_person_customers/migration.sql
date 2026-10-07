-- Additive customer assignments for generic CRM transport contacts.
-- IDs are validated against tenant-owned Contact rows before storage.
ALTER TABLE `TransportPerson`
    ADD COLUMN `customerIdsJson` TEXT NULL;
