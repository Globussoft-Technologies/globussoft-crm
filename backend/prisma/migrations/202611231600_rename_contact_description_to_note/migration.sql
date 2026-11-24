-- Rename the Generic CRM Contact note column without dropping existing values.
ALTER TABLE `Contact` CHANGE COLUMN `description` `note` TEXT NULL;
