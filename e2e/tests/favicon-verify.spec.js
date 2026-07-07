import { test, expect } from '@playwright/test';

test.describe('Favicon Verification', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('favicon is loaded with logo-header.png', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login', { waitUntil: 'load' });
    
    // Get favicon link element
    const faviconLink = page.locator('link[rel="icon"]');
    const href = await faviconLink.getAttribute('href');
    const type = await faviconLink.getAttribute('type');
    
    console.log('Favicon href:', href);
    console.log('Favicon type:', type);
    
    expect(href).toBe('/logo-header.png');
    expect(type).toBe('image/png');
    
    // Take screenshot showing the browser tab
    await page.screenshot({ path: '../favicon-check.png', fullPage: false });
  });
});
