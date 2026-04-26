// @ts-check
/**
 * Audit log viewer route smoke (`/api/audit-viewer`)
 *  - GET /            (paginated audit logs)
 *  - GET /stats       (30-day aggregate)
 *  - GET /entity/:entity/:id  (single-record trail)
 *  - GET /export.csv  (CSV blob)
 *
 * The whole router is gated by ADMIN+MANAGER (verifyToken + verifyRole) so we
 * also assert the auth gate.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Audit log viewer — /api/audit-viewer', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('auth gate — GET / without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?page=1&limit=10`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(typeof body.pages).toBe('number');
  });

  test('GET / honours filter params (entity, action)', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?entity=Contact&action=CREATE&limit=5`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    for (const log of body.logs) {
      expect(log.entity).toBe('Contact');
      expect(log.action).toBe('CREATE');
    }
  });

  test('GET / clamps limit to 200', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?limit=999`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(200);
  });

  test('GET /stats returns 30-day aggregate shape', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(body.byAction).toBeTruthy();
    expect(typeof body.byAction.CREATE).toBe('number');
    expect(typeof body.byAction.UPDATE).toBe('number');
    expect(typeof body.byAction.DELETE).toBe('number');
    expect(Array.isArray(body.byEntity)).toBe(true);
    expect(Array.isArray(body.topUsers)).toBe(true);
  });

  test('GET /entity/:entity/:id with non-numeric id returns 400', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/entity/Contact/not-a-number`, {
      headers: auth(),
    });
    expect(res.status()).toBe(400);
  });

  test('GET /entity/:entity/:id returns trail shape (may be empty)', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/entity/Contact/1`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.entity).toBe('Contact');
    expect(body.entityId).toBe(1);
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test('GET /export.csv returns text/csv', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/export.csv?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text).toMatch(/^ID,Timestamp,Action,Entity,EntityId,UserName,UserEmail,Details/);
  });
});
