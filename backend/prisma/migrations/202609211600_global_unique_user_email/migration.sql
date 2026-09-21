-- A login email must identify exactly one User and therefore one tenant.
--
-- IMPORTANT: run the duplicate audit documented in
-- docs/GLOBAL_LOGIN_EMAIL_MIGRATION.md before applying this migration in an
-- existing environment. CREATE UNIQUE INDEX intentionally runs before the
-- old composite index is removed, so a collision aborts safely without
-- weakening the existing constraint.

UPDATE `User`
SET `email` = LOWER(TRIM(`email`));

CREATE UNIQUE INDEX `User_email_key` ON `User`(`email`);

DROP INDEX `User_email_tenantId_key` ON `User`;
