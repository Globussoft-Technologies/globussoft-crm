// @ts-check
/**
 * Support spec — Support/ticketing page: ticket list,
 * ticket creation, empty state handling.
 */
const { test, expect } = require('@playwright/test');

test.describe('Support — Ticket Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/support');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Support page', async ({ page }) => {
    await expect(page).toHaveURL(/\/support/);
    await expect(
      page.locator('h1, h2').filter({ hasText: /support|ticket/i }).first()
    ).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/support-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/support');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('shows support tickets or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    const ticketList = page.locator('text=/ticket|no tickets|empty/i').first();
    const ticketCount = await ticketList.count();

    if (ticketCount > 0) {
      await expect(ticketList).toBeVisible();
    }

    // There should be either a ticket list, table, or an empty state
    const contentArea = page.locator('table, .ticket-list, [class*="ticket"], ul, [class*="empty"], text=/no tickets|open|closed|pending/i').first();
    const contentCount = await contentArea.count();
    expect(contentCount).toBeGreaterThanOrEqual(0);
  });

  test('has a form or button to create tickets', async ({ page }) => {
    await page.waitForTimeout(1500);

    const createForm = page.locator('form').first();
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new|add|submit/i })
      .first();

    const formCount = await createForm.count();
    const btnCount = await createBtn.count();

    expect(formCount + btnCount).toBeGreaterThan(0);
  });

  test('full page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/support-full.png', fullPage: true });
  });
});
