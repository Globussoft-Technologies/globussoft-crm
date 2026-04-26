// @ts-check
/**
 * /api/lead-routing — smoke spec covering 6 handlers in
 * backend/routes/lead_routing.js.
 *
 *   GET    /
 *   POST   /
 *   PUT    /:id
 *   DELETE /:id
 *   POST   /apply/:contactId
 *   POST   /apply-all
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const createdRuleIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('lead-routing API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdRuleIds) {
      await request.delete(`${API}/lead-routing/${id}`, { headers: auth() }).catch(() => {});
    }
  });

  test('GET / requires auth', async ({ request }) => {
    const res = await request.get(`${API}/lead-routing`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns rules array (priority order)', async ({ request }) => {
    const res = await request.get(`${API}/lead-routing`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST / rejects missing name', async ({ request }) => {
    const res = await request.post(`${API}/lead-routing`, { headers: auth(), data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST / + PUT /:id + DELETE /:id round-trip', async ({ request }) => {
    const stamp = Date.now();
    const create = await request.post(`${API}/lead-routing`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_rule_${stamp}`,
        conditions: { source: { op: 'eq', value: 'e2e-test' } },
        assignType: 'round_robin',
        priority: 999,
        isActive: true,
      },
    });
    expect(create.status()).toBe(201);
    const rule = await create.json();
    expect(rule.id).toBeTruthy();
    createdRuleIds.push(rule.id);

    const upd = await request.put(`${API}/lead-routing/${rule.id}`, {
      headers: auth(),
      data: { isActive: false, priority: 1000 },
    });
    expect(upd.status()).toBe(200);
    const updated = await upd.json();
    expect(updated.isActive).toBe(false);

    const del = await request.delete(`${API}/lead-routing/${rule.id}`, { headers: auth() });
    expect(del.status()).toBe(200);
    createdRuleIds.splice(createdRuleIds.indexOf(rule.id), 1);
  });

  test('PUT /:id 400s for invalid id', async ({ request }) => {
    const res = await request.put(`${API}/lead-routing/abc`, {
      headers: auth(),
      data: { name: 'x' },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT /:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/lead-routing/99999999`, {
      headers: auth(),
      data: { name: 'x' },
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/lead-routing/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /apply/:contactId 400s for non-numeric id', async ({ request }) => {
    const res = await request.post(`${API}/lead-routing/apply/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /apply/:contactId 404s for unknown contact', async ({ request }) => {
    const res = await request.post(`${API}/lead-routing/apply/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /apply-all returns processed/assigned counts', async ({ request }) => {
    const res = await request.post(`${API}/lead-routing/apply-all`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('processed');
    expect(body).toHaveProperty('assigned');
    expect(typeof body.processed).toBe('number');
    expect(typeof body.assigned).toBe('number');
  });
});
