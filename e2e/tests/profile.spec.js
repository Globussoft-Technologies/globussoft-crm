// @ts-check
/**
 * Profile spec — covers the user profile page: user info display,
 * name/email fields, change password section, and runtime error checks.
 */
const { test, expect } = require('@playwright/test');

test.describe('Profile — User Profile page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/profile');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Profile page with user info', async ({ page }) => {
    const heading = page.locator('h1, h2, h3').filter({ hasText: /profile|account/i });
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('shows user name and email fields', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Look for input fields containing user name and email
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], input[type="text"]').first();
    await expect(nameInput).toBeVisible({ timeout: 10000 });

    const emailInput = page.locator('input[name="email"], input[placeholder*="email" i], input[type="email"]').first();
    await expect(emailInput).toBeVisible({ timeout: 10000 });

    // Verify inputs have values (not empty)
    const nameValue = await nameInput.inputValue();
    expect(nameValue.length).toBeGreaterThan(0);

    const emailValue = await emailInput.inputValue();
    expect(emailValue).toContain('@');
  });

  test('shows change password section', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Look for password-related UI elements
    const passwordSection = page.locator('text=/change password|update password|new password|current password/i').first();
    await expect(passwordSection).toBeVisible({ timeout: 10000 });

    // Check for password input fields
    const passwordInputs = page.locator('input[type="password"]');
    const count = await passwordInputs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/profile');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    expect(errors).toEqual([]);
  });

  test('full profile page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/profile-full.png', fullPage: true });
  });
});
