import { test, expect } from '@playwright/test';

test.describe('Login and Signup Page Logo Verification', () => {
  test('Login page should display logo and updated text', async ({ page }) => {
    await page.goto('http://localhost:5174/login');
    
    // Wait for the page to load
    await page.waitForLoadState('domcontentloaded');
    
    // Check if logo image exists
    const logoImg = page.locator('img[alt="Globussoft CRM"]').first();
    await expect(logoImg).toBeVisible();
    
    // Check if logo has correct src
    const logoSrc = await logoImg.getAttribute('src');
    console.log('Logo src:', logoSrc);
    expect(logoSrc).toBe('/globussoft-logo-pdf.png');
    
    // Check if the text says "Sign into your CRM account"
    const subtitle = page.locator('p').filter({ hasText: 'Sign into your CRM account' });
    await expect(subtitle).toBeVisible();
    
    // Take screenshot
    await page.screenshot({ path: 'login-page.png', fullPage: true });
    console.log('Login page screenshot saved');
  });

  test('Signup page should display logo', async ({ page }) => {
    await page.goto('http://localhost:5174/signup');
    
    // Wait for the page to load
    await page.waitForLoadState('domcontentloaded');
    
    // Check if logo image exists
    const logoImg = page.locator('img[alt="Globussoft CRM"]').first();
    await expect(logoImg).toBeVisible();
    
    // Check if logo has correct src
    const logoSrc = await logoImg.getAttribute('src');
    expect(logoSrc).toBe('/globussoft-logo-pdf.png');
    
    // Check if the text says "Create your organization"
    const subtitle = page.locator('p').filter({ hasText: 'Create your organization' });
    await expect(subtitle).toBeVisible();
    
    // Take screenshot
    await page.screenshot({ path: 'signup-page.png', fullPage: true });
    console.log('Signup page screenshot saved');
  });
});
