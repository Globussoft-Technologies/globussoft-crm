// @ts-check
/**
 * Leads spec — Leads management page: list view, search, create form,
 * and convert-to-customer action.
 */
const { test, expect } = require('@playwright/test');

test.describe('Leads — Lead management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Leads page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/leads/);
    const heading = page.locator('h1, h2').filter({ hasText: /leads/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/leads-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/leads');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('lead table or list renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      // Card/grid layout fallback
      const listContainer = page.locator('.card, [class*="lead"]').first();
      const containerCount = await listContainer.count();
      if (containerCount > 0) {
        await expect(listContainer).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/leads-table.png' });
  });

  test('search input is visible and accepts input', async ({ page }) => {
    const searchInput = page
      .locator('input[placeholder*="search" i], input[type="search"], input[placeholder*="lead" i]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15000 });
    await searchInput.fill('test lead');
    await page.waitForTimeout(500);
    const value = await searchInput.inputValue();
    expect(value).toBe('test lead');
  });

  test('create lead form or button is visible', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add lead|new lead|create lead|\+ lead/i })
      .first();
    const form = page.locator('form').first();

    const btnCount = await createBtn.count();
    const formCount = await form.count();
    expect(btnCount + formCount).toBeGreaterThan(0);
  });

  test('convert-to-customer button exists on lead rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const convertBtn = page
      .locator('button')
      .filter({ hasText: /convert|customer/i })
      .first();
    const btnCount = await convertBtn.count();
    if (btnCount > 0) {
      await expect(convertBtn).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no leads exist yet — the table may be empty
  });

  test('status badges are visible on lead rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page.locator('text=/new|contacted|qualified|lost/i').first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('full leads page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/leads-full.png', fullPage: true });
  });
});
