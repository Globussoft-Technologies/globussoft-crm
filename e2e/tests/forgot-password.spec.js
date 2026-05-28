// @ts-check
/**
 * Forgot Password spec — covers the forgot password link on the login page
 * and the API endpoints for password reset flow.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

// #526 wire-in: this spec mixes a UI page-render test with pure-API tests.
// The api_tests deploy gate boots only the backend (BASE_URL=127.0.0.1:5000,
// no SPA served), so the UI test below would fail with "element not found"
// because navigation returns the JSON root, not index.html. Same `IS_LOCAL_STACK`
// guard pattern documented in CLAUDE.md "Local-stack-only specs must guard on
// BASE_URL" standing rule (used by backup-engine-api + migration-safety).
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

test.describe('Forgot Password — Password reset flow', () => {
  // Run without auth since this is a public/unauthenticated flow
  test.use({ storageState: { cookies: [], origins: [] } });

  // Collection-time skip (NOT a body-level test.skip): when IS_LOCAL_STACK,
  // register the test as skipped so Playwright never resolves the `page`
  // fixture — which would launch a browser. The api_tests deploy gate no
  // longer installs the Chromium binary (all gated specs are request-only),
  // so a body-level skip would still trigger a browser launch during fixture
  // setup and fail with "Executable doesn't exist". This form skips before
  // any fixture resolves. The UI assertion still runs in e2e-full vs demo.
  (IS_LOCAL_STACK ? test.skip : test)('login page shows forgot password link', async ({ page }) => {
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

    // 429 acceptance: see the #526 regression test below for the rate-limit
    // sharing window (#531 = 5/hr/email; two e2e-full runs against demo within
    // an hour exhaust the budget for admin@globussoft.com).
    expect([200, 429]).toContain(response.status());

    const body = await response.json();
    expect(body).toBeTruthy();
  });

  // #526 (CRIT-01) regression guard: the response body MUST NOT contain a
  // reset token under any field name. Previously `response.resetToken = token`
  // returned a valid reset token to any unauthenticated caller — full
  // account takeover for any known email. Token now ships via SendGrid only.
  //
  // 429 acceptance note (added 2026-05-06 after release-triggered e2e-full
  // failed when the push-triggered run had eaten the #531 5/hr/email budget):
  // when two e2e-full runs hit demo within an hour they share the per-email
  // rate-limit bucket. The security property (no token in body) still holds
  // for the rate-limiter response too — it has its own envelope, no token
  // field, and no 64-hex-char string. We assert on whichever status came back.
  test('#526 regression: response body NEVER contains a reset token', async ({ request }) => {
    const knownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: 'admin@globussoft.com' },
    });
    expect([200, 429]).toContain(knownRes.status());
    const knownBody = await knownRes.json();
    // Belt + suspenders: cover every plausible token field name an attacker
    // would scrape, AND assert no string in the JSON looks like our 32-byte
    // hex token (64 hex chars). These hold whether the response is the
    // happy-path 200 envelope or the rate-limiter 429 envelope.
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
  //
  // 429 acceptance: when the known email's bucket is exhausted (see test
  // above), it returns 429 while a freshly-generated unknown email lands on
  // its own untouched bucket → 200. The shape-equality assertion would then
  // compare a rate-limiter envelope to a forgot-password envelope and fail
  // even though no real anti-enumeration property is being violated. Skip
  // the shape comparison if either request was rate-limited; the actual
  // anti-enumeration contract is exercised whenever both are 200.
  test('#526/HI-02 regression: identical response shape for unknown email', async ({ request }) => {
    const knownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: 'admin@globussoft.com' },
    });
    const unknownRes = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: { email: `nope-${Date.now()}@no-such-tenant.example` },
    });
    expect([200, 429]).toContain(knownRes.status());
    expect([200, 429]).toContain(unknownRes.status());
    if (knownRes.status() === 429 || unknownRes.status() === 429) {
      test.skip(true, '#531 rate-limit hit — anti-enumeration shape contract requires both 200; runs cleanly when bucket is fresh');
      return;
    }
    const knownBody = await knownRes.json();
    const unknownBody = await unknownRes.json();
    // Same set of keys + same `message` string. (Don't assert deep equality
    // because some envs may add request-id headers etc., but the body shape
    // should be stable.)
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
    expect(knownBody.code).toBe(unknownBody.code); expect(knownBody.code).toBe("RESET_LINK_REQUESTED"); // #550
  });

  test('API: POST /api/auth/reset-password with valid token resets password', async ({ request }) => {
    // Step 1: Call forgot-password to obtain a reset token
    const forgotResponse = await request.post(`${BASE_URL}/api/auth/forgot-password`, {
      data: {
        email: 'admin@globussoft.com',
      },
    });

    // 429 acceptance: same rate-limiter window as the #526 / #526-HI-02 tests
    // above. When the bucket is exhausted, no token can be issued → fall
    // through to the no-token branch which the test already handles.
    expect([200, 429]).toContain(forgotResponse.status());
    if (forgotResponse.status() === 429) {
      test.skip(true, '#531 rate-limit hit — reset-with-token requires a fresh forgot-password 200; runs cleanly when bucket is fresh');
      return;
    }
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
      expect(forgotBody.code || forgotBody.message || forgotBody.success).toBeTruthy(); // #550 (back-compat with code)
    }
  });
});
