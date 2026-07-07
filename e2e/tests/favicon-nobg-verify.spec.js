import { test, expect } from '@playwright/test';

test.describe('Updated Favicon Verification', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('favicon is now logo-header-nobg.png', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login', { waitUntil: 'load' });
    
    // Get all favicon link elements
    const iconLink = page.locator('link[rel="icon"]');
    const altIcon = page.locator('link[rel="alternate icon"]');
    const appleTouchIcon = page.locator('link[rel="apple-touch-icon"]');
    
    const iconHref = await iconLink.getAttribute('href');
    const altHref = await altIcon.getAttribute('href');
    const appleTouchHref = await appleTouchIcon.getAttribute('href');
    
    console.log('Main icon href:', iconHref);
    console.log('Alternate icon href:', altHref);
    console.log('Apple touch icon href:', appleTouchHref);
    
    // Verify all point to the new favicon
    expect(iconHref).toBe('/logo-header-nobg.png');
    expect(altHref).toBe('/logo-header-nobg.png');
    expect(appleTouchHref).toBe('/logo-header-nobg.png');
  });
});
