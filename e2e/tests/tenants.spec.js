// @ts-check
/**
 * Tenants routes — /api/tenants/*
 *   Auth:    GET /current, GET /users
 *   Admin:   PUT /current, POST /users
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';
const USER_EMAIL = 'user@crm.com';
const USER_PASSWORD = 'password123';

let adminToken = '';
let userToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('tenants.js — multi-tenant admin', () => {
  test.beforeAll(async ({ request }) => {
    const adminLogin = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(adminLogin.ok()).toBeTruthy();
    adminToken = (await adminLogin.json()).token;

    const userLogin = await request.post(`${API}/auth/login`, {
      data: { email: USER_EMAIL, password: USER_PASSWORD },
    });
    if (userLogin.ok()) {
      userToken = (await userLogin.json()).token;
    }
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('GET /tenants/current requires auth', async ({ request }) => {
    const res = await request.get(`${API}/tenants/current`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /tenants/current returns the tenant for the caller', async ({ request }) => {
    const res = await request.get(`${API}/tenants/current`, { headers: auth(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBeTruthy();
    expect(body.slug).toBeTruthy();
  });

  test('GET /tenants/users returns users in the tenant', async ({ request }) => {
    const res = await request.get(`${API}/tenants/users`, { headers: auth(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Admin's own row must always be present.
    expect(body.find((u) => u.email === ADMIN_EMAIL)).toBeTruthy();
    // Sensitive fields must not leak.
    for (const u of body) {
      expect(u.password).toBeUndefined();
    }
  });

  test('PUT /tenants/current rejects non-admin (403)', async ({ request }) => {
    test.skip(!userToken, 'no non-admin user available to login');
    const res = await request.put(`${API}/tenants/current`, {
      headers: auth(userToken),
      data: { name: 'Hacked by USER role' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /tenants/current admin can no-op update (returns 200)', async ({ request }) => {
    // Read current first so we can PUT back exactly the same value.
    const cur = await request.get(`${API}/tenants/current`, { headers: auth(adminToken) });
    const tenant = await cur.json();

    const res = await request.put(`${API}/tenants/current`, {
      headers: auth(adminToken),
      data: { name: tenant.name }, // no-op so we don't mutate live data
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(tenant.id);
    expect(body.name).toBe(tenant.name);
  });

  test('POST /tenants/users requires email + password (400)', async ({ request }) => {
    const res = await request.post(`${API}/tenants/users`, {
      headers: auth(adminToken),
      data: { name: 'Aarav Nair' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /tenants/users rejects non-admin (403)', async ({ request }) => {
    test.skip(!userToken, 'no non-admin user available');
    const res = await request.post(`${API}/tenants/users`, {
      headers: auth(userToken),
      data: { email: `ignored-${Date.now()}@test.com`, password: 'password123' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // We do not test the happy-path POST /tenants/users (creating a real user)
  // because tenants.js exposes no DELETE endpoint for users — running the
  // happy path would leak a row that cannot be cleaned up via this surface.
  test.skip('POST /tenants/users happy path', () => {
    // Skipped: no DELETE endpoint on tenants.js to clean up the created user;
    // creating a real bcrypt user via this route would leak across runs.
  });
});
