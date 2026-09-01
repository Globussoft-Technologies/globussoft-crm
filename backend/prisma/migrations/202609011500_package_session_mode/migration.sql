-- Packing of per-service runs into visits: "combined" (one visit delivers
-- every service that still has a run left) or "separate" (one service per
-- visit). Defaults to "combined", which is what every existing package
-- already means.
ALTER TABLE `ServicePackage` ADD COLUMN `sessionMode` VARCHAR(191) NOT NULL DEFAULT 'combined';
