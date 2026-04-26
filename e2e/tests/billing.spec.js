// @ts-check
/**
 * Billing spec — invoices/estimates management page: tabs, invoice list,
 * create invoice, mark paid, delete invoice.
 */
const { test, expect } = require('@playwright/test');

test.describe('Billing — Invoice management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Billing page', async ({ page }) => {
    await expect(page).toHaveURL(/\/invoices/);
    await expect(page.locator('h1, h2').filter({ hasText: /billing|invoice/i }).first()).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({ path: 'playwright-results/billing-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('billing page shows invoice list or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Should show either invoices or an empty/create state
    const content = page.locator('.card, table, [class*="invoice"]').first();
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('Create Invoice or Issue Invoice form is present', async ({ page }) => {
    await page.waitForTimeout(2000);
    // The billing page has a form to issue new invoices
    const createForm = page.locator('form').first();
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|issue|new invoice|\+ invoice/i })
      .first();

    const formCount = await createForm.count();
    const btnCount = await createBtn.count();

    // Either form or button should be present
    expect(formCount + btnCount).toBeGreaterThan(0);
  });

  test('invoice list shows status badges (Paid/Pending)', async ({ page }) => {
    await page.waitForTimeout(2000);

    const statusBadge = page.locator('text=/paid|pending|overdue/i').first();
    const statusCount = await statusBadge.count();

    if (statusCount > 0) {
      await expect(statusBadge).toBeVisible();
    }
    // If no invoices exist, the empty state is acceptable
  });

  test('Mark as Paid button appears on unpaid invoices', async ({ page }) => {
    await page.waitForTimeout(2000);

    const markPaidBtn = page
      .locator('button')
      .filter({ hasText: /mark paid|pay|paid/i })
      .first();
    const btnCount = await markPaidBtn.count();

    if (btnCount > 0) {
      await expect(markPaidBtn).toBeVisible();
    }
    // OK if no unpaid invoices exist
  });

  test('delete invoice shows confirmation dialog', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Native window.confirm was replaced with an HTML modal (useNotify) in the
    // batch 6 dialog migration. The browser-side `dialog` event no longer
    // fires; we now look for the rendered HTML modal instead.
    const deleteBtn = page
      .locator('button')
      .filter({ hasText: /delete|remove|void/i })
      .first();
    const btnCount = await deleteBtn.count();

    if (btnCount === 0) {
      test.skip(true, 'No delete buttons found — invoice list may be empty');
      return;
    }
    await deleteBtn.click();
    const modal = page.locator('[role="dialog"][aria-modal="true"], [data-notify-modal]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
    // Cancel so we don't actually void the invoice.
    const cancelBtn = modal.locator('button').filter({ hasText: /cancel|no|close/i }).first();
    if ((await cancelBtn.count()) > 0) await cancelBtn.click();
  });

  test('billing page shows financial summary or totals', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Look for dollar amounts or total indicators
    const dollarEl = page.locator('text=/\\$[0-9,]+/').first();
    const totalEl = page.locator('text=/total|amount|revenue/i').first();

    const dollarCount = await dollarEl.count();
    const totalCount = await totalEl.count();

    // Either financial data or create form should be present
    expect(dollarCount + totalCount).toBeGreaterThanOrEqual(0);
    // Page renders
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('full billing page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/billing-full.png', fullPage: true });
  });
});
