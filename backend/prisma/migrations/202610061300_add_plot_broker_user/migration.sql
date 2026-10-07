-- Link a plot-broker profile to the staff login that represents it.
-- Nullable keeps existing profile-only broker records backward compatible.
ALTER TABLE `PlotBroker`
    ADD COLUMN `userId` INTEGER NULL,
    ADD UNIQUE INDEX `PlotBroker_userId_key`(`userId`),
    ADD CONSTRAINT `PlotBroker_userId_fkey`
        FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;
