-- GeofenceZone + UserGeofenceZone — standalone geofenced check-in zones,
-- decoupled from clinic Location.
--
-- Non-destructive additive migration: two new tables only, nothing existing
-- is touched. A tenant with zero rows in GeofenceZone behaves identically
-- to today (resolveGeofenceContext's fallback path finds no Global zone and
-- returns [], same as before this migration existed).
--
-- GeofenceZone.isGlobal has no DB-level uniqueness constraint (MySQL has no
-- clean "unique where isGlobal = true" partial index). Uniqueness is
-- enforced in routes/wellness_geofence_zones.js by wrapping every
-- isGlobal:true write in a transaction that first clears any other global
-- zone for the tenant.
CREATE TABLE `GeofenceZone` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `latitude` DOUBLE NOT NULL,
  `longitude` DOUBLE NOT NULL,
  `radiusM` INT NOT NULL DEFAULT 150,
  `isGlobal` TINYINT(1) NOT NULL DEFAULT 0,
  `isActive` TINYINT(1) NOT NULL DEFAULT 1,
  `tenantId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `GeofenceZone_tenantId_isActive_idx` (`tenantId`, `isActive`),
  KEY `GeofenceZone_tenantId_isGlobal_idx` (`tenantId`, `isGlobal`),
  CONSTRAINT `GeofenceZone_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `UserGeofenceZone` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `zoneId` INT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UserGeofenceZone_userId_zoneId_key` (`userId`, `zoneId`),
  KEY `UserGeofenceZone_zoneId_idx` (`zoneId`),
  CONSTRAINT `UserGeofenceZone_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `UserGeofenceZone_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `GeofenceZone` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
