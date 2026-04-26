// @ts-check
/**
 * Smoke spec for backend/routes/custom_reports.js (7 handlers).
 * Mounted at /api/custom-reports.
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Each test seeds + cleans its own data so rows don't leak.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdReportIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('custom-reports routes', () => {
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
    for (const id of createdReportIds) {
      await request
        .delete(`${API}/custom-reports/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/custom-reports requires auth', async ({ request }) => {
    const res = await request.get(`${API}/custom-reports`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/custom-reports returns an array', async ({ request }) => {
    const res = await request.get(`${API}/custom-reports`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/custom-reports rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports`, {
      headers: auth(),
      data: { config: { entity: 'Deal' } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  test('POST /api/custom-reports rejects missing config with 400', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports`, {
      headers: auth(),
      data: { name: 'no-config' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/config/i);
  });

  test('POST /api/custom-reports creates a report (Arjun pipeline)', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_${Date.now()}_arjun_deals_by_stage`,
        description: 'Pipeline grouped by stage — owned by Arjun Patel',
        config: {
          entity: 'Deal',
          columns: ['id', 'title', 'amount', 'stage'],
          filters: [],
          orderBy: { field: 'createdAt', dir: 'desc' },
          limit: 50,
        },
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain('E2E_AUDIT_');
    expect(body.config.entity).toBe('Deal');
    createdReportIds.push(body.id);
  });

  test('GET /api/custom-reports/:id returns the saved report', async ({ request }) => {
    const id = createdReportIds[0];
    test.skip(!id, 'no report from previous test');
    const res = await request.get(`${API}/custom-reports/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.config.entity).toBe('Deal');
  });

  test('GET /api/custom-reports/9999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/custom-reports/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('PUT /api/custom-reports/:id updates description', async ({ request }) => {
    const id = createdReportIds[0];
    test.skip(!id, 'no report from previous test');
    const res = await request.put(`${API}/custom-reports/${id}`, {
      headers: auth(),
      data: { description: 'updated by E2E' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.description).toBe('updated by E2E');
  });

  test('POST /api/custom-reports/run rejects missing config with 400', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports/run`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/custom-reports/run executes ad-hoc Deal report', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports/run`, {
      headers: auth(),
      data: {
        config: {
          entity: 'Deal',
          columns: ['id', 'title', 'amount', 'stage'],
          limit: 5,
        },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Array.isArray(body.columns)).toBe(true);
  });

  test('POST /api/custom-reports/run rejects unsupported entity with 400', async ({ request }) => {
    const res = await request.post(`${API}/custom-reports/run`, {
      headers: auth(),
      data: { config: { entity: 'NotARealEntity' } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unsupported|entity/i);
  });

  test('POST /api/custom-reports/:id/run executes a saved report', async ({ request }) => {
    const id = createdReportIds[0];
    test.skip(!id, 'no report from previous test');
    const res = await request.post(`${API}/custom-reports/${id}/run`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Array.isArray(body.columns)).toBe(true);
  });

  test('DELETE /api/custom-reports/:id removes the report', async ({ request }) => {
    const id = createdReportIds[0];
    test.skip(!id, 'no report from previous test');
    const res = await request.delete(`${API}/custom-reports/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    createdReportIds.length = 0;

    const after = await request.get(`${API}/custom-reports/${id}`, { headers: auth() });
    expect(after.status()).toBe(404);
  });
});
