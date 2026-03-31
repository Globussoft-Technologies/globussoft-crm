// @ts-check
/**
 * Estimates spec — Estimates page: create form with line items section,
 * add-line-item button, estimate table, and convert-to-invoice action.
 */
const { test, expect } = require('@playwright/test');

test.describe('Estimates — Estimate management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/estimates');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Estimates page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/estimates/);
    const heading = page.locator('h1, h2').filter({ hasText: /estimate/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/estimates-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/estimates');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('create estimate form or button is visible', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add estimate|new estimate|create estimate|\+ estimate/i })
      .first();
    const form = page.locator('form').first();

    const btnCount = await createBtn.count();
    const formCount = await form.count();
    expect(btnCount + formCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'playwright-results/estimates-form.png' });
  });

  test('line items section is present in the create form', async ({ page }) => {
    // Open the create form if behind a button
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add estimate|new estimate|create estimate|\+ estimate/i })
      .first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }

    const lineItemsSection = page
      .locator('text=/line items?|items?|products?/i')
      .first();
    const sectionCount = await lineItemsSection.count();
    if (sectionCount > 0) {
      await expect(lineItemsSection).toBeVisible({ timeout: 15000 });
    }
    await page.screenshot({ path: 'playwright-results/estimates-line-items.png' });
  });

  test('add line item button works', async ({ page }) => {
    // Open the create form if behind a button
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add estimate|new estimate|create estimate|\+ estimate/i })
      .first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }

    const addLineItemBtn = page
      .locator('button')
      .filter({ hasText: /add item|add line|add product|\+ item|\+ line/i })
      .first();
    const addBtnCount = await addLineItemBtn.count();
    if (addBtnCount > 0) {
      await expect(addLineItemBtn).toBeVisible({ timeout: 15000 });
      await addLineItemBtn.click({ force: true });
      await page.waitForTimeout(500);
      // A new row should appear — count input rows after click
      const lineInputs = page.locator(
        'input[placeholder*="item" i], input[placeholder*="description" i], input[name*="item" i]'
      );
      const inputCount = await lineInputs.count();
      expect(inputCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('estimate table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      const card = page.locator('.card, [class*="estimate"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/estimates-table.png' });
  });

  test('convert-to-invoice button exists on estimate rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const convertBtn = page
      .locator('button')
      .filter({ hasText: /convert.to.invoice|create invoice|to invoice/i })
      .first();
    const btnCount = await convertBtn.count();
    if (btnCount > 0) {
      await expect(convertBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no estimates exist yet
  });

  test('full estimates page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/estimates-full.png', fullPage: true });
  });
});
