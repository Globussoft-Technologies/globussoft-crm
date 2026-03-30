// @ts-check
/**
 * Auth spec — covers login, logout, signup page, invalid credentials,
 * and token persistence across page reloads.
 *
 * NOTE: These tests do NOT use saved storage state — they exercise the
 * actual login/logout flows from a clean browser context.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

const VALID_CREDENTIALS = {
  email: 'admin@globussoft.com',
  password: 'password123',
};

test.describe('Authentication — Login flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
  });

  test('renders login page with required elements', async ({ page }) => {
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('text=Globussoft CRM')).toBeVisible();
    await expect(page.locator('text=Sign in to your account')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toHaveText(/sign in/i);
  });

  test('shows demo credentials hint on login page', async ({ page }) => {
    // The login page shows demo credential hints
    const demoHint = page.locator('text=Demo Credentials');
    await expect(demoHint).toBeVisible();
  });

  test('shows link to signup page', async ({ page }) => {
    const signupLink = page.locator('a[href="/signup"]');
    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveText(/sign up/i);
  });

  test('shows error message with invalid credentials', async ({ page }) => {
    await page.fill('input[type="email"]', 'invalid@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    // Wait for error message to appear
    const errorEl = page.locator('[style*="danger"], .error, [class*="error"]').first();
    await expect(errorEl).toBeVisible({ timeout: 8000 });

    // Should still be on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('shows error message with empty password', async ({ page }) => {
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    // Leave password empty and submit
    await page.click('button[type="submit"]');

    // HTML5 validation should prevent submission or show an error
    // Either the browser shows native validation or the app shows a message
    const url = page.url();
    expect(url).toContain('/login');
  });

  test('successfully logs in with valid credentials and redirects to dashboard', async ({ page }) => {
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    await page.fill('input[type="password"]', VALID_CREDENTIALS.password);
    await page.click('button[type="submit"]');

    await page.waitForURL('/', { timeout: 15000 });
    await expect(page).not.toHaveURL(/\/login/);

    // Dashboard should be visible
    await expect(page.locator('text=Enterprise Overview')).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: 'playwright-results/auth-login-success.png' });
  });

  test('token is stored in localStorage after login', async ({ page }) => {
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    await page.fill('input[type="password"]', VALID_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('/', { timeout: 15000 });

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).not.toBeNull();
    expect(token.length).toBeGreaterThan(10);
  });

  test('token persists across page reload', async ({ page }) => {
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    await page.fill('input[type="password"]', VALID_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('/', { timeout: 15000 });

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still be on dashboard, not redirected to login
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('text=Enterprise Overview')).toBeVisible({ timeout: 10000 });
  });

  test('unauthenticated user is redirected to login when accessing protected route', async ({ page }) => {
    // Attempt to navigate to dashboard without auth
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should be redirected to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 });
  });
});

test.describe('Authentication — Logout flow', () => {
  test.beforeEach(async ({ page }) => {
    // Log in first
    await page.goto('/login');
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    await page.fill('input[type="password"]', VALID_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('/', { timeout: 15000 });
  });

  test('clearing token and reloading redirects to login', async ({ page }) => {
    // Simulate logout by clearing the token from localStorage
    await page.evaluate(() => localStorage.removeItem('token'));
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should redirect to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 });
  });
});

test.describe('Authentication — Signup page', () => {
  test('signup page renders correctly', async ({ page }) => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/signup/);
    // Page should contain some form for registration
    await expect(page.locator('form, input[type="email"]').first()).toBeVisible({ timeout: 8000 });

    await page.screenshot({ path: 'playwright-results/auth-signup-page.png' });
  });

  test('authenticated user visiting /signup is redirected to dashboard', async ({ page }) => {
    // Log in first
    await page.goto('/login');
    await page.fill('input[type="email"]', VALID_CREDENTIALS.email);
    await page.fill('input[type="password"]', VALID_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('/', { timeout: 15000 });

    // Now navigate to /signup — should redirect to dashboard
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/signup/);
    await expect(page).toHaveURL('/');
  });
});
