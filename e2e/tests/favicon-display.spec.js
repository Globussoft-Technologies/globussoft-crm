import { test, expect } from '@playwright/test';

test.describe('Favicon Display', () => {
  test('view favicon in browser tab', async ({ page, context }) => {
    await context.clearCookies();
    
    // Add a small delay to ensure favicon is fetched
    await page.goto('/dashboard', { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    
    // Take full screenshot with more height to capture tab area
    await page.screenshot({ path: '../favicon-browser-tab.png', fullPage: false });
  });
});
