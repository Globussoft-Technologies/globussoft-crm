import { test, expect } from '@playwright/test';

test.describe('Login Page Logo Full View', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('full page with logo at top', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login', { waitUntil: 'load' });
    
    // Get the card element
    const card = page.locator('.card').first();
    
    // Take screenshot of just the card area
    await card.screenshot({ path: '../login-card-screenshot.png' });
  });
});
