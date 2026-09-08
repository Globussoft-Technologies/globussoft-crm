-- PrescriptionRequest — patient-raised renewal / medicine request against an
-- already-issued Prescription (Android app → Clinical admin panel workflow).
--
-- Non-destructive: two NEW tables only. No existing column, index or row is
-- touched, so this is safe to run against a populated production database.
--
-- Design notes (the full rationale lives on the models in schema.prisma):
--   • `requestedDrugs` is a JSON array of the specific medicines asked for;
--     NULL means "renew the complete prescription". Matches the existing
--     JSON-string-column convention used by Prescription.drugs.
--   • FK to Prescription/Patient CASCADEs — a request has no meaning once
--     its source Rx or patient record is gone.
--   • FK to Tenant is RESTRICT, mirroring Prescription: a misclick on
--     tenant.delete() must not silently destroy a medication-demand trail.
--   • FK to User is SET NULL on both doctorId and reviewedById — staff churn
--     must not delete clinical workflow history.
-- Every FK below declares ON DELETE explicitly (check-migration-safety.js).

CREATE TABLE `PrescriptionRequest` (
  `id`                      INT NOT NULL AUTO_INCREMENT,
  `prescriptionId`          INT NOT NULL,
  `patientId`               INT NOT NULL,
  `doctorId`                INT NULL,
  `requestedDrugs`          TEXT NULL,
  `requestedDurationDays`   INT NULL,
  `requestedFrom`           DATETIME(3) NULL,
  `requestedTo`             DATETIME(3) NULL,
  `notes`                   TEXT NULL,
  `status`                  VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `reviewedById`            INT NULL,
  `reviewedAt`              DATETIME(3) NULL,
  `reviewNote`              TEXT NULL,
  `fulfilledPrescriptionId` INT NULL,
  `tenantId`                INT NOT NULL DEFAULT 1,
  `createdAt`               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`               DATETIME(3) NOT NULL,

  INDEX `PrescriptionRequest_tenantId_status_createdAt_idx` (`tenantId`, `status`, `createdAt`),
  INDEX `PrescriptionRequest_tenantId_createdAt_idx` (`tenantId`, `createdAt`),
  INDEX `PrescriptionRequest_patientId_createdAt_idx` (`patientId`, `createdAt`),
  INDEX `PrescriptionRequest_doctorId_status_idx` (`doctorId`, `status`),
  INDEX `PrescriptionRequest_prescriptionId_idx` (`prescriptionId`),
  INDEX `PrescriptionRequest_reviewedById_idx` (`reviewedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Request-scoped, append-only status history. Distinct from AuditLog: this
-- one is cheap to read inline on the review screen; AuditLog stays the
-- hash-chained compliance record.
CREATE TABLE `PrescriptionRequestEvent` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `requestId`   INT NOT NULL,
  `action`      VARCHAR(191) NOT NULL,
  `fromStatus`  VARCHAR(191) NULL,
  `toStatus`    VARCHAR(191) NULL,
  `note`        TEXT NULL,
  `actorUserId` INT NULL,
  `actorType`   VARCHAR(191) NOT NULL DEFAULT 'user',
  `tenantId`    INT NOT NULL DEFAULT 1,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `PrescriptionRequestEvent_requestId_createdAt_idx` (`requestId`, `createdAt`),
  INDEX `PrescriptionRequestEvent_tenantId_createdAt_idx` (`tenantId`, `createdAt`),
  INDEX `PrescriptionRequestEvent_actorUserId_idx` (`actorUserId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PrescriptionRequest`
  ADD CONSTRAINT `PrescriptionRequest_prescriptionId_fkey`
  FOREIGN KEY (`prescriptionId`) REFERENCES `Prescription`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequest`
  ADD CONSTRAINT `PrescriptionRequest_patientId_fkey`
  FOREIGN KEY (`patientId`) REFERENCES `Patient`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequest`
  ADD CONSTRAINT `PrescriptionRequest_doctorId_fkey`
  FOREIGN KEY (`doctorId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequest`
  ADD CONSTRAINT `PrescriptionRequest_reviewedById_fkey`
  FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequest`
  ADD CONSTRAINT `PrescriptionRequest_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequestEvent`
  ADD CONSTRAINT `PrescriptionRequestEvent_requestId_fkey`
  FOREIGN KEY (`requestId`) REFERENCES `PrescriptionRequest`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PrescriptionRequestEvent`
  ADD CONSTRAINT `PrescriptionRequestEvent_actorUserId_fkey`
  FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
