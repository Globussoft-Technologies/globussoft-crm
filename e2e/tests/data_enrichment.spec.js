// @ts-check
/**
 * Smoke spec for backend/routes/data_enrichment.js (4 handlers).
 * Mounted at /api/data-enrichment.
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. We test heuristic enrichment (no third-party calls) — the /providers
 * endpoint reports which integrations are wired up.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdContactIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('data-enrichment routes', () => {
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
    for (const id of createdContactIds) {
      await request
        .delete(`${API}/contacts/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  async function createContact(request, overrides = {}) {
    const res = await request.post(`${API}/contacts`, {
      headers: auth(),
      data: {
        name: 'Priya Sharma',
        email: `priya.sharma+${Date.now()}@globussoft.com`,
        phone: '+919876543210',
        ...overrides,
      },
    });
    expect(res.ok(), `contact create: ${await res.text()}`).toBeTruthy();
    const c = await res.json();
    createdContactIds.push(c.id);
    return c;
  }

  test('GET /api/data-enrichment/providers requires auth', async ({ request }) => {
    const res = await request.get(`${API}/data-enrichment/providers`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/data-enrichment/providers reports provider availability', async ({ request }) => {
    const res = await request.get(`${API}/data-enrichment/providers`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('heuristic');
    expect(body.heuristic).toBe(true);
    expect(body).toHaveProperty('gemini');
    expect(body).toHaveProperty('clearbit');
    expect(body).toHaveProperty('apollo');
  });

  test('POST /api/data-enrichment/contact/:id with invalid id returns 400', async ({ request }) => {
    const res = await request.post(`${API}/data-enrichment/contact/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /api/data-enrichment/contact/9999999 returns 404', async ({ request }) => {
    const res = await request.post(`${API}/data-enrichment/contact/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/data-enrichment/contact/:id enriches a corporate-domain contact', async ({ request }) => {
    const c = await createContact(request, {
      name: 'Arjun Patel',
      email: `arjun.patel+${Date.now()}@acmecorp.test`,
    });

    const res = await request.post(`${API}/data-enrichment/contact/${c.id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBe(c.id);
    expect(body.isCorporate).toBe(true);
    expect(body.domain).toBe('acmecorp.test');
    expect(body.enriched).toHaveProperty('website');
    expect(body.enriched.website).toContain('acmecorp.test');
  });

  test('POST /api/data-enrichment/contact/:id flags free-mail domains as non-corporate', async ({ request }) => {
    const c = await createContact(request, {
      name: 'Sneha Iyer',
      email: `sneha.iyer+${Date.now()}@gmail.com`,
    });
    const res = await request.post(`${API}/data-enrichment/contact/${c.id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isCorporate).toBe(false);
    expect(body.domain).toBe('gmail.com');
  });

  test('POST /api/data-enrichment/bulk rejects empty/missing contactIds with 400', async ({ request }) => {
    const res = await request.post(`${API}/data-enrichment/bulk`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/contactIds/i);
  });

  test('POST /api/data-enrichment/bulk enriches multiple contacts', async ({ request }) => {
    const a = await createContact(request, { name: 'Rahul Verma', email: `rahul.verma+${Date.now()}@globussoft.com` });
    const b = await createContact(request, { name: 'Anika Reddy', email: `anika.reddy+${Date.now()}@yahoo.com` });

    const res = await request.post(`${API}/data-enrichment/bulk`, {
      headers: auth(),
      data: { contactIds: [a.id, b.id] },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.enrichedCount).toBe(2);
    expect(Array.isArray(body.results)).toBe(true);
  });

  test('POST /api/data-enrichment/auto-enrich-new returns scan summary', async ({ request }) => {
    const res = await request.post(`${API}/data-enrichment/auto-enrich-new`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('scanned');
    expect(body).toHaveProperty('enrichedCount');
    expect(typeof body.scanned).toBe('number');
  });
});
