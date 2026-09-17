import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');
const read = (relativePath) => readFileSync(resolve(SRC, relativePath), 'utf8');

const financePages = [
  ['pages/travel/InvoicesAdmin.jsx', 'Invoices'],
  ['pages/travel/tally/TallyHomePage.jsx', 'Tally'],
  ['pages/travel/MilestoneTracker.jsx', 'Milestones'],
  ['pages/travel/Payables.jsx', 'Payables'],
  ['pages/Payments.jsx', 'Payments Received'],
  ['pages/Expenses.jsx', 'Expense Management'],
  ['pages/travel/CostMaster.jsx', 'Cost Master'],
  ['pages/travel/PricingRules.jsx', 'Pricing Rules'],
];

describe('Finance module UI contract', () => {
  it.each(financePages)('%s uses the shared page shell and canonical title', (file, title) => {
    const source = read(file);
    expect(source).toContain('finance-page');
    expect(source).toContain('finance-page__title');
    expect(source).toContain(title);
  });

  it('defines one shared heading, filter, table, button, and mobile treatment', () => {
    const css = read('styles/finance.css');
    expect(css).toContain('.finance-page__header');
    expect(css).toContain('.finance-page__filters');
    expect(css).toContain('.finance-page__table-card');
    expect(css).toContain('.finance-page__primary-action');
    expect(css).toContain('@media (max-width: 768px)');
  });

  it('removes the Cost Master green-only title treatment through the shared title color', () => {
    const css = read('styles/finance.css');
    expect(css).toMatch(/\.finance-page__title\s*\{[\s\S]*?color:\s*var\(--text-primary\)\s*!important/);
  });
});
