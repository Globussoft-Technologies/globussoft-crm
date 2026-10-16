import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/202610161415_repair_pickup_staff_role_links/migration.sql',
  import.meta.url,
));
const sql = readFileSync(migrationPath, 'utf8');

describe('pickup staff role repair migration', () => {
  test('only replaces the tenant-owned built-in USER role on Generic tenants', () => {
    expect(sql.match(/`current_role`\.`key` = 'USER' AND `current_role`\.`isCustom` = false/g)).toHaveLength(3);
    expect(sql.match(/`current_role`\.`id` = `ur`\.`roleId` AND `current_role`\.`tenantId` = `u`\.`tenantId`/g)).toHaveLength(3);
    expect(sql.match(/`tenant`\.`vertical` = 'generic'/g)).toHaveLength(3);
  });
  test('maps each exclusive operational profile to its canonical role', () => {
    expect(sql).toContain("`target`.`key` = 'TRANSPORT_PERSON'");
    expect(sql).toContain("`target`.`key` IN ('BROOKER', 'BROKER')");
    expect(sql).toContain("`target`.`key` = 'BILLING'");
    expect(sql.match(/SET `ur`.`roleId` = `target`.`id`/g)).toHaveLength(3);
  });

  test('does not rewrite elevated identities or multi-workspace staff', () => {
    expect(sql.match(/`u`.`userType` = 'STAFF'/g)).toHaveLength(3);
    expect(sql.match(/`u`.`role` = 'USER'/g)).toHaveLength(3);
    expect(sql).toMatch(/`pb`.`id` IS NULL[\s\S]*`bp`.`id` IS NULL/);
    expect(sql).toMatch(/`tp`.`id` IS NULL[\s\S]*`bp`.`id` IS NULL/);
    expect(sql).toMatch(/`tp`.`id` IS NULL[\s\S]*`pb`.`id` IS NULL/);
  });
});
