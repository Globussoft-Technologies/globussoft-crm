// @ts-check
/**
 * SSO module — e2e API contract pin for backend/routes/sso.js.
 *
 * backend/routes/sso.js sits at 14.82% lines in c8 instrumentation — vitest
 * has solid unit coverage at backend/test/routes/sso.test.js but no
 * *-api.spec.js exercises the route through the api_tests gate's
 * c8-instrumented backend. This spec adds HTTP-layer coverage so c8 records
 * hits on every handler.
 *
 * Distinct from the bare `e2e/tests/sso.spec.js` (8-test smoke that is NOT in
 * the per-push api_tests gate spec list per the *-api.spec.js naming
 * convention). That bare spec covers basic OAuth-start + callback redirect
 * shapes; this spec pins config CRUD, secret-masking contract, validation,
 * auth-gate fan-out, and tenant-isolation in depth.
 *
 * Endpoints covered (all mounted at /api/sso):
 *   GET  /sso/config                     — list tenant's SSO configs (any authed user)
 *   PUT  /sso/config/:provider           — upsert provider config (ADMIN only)
 *   GET  /sso/google/start               — redirect to Google OAuth or 500 if unconfigured
 *   GET  /sso/microsoft/start            — redirect to Microsoft OAuth or 500 if unconfigured
 *   GET  /sso/google/callback            — code-exchange landing (public)
 *   GET  /sso/microsoft/callback         — code-exchange landing (public)
 *
 * Contracts pinned:
 *   1.  GET /config — ADMIN → 200 + array envelope.
 *   2.  GET /config — non-ADMIN (USER role) is ALLOWED (verifyToken only, no
 *       role gate) — contract is "any tenant member can read config shape".
 *       Pinned because the gap card hypothesised a 403 here; reality is 200.
 *   3.  GET /config — unauthenticated → 401.
 *   4.  GET /config — secret is MASKED in the response envelope (never raw).
 *   5.  PUT /config/:provider — ADMIN happy path returns upserted record with
 *       masked secret, then a subsequent GET reflects the new clientId.
 *   6.  PUT /config/:provider — partial update preserves the prior secret
 *       (omitting clientSecret in the body does NOT clear the stored secret).
 *   7.  PUT /config/:provider — USER role → 403 (verifyRole(['ADMIN']) gate).
 *   8.  PUT /config/:provider — unauthenticated → 401.
 *   9.  PUT /config/:provider — unsupported provider name → 400.
 *  10.  Cross-tenant isolation — wellness ADMIN's PUT against google is
 *       invisible to the generic ADMIN's GET (each tenant sees its own row only).
 *  11.  GET /sso/google/start — public (open path); either 302 to Google or
 *       500 when env vars are missing.
 *  12.  GET /sso/microsoft/start — public; either 302 to Microsoft or 500.
 *  13.  GET /sso/google/callback with no code → 302 to /login?sso_error=… per
 *       the route docstring (line 138-146 of routes/sso.js).
 *  14.  GET /sso/microsoft/callback with ?error=access_denied → 302 with
 *       sso_error= reflecting the IdP error.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';
const USER_EMAIL = 'user@crm.com';
const USER_PASSWORD = 'password123';
const WELLNESS_ADMIN_EMAIL = 'rishu@enhancedwellness.in';
const WELLNESS_ADMIN_PASSWORD = 'password123';

const RUN_TAG = `_teardown_sso_api_${Date.now()}`;

let adminToken = '';
let userToken = '';
let wellnessAdminToken = '';

async function login(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request.post(`${API}/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (res.ok()) {
        const body = await res.json();
        return body.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return '';
}

test.describe.configure({ mode: 'serial' });

test.describe('sso-api — config CRUD + OAuth redirect contracts', () => {
  test.beforeAll(async ({ request }) => {
    adminToken = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    userToken = await login(request, USER_EMAIL, USER_PASSWORD);
    wellnessAdminToken = await login(request, WELLNESS_ADMIN_EMAIL, WELLNESS_ADMIN_PASSWORD);
    expect(adminToken, 'generic admin login must succeed').toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // Soft-cleanup: deactivate any provider configs we touched. We upsert, so
    // a "delete" pass would orphan; instead we flip isActive=false so the
    // record stays but is dormant.
    if (adminToken) {
      for (const provider of ['google', 'microsoft']) {
        await request.put(`${API}/sso/config/${provider}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { isActive: false },
          timeout: REQUEST_TIMEOUT,
        }).catch(() => {});
      }
    }
    if (wellnessAdminToken) {
      await request.put(`${API}/sso/config/google`, {
        headers: { Authorization: `Bearer ${wellnessAdminToken}` },
        data: { isActive: false },
        timeout: REQUEST_TIMEOUT,
      }).catch(() => {});
    }
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  // ─── GET /sso/config ─────────────────────────────────────────────

  test('1. GET /sso/config — ADMIN → 200 + array envelope', async ({ request }) => {
    const res = await request.get(`${API}/sso/config`, {
      headers: auth(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('2. GET /sso/config — USER role is ALLOWED (verifyToken only, no role gate)', async ({ request }) => {
    test.skip(!userToken, 'generic USER credentials unavailable in this environment');
    const res = await request.get(`${API}/sso/config`, {
      headers: auth(userToken),
      timeout: REQUEST_TIMEOUT,
    });
    // Source: routes/sso.js:309 — `router.get("/config", verifyToken, ...)`
    // NO verifyRole gate. Any authed tenant member can read the (masked) config.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('3. GET /sso/config — unauthenticated → 401', async ({ request }) => {
    const res = await request.get(`${API}/sso/config`, { timeout: REQUEST_TIMEOUT });
    expect(res.status()).toBe(401);
  });

  test('4. GET /sso/config — clientSecret is MASKED in the response (never raw)', async ({ request }) => {
    // First seed a known secret via PUT so the GET has something to mask.
    const rawSecret = `${RUN_TAG}_raw_secret_value_zzz`;
    const putRes = await request.put(`${API}/sso/config/google`, {
      headers: auth(adminToken),
      data: {
        clientId: `${RUN_TAG}_clientId`,
        clientSecret: rawSecret,
        redirectUri: 'https://example.com/cb',
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(putRes.status()).toBe(200);

    const res = await request.get(`${API}/sso/config`, {
      headers: auth(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const googleRow = body.find((c) => c.provider === 'google');
    expect(googleRow, 'google config row must exist after PUT').toBeTruthy();
    expect(googleRow.clientSecret).not.toBe(rawSecret);
    expect(googleRow.clientSecret).toMatch(/\*/);
    // Mask helper format: first2 + ****(>=4) + last2
    expect(googleRow.clientSecret.length).toBeGreaterThanOrEqual(4);
  });

  // ─── PUT /sso/config/:provider ───────────────────────────────────

  test('5. PUT /sso/config/google — ADMIN happy path + GET reflects new clientId', async ({ request }) => {
    const newClientId = `${RUN_TAG}_updated_clientid`;
    const putRes = await request.put(`${API}/sso/config/google`, {
      headers: auth(adminToken),
      data: {
        clientId: newClientId,
        clientSecret: `${RUN_TAG}_some_secret`,
        redirectUri: 'https://example.com/cb2',
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(putRes.status()).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.provider).toBe('google');
    expect(putBody.clientId).toBe(newClientId);
    expect(putBody.clientSecret).toMatch(/\*/);

    const getRes = await request.get(`${API}/sso/config`, {
      headers: auth(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    const getBody = await getRes.json();
    const row = getBody.find((c) => c.provider === 'google');
    expect(row.clientId).toBe(newClientId);
  });

  test('6. PUT /sso/config/google — partial update (no clientSecret in body) preserves the prior secret', async ({ request }) => {
    // Source: routes/sso.js:344-345 — `...(clientSecret ? { clientSecret } : {})`.
    // Omitting clientSecret skips the overwrite; the stored secret survives.
    const partialClientId = `${RUN_TAG}_partial_clientid`;
    const res = await request.put(`${API}/sso/config/google`, {
      headers: auth(adminToken),
      data: {
        clientId: partialClientId,
        // intentionally NO clientSecret
        redirectUri: 'https://example.com/cb3',
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBe(partialClientId);
    // Secret must still be present (masked, not null) — was set in test 5.
    expect(body.clientSecret).not.toBeNull();
    expect(body.clientSecret).toMatch(/\*/);
  });

  test('7. PUT /sso/config/:provider — USER role → 403', async ({ request }) => {
    test.skip(!userToken, 'generic USER credentials unavailable in this environment');
    const res = await request.put(`${API}/sso/config/google`, {
      headers: auth(userToken),
      data: { clientId: 'should-not-apply' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(403);
  });

  test('8. PUT /sso/config/:provider — unauthenticated → 401', async ({ request }) => {
    const res = await request.put(`${API}/sso/config/google`, {
      data: { clientId: 'x' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
  });

  test('9. PUT /sso/config/:provider — unsupported provider name → 400', async ({ request }) => {
    const res = await request.put(`${API}/sso/config/okta`, {
      headers: auth(adminToken),
      data: { clientId: 'x', clientSecret: 'y' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(String(body.error)).toMatch(/unsupported|provider/i);
  });

  // ─── Cross-tenant isolation ──────────────────────────────────────

  test('10. Cross-tenant isolation — wellness PUT is invisible to generic GET', async ({ request }) => {
    test.skip(!wellnessAdminToken, 'wellness admin credentials unavailable in this environment');
    const wellnessOnlyClientId = `${RUN_TAG}_WELLNESS_ONLY_clientid`;

    const putRes = await request.put(`${API}/sso/config/google`, {
      headers: auth(wellnessAdminToken),
      data: {
        clientId: wellnessOnlyClientId,
        clientSecret: `${RUN_TAG}_wellness_secret`,
        redirectUri: 'https://wellness.example.com/cb',
        isActive: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(putRes.status()).toBe(200);

    // Generic admin's GET must NOT see the wellness-tagged clientId.
    const genericGet = await request.get(`${API}/sso/config`, {
      headers: auth(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(genericGet.status()).toBe(200);
    const genericBody = await genericGet.json();
    const leaked = genericBody.find((c) => c.clientId === wellnessOnlyClientId);
    expect(leaked, 'wellness-tagged config must not leak into generic tenant GET').toBeUndefined();

    // And wellness admin's GET must see it.
    const wellnessGet = await request.get(`${API}/sso/config`, {
      headers: auth(wellnessAdminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(wellnessGet.status()).toBe(200);
    const wellnessBody = await wellnessGet.json();
    const owned = wellnessBody.find((c) => c.clientId === wellnessOnlyClientId);
    expect(owned, 'wellness GET must include its own config row').toBeTruthy();
  });

  // ─── OAuth start (public) ────────────────────────────────────────

  test('11. GET /sso/google/start — public; 302 to Google or 500 if unconfigured', async ({ request }) => {
    const res = await request.get(`${API}/sso/google/start`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT,
    });
    expect([302, 500]).toContain(res.status());
    if (res.status() === 302) {
      const loc = res.headers()['location'] || '';
      expect(loc).toMatch(/accounts\.google\.com|oauth/i);
    }
  });

  test('12. GET /sso/microsoft/start — public; 302 to Microsoft or 500 if unconfigured', async ({ request }) => {
    const res = await request.get(`${API}/sso/microsoft/start`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT,
    });
    expect([302, 500]).toContain(res.status());
    if (res.status() === 302) {
      const loc = res.headers()['location'] || '';
      expect(loc).toMatch(/login\.microsoftonline\.com/i);
    }
  });

  // ─── OAuth callback (public, error paths) ────────────────────────

  test('13. GET /sso/google/callback with no code → 302 /login?sso_error=', async ({ request }) => {
    const res = await request.get(`${API}/sso/google/callback`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] || '';
    expect(loc).toMatch(/sso_error=/);
    expect(loc).toMatch(/\/login\?/);
  });

  test('14. GET /sso/microsoft/callback with ?error=access_denied → 302 with sso_error reflecting IdP error', async ({ request }) => {
    const res = await request.get(
      `${API}/sso/microsoft/callback?error=access_denied&error_description=user_cancelled`,
      { maxRedirects: 0, timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] || '';
    expect(loc).toMatch(/sso_error=/);
    // error_description (when present) is preferred over error per route line 234
    expect(loc).toMatch(/user_cancelled|access_denied/);
  });
});
