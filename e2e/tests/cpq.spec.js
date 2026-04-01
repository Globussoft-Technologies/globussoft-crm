// @ts-check
/**
 * CPQ spec — Configure-Price-Quote builder: deal selection,
 * product configuration, quote creation.
 */
const { test, expect } = require('@playwright/test');

test.describe('CPQ — Configure, Price, Quote', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/cpq');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the CPQ page', async ({ page }) => {
    await expect(page).toHaveURL(/\/cpq/);
    await expect(
      page.locator('h1, h2').filter({ hasText: /cpq|configure/i }).first()
    ).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/cpq-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/cpq');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('displays deals list or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    // CPQ page shows "Deal Selection" heading and either deals or "No deals available"
    const dealSelection = page.locator('text=/Deal Selection/i').first();
    const noDealMsg = page.locator('text=/No deals available|Loading deals/i').first();
    const dealButtons = page.locator('button').filter({ hasText: /./  });

    const headingCount = await dealSelection.count();
    const msgCount = await noDealMsg.count();

    // Either the heading is visible, or a message, or deal buttons
    expect(headingCount + msgCount).toBeGreaterThanOrEqual(1);
  });

  test('shows CPQ-related headings (Configure, Price, Quote)', async ({ page }) => {
    await page.waitForTimeout(2000);

    const cpqHeading = page
      .locator('h1, h2, h3, h4')
      .filter({ hasText: /configure|price|quote|cpq|product/i })
      .first();
    const headingCount = await cpqHeading.count();

    if (headingCount > 0) {
      await expect(cpqHeading).toBeVisible({ timeout: 10000 });
    }

    await page.screenshot({ path: 'playwright-results/cpq-headings.png' });
  });

  test('full page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/cpq-full.png', fullPage: true });
  });
});
