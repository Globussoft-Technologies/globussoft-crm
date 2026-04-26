// @ts-check
/**
 * Smoke tests for backend/routes/pipelines.js — generic CRM tenant.
 * Mounted at /api/pipelines.
 *
 * Endpoints covered:
 *   GET    /                  list (with deal counts)
 *   POST   /                  create
 *   PUT    /:id               update name/description
 *   DELETE /:id               delete (rejects default + with deals)
 *   POST   /:id/set-default   atomic default swap
 *   GET    /:id/deals         list deals in pipeline
 *   GET    /:id/stats         per-stage counts
 *
 * Each test that creates state cleans up after itself.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Pipelines API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    token = body.token;
    expect(token).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${API}/pipelines/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/pipelines returns an array (smoke + dealCount field)', async ({ request }) => {
    const res = await request.get(`${API}/pipelines`, { headers: auth() });
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    if (list.length) {
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('name');
      expect(list[0]).toHaveProperty('dealCount');
    }
  });

  test('GET /api/pipelines without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API}/pipelines`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/pipelines without name returns 400', async ({ request }) => {
    const res = await request.post(`${API}/pipelines`, {
      headers: auth(),
      data: { description: 'no name' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/pipelines creates a pipeline (cleanup)', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const res = await request.post(`${API}/pipelines`, {
      headers: auth(),
      data: { name: tag, description: 'Aarav Mehta E2E pipeline' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe(tag);
    createdIds.push(body.id);

    // PUT update
    const upd = await request.put(`${API}/pipelines/${body.id}`, {
      headers: auth(),
      data: { description: 'updated by Priya Nair' },
    });
    expect(upd.status()).toBe(200);
    const updBody = await upd.json();
    expect(updBody.description).toBe('updated by Priya Nair');

    // GET /:id/stats
    const stats = await request.get(`${API}/pipelines/${body.id}/stats`, { headers: auth() });
    expect(stats.status()).toBe(200);
    const sBody = await stats.json();
    expect(sBody.pipelineId).toBe(body.id);
    expect(typeof sBody.totalDeals).toBe('number');
    expect(Array.isArray(sBody.byStage)).toBe(true);

    // GET /:id/deals
    const deals = await request.get(`${API}/pipelines/${body.id}/deals`, { headers: auth() });
    expect(deals.status()).toBe(200);
    expect(Array.isArray(await deals.json())).toBe(true);
  });

  test('PUT /api/pipelines/:id with non-numeric id returns 400', async ({ request }) => {
    const res = await request.put(`${API}/pipelines/not-a-number`, {
      headers: auth(),
      data: { name: 'x' },
    });
    expect(res.status()).toBe(400);
  });

  test('DELETE /api/pipelines/:id 404s for missing id', async ({ request }) => {
    const res = await request.delete(`${API}/pipelines/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/pipelines/:id/set-default makes a non-default pipeline default, then restores', async ({ request }) => {
    // Create a fresh non-default pipeline so we can flip it.
    const tag = `E2E_AUDIT_DEFAULT_${Date.now()}`;
    const create = await request.post(`${API}/pipelines`, {
      headers: auth(),
      data: { name: tag, isDefault: false },
    });
    expect(create.status()).toBe(201);
    const created = await create.json();
    createdIds.push(created.id);

    // Find the existing default to restore later.
    const list = await request.get(`${API}/pipelines`, { headers: auth() });
    const all = await list.json();
    const previousDefault = all.find((p) => p.isDefault && p.id !== created.id);

    // Flip default to our new pipeline.
    const swap = await request.post(`${API}/pipelines/${created.id}/set-default`, { headers: auth() });
    expect(swap.status()).toBe(200);
    const swapped = await swap.json();
    expect(swapped.isDefault).toBe(true);

    // Restore the previous default if there was one.
    if (previousDefault) {
      const restore = await request.post(`${API}/pipelines/${previousDefault.id}/set-default`, {
        headers: auth(),
      });
      expect(restore.status()).toBe(200);
    }
  });
});
