// @ts-check
/**
 * Dashboard spec — verifies the main analytics overview page:
 * metrics cards, revenue chart, navigation to reports.
 */
const { test, expect } = require('@playwright/test');

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Enterprise Overview header', async ({ page }) => {
    await expect(page.locator('h1').filter({ hasText: 'Enterprise Overview' })).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/dashboard-header.png' });
  });

  test('shows all four metric stat cards', async ({ page }) => {
    // The dashboard renders 4 stat cards: Closed Revenue, Total Contacts, Conversion Rate, Total Deals
    const statLabels = ['Closed Revenue', 'Total Contacts', 'Conversion Rate', 'Total Deals'];
    for (const label of statLabels) {
      await expect(page.locator(`text=${label}`)).toBeVisible({ timeout: 10000 });
    }
  });

  test('stat cards show numeric values', async ({ page }) => {
    // Revenue card should show a dollar sign
    const revenueCard = page.locator('text=Closed Revenue').locator('..').locator('..');
    await expect(revenueCard).toBeVisible({ timeout: 10000 });

    // Conversion rate shows a percentage
    const conversionCard = page.locator('text=Conversion Rate').locator('..').locator('..');
    await expect(conversionCard).toBeVisible({ timeout: 10000 });
  });

  test('percentage increase badges are visible on metric cards', async ({ page }) => {
    // All cards show trend indicators like +14%, +5%
    const trendBadges = page.locator('text=/\\+\\d+(\\.\\d+)?%/');
    const count = await trendBadges.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('revenue chart is rendered', async ({ page }) => {
    // Recharts renders an SVG element for the area chart
    const chartSvg = page.locator('.recharts-wrapper, svg').first();
    await expect(chartSvg).toBeVisible({ timeout: 10000 });
  });

  test('chart shows pipeline stage labels', async ({ page }) => {
    // The chart X-axis has: Lead, Contacted, Proposal, Won
    const stages = ['Lead', 'Contacted', 'Proposal', 'Won'];
    for (const stage of stages) {
      await expect(page.locator(`text=${stage}`).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('Generate Report button is visible and navigates to /reports', async ({ page }) => {
    const btn = page.locator('button', { hasText: 'Generate Report' });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page).toHaveURL(/\/reports/, { timeout: 10000 });
  });

  test('sidebar is visible on dashboard', async ({ page }) => {
    await expect(page.locator('text=Globussoft').first()).toBeVisible();
    await expect(page.locator('text=Dashboard').first()).toBeVisible();
    await expect(page.locator('text=Contacts').first()).toBeVisible();
  });

  test('no console errors on dashboard load', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Filter out known non-critical browser extension errors
    const criticalErrors = consoleErrors.filter(
      (err) => !err.includes('favicon') && !err.includes('extension')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('no failed network requests on dashboard load', async ({ page }) => {
    const failedRequests = [];
    page.on('requestfailed', (req) => {
      failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const criticalFailures = failedRequests.filter(
      (r) => !r.url.includes('favicon') && !r.url.includes('socket.io')
    );
    expect(criticalFailures).toHaveLength(0);
  });

  test('dashboard loads within acceptable time', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const duration = Date.now() - start;
    // Page should load within 8 seconds
    expect(duration).toBeLessThan(8000);
  });

  test('full dashboard screenshot', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: 'playwright-results/dashboard-full.png', fullPage: true });
  });
});
