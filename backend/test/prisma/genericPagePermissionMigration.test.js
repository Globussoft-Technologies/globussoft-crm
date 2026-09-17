import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/202609171500_backfill_generic_page_permissions/migration.sql',
  import.meta.url,
));
const sql = readFileSync(migrationPath, 'utf8');

describe('generic page permission backfill migration', () => {
  test('is tenant-scoped, role-scoped, and idempotent', () => {
    expect(sql).toContain("`t`.`vertical` = 'generic'");
    expect(sql).toContain("`r`.`key` IN ('ADMIN', 'MANAGER')");
    expect(sql).toMatch(/NOT EXISTS\s*\(/);
  });

  test('backfills every generic-only module while preserving manager restrictions', () => {
    const modules = [
      'cpq', 'playbooks', 'territories', 'live_chat', 'support', 'sla',
      'social', 'field_permissions', 'sandbox', 'document_templates',
      'custom_objects', 'lead_scoring', 'deal_insights', 'calendar',
      'ab_tests', 'booking_pages', 'web_forms',
      'forecasting', 'quotas', 'sequences', 'settings',
    ];
    for (const module of modules) expect(sql).toContain(`'${module}'`);
    expect(sql).toContain("`permissionAction`.`action` <> 'delete'");
    expect(sql).toContain('`pagePermission`.`managerGrant` = 1');
    expect(sql).toContain("SELECT `r`.`id`, `managerPage`.`module`, 'read'");
  });
});
