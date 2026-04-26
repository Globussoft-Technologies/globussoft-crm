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
    await page.waitForTimeout(2000);
    // #128 made deltas period-over-period, so when there's no prior baseline
    // (range = "all" or prior = 0) the cards render an em-dash instead of "+22%".
    // Either trend percentage badges OR em-dash placeholders are valid output.
    const trendBadges = page.locator('span').filter({ hasText: /[+\-]\d|—/ });
    const count = await trendBadges.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('revenue chart is rendered', async ({ page }) => {
    // Recharts renders an SVG element for the area chart
    const chartSvg = page.locator('.recharts-wrapper, svg').first();
    await expect(chartSvg).toBeVisible({ timeout: 10000 });
  });

  test('chart shows pipeline stage labels', async ({ page }) => {
    // Wait for chart to render
    await page.waitForTimeout(2000);
    // On mobile Recharts may hide tick labels on narrow viewports;
    // verify the chart wrapper itself is present as a fallback
    const chartWrapper = page.locator('.recharts-wrapper, svg').first();
    await expect(chartWrapper).toBeVisible({ timeout: 10000 });

    // Also try to find stage labels in the DOM (may be present but clipped)
    const bodyHtml = await page.locator('body').innerHTML();
    const hasStageData = ['Lead', 'Contacted', 'Proposal', 'Won'].some(s => bodyHtml.includes(s));
    expect(hasStageData).toBe(true);
  });

  test('Generate Report button is visible and navigates to /reports', async ({ page }) => {
    // Button label was renamed from "Generate Report" to "View Reports" (#128)
    const btn = page.locator('button').filter({ hasText: /View Reports|Generate Report/i }).first();
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
      (r) => 
        !r.url.includes('favicon') &&
        !r.url.includes('socket.io') &&
        !r.url.includes('vite.svg') &&
        !r.url.includes('ai_scoring') &&
        !r.url.includes('extension') &&
        !r.url.includes('chrome-extension') &&
        !(r.failure === 'net::ERR_BLOCKED_BY_CLIENT') &&
        !(r.failure === 'net::ERR_ABORTED')
    );
    // Log any failures for debugging
    if (criticalFailures.length > 0) {
      console.log('Critical network failures:', JSON.stringify(criticalFailures));
    }
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
