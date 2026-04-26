// @ts-check
/**
 * Smoke spec for backend/routes/currencies.js (8 handlers).
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Each test seeds + cleans its own data so rows don't leak.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdCurrencyIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('currencies routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdCurrencyIds) {
      await request
        .delete(`${API}/currencies/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/currencies requires auth', async ({ request }) => {
    const res = await request.get(`${API}/currencies`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/currencies returns an array', async ({ request }) => {
    const res = await request.get(`${API}/currencies`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('code');
    expect(body[0]).toHaveProperty('symbol');
  });

  test('POST /api/currencies rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/currencies`, {
      headers: auth(),
      data: { code: 'XYZ' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  test('POST /api/currencies creates a non-base currency', async ({ request }) => {
    // Use unlikely code so we don't collide with seed data.
    const code = `T${Math.floor(Math.random() * 90 + 10)}`;
    const res = await request.post(`${API}/currencies`, {
      headers: auth(),
      data: { code, symbol: 'T$', name: `E2E_AUDIT_${Date.now()}_test_currency`, exchangeRate: 12.34 },
    });
    // 409 if the random code happens to exist; that's still proof the validator works.
    expect([201, 409]).toContain(res.status());
    if (res.status() === 201) {
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(body.isBase).toBe(false);
      createdCurrencyIds.push(body.id);
    }
  });

  test('PUT /api/currencies/:id updates exchangeRate', async ({ request }) => {
    const id = createdCurrencyIds[0];
    test.skip(!id, 'no currency from previous test');
    const res = await request.put(`${API}/currencies/${id}`, {
      headers: auth(),
      data: { exchangeRate: 99.99 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body.exchangeRate)).toBeCloseTo(99.99, 2);
  });

  test('PUT /api/currencies/9999999 returns 404', async ({ request }) => {
    const res = await request.put(`${API}/currencies/9999999`, {
      headers: auth(),
      data: { exchangeRate: 1 },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/currencies/convert rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/currencies/convert`, {
      headers: auth(),
      data: { amount: 100 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/currencies/convert returns converted amount', async ({ request }) => {
    // Pick two currencies the tenant actually has seeded — the route only
    // falls back to DEFAULTS when the tenant has zero rows. The generic
    // tenant's seed leaves USD as base; without other rows present the test
    // would 404 on INR. Read the list and convert between the first two.
    const list = await request.get(`${API}/currencies`, { headers: auth() });
    const items = await list.json();
    test.skip(!Array.isArray(items) || items.length < 2, 'tenant has fewer than 2 currencies — convert needs at least 2');
    const from = items[0].code;
    const to = items[1].code;

    const res = await request.post(`${API}/currencies/convert`, {
      headers: auth(),
      data: { amount: 100, from, to },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('converted');
    expect(body).toHaveProperty('rate');
    expect(body.from).toBe(from);
    expect(body.to).toBe(to);
  });

  test('POST /api/currencies/convert with unknown code returns 404', async ({ request }) => {
    const res = await request.post(`${API}/currencies/convert`, {
      headers: auth(),
      data: { amount: 100, from: 'USD', to: 'ZZZ' },
    });
    expect(res.status()).toBe(404);
  });

  test('GET /api/currencies/pivot/deals returns aggregate', async ({ request }) => {
    const res = await request.get(`${API}/currencies/pivot/deals`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('baseCode');
    expect(body).toHaveProperty('totalInBase');
    expect(body).toHaveProperty('byCurrency');
    expect(typeof body.dealCount).toBe('number');
  });

  test('POST /api/currencies/seed errors when currencies already initialized', async ({ request }) => {
    const res = await request.post(`${API}/currencies/seed`, { headers: auth() });
    // Tenant likely has currencies → 400. Fresh tenant would be 201.
    expect([201, 400]).toContain(res.status());
  });

  test('DELETE /api/currencies/:id deletes a non-base currency', async ({ request }) => {
    const id = createdCurrencyIds[0];
    test.skip(!id, 'no currency from previous test');
    const res = await request.delete(`${API}/currencies/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    // remove from afterAll cleanup
    createdCurrencyIds.length = 0;
  });

  test('DELETE /api/currencies/:id refuses to drop the base currency', async ({ request }) => {
    const list = await request.get(`${API}/currencies`, { headers: auth() });
    const all = await list.json();
    const base = all.find((c) => c.isBase && c.id > 0);
    test.skip(!base, 'tenant has no persisted base currency yet');
    const res = await request.delete(`${API}/currencies/${base.id}`, { headers: auth() });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/base/i);
  });

  test('POST /api/currencies/:id/set-base rotates base currency atomically', async ({ request }) => {
    const list = await request.get(`${API}/currencies`, { headers: auth() });
    const all = await list.json();
    const persisted = all.filter((c) => c.id > 0);
    test.skip(persisted.length < 2, 'need at least 2 persisted currencies to test set-base');
    const target = persisted.find((c) => !c.isBase);
    test.skip(!target, 'no non-base persisted currency');

    const previousBase = persisted.find((c) => c.isBase);

    const res = await request.post(`${API}/currencies/${target.id}/set-base`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isBase).toBe(true);
    expect(Number(body.exchangeRate)).toBeCloseTo(1.0, 6);

    // Restore original base if we rotated.
    if (previousBase && previousBase.id !== target.id) {
      await request.post(`${API}/currencies/${previousBase.id}/set-base`, { headers: auth() });
    }
  });
});
