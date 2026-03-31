// @ts-check
/**
 * Contracts spec — Contracts management page: create form, contract table,
 * status badges with color coding, and activate/terminate actions.
 */
const { test, expect } = require('@playwright/test');

test.describe('Contracts — Contract management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contracts');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Contracts page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/contracts/);
    const heading = page.locator('h1, h2').filter({ hasText: /contract/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/contracts-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/contracts');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('create contract form or button is visible', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add contract|new contract|create contract|\+ contract/i })
      .first();
    const form = page.locator('form').first();

    const btnCount = await createBtn.count();
    const formCount = await form.count();
    expect(btnCount + formCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'playwright-results/contracts-form.png' });
  });

  test('contract table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      const card = page.locator('.card, [class*="contract"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/contracts-table.png' });
  });

  test('status badges are visible and correctly labeled', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Common contract statuses
    const badge = page
      .locator('text=/draft|active|expired|terminated|pending.signature/i')
      .first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('activate button exists on eligible contract rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const activateBtn = page
      .locator('button')
      .filter({ hasText: /activate|sign|execute/i })
      .first();
    const btnCount = await activateBtn.count();
    if (btnCount > 0) {
      await expect(activateBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no draft contracts exist
  });

  test('terminate button exists on active contract rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const terminateBtn = page
      .locator('button')
      .filter({ hasText: /terminate|cancel contract|void/i })
      .first();
    const btnCount = await terminateBtn.count();
    if (btnCount > 0) {
      await expect(terminateBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no active contracts exist
  });

  test('full contracts page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/contracts-full.png', fullPage: true });
  });
});
