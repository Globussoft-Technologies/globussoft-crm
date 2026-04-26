// @ts-check
/**
 * Smoke tests for backend/routes/sla.js — generic CRM tenant.
 * Mounted at /api/sla.
 *
 * Endpoints covered:
 *   GET    /policies
 *   POST   /policies
 *   PUT    /policies/:id
 *   DELETE /policies/:id
 *   POST   /apply/:ticketId          per-ticket
 *   POST   /apply-all                bulk
 *   GET    /breaches
 *   GET    /stats
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('SLA API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    token = (await login.json()).token;
    expect(token).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${API}/sla/policies/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/sla/policies returns array', async ({ request }) => {
    const res = await request.get(`${API}/sla/policies`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/sla/policies without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/sla/policies`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/sla/breaches returns array', async ({ request }) => {
    const res = await request.get(`${API}/sla/breaches`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/sla/stats returns shape', async ({ request }) => {
    const res = await request.get(`${API}/sla/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.activePolicies).toBe('number');
    expect(typeof body.breachesToday).toBe('number');
    expect(typeof body.avgResponseMinutes).toBe('number');
    expect(typeof body.avgResolveMinutes).toBe('number');
  });

  test('POST /api/sla/policies without name → 400', async ({ request }) => {
    const res = await request.post(`${API}/sla/policies`, {
      headers: auth(),
      data: { priority: 'High' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/sla/policies without priority → 400', async ({ request }) => {
    const res = await request.post(`${API}/sla/policies`, {
      headers: auth(),
      data: { name: 'no priority' },
    });
    expect(res.status()).toBe(400);
  });

  test('Create + update + delete policy cycle', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/sla/policies`, {
      headers: auth(),
      data: {
        name: tag,
        priority: 'E2E_AUDIT', // unique priority avoids collision with seeded policies
        responseMinutes: 30,
        resolveMinutes: 240,
        isActive: true,
      },
    });
    expect(create.status()).toBe(201);
    const policy = await create.json();
    expect(policy.id).toBeTruthy();
    createdIds.push(policy.id);

    // PUT
    const put = await request.put(`${API}/sla/policies/${policy.id}`, {
      headers: auth(),
      data: { responseMinutes: 60 },
    });
    expect(put.status()).toBe(200);
    expect((await put.json()).responseMinutes).toBe(60);
  });

  test('PUT /api/sla/policies/:id 404 for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/sla/policies/99999999`, {
      headers: auth(),
      data: { responseMinutes: 10 },
    });
    expect(res.status()).toBe(404);
  });

  test('PUT /api/sla/policies/:id 400 for non-numeric id', async ({ request }) => {
    const res = await request.put(`${API}/sla/policies/not-a-number`, {
      headers: auth(),
      data: { responseMinutes: 10 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/sla/apply/:ticketId 400 for non-numeric id', async ({ request }) => {
    const res = await request.post(`${API}/sla/apply/not-a-number`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /api/sla/apply/:ticketId 404 for unknown ticket', async ({ request }) => {
    const res = await request.post(`${API}/sla/apply/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/sla/apply-all returns counts', async ({ request }) => {
    const res = await request.post(`${API}/sla/apply-all`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.applied).toBe('number');
    expect(typeof body.skipped).toBe('number');
    expect(typeof body.total).toBe('number');
  });
});
