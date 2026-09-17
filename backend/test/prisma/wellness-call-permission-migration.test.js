import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migration = readFileSync(fileURLToPath(new URL(
  '../../prisma/migrations/202609171200_backfill_wellness_call_permissions/migration.sql',
  import.meta.url,
)), 'utf8');

describe('wellness call permission migration', () => {
  test('backfills both modes only for the intended wellness roles', () => {
    expect(migration).toContain("`t`.`vertical` = 'wellness'");
    expect(migration).toContain("'ai_call' AS `action`");
    expect(migration).toContain("'manual_call' AS `action`");
    expect(migration).toContain("('ADMIN', 'MANAGER', 'RECEPTIONIST', 'TELECALLER')");
  });

  test('is idempotent and does not overwrite existing grants', () => {
    expect(migration).toContain('NOT EXISTS');
    expect(migration).toContain("`existing`.`module` = 'appointments'");
    expect(migration).toContain('`existing`.`action` = `callMode`.`action`');
  });
});
