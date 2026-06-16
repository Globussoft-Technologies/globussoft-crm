// @ts-check
/**
 * Home-dashboard widget API spec.
 *
 * Endpoints covered:
 *   GET  /api/widgets/catalog       — static metadata
 *   GET  /api/widgets/me            — permission-filtered layout for the
 *                                     signed-in user (admin sees ALL via
 *                                     OWNER short-circuit OR has all perms;
 *                                     plain USER sees the subset matching
 *                                     their grants)
 *   GET  /api/roles/:id/widgets     — current layout
 *   PUT  /api/roles/:id/widgets     — bulk replace (accept + validate)
 *
 * Run tag isolation: tests touch a temporary role (E2E_WIDGETS_*) so they
 * never mutate the seeded ADMIN / USER / DOCTOR rows that other specs
 * rely on. afterAll cleans up by deleting the role (cascade drops its
 * RoleWidget + RolePermission rows).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_WIDGETS_${Date.now()}`;

let adminToken = null;
let userToken = null;
let createdRoleId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return await r.json();
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdmin(request) {
  if (!adminToken) {
    const j = await loginAs(request, 'admin@globussoft.com', 'password123');
    if (j) adminToken = j.token;
  }
  return adminToken;
}

async function getUser(request) {
  if (!userToken) {
    const j = await loginAs(request, 'user@crm.com', 'password123');
    if (j) userToken = j.token;
  }
  return userToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}

test.afterAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (!token || !createdRoleId) return;
  await del(request, token, `/api/roles/${createdRoleId}`).catch(() => {});
});

// ── GET /api/widgets/catalog ──────────────────────────────────────────

test.describe('GET /api/widgets/catalog', () => {
  test('200 returns catalog array with categories', async ({ request }) => {
    const token = await getAdmin(request);
    const res = await get(request, token, '/api/widgets/catalog');
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.catalog)).toBe(true);
    // Vertical-aware (2026-06-15): /api/widgets/catalog now returns
    // only the requesting tenant's vertical-relevant widgets.
    // admin@globussoft.com is on the generic tenant, which only gets
    // COMMON_WIDGETS (`quick-links`). Wellness / travel tenants would
    // get their vertical-specific widgets plus the common core.
    expect(body.catalog.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.categories)).toBe(true);
    const keys = body.catalog.map((/** @type {{key:string}} */ w) => w.key);
    expect(keys).toContain('quick-links');
    // Wellness/travel-only widget keys are hidden from the generic tenant.
    expect(keys).not.toContain('today-appointments');
    expect(keys).not.toContain('travel-todays-departures');
    const sample = body.catalog[0];
    expect(typeof sample.key).toBe('string');
    expect(typeof sample.title).toBe('string');
    expect(Array.isArray(sample.requiredPermissions)).toBe(true);
    // The vertical field is echoed for client-side observability.
    expect(body.vertical === null || typeof body.vertical === 'string').toBe(true);
  });

  test('401 without a token', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/widgets/catalog`);
    expect(res.status()).toBe(401);
  });
});

// ── GET /api/widgets/me ────────────────────────────────────────────────

test.describe('GET /api/widgets/me', () => {
  test('200 returns widgets array (admin has all permissions, sees their layout)', async ({
    request,
  }) => {
    const token = await getAdmin(request);
    const res = await get(request, token, '/api/widgets/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.widgets)).toBe(true);
    // Each entry, if any, has the expected shape.
    if (body.widgets.length > 0) {
      const w = body.widgets[0];
      expect(typeof w.widgetKey).toBe('string');
      expect(typeof w.position).toBe('number');
      expect(typeof w.isEnabled).toBe('boolean');
      expect(w.meta).toBeTruthy();
    }
  });

  test('200 returns a possibly-smaller list for a USER token (permission intersection)', async ({
    request,
  }) => {
    const token = await getUser(request);
    if (!token) test.skip(true, 'USER login not available in this env');
    const res = await get(request, token, '/api/widgets/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.widgets)).toBe(true);
  });
});

// ── PUT /api/roles/:id/widgets ────────────────────────────────────────

test.describe('PUT /api/roles/:id/widgets', () => {
  test('round-trip: create a role, set layout, read it back', async ({
    request,
  }) => {
    const token = await getAdmin(request);

    // Create a throwaway role.
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} role`,
      key: RUN_TAG,
      userType: 'STAFF',
      landingPath: '/home',
    });
    expect(create.status(), await create.text()).toBe(201);
    const created = await create.json();
    createdRoleId = created.id;

    const layoutBody = {
      widgets: [
        { widgetKey: 'today-appointments', position: 10, isEnabled: true },
        { widgetKey: 'pending-prescriptions', position: 20, isEnabled: true },
        { widgetKey: 'waiting-room', position: 30, isEnabled: false },
      ],
    };
    const putRes = await put(
      request,
      token,
      `/api/roles/${createdRoleId}/widgets`,
      layoutBody,
    );
    expect(putRes.status(), await putRes.text()).toBe(200);
    const putBody = await putRes.json();
    expect(Array.isArray(putBody.widgets)).toBe(true);
    expect(putBody.widgets).toHaveLength(3);

    const getRes = await get(
      request,
      token,
      `/api/roles/${createdRoleId}/widgets`,
    );
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.widgets).toHaveLength(3);
    expect(getBody.widgets[0].widgetKey).toBe('today-appointments');
    expect(getBody.widgets[2].isEnabled).toBe(false);
  });

  test('400 rejects an unknown widget key', async ({ request }) => {
    const token = await getAdmin(request);
    if (!createdRoleId) test.skip(true, 'depends on prior test');
    const res = await put(
      request,
      token,
      `/api/roles/${createdRoleId}/widgets`,
      {
        widgets: [
          { widgetKey: 'definitely-not-a-real-widget', position: 10 },
        ],
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid widget key/i);
  });

  test('200 accepts an empty layout (clears all widgets)', async ({
    request,
  }) => {
    const token = await getAdmin(request);
    if (!createdRoleId) test.skip(true, 'depends on prior test');
    const res = await put(
      request,
      token,
      `/api/roles/${createdRoleId}/widgets`,
      { widgets: [] },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.widgets).toHaveLength(0);
  });

  test('400 rejects non-array body', async ({ request }) => {
    const token = await getAdmin(request);
    if (!createdRoleId) test.skip(true, 'depends on prior test');
    const res = await put(
      request,
      token,
      `/api/roles/${createdRoleId}/widgets`,
      { widgets: 'not-an-array' },
    );
    expect(res.status()).toBe(400);
  });
});
