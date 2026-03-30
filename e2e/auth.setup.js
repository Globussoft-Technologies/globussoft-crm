// @ts-check
/**
 * Auth setup — gets a token via API and injects it into localStorage
 * so all other tests skip the login step.
 */
const { test: setup, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const AUTH_STATE_PATH = path.join(__dirname, 'playwright/.auth/user.json');

setup('authenticate and save storage state', async ({ page, request }) => {
  // Ensure the auth state directory exists
  const authDir = path.dirname(AUTH_STATE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Use the admin/admin bypass to get a token via API
  const loginResponse = await request.post('/api/auth/login', {
    data: { email: 'admin', password: 'admin' },
  });

  expect(loginResponse.ok()).toBeTruthy();
  const loginData = await loginResponse.json();
  expect(loginData.token).toBeTruthy();

  console.log('[auth.setup] Got token via API bypass');

  // Navigate to the app and inject the token into localStorage
  await page.goto('/login');
  await page.evaluate((token) => {
    localStorage.setItem('token', token);
  }, loginData.token);

  // Navigate to dashboard — should now be authenticated
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Verify we're on the dashboard (not redirected to /login)
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('text=Globussoft').first()).toBeVisible({ timeout: 10000 });

  console.log('[auth.setup] Dashboard loaded successfully');

  // Persist auth state (localStorage token + cookies)
  await page.context().storageState({ path: AUTH_STATE_PATH });

  console.log('[auth.setup] Storage state saved to:', AUTH_STATE_PATH);
});
