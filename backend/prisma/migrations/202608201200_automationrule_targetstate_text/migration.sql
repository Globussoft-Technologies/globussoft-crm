-- AutomationRule.targetState carries the whole workflow-builder JSON blob
-- (module, execution, description, actions[] with per-action config). As
-- varchar(191) every non-trivial save failed with Prisma P2000 -> HTTP 500.
-- Widening varchar -> TEXT is non-destructive; existing rows are unchanged.
ALTER TABLE `AutomationRule` MODIFY `targetState` TEXT NULL;
