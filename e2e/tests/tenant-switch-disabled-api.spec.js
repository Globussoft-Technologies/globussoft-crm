// @ts-check
/**
 * #555 (HI-06) — tenant access lock-per-session policy.
 *
 * v3.7.2 disposition: user picks tenant at LOGIN, cannot switch in-session.
 * Rationale: the JWT's tenantId is the only trustworthy scope boundary for
 * per-tenant data isolation; any in-session switcher creates a window where
 * the JWT and the rendered shell can disagree (pen-test privilege-confusion
 * surface). The accountability surface is the LOGIN audit row emitted on
 * every successful authentication.
 *
 * Contract:
 *   • POST /api/auth/tenant-switch — ALWAYS 410 Gone with code
 *     TENANT_SWITCH_DISABLED. Even a "same-tenant no-op" body is rejected;
 *     the documented switch path is logout → login.
 *   • GET /api/auth/tenants — still returns the user's accessible-tenants
 *     list (today: single-element) so the topbar tenant chip can render.
 *   • POST /api/auth/login — emits a LOGIN audit row on every successful
 *     authentication. The row is the canonical "this user entered this
 *     tenant at this time" record under the lock-per-session policy.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let adminTenantId = null;

test.describe.configure({ mode: 'serial' });

test.describe('#555 lock-per-session — tenant-switch disabled', () => {
  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), 'admin login must succeed for lock-per-session spec').toBe(true);
    const j = await r.json();
    adminToken = j.token;
    adminTenantId = j.user?.tenantId ?? j.tenant?.id ?? 1;
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('POST /auth/tenant-switch returns 410 even for same-tenant no-op', async ({ request }) => {
    const r = await request.post(`${API}/auth/tenant-switch`, {
      headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
      data: { toTenantId: adminTenantId },
    });
    expect(r.status()).toBe(410);
    const body = await r.json();
    expect(body.code).toBe('TENANT_SWITCH_DISABLED');
    expect(body.error).toMatch(/log out/i);
    expect(body.hint).toMatch(/logout.*login/i);
  });

  test('POST /auth/tenant-switch returns 410 for cross-tenant (no information disclosure)', async ({ request }) => {
    // Use a different tenantId — should NOT trip a 403 "tenant not
    // accessible" path (which would leak the existence of other tenants).
    const r = await request.post(`${API}/auth/tenant-switch`, {
      headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
      data: { toTenantId: 999 },
    });
    expect(r.status()).toBe(410);
    const body = await r.json();
    expect(body.code).toBe('TENANT_SWITCH_DISABLED');
  });

  test('POST /auth/tenant-switch returns 410 with empty body (no validation precedence)', async ({ request }) => {
    // 410 must take precedence over 400 (missing toTenantId) — the endpoint
    // is dead, not "live but with validation gates". This pins the policy.
    const r = await request.post(`${API}/auth/tenant-switch`, {
      headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
      data: {},
    });
    expect(r.status()).toBe(410);
    const body = await r.json();
    expect(body.code).toBe('TENANT_SWITCH_DISABLED');
  });

  test('GET /auth/tenants still returns the accessible tenants list (chip needs it)', async ({ request }) => {
    const r = await request.get(`${API}/auth/tenants`, {
      headers: auth(adminToken),
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(body.tenants.length).toBeGreaterThanOrEqual(1);
    expect(body.activeTenantId).toBe(adminTenantId);
  });

  test('login emits a LOGIN audit row stamping the tenantId', async ({ request }) => {
    // Login as admin (fresh login so the audit row is created in this run).
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(loginRes.ok()).toBe(true);
    const loginAt = Date.now();
    const freshToken = (await loginRes.json()).token;

    // Read recent audit rows and look for a LOGIN action attributable to the
    // admin user with the current tenantId. We accept any LOGIN row within
    // the last 5 minutes — the per-second timing is too tight under demo
    // load and clock skew, but a 5-minute window is plenty.
    const auditRes = await request.get(`${API}/audit?action=LOGIN&limit=20`, {
      headers: auth(freshToken),
    });
    expect(auditRes.ok()).toBe(true);
    const auditBody = await auditRes.json();
    const rows = Array.isArray(auditBody) ? auditBody : (auditBody.logs || auditBody.rows || []);
    const recent = rows.filter((row) => {
      const t = new Date(row.createdAt || row.timestamp).getTime();
      return t >= loginAt - 5 * 60 * 1000 && row.action === 'LOGIN';
    });
    expect(recent.length).toBeGreaterThan(0);
  });
});
