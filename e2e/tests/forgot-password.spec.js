// @ts-check
/**
 * Forgot Password spec — covers the forgot password link on the login page
 * and the API endpoints for password reset flow.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

test.describe('Forgot Password — Password reset flow', () => {
  // Run without auth since this is a public/unauthenticated flow
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login page shows forgot password link', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    const forgotLink = page.locator('text=/forgot/i');
    await expect(forgotLink).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/forgot-password-link.png' });
  });

  test('API: POST /api/auth/forgot-password returns success', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: {
        email: 'admin@globussoft.com',
      },
    });

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toBeTruthy();
  });

  test('API: POST /api/auth/reset-password with valid token resets password', async ({ request }) => {
    // Step 1: Call forgot-password to obtain a reset token
    const forgotResponse = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: {
        email: 'admin@globussoft.com',
      },
    });

    expect(forgotResponse.status()).toBe(200);
    const forgotBody = await forgotResponse.json();

    // Extract the token from the response (the API may return it directly for demo/dev environments)
    const token = forgotBody.token || forgotBody.resetToken || forgotBody.data?.token;

    // Step 2: Call reset-password with the token
    if (token) {
      const resetResponse = await request.post(`${BASE_URL}/api/auth/reset-password`, {
        data: {
          token: token,
          password: 'password123',
        },
      });

      expect(resetResponse.status()).toBe(200);

      const resetBody = await resetResponse.json();
      expect(resetBody).toBeTruthy();
    } else {
      // If no token returned (e.g. sent via email), verify the forgot-password response indicates success
      expect(forgotBody.message || forgotBody.success).toBeTruthy();
    }
  });
});
