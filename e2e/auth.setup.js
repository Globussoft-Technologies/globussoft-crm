// @ts-check
/**
 * Auth setup — gets a token via API and seeds storage so other tests
 * load already-authenticated.
 *
 * KEY INSIGHT (the bug we shipped in commit 294a697 + had to fix here):
 * Playwright's `storageState({path})` only captures `localStorage` and
 * cookies. It does NOT capture `sessionStorage`. So if the setup writes
 * the token to sessionStorage only, the captured state is empty and
 * every chromium-project test boots with no auth → redirects to /login
 * → cascades to ~150+ UI test failures.
 *
 * v3.2.5 (#343) migrated the app from localStorage to a module-level
 * in-memory holder + sessionStorage fallback (security: XSS could exfil
 * the localStorage token). The cold-start rehydrate in
 * frontend/src/utils/api.js reads sessionStorage; it deliberately does
 * NOT read localStorage on the modern path. BUT — frontend/src/App.jsx
 * has a one-time legacy-localStorage migration: on app boot, if a
 * legacy `localStorage.token` is present, it copies the value to the
 * in-memory holder + sessionStorage and deletes the localStorage key.
 *
 * That migration path is exactly what we exploit here:
 *   1. setup writes localStorage.token = <real JWT>
 *   2. Playwright's storageState({path}) captures localStorage → user.json
 *   3. chromium-project tests load user.json → start with localStorage
 *      pre-populated
 *   4. App boots → cold-start migration moves localStorage → sessionStorage
 *      + memory holder → deletes localStorage key
 *   5. Tests are authenticated; the token lives in sessionStorage exactly
 *      as production users would have it
 *
 * Defense-in-depth: we ALSO write sessionStorage directly — if the
 * migration path ever changes, the app will still find the token. The
 * extra write is a 5-byte string copy, no overhead.
 */
const { test: setup, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const AUTH_STATE_PATH = path.join(__dirname, 'playwright/.auth/user.json');

setup('authenticate and save storage state', async ({ page, request }) => {
  const authDir = path.dirname(AUTH_STATE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Login with real admin credentials.
  const loginResponse = await request.post('/api/auth/login', {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });

  expect(loginResponse.ok()).toBeTruthy();
  const loginData = await loginResponse.json();
  expect(loginData.token).toBeTruthy();

  console.log('[auth.setup] Got token via admin login');

  // Navigate to /login (sets the origin so storage writes are scoped to
  // the demo origin) then seed BOTH localStorage and sessionStorage with
  // the token. localStorage is the one Playwright actually captures via
  // storageState; sessionStorage is belt-and-braces in case the app's
  // migration path changes. Same key name ('token') in both places.
  await page.goto('/login');
  await page.evaluate((token) => {
    localStorage.setItem('token', token);
    try {
      sessionStorage.setItem('token', token);
    } catch (_e) {
      // sessionStorage can be disabled in some private modes; ignore.
    }
  }, loginData.token);

  // Visit / so the SPA boots, runs its legacy-localStorage migration
  // (App.jsx), and confirms it sees the token. If we save storageState
  // before this happens, the captured state would be the raw login-page
  // origin without the cold-start migration having fired — that's still
  // fine for the chromium-project tests because they ALSO will fire the
  // migration on first load. But waiting here proves the auth path
  // actually works before we save.
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Verify we're not on /login. We deliberately don't assert specific
  // brand text — the tenant.name is "NovaCrest Technologies" (per
  // backend/prisma/seed.js); a future tenant rename could break the
  // assertion. URL not /login is enough.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });

  // Wait for the SPA to settle so the post-migration state is what
  // gets captured.
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  console.log('[auth.setup] Dashboard loaded successfully');

  // Capture storage state. Playwright captures localStorage + cookies;
  // chromium-project tests will load this and the App.jsx migration
  // re-runs on each test's cold start (idempotent — moves localStorage
  // to sessionStorage, deletes localStorage). The token reaches the app
  // either way.
  await page.context().storageState({ path: AUTH_STATE_PATH });

  console.log('[auth.setup] Storage state saved to:', AUTH_STATE_PATH);
});
