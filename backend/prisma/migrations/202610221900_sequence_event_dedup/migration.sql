ALTER TABLE `SequenceEnrollment` ADD COLUMN `automationEventKey` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `SequenceEnrollment_automationEventKey_key` ON `SequenceEnrollment`(`automationEventKey`);
