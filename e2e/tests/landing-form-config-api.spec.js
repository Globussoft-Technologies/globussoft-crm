// @ts-check
/**
 * Landing-page hero form config — fail-closed contract.
 *
 * routes/landing_form_config.js (backed by lib/landingFormConfig.js +
 * TenantSetting `landing.form.webFormId` under PUBLIC_LEAD_TENANT_ID).
 *
 * The per-push api_tests gate boots the backend with NEITHER
 * PUBLIC_LEAD_TENANT_ID NOR LANDING_FORM_ADMIN_EMAILS set, so every
 * assertion below pins the fail-closed behaviour deterministically:
 *
 *   GET  /api/landing-form-config         (public, no token) → 503
 *      LANDING_FORM_NOT_CONFIGURED — and crucially NOT 401, which proves
 *      the server.js GET-only bypass exempts exactly this path while
 *      /access + PUT stay behind the global verifyToken guard.
 *   GET  /api/landing-form-config/access  (admin token) → 200
 *      { canManage: false } — empty allowlist admits nobody.
 *   PUT  /api/landing-form-config         (admin token) → 403
 *      LANDING_FORM_FORBIDDEN — even ADMIN cannot change the public
 *      landing page without being on the email allowlist.
 *   PUT  /api/landing-form-config         (no token) → 401 — the global
 *      guard still fires for anonymous writes.
 *
 * The allowlisted happy path (200 resolve + PUT upsert) is covered by
 * backend/test/routes/landing-form-config.test.js with the env vars set —
 * playwright specs cannot inject server env, so the gate spec pins the
 * closed side and the vitest suite pins the open side.
 *
 * No test data is created (nothing ever successfully writes), so there is
 * no afterAll cleanup and nothing for demo-hygiene to purge. Safe to run
 * against the live demo too: with the allowlist unset there, PUT can never
 * succeed, so the spec is read-only in practice.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let adminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdminToken(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
  }
  return adminToken;
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

test.describe('landing-form-config fail-closed contract', () => {
  test('anonymous GET is public (not 401) and fail-closed without tenant env', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/landing-form-config`, {
      headers: { Accept: 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(503);
    const body = await r.json();
    expect(body).toMatchObject({ code: 'LANDING_FORM_NOT_CONFIGURED' });
    expect(JSON.stringify(body)).not.toContain('LANDING_FORM_ADMIN_EMAILS');
  });

  test('admin GET /access → canManage false on empty allowlist (no leak)', async ({ request }) => {
    const token = await getAdminToken(request);
    expect(token).toBeTruthy();
    const r = await request.get(`${BASE_URL}/api/landing-form-config/access`, {
      headers: authHeaders(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ canManage: false });
  });

  test('admin PUT without allowlist email → 403 LANDING_FORM_FORBIDDEN', async ({ request }) => {
    const token = await getAdminToken(request);
    expect(token).toBeTruthy();
    const r = await request.put(`${BASE_URL}/api/landing-form-config`, {
      headers: authHeaders(token),
      data: { webFormId: 1 },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'LANDING_FORM_FORBIDDEN' });
  });

  test('anonymous PUT → 401 (global auth guard still fires)', async ({ request }) => {
    const r = await request.put(`${BASE_URL}/api/landing-form-config`, {
      headers: { 'Content-Type': 'application/json' },
      data: { webFormId: 1 },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });
});
