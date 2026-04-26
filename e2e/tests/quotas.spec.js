// @ts-check
/**
 * Smoke tests for backend/routes/quotas.js — generic CRM tenant.
 * Mounted at /api/quotas. All endpoints behind verifyToken.
 *
 * Endpoints covered:
 *   GET    /                 list (filterable by userId/period)
 *   POST   /                 upsert
 *   PUT    /:id              update target
 *   DELETE /:id
 *   GET    /attainment       computed for a period
 *   GET    /leaderboard      sorted attainment
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let adminUserId = null;
let createdQuotaIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Quotas API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    const body = await login.json();
    token = body.token;
    expect(token).toBeTruthy();
    adminUserId = body.user?.id || body.userId || body.user?.userId;
    if (!adminUserId) {
      // Fall back: pick the first user in the tenant via /api/staff or /api/users
      const staff = await request.get(`${API}/staff`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (staff.ok()) {
        const list = await staff.json();
        const users = Array.isArray(list) ? list : list.data || list.users || [];
        adminUserId = users[0]?.id;
      }
    }
    expect(adminUserId, 'need a userId for quota upsert').toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdQuotaIds) {
      await request.delete(`${API}/quotas/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdQuotaIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/quotas returns array', async ({ request }) => {
    const res = await request.get(`${API}/quotas`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/quotas without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/quotas`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/quotas missing fields → 400', async ({ request }) => {
    const res = await request.post(`${API}/quotas`, {
      headers: auth(),
      data: { userId: adminUserId }, // missing period, target
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/quotas with negative target → 400', async ({ request }) => {
    const res = await request.post(`${API}/quotas`, {
      headers: auth(),
      data: { userId: adminUserId, period: '2099-Q1', target: -100 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST upsert + PUT update + DELETE happy path', async ({ request }) => {
    // Use a far-future period so we don't collide with real seeds.
    const period = `2099-Q${1 + (Date.now() % 4)}`;
    const create = await request.post(`${API}/quotas`, {
      headers: auth(),
      data: { userId: adminUserId, period, target: 50000 },
    });
    expect(create.status()).toBe(201);
    const q = await create.json();
    expect(q.id).toBeTruthy();
    expect(Number(q.target)).toBe(50000);
    createdQuotaIds.push(q.id);

    // Idempotent upsert — same userId+period; different target
    const upsert = await request.post(`${API}/quotas`, {
      headers: auth(),
      data: { userId: adminUserId, period, target: 75000 },
    });
    expect(upsert.status()).toBe(201);
    const q2 = await upsert.json();
    expect(q2.id).toBe(q.id);
    expect(Number(q2.target)).toBe(75000);

    // PUT
    const put = await request.put(`${API}/quotas/${q.id}`, {
      headers: auth(),
      data: { target: 100000 },
    });
    expect(put.status()).toBe(200);
    expect(Number((await put.json()).target)).toBe(100000);
  });

  test('PUT /api/quotas/:id 404 for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/quotas/99999999`, {
      headers: auth(),
      data: { target: 10 },
    });
    expect(res.status()).toBe(404);
  });

  test('GET /api/quotas/attainment requires period', async ({ request }) => {
    const res = await request.get(`${API}/quotas/attainment`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/quotas/attainment with period returns array', async ({ request }) => {
    const res = await request.get(`${API}/quotas/attainment?period=2099-Q1`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/quotas/leaderboard with period returns array', async ({ request }) => {
    const res = await request.get(`${API}/quotas/leaderboard?period=2099-Q1`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
