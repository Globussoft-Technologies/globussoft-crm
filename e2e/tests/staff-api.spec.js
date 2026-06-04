// @ts-check
/**
 * Staff directory API contract — GET /api/staff (routes/staff.js).
 *
 * Pins the customer-exclusion fix: the staff directory is for EMPLOYEES
 * only (userType STAFF / OWNER — doctors, professionals, telecallers,
 * helpers, managers, admins, owner). Self-registered customers
 * (userType='CUSTOMER', created via /auth/customer/register so they can buy
 * gift cards / view their own transactions) must NOT appear in the staff
 * list, nor in the ?fields=summary picker shape that the wellness Doctor /
 * Professional dropdowns read.
 *
 * Strategy: register a CUSTOMER with a uniquely-tagged email, then assert
 * that email never appears in GET /api/staff (full OR summary). The admin's
 * own staff row is used as a positive control so we know the list isn't
 * simply empty.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_STAFFEXCL_${Date.now()}`;

const ADMIN = { email: 'admin@wellness.demo', password: 'password123' };

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

let adminToken = null;
let tenantId = null;
let customerEmail = null;
let customerId = null;

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, {
    data: ADMIN,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!login.ok()) return;
  const lj = await login.json();
  adminToken = lj.token;
  tenantId = lj.tenant?.id || null;

  if (!adminToken || !tenantId) return;

  // Register a CUSTOMER in the same tenant. This is exactly the row that
  // must NOT leak into the staff directory.
  customerEmail = `${RUN_TAG}@example.com`.toLowerCase();
  const reg = await request.post(`${BASE_URL}/api/auth/customer/register`, {
    data: {
      email: customerEmail,
      password: 'TestPass123!',
      name: `${RUN_TAG} Customer`,
      registrationTenantId: tenantId,
    },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (reg.status() === 201) {
    const rj = await reg.json();
    customerId = rj.user?.id || null;
  } else {
    customerEmail = null; // registration failed — exclusion tests will skip
  }
});

test.afterAll(async ({ request }) => {
  // Best-effort cleanup — deactivate the test customer. demo-hygiene also
  // reaps E2E_-tagged rows, so a failure here is non-fatal.
  if (adminToken && customerId) {
    await request
      .delete(`${BASE_URL}/api/staff/${customerId}`, {
        headers: headers(adminToken),
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

test.describe('GET /api/staff — customer exclusion', () => {
  test('requires authentication (401/403 without a token)', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/staff`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('returns a non-empty staff list for an admin (positive control)', async ({ request }) => {
    test.skip(!adminToken, 'admin login failed');
    const r = await request.get(`${BASE_URL}/api/staff`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBeTruthy();
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // The signed-in admin themselves must be in the staff directory.
    expect(rows.some((u) => u.email === ADMIN.email)).toBe(true);
  });

  test('does NOT include the self-registered CUSTOMER (full shape)', async ({ request }) => {
    test.skip(!adminToken || !customerEmail, 'no customer seeded for this run');
    const r = await request.get(`${BASE_URL}/api/staff`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBeTruthy();
    const rows = await r.json();
    const emails = rows.map((u) => u.email);
    expect(emails).not.toContain(customerEmail);
  });

  test('does NOT include the CUSTOMER in the ?fields=summary picker shape', async ({ request }) => {
    test.skip(!adminToken || !customerEmail, 'no customer seeded for this run');
    const r = await request.get(`${BASE_URL}/api/staff?fields=summary`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBeTruthy();
    const rows = await r.json();
    const emails = rows.map((u) => u.email);
    expect(emails).not.toContain(customerEmail);
  });
});
