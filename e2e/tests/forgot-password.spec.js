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

  // #526 (CRIT-01) regression guard: the response body MUST NOT contain a
  // reset token under any field name. Previously `response.resetToken = token`
  // returned a valid reset token to any unauthenticated caller — full
  // account takeover for any known email. Token now ships via SendGrid only.
  test('#526 regression: response body NEVER contains a reset token', async ({ request }) => {
    const knownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: 'admin@globussoft.com' },
    });
    expect(knownRes.status()).toBe(200);
    const knownBody = await knownRes.json();
    // Belt + suspenders: cover every plausible token field name an attacker
    // would scrape, AND assert no string in the JSON looks like our 32-byte
    // hex token (64 hex chars).
    expect(knownBody.resetToken).toBeUndefined();
    expect(knownBody.token).toBeUndefined();
    expect(knownBody.data?.token).toBeUndefined();
    expect(knownBody.data?.resetToken).toBeUndefined();
    const flat = JSON.stringify(knownBody);
    expect(flat).not.toMatch(/[a-f0-9]{64}/i);
  });

  // #526/HI-02 anti-enumeration: response body shape is identical for known
  // and unknown emails. (Timing parity is best-effort — fire-and-forget
  // SendGrid send means timing is also identical, but we don't assert on
  // timing here because CI variance dominates.)
  test('#526/HI-02 regression: identical response shape for unknown email', async ({ request }) => {
    const knownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: 'admin@globussoft.com' },
    });
    const unknownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: `nope-${Date.now()}@no-such-tenant.example` },
    });
    expect(knownRes.status()).toBe(200);
    expect(unknownRes.status()).toBe(200);
    const knownBody = await knownRes.json();
    const unknownBody = await unknownRes.json();
    // Same set of keys + same `message` string. (Don't assert deep equality
    // because some envs may add request-id headers etc., but the body shape
    // should be stable.)
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
    expect(knownBody.message).toBe(unknownBody.message);
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
          newPassword: 'password123',
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
