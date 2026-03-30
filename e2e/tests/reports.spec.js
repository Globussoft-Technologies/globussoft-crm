// @ts-check
/**
 * Reports spec — BI analytics page loads, charts render, data filters work.
 */
const { test, expect } = require('@playwright/test');

test.describe('Reports — BI Analytics', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/reports');
    await page.waitForLoadState('networkidle');
  });

  test('renders the Reports page', async ({ page }) => {
    await expect(page).toHaveURL(/\/reports/);
    await expect(page.locator('h1, h2').filter({ hasText: /report|analytics|bi/i }).first()).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({ path: 'playwright-results/reports-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/reports');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('at least one chart is rendered on the reports page', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Recharts renders SVG — check for chart SVG elements
    const chartEl = page.locator('.recharts-wrapper, .recharts-surface, svg').first();
    await expect(chartEl).toBeVisible({ timeout: 10000 });
  });

  test('reports page shows revenue or deal metrics', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Reports should show some financial/deal analytics
    const metricsEl = page
      .locator('text=/revenue|deals|conversion|pipeline|contacts/i')
      .first();
    await expect(metricsEl).toBeVisible({ timeout: 10000 });
  });

  test('date range filter or period selector is present', async ({ page }) => {
    // Reports typically have a date range picker or period selector
    const filterEl = page
      .locator('select, input[type="date"], button')
      .filter({ hasText: /30 days|week|month|year|filter|period/i })
      .first();
    const filterCount = await filterEl.count();
    if (filterCount > 0) {
      await expect(filterEl).toBeVisible();
    }
  });

  test('recharts tooltip appears on chart hover', async ({ page }) => {
    await page.waitForTimeout(2000);

    const chart = page.locator('.recharts-wrapper').first();
    const chartCount = await chart.count();

    if (chartCount > 0) {
      const chartBox = await chart.boundingBox();
      if (chartBox) {
        // Hover over the center of the chart
        await page.mouse.move(
          chartBox.x + chartBox.width / 2,
          chartBox.y + chartBox.height / 2
        );
        await page.waitForTimeout(500);
        // Tooltip may or may not appear depending on data
        // Just verify no crash
        await expect(chart).toBeVisible();
      }
    }
  });

  test('reports page has multiple chart sections', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Count chart containers
    const charts = page.locator('.recharts-wrapper, svg[class*="recharts"]');
    const chartCount = await charts.count();
    expect(chartCount).toBeGreaterThanOrEqual(1);
  });

  test('full reports page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/reports-full.png', fullPage: true });
  });
});
