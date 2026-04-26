// @ts-check
/**
 * Attribution route smoke (`/api/attribution`)
 *  - POST /track       (record a touchpoint)
 *  - GET  /contact/:id (timeline)
 *  - GET  /report      (per-channel + per-source aggregation)
 *  - GET  /first-touch-revenue
 *  - GET  /multi-touch-revenue
 *
 * Tests use an existing tenant contact (no need to create new ones beyond
 * the touchpoint itself, which is intentional historical data — no cleanup
 * needed since touchpoints are append-only attribution records).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let contactId = null;

test.describe.configure({ mode: 'serial' });

test.describe('Attribution — /api/attribution', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;

    const contacts = await request.get(`${API}/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cdata = await contacts.json();
    const list = Array.isArray(cdata) ? cdata : (cdata.data || cdata.contacts || []);
    if (list[0]) contactId = list[0].id;
    test.skip(!contactId, 'tenant has no contacts; cannot exercise attribution');
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('auth gate — GET /report without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/attribution/report`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /track rejects missing contactId with 400', async ({ request }) => {
    const res = await request.post(`${API}/attribution/track`, {
      headers: auth(),
      data: { channel: 'email' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/contactId|channel/i);
  });

  test('POST /track rejects missing channel with 400', async ({ request }) => {
    const res = await request.post(`${API}/attribution/track`, {
      headers: auth(),
      data: { contactId },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /track returns 404 for unknown contact', async ({ request }) => {
    const res = await request.post(`${API}/attribution/track`, {
      headers: auth(),
      data: { contactId: 99999999, channel: 'email' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /track records a touchpoint (happy path)', async ({ request }) => {
    const res = await request.post(`${API}/attribution/track`, {
      headers: auth(),
      data: {
        contactId,
        channel: 'email',
        source: 'newsletter',
        medium: 'organic',
        url: 'https://crm.globusdemos.com/landing/april',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.channel).toBe('email');
    expect(body.contactId).toBe(contactId);
  });

  test('GET /contact/:id returns timeline for a known contact', async ({ request }) => {
    const res = await request.get(`${API}/attribution/contact/${contactId}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.contact).toBeTruthy();
    expect(body.contact.id).toBe(contactId);
    expect(Array.isArray(body.touchpoints)).toBe(true);
  });

  test('GET /contact/:id returns 404 for unknown contact', async ({ request }) => {
    const res = await request.get(`${API}/attribution/contact/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /report returns byChannel + bySource arrays', async ({ request }) => {
    const res = await request.get(`${API}/attribution/report`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.byChannel)).toBe(true);
    expect(Array.isArray(body.bySource)).toBe(true);
  });

  test('GET /first-touch-revenue returns model+totals', async ({ request }) => {
    const res = await request.get(`${API}/attribution/first-touch-revenue`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('first-touch');
    expect(typeof body.totalRevenue).toBe('number');
    expect(Array.isArray(body.bySource)).toBe(true);
  });

  test('GET /multi-touch-revenue returns model+totals', async ({ request }) => {
    const res = await request.get(`${API}/attribution/multi-touch-revenue`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('multi-touch-linear');
    expect(typeof body.totalRevenue).toBe('number');
    expect(Array.isArray(body.bySource)).toBe(true);
  });
});
