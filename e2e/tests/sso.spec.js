// @ts-check
/**
 * SSO routes — /api/sso/*
 *   Public:  GET /google/start, /microsoft/start, /google/callback, /microsoft/callback
 *   Auth:    GET /config (any tenant member)
 *   Admin:   PUT /config/:provider
 *
 * The /start endpoints redirect to the provider's OAuth consent screen when
 * configured, or 500 with a "not configured" body when env vars are missing.
 * Callback endpoints with bogus codes redirect back to /login with sso_error.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdConfigProviders = []; // we upsert, so cleanup means resetting to inactive

test.describe.configure({ mode: 'serial' });

test.describe('sso.js — Google/Microsoft OAuth + tenant SSO config', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // Soft-cleanup: deactivate any provider configs we touched.
    for (const provider of createdConfigProviders) {
      await request.put(`${API}/sso/config/${provider}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { isActive: false },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /sso/config requires auth', async ({ request }) => {
    const res = await request.get(`${API}/sso/config`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /sso/config returns array for authed user', async ({ request }) => {
    const res = await request.get(`${API}/sso/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /sso/google/start either redirects to Google or returns 500 when unconfigured', async ({ request }) => {
    const res = await request.get(`${API}/sso/google/start`, { maxRedirects: 0 });
    // 302 to accounts.google.com when configured; 500 if env vars missing.
    expect([302, 500]).toContain(res.status());
    if (res.status() === 302) {
      const loc = res.headers()['location'] || '';
      expect(loc).toMatch(/accounts\.google\.com|oauth/i);
    }
  });

  test('GET /sso/microsoft/start either redirects to Microsoft or returns 500 when unconfigured', async ({ request }) => {
    const res = await request.get(`${API}/sso/microsoft/start`, { maxRedirects: 0 });
    expect([302, 500]).toContain(res.status());
    if (res.status() === 302) {
      const loc = res.headers()['location'] || '';
      expect(loc).toMatch(/login\.microsoftonline\.com/i);
    }
  });

  test('GET /sso/google/callback with no code redirects to /login?sso_error=', async ({ request }) => {
    const res = await request.get(`${API}/sso/google/callback`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] || '';
    expect(loc).toMatch(/sso_error=/);
  });

  test('GET /sso/microsoft/callback with explicit ?error redirects with that error', async ({ request }) => {
    const res = await request.get(`${API}/sso/microsoft/callback?error=access_denied&error_description=user_cancelled`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] || '';
    expect(loc).toMatch(/sso_error=/);
  });

  test('PUT /sso/config/:provider rejects unsupported provider with 400', async ({ request }) => {
    const res = await request.put(`${API}/sso/config/okta`, {
      headers: auth(),
      data: { clientId: 'x', clientSecret: 'y' },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT /sso/config/google upserts and returns masked secret', async ({ request }) => {
    const res = await request.put(`${API}/sso/config/google`, {
      headers: auth(),
      data: {
        clientId: 'E2E_AUDIT_clientid',
        clientSecret: 'E2E_AUDIT_secret_value',
        redirectUri: 'https://example.com/cb',
        isActive: false,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('google');
    expect(body.clientId).toBe('E2E_AUDIT_clientid');
    expect(body.clientSecret).toMatch(/\*/); // must be masked
    createdConfigProviders.push('google');
  });

  test('PUT /sso/config/:provider requires auth', async ({ request }) => {
    const res = await request.put(`${API}/sso/config/google`, {
      data: { clientId: 'x' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
