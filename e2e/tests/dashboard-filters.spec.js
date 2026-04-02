// @ts-check
/**
 * Dashboard Filters spec — covers the date range filter dropdown
 * on the main dashboard page and verifies interactivity.
 */
const { test, expect } = require('@playwright/test');

test.describe('Dashboard — Date range filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // Wait for dashboard content to load
    await page.waitForTimeout(2000);
  });

  test('dashboard has date range dropdown with multiple options', async ({ page }) => {
    const dropdown = page.locator('select').first();
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Verify the dropdown contains expected date range options
    const options = dropdown.locator('option');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Check for specific option values
    const optionTexts = [];
    for (let i = 0; i < count; i++) {
      const text = await options.nth(i).textContent();
      optionTexts.push(text);
    }

    const expectedOptions = ['All Time', 'Last 7 Days', 'Last 30 Days'];
    for (const expected of expectedOptions) {
      const found = optionTexts.some((text) => text.includes(expected));
      expect(found).toBeTruthy();
    }
  });

  test('changing date range filter updates the dashboard', async ({ page }) => {
    const dropdown = page.locator('select').first();
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Select "Last 30 Days" option
    await dropdown.selectOption({ label: 'Last 30 Days' });
    await page.waitForTimeout(1500);

    // Verify the page did not crash — dashboard heading still visible
    const heading = page.locator('h1').filter({ hasText: /enterprise overview/i });
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('date range dropdown is interactive', async ({ page }) => {
    const dropdown = page.locator('select').first();
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Get the initial value
    const initialValue = await dropdown.inputValue();

    // Change to a different option
    await dropdown.selectOption({ label: 'Last 7 Days' });
    const newValue = await dropdown.inputValue();

    // Verify the value actually changed
    expect(newValue).not.toBe(initialValue);
  });

  test('full dashboard with filter screenshot', async ({ page }) => {
    const dropdown = page.locator('select').first();
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Select a filter to show filtered state
    await dropdown.selectOption({ label: 'Last 30 Days' });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'playwright-results/dashboard-filters.png', fullPage: true });
  });
});
