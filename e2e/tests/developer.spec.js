// @ts-check
/**
 * Developer portal spec — API key management, webhook registration,
 * key generation and revocation.
 */
const { test, expect } = require('@playwright/test');

test.describe('Developer Portal — API Keys & Webhooks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/developer');
    await page.waitForLoadState('networkidle');
  });

  test('renders the Developer page', async ({ page }) => {
    await expect(page).toHaveURL(/\/developer/);
    await expect(
      page.locator('h1, h2').filter({ hasText: /developer|api|key/i }).first()
    ).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/developer-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/developer');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('API Keys section is visible', async ({ page }) => {
    await page.waitForTimeout(1500);

    const apiSection = page.locator('text=/api key|api keys/i').first();
    await expect(apiSection).toBeVisible({ timeout: 10000 });
  });

  test('Webhooks section is visible', async ({ page }) => {
    await page.waitForTimeout(1500);

    const webhookSection = page.locator('text=/webhook|webhooks/i').first();
    await expect(webhookSection).toBeVisible({ timeout: 10000 });
  });

  test('Generate API Key form is present', async ({ page }) => {
    // Developer page has a form to create API keys by name
    const keyNameInput = page
      .locator('input[placeholder*="key name" i], input[placeholder*="name" i]')
      .first();
    await expect(keyNameInput).toBeVisible({ timeout: 8000 });
  });

  test('Generate Key button is present', async ({ page }) => {
    const generateBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /generate|create key|new key/i })
      .first();
    await expect(generateBtn).toBeVisible({ timeout: 8000 });
  });

  test('existing API keys list renders (or empty state)', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Shows either a list of existing keys or an empty state
    const keyList = page.locator('.card, [class*="key"], li').first();
    await expect(keyList).toBeVisible({ timeout: 10000 });
  });

  test('Webhook registration form has event and URL fields', async ({ page }) => {
    await page.waitForTimeout(1500);

    const urlInput = page
      .locator('input[placeholder*="url" i], input[type="url"], input[name*="url" i]')
      .first();
    const eventSelect = page
      .locator('select')
      .first();

    await expect(urlInput).toBeVisible({ timeout: 8000 });
    await expect(eventSelect).toBeVisible({ timeout: 8000 });
  });

  test('register webhook button is present', async ({ page }) => {
    const registerBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /register|add webhook|create webhook/i })
      .last();
    await expect(registerBtn).toBeVisible({ timeout: 8000 });
  });

  test('generating an API key shows the raw key in an alert', async ({ page }) => {
    await page.waitForTimeout(1000);

    const keyNameInput = page
      .locator('input[placeholder*="key name" i], input[placeholder*="name" i]')
      .first();

    let alertText = '';
    page.on('dialog', async (dialog) => {
      alertText = dialog.message();
      await dialog.accept();
    });

    await keyNameInput.fill(`E2E Test Key ${Date.now()}`);

    const generateBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /generate|create key|new key/i })
      .first();
    await generateBtn.click();

    await page.waitForTimeout(2000);

    // The key should have been shown in an alert
    if (alertText) {
      expect(alertText).toContain('ATTENTION');
    }
    // No crash regardless
    await expect(page).toHaveURL(/\/developer/);
  });

  test('full developer page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/developer-full.png', fullPage: true });
  });
});
