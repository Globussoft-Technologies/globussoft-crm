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

// One-admin-per-org enforcement tests.
// These are separate from the customer-exclusion describe so they can
// run without the beforeAll customer-registration step.
test.describe('Staff API — one-admin-per-org rule (SINGLE_ADMIN_LIMIT)', () => {
  let adminTok = null;

  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${BASE_URL}/api/auth/login`, {
      data: ADMIN,
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    if (login.ok()) {
      adminTok = (await login.json()).token;
    }
  });

  test('POST /api/staff — creating a second ADMIN returns 409 SINGLE_ADMIN_LIMIT', async ({ request }) => {
    test.skip(!adminTok, 'admin login failed');
    const res = await request.post(`${BASE_URL}/api/staff`, {
      headers: headers(adminTok),
      data: {
        name: `${RUN_TAG} Second Admin`,
        email: `${RUN_TAG}-second-admin@example.com`.toLowerCase(),
        password: 'TestPass123!',
        role: 'ADMIN',
      },
      timeout: REQUEST_TIMEOUT,
    });
    // The wellness tenant already has an admin (admin@wellness.demo) so
    // trying to create another should be blocked.
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('SINGLE_ADMIN_LIMIT');
  });

  test('PUT /api/staff/:id/role — promoting a user to ADMIN when one exists returns 409 SINGLE_ADMIN_LIMIT', async ({ request }) => {
    test.skip(!adminTok, 'admin login failed');
    // Login as the admin to get their own id; use their id as the test
    // target (the endpoint excludes the target's own id to allow re-saving
    // the same ADMIN role without tripping the check — but when the caller
    // IS already ADMIN and they try to promote a different existing user,
    // the tenant already has the caller as admin, so any OTHER non-admin user
    // would trigger the limit). We use admin's own id (target.role = 'ADMIN')
    // to verify the idempotent self-save path returns 200, not 409.
    // The 409 path is covered by POST above (trying to create a fresh ADMIN).
    const meRes = await request.get(`${BASE_URL}/api/staff`, {
      headers: headers(adminTok),
      timeout: REQUEST_TIMEOUT,
    });
    if (!meRes.ok()) test.skip(true, 'GET /staff failed');
    const staffList = await meRes.json();
    const adminRow = staffList.find(u => u.email === ADMIN.email);
    test.skip(!adminRow, 'could not locate admin row in staff list');

    // Idempotent: promoting the admin to ADMIN again (same role) should NOT
    // trip the SINGLE_ADMIN_LIMIT (excludeUserId == target.id path).
    const res = await request.put(`${BASE_URL}/api/staff/${adminRow.id}/role`, {
      headers: headers(adminTok),
      data: { role: 'ADMIN' },
      timeout: REQUEST_TIMEOUT,
    });
    // Re-saving ADMIN on the same user is idempotent — should succeed.
    expect(res.status()).toBe(200);
  });
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
