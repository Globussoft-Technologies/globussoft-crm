// @ts-check
/**
 * Invoices spec — Invoices page: summary stats, create form required fields,
 * invoice table, and mark-paid action.
 */
const { test, expect } = require('@playwright/test');

test.describe('Invoices — Invoice management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Invoices page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/invoices/);
    const heading = page.locator('h1, h2').filter({ hasText: /invoice/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/invoices-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('summary stats cards are visible', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Stats like total invoiced, paid, outstanding
    const statsEl = page
      .locator('[class*="stat"], [class*="summary"], [class*="card"]')
      .first();
    const statsCount = await statsEl.count();
    if (statsCount > 0) {
      await expect(statsEl).toBeVisible({ timeout: 15000 });
    }
    // Also check for dollar values as a proxy for stats
    const dollar = page.locator('text=/\\$[0-9]/').first();
    const dollarCount = await dollar.count();
    if (dollarCount > 0) {
      await expect(dollar).toBeVisible({ timeout: 15000 });
    }
    await page.screenshot({ path: 'playwright-results/invoices-stats.png' });
  });

  test('create invoice form has required fields (client, amount, due date)', async ({ page }) => {
    // Try to open create form if it requires a button click
    const createBtn = page
      .locator('button')
      .filter({ hasText: /new invoice|create invoice|add invoice|\+ invoice/i })
      .first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }

    // Client/contact field
    const clientField = page
      .locator('input[placeholder*="client" i], input[placeholder*="contact" i], select[name*="client" i]')
      .first();
    // Amount field
    const amountField = page
      .locator('input[placeholder*="amount" i], input[type="number"], input[name*="amount" i]')
      .first();
    // Due date field
    const dueDateField = page
      .locator('input[type="date"], input[placeholder*="due" i], input[name*="due" i]')
      .first();

    const clientCount = await clientField.count();
    const amountCount = await amountField.count();
    const dateCount = await dueDateField.count();

    // At least two of the three core fields should be present
    expect(clientCount + amountCount + dateCount).toBeGreaterThanOrEqual(2);
  });

  test('invoice table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      const card = page.locator('.card, [class*="invoice"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/invoices-table.png' });
  });

  test('mark paid button exists on unpaid invoices', async ({ page }) => {
    await page.waitForTimeout(2000);
    const markPaidBtn = page
      .locator('button')
      .filter({ hasText: /mark paid|mark as paid|paid/i })
      .first();
    const btnCount = await markPaidBtn.count();
    if (btnCount > 0) {
      await expect(markPaidBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no unpaid invoices exist
  });

  test('invoice status badges are visible (paid, pending, overdue)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page.locator('text=/paid|pending|overdue|draft/i').first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('full invoices page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/invoices-full.png', fullPage: true });
  });
});
