-- Preserve an explicit scope on each submission for isolation and reporting.
ALTER TABLE `WebFormSubmission`
  ADD COLUMN `scope` VARCHAR(191) NOT NULL DEFAULT 'generic';


CREATE INDEX `WebFormSubmission_tenantId_scope_webFormId_idx`
  ON `WebFormSubmission`(`tenantId`, `scope`, `webFormId`);

CREATE INDEX `WebFormSubmission_tenantId_scope_submittedAt_idx`
  ON `WebFormSubmission`(`tenantId`, `scope`, `submittedAt`);
