-- TreatmentPlan.servicePackageId — which catalog package a plan was bought from.
--
-- A package purchase already created a TreatmentPlan, but nothing tied the two
-- together, so the customer catalog could not tell a buyer "you already own
-- this" or show the window left to use it. The link also lets a clinic ask how
-- a package is actually selling.
--
-- Non-destructive and additive: NULL on every existing row, which is exactly
-- what a plan written up by hand should read as.
--
-- ON DELETE SET NULL, never CASCADE — deleting a package must not delete the
-- plans patients paid for. The plan keeps its own name, sessions and price
-- snapshot, so it survives the package disappearing.
ALTER TABLE `TreatmentPlan`
  ADD COLUMN `servicePackageId` INT NULL;

CREATE INDEX `TreatmentPlan_tenantId_servicePackageId_idx`
  ON `TreatmentPlan`(`tenantId`, `servicePackageId`);

ALTER TABLE `TreatmentPlan`
  ADD CONSTRAINT `TreatmentPlan_servicePackageId_fkey`
  FOREIGN KEY (`servicePackageId`) REFERENCES `ServicePackage`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
