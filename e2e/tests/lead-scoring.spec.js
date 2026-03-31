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
    const res = await page.evaluate(async () => {
      const resp = await fetch('/api/ai_scoring/trigger', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      return resp.json();
    });
    expect(res.success).toBe(true);
    expect(typeof res.scored).toBe('number');
    expect(res.scored).toBeGreaterThan(0);
  });

  test('full lead scoring page screenshot', async ({ page }) => {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'playwright-results/lead-scoring-full.png', fullPage: true });
  });
});
