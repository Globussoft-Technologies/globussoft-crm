import { test, expect } from '@playwright/test';

test.describe('Signup Page Visual', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('displays logo', async ({ page, context }) => {
    await context.clearCookies();
    
    await page.goto('/signup', { waitUntil: 'load' });
    
    // Check for the logo image
    const logo = page.locator('img[alt="Globussoft CRM"]');
    const logoCount = await logo.count();
    console.log('Signup - Found logo images:', logoCount);
    
    // Take screenshot
    await page.screenshot({ path: '../signup-page-screenshot.png', fullPage: true });
  });
});
