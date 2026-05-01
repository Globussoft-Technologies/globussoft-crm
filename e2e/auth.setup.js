// @ts-check
/**
 * Auth setup — gets a token via API and injects it into sessionStorage
 * so all other tests skip the login step.
 *
 * NOTE: Pre-v3.2.5 the token lived in localStorage and the AuthContext
 * read it on cold start. v3.2.5 (#343) migrated to a module-level
 * in-memory holder + sessionStorage fallback for security (XSS could
 * exfil any localStorage token; sessionStorage at least clears on tab
 * close). The cold-start rehydrate in frontend/src/utils/api.js (line
 * ~55) reads ONLY from sessionStorage. So this setup writes to
 * sessionStorage to match the new auth model.
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

  // Login with real admin credentials
  const loginResponse = await request.post('/api/auth/login', {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });

  expect(loginResponse.ok()).toBeTruthy();
  const loginData = await loginResponse.json();
  expect(loginData.token).toBeTruthy();

  console.log('[auth.setup] Got token via admin login');

  // Navigate to the app and inject the token into sessionStorage
  // (the v3.2.5+ persistence path). Don't write to localStorage —
  // utils/api.js explicitly skips it on cold-start rehydrate.
  await page.goto('/login');
  await page.evaluate((token) => {
    sessionStorage.setItem('token', token);
  }, loginData.token);

  // Navigate to dashboard — should now be authenticated
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Verify we're on the dashboard (not redirected to /login)
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
  await expect(page.locator('text=Globussoft').first()).toBeVisible({ timeout: 10000 });

  console.log('[auth.setup] Dashboard loaded successfully');

  // Persist auth state (localStorage token + cookies)
  await page.context().storageState({ path: AUTH_STATE_PATH });

  console.log('[auth.setup] Storage state saved to:', AUTH_STATE_PATH);
});
