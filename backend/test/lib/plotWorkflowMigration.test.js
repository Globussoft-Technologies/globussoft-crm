import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const migration = (name) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');

describe('Plot workflow upgrade migration', () => {
  test('preserves the already shipped billing migration', () => {
    expect(migration('202610071000_add_billing_person_assignments')).toBe(
      'ALTER TABLE `BillingPerson`\n  ADD COLUMN `customerIdsJson` TEXT NULL,\n  ADD COLUMN `plotSiteIdsJson` TEXT NULL;\n',
    );
  });

  test('ships the workflow additions and nullable tenant-scoped payment key separately', () => {
    const sql = migration('202610091000_plot_workflow_and_payment_reference');
    for (const table of ['PlotBooking', 'PlotInvoiceItem', 'PlotWorkflowEvent']) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql).toContain('ADD COLUMN `plotPaymentReference` VARCHAR(128) NULL');
    expect(sql).toContain('ON `Payment` (`tenantId`, `plotPaymentReference`)');
    expect(sql).not.toContain('ADD COLUMN `customerIdsJson`');
    expect(sql).not.toContain('ADD COLUMN `plotSiteIdsJson`');
  });
});
