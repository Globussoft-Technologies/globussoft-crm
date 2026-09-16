-- Contacts remain tenant-scoped, but email is no longer a hard uniqueness
-- constraint. The route-level duplicate preflight still protects normal
-- creates; an explicit force=true is required for a separate product lead.
ALTER TABLE `Contact`
  DROP INDEX `Contact_email_tenantId_key`;

CREATE INDEX `Contact_tenantId_email_idx`
  ON `Contact`(`tenantId`, `email`);
