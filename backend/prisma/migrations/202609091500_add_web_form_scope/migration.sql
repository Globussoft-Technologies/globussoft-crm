-- Keep existing Web Forms in the Generic scope while allowing Travel to use
-- the same form slugs without crossing data boundaries.
ALTER TABLE `WebForm`
  ADD COLUMN `scope` VARCHAR(191) NOT NULL DEFAULT 'generic';

DROP INDEX `WebForm_slug_key` ON `WebForm`;

CREATE UNIQUE INDEX `WebForm_scope_slug_key`
  ON `WebForm`(`scope`, `slug`);

CREATE INDEX `WebForm_tenantId_scope_createdAt_idx`
  ON `WebForm`(`tenantId`, `scope`, `createdAt`);

CREATE INDEX `WebForm_tenantId_scope_isActive_idx`
  ON `WebForm`(`tenantId`, `scope`, `isActive`);
