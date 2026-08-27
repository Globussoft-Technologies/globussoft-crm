-- Drug stock — hold quantity on the drug catalogue itself.
--
-- The clinic dispenses from the same shelf the doctor prescribes off, so the
-- drug catalogue IS the stock ledger. This replaces the short-lived
-- Drug.productId bridge to the Product catalogue: one number per drug, managed
-- in one place, with nothing to reconcile or drift.
--
--   quantity           units on hand. NOT NULL DEFAULT 0 — "unknown stock" is
--                      not a state worth modelling, and 0 is the honest
--                      default for a drug nobody has counted yet.
--   lowStockThreshold  reorder point. 0 = "don't alert on this one", matching
--                      the convention Product.threshold already uses.
--
-- Adding the columns is non-destructive. Dropping `productId` removes a column
-- that shipped in the same development cycle and was never populated on any
-- deployed tenant, so no mapping work is lost.
-- safe-drop: Drug.productId superseded by Drug.quantity; never populated in production.

ALTER TABLE `Drug`
  ADD COLUMN `quantity`          INT NOT NULL DEFAULT 0,
  ADD COLUMN `lowStockThreshold` INT NOT NULL DEFAULT 0;

-- Drives the low-stock sweep: "which drugs are at or below their reorder point".
CREATE INDEX `Drug_tenantId_quantity_idx` ON `Drug` (`tenantId`, `quantity`);
