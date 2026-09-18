CREATE TABLE `SalesTeam` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `name` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `SalesTeam_tenantId_idx`(`tenantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SalesTeamMember` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `tenantId` INTEGER NOT NULL DEFAULT 1,
  `teamId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `SalesTeamMember_teamId_userId_key`(`teamId`, `userId`),
  INDEX `SalesTeamMember_tenantId_idx`(`tenantId`),
  INDEX `SalesTeamMember_userId_idx`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SalesTeam`
  ADD CONSTRAINT `SalesTeam_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SalesTeamMember`
  ADD CONSTRAINT `SalesTeamMember_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesTeamMember_teamId_fkey`
  FOREIGN KEY (`teamId`) REFERENCES `SalesTeam`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `SalesTeamMember_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
