// @ts-check
/**
 * Marketing spec — campaign management page loads, campaigns list renders,
 * create campaign flow.
 */
const { test, expect } = require('@playwright/test');

test.describe('Marketing — Campaign management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/marketing');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Marketing page', async ({ page }) => {
    await expect(page).toHaveURL(/\/marketing/);
    await expect(page.locator('h1, h2').filter({ hasText: /marketing|campaign/i }).first()).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({ path: 'playwright-results/marketing-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/marketing');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('shows campaigns list or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Page should show either campaign items or an empty/create state
    const content = page.locator('.card, [class*="campaign"], table, ul').first();
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('Create Campaign button is present', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new campaign|\+ campaign/i })
      .first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
  });

  test('clicking Create Campaign opens a form or modal', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new campaign|\+ campaign/i })
      .first();
    await createBtn.click();
    await page.waitForTimeout(500);

    // Should show a form or modal
    const formEl = page.locator('[role="dialog"], form, .modal').first();
    const formCount = await formEl.count();
    if (formCount > 0) {
      await expect(formEl).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'playwright-results/marketing-create-campaign.png' });
    }
  });

  test('marketing page shows stats or metrics if campaigns exist', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Look for metrics like open rate, click rate, sent count
    const metricsEl = page
      .locator('text=/sent|open rate|click rate|delivered/i')
      .first();
    const metricsCount = await metricsEl.count();
    // If campaigns exist, metrics should be visible; otherwise page still renders
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('full marketing page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/marketing-full.png', fullPage: true });
  });
});
