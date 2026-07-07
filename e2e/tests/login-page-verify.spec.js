import { test, expect } from '@playwright/test';

test.describe('Login Page Visual', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('displays logo and updated text', async ({ page, context }) => {
    // Clear storage to ensure we're not authenticated
    await context.clearCookies();
    
    await page.goto('/login', { waitUntil: 'load' });
    
    // Verify we're on login page
    expect(page.url()).toContain('/login');
    
    // Check for the logo image
    const logo = page.locator('img[alt="Globussoft CRM"]');
    const logoCount = await logo.count();
    console.log('Found logo images:', logoCount);
    
    // Check for updated text
    const subtitle = page.getByText('Sign into your CRM account');
    const subtitleCount = await subtitle.count();
    console.log('Found updated subtitle:', subtitleCount);
    
    // Take screenshot
    await page.screenshot({ path: '../login-page-screenshot.png', fullPage: true });
  });
});
