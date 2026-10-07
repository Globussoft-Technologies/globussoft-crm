-- Link a transport profile to the staff login that owns it. Nullable keeps
-- all existing transport-only records valid; UNIQUE ensures one transport
-- profile per staff identity while allowing multiple NULL legacy rows.
ALTER TABLE `TransportPerson`
  ADD COLUMN `userId` INTEGER NULL,
  ADD UNIQUE INDEX `TransportPerson_userId_key` (`userId`),
  ADD CONSTRAINT `TransportPerson_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
