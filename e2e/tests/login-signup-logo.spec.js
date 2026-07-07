import { test, expect } from '@playwright/test';

test.describe('Login and Signup Page Logo Updates', () => {
  test('Login page displays logo and updated subtitle', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    
    // Verify logo is visible
    const logo = page.locator('img[alt="Globussoft CRM"]').first();
    await expect(logo).toBeVisible();
    
    // Verify logo source
    const logoSrc = await logo.getAttribute('src');
    expect(logoSrc).toBe('/globussoft-logo-pdf.png');
    
    // Verify subtitle text
    const subtitle = page.locator('text=Sign into your CRM account');
    await expect(subtitle).toBeVisible();
  });

  test('Signup page displays logo', async ({ page }) => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    
    // Verify logo is visible
    const logo = page.locator('img[alt="Globussoft CRM"]').first();
    await expect(logo).toBeVisible();
    
    // Verify logo source
    const logoSrc = await logo.getAttribute('src');
    expect(logoSrc).toBe('/globussoft-logo-pdf.png');
    
    // Verify subtitle text
    const subtitle = page.locator('text=Create your organization');
    await expect(subtitle).toBeVisible();
  });
});
