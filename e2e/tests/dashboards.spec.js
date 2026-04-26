// @ts-check
/**
 * Smoke spec for backend/routes/dashboards.js (7 handlers).
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Each test seeds + cleans its own data so rows don't leak.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdDashboardIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('dashboards routes', () => {
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
    for (const id of createdDashboardIds) {
      await request
        .delete(`${API}/dashboards/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/dashboards requires auth', async ({ request }) => {
    const res = await request.get(`${API}/dashboards`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/dashboards returns an array', async ({ request }) => {
    const res = await request.get(`${API}/dashboards`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/dashboards rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/dashboards`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  test('POST /api/dashboards creates a dashboard with KPI widgets', async ({ request }) => {
    const res = await request.post(`${API}/dashboards`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_${Date.now()}_priya_dashboard`,
        layout: [
          { i: 'w1', type: 'kpi-revenue', x: 0, y: 0, w: 4, h: 2 },
          { i: 'w2', type: 'kpi-deals', x: 4, y: 0, w: 4, h: 2 },
          { i: 'w3', type: 'chart-pipeline', x: 0, y: 2, w: 8, h: 4 },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain('E2E_AUDIT_');
    expect(Array.isArray(body.layout)).toBe(true);
    expect(body.layout.length).toBe(3);
    createdDashboardIds.push(body.id);
  });

  test('GET /api/dashboards/:id returns the dashboard', async ({ request }) => {
    const id = createdDashboardIds[0];
    test.skip(!id, 'no dashboard from previous test');
    const res = await request.get(`${API}/dashboards/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  test('GET /api/dashboards/9999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/dashboards/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /api/dashboards/abc returns 400 for non-numeric id', async ({ request }) => {
    const res = await request.get(`${API}/dashboards/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('PUT /api/dashboards/:id updates name and layout', async ({ request }) => {
    const id = createdDashboardIds[0];
    test.skip(!id, 'no dashboard from previous test');
    const res = await request.put(`${API}/dashboards/${id}`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_${Date.now()}_renamed`,
        layout: [{ i: 'w1', type: 'kpi-contacts', x: 0, y: 0, w: 4, h: 2 }],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toContain('renamed');
    expect(body.layout.length).toBe(1);
  });

  test('GET /api/dashboards/:id/data resolves widget data', async ({ request }) => {
    const id = createdDashboardIds[0];
    test.skip(!id, 'no dashboard from previous test');
    const res = await request.get(`${API}/dashboards/${id}/data`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
    // Should have entry for w1
    expect(body).toHaveProperty('w1');
  });

  test('POST /api/dashboards/:id/set-default sets tenant default (admin)', async ({ request }) => {
    const id = createdDashboardIds[0];
    test.skip(!id, 'no dashboard from previous test');
    const res = await request.post(`${API}/dashboards/${id}/set-default`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isDefault).toBe(true);
  });

  test('DELETE /api/dashboards/:id removes the dashboard', async ({ request }) => {
    const id = createdDashboardIds[0];
    test.skip(!id, 'no dashboard from previous test');
    const res = await request.delete(`${API}/dashboards/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    createdDashboardIds.length = 0;
  });
});
