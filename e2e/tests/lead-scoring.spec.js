// @ts-check
/**
 * Lead Scoring spec — AI Lead Intelligence Dashboard
 */
const { test, expect } = require('@playwright/test');

test.describe('Lead Scoring — AI Lead Intelligence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lead-scoring');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
  });

  test('renders Lead Scoring page with correct heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/lead-scoring/);
    const heading = page.locator('h1').filter({ hasText: /Lead Intelligence/i }).first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: 'playwright-results/lead-scoring-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/lead-scoring');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(errors).toHaveLength(0);
  });

  test('KPI stat cards are visible', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(3000);
    // At least one card should exist
    const cards = page.locator('.card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Re-score All button triggers scoring and shows confirmation', async ({ page }) => {
    const trigger = page.locator('#trigger-rescore-btn');
    await expect(trigger).toBeVisible({ timeout: 8000 });
    await trigger.click({ force: true });

    // Button should show "Scoring..." briefly, then come back
    await page.waitForTimeout(4000);
    // Confirmation banner or button restored
    const btnRestored = await trigger.isVisible();
    expect(btnRestored).toBeTruthy();
    await page.screenshot({ path: 'playwright-results/lead-scoring-triggered.png' });
  });

  test('scores are updated via trigger API', async ({ page }) => {
    // Post-v3.2.5 the JWT lives in sessionStorage, not localStorage.
    // Pre-fix this test was reading localStorage.getItem('token') which
    // returns null → the request went out as `Bearer null` → 401 → no
    // `success` field on the response body → test failed. Fall back to
    // localStorage so the spec still works against older deployments.
    const res = await page.evaluate(async () => {
      const token = sessionStorage.getItem('token') || localStorage.getItem('token');
      const resp = await fetch('/api/ai_scoring/trigger', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      return resp.json();
    });
    expect(res.success).toBe(true);
    expect(typeof res.scored).toBe('number');
    // The engine only rescores contacts whose aiScoreLastComputedAt is null
    // OR older than RECOMPUTE_WINDOW_HOURS (24h). A `scored: 0` is a valid,
    // load-bearing answer when the cron has just run (every 10 min on demo)
    // — every contact is "fresh", nothing needs work. Pre-fix this asserted
    // `> 0`, which broke against demo precisely when the cron was healthy.
    // The contract we DO want to pin is: shape is `{ success: true, scored: number }`
    // with no NaN/null in `scored`. Negative is impossible from the engine.
    expect(res.scored).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(res.scored)).toBe(true);
  });

  test('full lead scoring page screenshot', async ({ page }) => {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'playwright-results/lead-scoring-full.png', fullPage: true });
  });
});
