// @ts-check
/**
 * /api/field-permissions — smoke spec covering 7 handlers in
 * backend/routes/field_permissions.js. ADMIN-only for write paths.
 *
 *   GET    /entities
 *   GET    /effective?role=&entity=
 *   GET    /
 *   POST   /                       (ADMIN)
 *   POST   /bulk-update            (ADMIN)
 *   PUT    /:id                    (ADMIN)
 *   DELETE /:id                    (ADMIN)
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const ADMIN_EMAIL = 'admin@globussoft.com';
const USER_EMAIL = 'user@crm.com';
const PASSWORD = 'password123';

let adminToken = '';
let userToken = '';
const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });
const userAuth = () => ({ Authorization: `Bearer ${userToken}` });

const createdRuleIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('field-permissions API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const adminLogin = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(adminLogin.ok(), 'admin login must succeed').toBeTruthy();
    adminToken = (await adminLogin.json()).token;

    const userLogin = await request.post(`${API}/auth/login`, {
      data: { email: USER_EMAIL, password: PASSWORD },
    });
    if (userLogin.ok()) {
      userToken = (await userLogin.json()).token;
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdRuleIds) {
      await request.delete(`${API}/field-permissions/${id}`, { headers: adminAuth() });
    }
  });

  test('GET /entities requires auth', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions/entities`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /entities returns the supported registry', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions/entities`, { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('Deal');
    expect(body).toHaveProperty('Contact');
    expect(Array.isArray(body.Deal)).toBe(true);
  });

  test('GET /effective rejects invalid role', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions/effective?role=GOD&entity=Deal`, {
      headers: adminAuth(),
    });
    expect(res.status()).toBe(400);
  });

  test('GET /effective rejects unsupported entity', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions/effective?role=USER&entity=Frog`, {
      headers: adminAuth(),
    });
    expect(res.status()).toBe(400);
  });

  test('GET /effective returns per-field rules', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions/effective?role=USER&entity=Deal`, {
      headers: adminAuth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('amount');
    expect(body.amount).toHaveProperty('canRead');
    expect(body.amount).toHaveProperty('canWrite');
  });

  test('GET / returns rules grouped by entity', async ({ request }) => {
    const res = await request.get(`${API}/field-permissions`, { headers: adminAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('POST / rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/field-permissions`, {
      headers: adminAuth(),
      data: { role: 'USER' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST / rejects unsupported field on entity', async ({ request }) => {
    const res = await request.post(`${API}/field-permissions`, {
      headers: adminAuth(),
      data: { role: 'USER', entity: 'Deal', field: 'frog_field' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST / as non-admin returns 403', async ({ request }) => {
    test.skip(!userToken, 'no non-admin token available');
    const res = await request.post(`${API}/field-permissions`, {
      headers: userAuth(),
      data: { role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST / + PUT /:id + DELETE /:id round-trip', async ({ request }) => {
    const create = await request.post(`${API}/field-permissions`, {
      headers: adminAuth(),
      data: { role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false },
    });
    expect(create.status()).toBe(201);
    const rule = await create.json();
    expect(rule.id).toBeTruthy();
    createdRuleIds.push(rule.id);

    const upd = await request.put(`${API}/field-permissions/${rule.id}`, {
      headers: adminAuth(),
      data: { canRead: false, canWrite: false },
    });
    expect(upd.status()).toBe(200);
    const updated = await upd.json();
    expect(updated.canRead).toBe(false);

    const del = await request.delete(`${API}/field-permissions/${rule.id}`, { headers: adminAuth() });
    expect(del.status()).toBe(200);
    // mark cleaned up so afterAll doesn't double-delete
    createdRuleIds.splice(createdRuleIds.indexOf(rule.id), 1);
  });

  test('POST /bulk-update rejects non-array body', async ({ request }) => {
    const res = await request.post(`${API}/field-permissions/bulk-update`, {
      headers: adminAuth(),
      data: { rules: 'not an array' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /bulk-update upserts an array of rules', async ({ request }) => {
    const res = await request.post(`${API}/field-permissions/bulk-update`, {
      headers: adminAuth(),
      data: {
        rules: [
          { role: 'MANAGER', entity: 'Deal', field: 'probability', canRead: true, canWrite: true },
          { role: 'MANAGER', entity: 'Contact', field: 'email', canRead: true, canWrite: false },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('updated');
    expect(body).toHaveProperty('errors');
    for (const r of body.rules || []) createdRuleIds.push(r.id);
  });

  test('PUT /:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/field-permissions/99999999`, {
      headers: adminAuth(),
      data: { canRead: false },
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/field-permissions/99999999`, { headers: adminAuth() });
    expect(res.status()).toBe(404);
  });
});
