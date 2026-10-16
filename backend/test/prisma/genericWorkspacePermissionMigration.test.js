import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/202610152000_add_generic_workspace_permissions/migration.sql',
  import.meta.url,
));
const sql = readFileSync(migrationPath, 'utf8');

describe('generic workspace permission migration', () => {
  test('adds all workspaces to generic admins without relying on role display names', () => {
    expect(sql).toContain("`t`.`vertical` = 'generic'");
    expect(sql).toContain("`r`.`key` = 'ADMIN'");
    expect(sql).toContain("'transport_workspace'");
    expect(sql).toContain("'broker_workspace'");
    expect(sql).toContain("'billing_workspace'");
    expect(sql).not.toMatch(/Transport Person role|Billing Department|BROOKER/);
  });

  test('does not expand one staff assignment to every member of a shared role', () => {
    expect(sql).not.toContain('INNER JOIN `TransportPerson`');
    expect(sql).not.toContain('INNER JOIN `PlotBroker`');
    expect(sql).not.toContain('INNER JOIN `BillingPerson`');
    expect(sql).toMatch(/NOT EXISTS\s*\(/);
    expect(sql).toContain("SELECT 'update'");
  });
});
