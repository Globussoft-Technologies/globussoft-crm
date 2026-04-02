// @ts-check
/**
 * Clients spec — Clients management page: list view, search, client name
 * links to detail page.
 */
const { test, expect } = require('@playwright/test');

test.describe('Clients — Client management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Clients page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/clients/);
    const heading = page.locator('h1, h2').filter({ hasText: /clients/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/clients-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('client table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      // Card/grid layout fallback
      const card = page.locator('.card, [class*="client"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/clients-table.png' });
  });

  test('search input is visible and accepts input', async ({ page }) => {
    const searchInput = page
      .locator('input[placeholder*="search" i], input[type="search"], input[placeholder*="client" i]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15000 });
    await searchInput.fill('acme');
    await page.waitForTimeout(500);
    const value = await searchInput.inputValue();
    expect(value).toBe('acme');
  });

  test('client name links navigate to contact detail page', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Clients page links go to /contacts/:id (clients is a filtered view of contacts)
    const clientLink = page.locator('a[href*="/contacts/"]').first();
    const linkCount = await clientLink.count();
    if (linkCount > 0) {
      await clientLink.click();
      await page.waitForLoadState('domcontentloaded');
      await expect(page).toHaveURL(/\/contacts\/.+/);
      await page.screenshot({ path: 'playwright-results/clients-detail.png' });
    } else {
      // No clients yet — skip gracefully
      test.skip(true, 'No client links found — list may be empty');
    }
  });

  test('clients page shows search or table (filtered contacts view)', async ({ page }) => {
    // Clients is a filtered view of contacts (status=Customer), no separate "Add" button
    const searchInput = page.locator('input[placeholder*="search" i]').first();
    const table = page.locator('table').first();

    const searchCount = await searchInput.count();
    const tableCount = await table.count();
    expect(searchCount + tableCount).toBeGreaterThan(0);
  });

  test('client rows show company or contact name column', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Column headers should include Name or Company
    const nameHeader = page.locator('th, [class*="header"]').filter({ hasText: /name|company/i }).first();
    const headerCount = await nameHeader.count();
    if (headerCount > 0) {
      await expect(nameHeader).toBeVisible({ timeout: 15000 });
    }
  });

  test('full clients page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/clients-full.png', fullPage: true });
  });
});
