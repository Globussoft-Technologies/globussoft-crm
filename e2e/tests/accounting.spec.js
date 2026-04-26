// @ts-check
/**
 * Accounting integrations route smoke (`/api/accounting`)
 *  - GET /providers (status object)
 *  - POST /:provider/connect with valid + invalid bodies
 *  - POST /:provider/disconnect (no integration → 404)
 *  - POST /:provider/sync/invoice/:id (404 path)
 *  - POST /:provider/sync/expense/:id (404 path)
 *  - POST /:provider/sync/all
 *  - GET /:provider/synced (paginated)
 *  - POST /webhook/:provider (public)
 *
 * Targets the wellness tenant (admin@wellness.demo) — accounting endpoints
 * exist for both verticals; wellness has live invoices/expenses we can list.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@wellness.demo';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Accounting integrations — /api/accounting', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /providers returns status for all 3 supported providers', async ({ request }) => {
    const res = await request.get(`${API}/accounting/providers`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.quickbooks).toBeTruthy();
    expect(body.xero).toBeTruthy();
    expect(body.tally).toBeTruthy();
    expect(typeof body.quickbooks.connected).toBe('boolean');
  });

  test('auth gate — GET /providers without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/accounting/providers`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:provider/connect rejects unsupported provider with 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/zoho/connect`, {
      headers: auth(),
      data: { accessToken: 'x', refreshToken: 'y', realmId: 'z' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unsupported provider/i);
  });

  test('POST /quickbooks/connect rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/quickbooks/connect`, {
      headers: auth(),
      data: { accessToken: 'only-this' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/quickbooks requires/);
  });

  test('POST /xero/connect rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/xero/connect`, {
      headers: auth(),
      data: { accessToken: 'a' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/xero requires/);
  });

  test('POST /tally/connect rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/tally/connect`, {
      headers: auth(),
      data: { url: 'http://localhost' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tally requires/);
  });

  test('POST /:provider/sync/invoice/:id with non-numeric id returns 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/quickbooks/sync/invoice/not-a-number`, {
      headers: auth(),
    });
    expect(res.status()).toBe(400);
  });

  test('POST /:provider/sync/invoice/:id with unknown id returns 404', async ({ request }) => {
    const res = await request.post(`${API}/accounting/quickbooks/sync/invoice/99999999`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('POST /:provider/sync/expense/:id with unknown id returns 404', async ({ request }) => {
    const res = await request.post(`${API}/accounting/xero/sync/expense/99999999`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('GET /:provider/synced returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/accounting/quickbooks/synced?page=1&pageSize=10`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('POST /:provider/sync/all returns counts for valid provider', async ({ request }) => {
    const res = await request.post(`${API}/accounting/quickbooks/sync/all`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.syncedCount).toBe('number');
    expect(typeof body.skippedCount).toBe('number');
  });

  test('POST /webhook/:provider is public + accepts payload', async ({ request }) => {
    const res = await request.post(`${API}/accounting/webhook/quickbooks`, {
      data: { event: 'test.ping', id: 'abc' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.received).toBe(true);
  });

  test('POST /webhook/:provider rejects unsupported provider with 400', async ({ request }) => {
    const res = await request.post(`${API}/accounting/webhook/foobar`, { data: {} });
    expect(res.status()).toBe(400);
  });
});
