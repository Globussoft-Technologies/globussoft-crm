// @ts-check
/**
 * Portal spec — Public-facing Support & Knowledge Base page.
 * No authentication required (outside Layout wrapper).
 */
const { test, expect } = require('@playwright/test');

test.describe('Portal — Public Support Page', () => {
  // Clear auth state so we hit the page as an unauthenticated visitor
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/portal');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Portal page', async ({ page }) => {
    await expect(page).toHaveURL(/\/portal/);

    // The portal heading is "Support & Knowledge Base"
    await expect(
      page.locator('h1').filter({ hasText: /Support|Knowledge Base/i }).first()
    ).toBeVisible({ timeout: 10000 });

    // Verify Help Articles section exists
    await expect(
      page.locator('text=/Help Articles/i').first()
    ).toBeVisible({ timeout: 10000 });

    // Verify ticket submission form exists
    await expect(
      page.locator('text=/Submit.*Ticket|Raise.*Ticket/i').first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/portal');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('portal page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: 'playwright-results/portal-overview.png',
      fullPage: true,
    });
  });
});
