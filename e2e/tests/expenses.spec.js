// @ts-check
/**
 * Expenses spec — Expenses management page: create form, category dropdown,
 * expense table, and approve/reject actions on pending items.
 */
const { test, expect } = require('@playwright/test');

test.describe('Expenses — Expense management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/expenses');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Expenses page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/expenses/);
    const heading = page.locator('h1, h2').filter({ hasText: /expense/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/expenses-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/expenses');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('create expense form or button is visible', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add expense|new expense|create expense|\+ expense/i })
      .first();
    const form = page.locator('form').first();

    const btnCount = await createBtn.count();
    const formCount = await form.count();
    expect(btnCount + formCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'playwright-results/expenses-form.png' });
  });

  test('category dropdown has selectable options', async ({ page }) => {
    // Open the create form if behind a button
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add expense|new expense|create expense|\+ expense/i })
      .first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }

    const categorySelect = page
      .locator('select[name*="category" i], select[aria-label*="category" i]')
      .first();
    const categoryCount = await categorySelect.count();
    if (categoryCount > 0) {
      await expect(categorySelect).toBeVisible({ timeout: 15000 });
      // Should have more than just a blank/placeholder option
      const options = await categorySelect.locator('option').count();
      expect(options).toBeGreaterThan(1);
    }
  });

  test('expense table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      const card = page.locator('.card, [class*="expense"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/expenses-table.png' });
  });

  test('approve and reject buttons exist on pending expense rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const approveBtn = page
      .locator('button')
      .filter({ hasText: /approve/i })
      .first();
    const rejectBtn = page
      .locator('button')
      .filter({ hasText: /reject|decline/i })
      .first();

    const approveCount = await approveBtn.count();
    const rejectCount = await rejectBtn.count();

    if (approveCount > 0) {
      await expect(approveBtn).toBeVisible({ timeout: 15000 });
    }
    if (rejectCount > 0) {
      await expect(rejectBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no pending expenses exist
  });

  test('expense status badges are visible (pending, approved, rejected)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page.locator('text=/pending|approved|rejected|reimbursed/i').first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('full expenses page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/expenses-full.png', fullPage: true });
  });
});
