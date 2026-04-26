// @ts-check
/**
 * AB Tests route smoke (`/api/ab-tests`)
 *  - list / detail / create / update / delete
 *  - start, track, declare-winner, stats
 *  - validation gates on track + declare-winner
 *
 * Hits BASE_URL (default https://crm.globusdemos.com). Each test cleans up
 * any rows it creates so nothing leaks between runs.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('AB Tests — /api/ab-tests', () => {
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

  async function createTest(request, name) {
    const res = await request.post(`${API}/ab-tests`, {
      headers: auth(),
      data: {
        name: name || `E2E_AB_${Date.now()}`,
        variantA: { subject: 'Try our new feature' },
        variantB: { subject: 'Discover what is new' },
      },
    });
    expect(res.status(), `create AB test: ${await res.text()}`).toBe(201);
    return await res.json();
  }

  async function deleteTest(request, id) {
    await request.delete(`${API}/ab-tests/${id}`, { headers: auth() });
  }

  test('GET /ab-tests returns an array (smoke)', async ({ request }) => {
    const res = await request.get(`${API}/ab-tests`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('auth gate — GET without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/ab-tests`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /ab-tests rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/ab-tests`, {
      headers: auth(),
      data: { variantA: {}, variantB: {} },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  test('happy path — create + GET detail + stats + delete', async ({ request }) => {
    const created = await createTest(request, `E2E_AB_${Date.now()}`);
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('DRAFT');

    const detail = await request.get(`${API}/ab-tests/${created.id}`, { headers: auth() });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.id).toBe(created.id);
    expect(body.stats).toBeTruthy();
    expect(body.stats.variantA).toBeTruthy();

    const stats = await request.get(`${API}/ab-tests/${created.id}/stats`, { headers: auth() });
    expect(stats.status()).toBe(200);
    const sb = await stats.json();
    expect(sb.id).toBe(created.id);
    expect(typeof sb.totalSent).toBe('number');

    await deleteTest(request, created.id);
  });

  test('PUT /ab-tests/:id can update name', async ({ request }) => {
    const created = await createTest(request);
    const newName = `E2E_AB_RENAMED_${Date.now()}`;
    const res = await request.put(`${API}/ab-tests/${created.id}`, {
      headers: auth(),
      data: { name: newName },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(newName);
    await deleteTest(request, created.id);
  });

  test('POST /:id/start moves DRAFT → RUNNING', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/start`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('RUNNING');
    await deleteTest(request, created.id);
  });

  test('POST /:id/track rejects invalid variant with 400', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/track`, {
      headers: auth(),
      data: { variant: 'C', action: 'sent' },
    });
    expect(res.status()).toBe(400);
    await deleteTest(request, created.id);
  });

  test('POST /:id/track rejects invalid action with 400', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/track`, {
      headers: auth(),
      data: { variant: 'A', action: 'opened' },
    });
    expect(res.status()).toBe(400);
    await deleteTest(request, created.id);
  });

  test('POST /:id/track A/sent increments counter', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/track`, {
      headers: auth(),
      data: { variant: 'A', action: 'sent' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.variantASent).toBe(1);
    await deleteTest(request, created.id);
  });

  test('POST /:id/declare-winner rejects invalid winner with 400', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/declare-winner`, {
      headers: auth(),
      data: { winner: 'Z' },
    });
    expect(res.status()).toBe(400);
    await deleteTest(request, created.id);
  });

  test('POST /:id/declare-winner sets winner + COMPLETED', async ({ request }) => {
    const created = await createTest(request);
    const res = await request.post(`${API}/ab-tests/${created.id}/declare-winner`, {
      headers: auth(),
      data: { winner: 'A' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.winningVariant).toBe('A');
    expect(body.status).toBe('COMPLETED');
    await deleteTest(request, created.id);
  });

  test('GET /:id 404s for non-existent id', async ({ request }) => {
    const res = await request.get(`${API}/ab-tests/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
