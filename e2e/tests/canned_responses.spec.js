// @ts-check
/**
 * Canned responses route smoke (`/api/canned-responses`)
 *  - GET / list (with category filter)
 *  - POST / create (validation + happy path)
 *  - PUT /:id update
 *  - DELETE /:id
 *
 * Self-cleans every row it creates.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Canned responses — /api/canned-responses', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  async function createResponse(request, overrides = {}) {
    const res = await request.post(`${API}/canned-responses`, {
      headers: auth(),
      data: {
        name: `E2E_CANNED_${Date.now()}`,
        content: 'Hi {name}, thanks for reaching out — we will get back to you within 24 hours.',
        category: 'Support',
        ...overrides,
      },
    });
    expect(res.status(), `create canned: ${await res.text()}`).toBe(201);
    return await res.json();
  }

  async function deleteResponse(request, id) {
    await request.delete(`${API}/canned-responses/${id}`, { headers: auth() });
  }

  test('auth gate — GET / without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/canned-responses`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns array', async ({ request }) => {
    const res = await request.get(`${API}/canned-responses`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET / with category filter only returns that category', async ({ request }) => {
    const created = await createResponse(request, { category: 'E2ECategory' });
    const res = await request.get(`${API}/canned-responses?category=E2ECategory`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const item of body) {
      expect(item.category).toBe('E2ECategory');
    }
    expect(body.find((b) => b.id === created.id)).toBeTruthy();
    await deleteResponse(request, created.id);
  });

  test('POST / rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/canned-responses`, {
      headers: auth(),
      data: { content: 'no name' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name|content/i);
  });

  test('POST / rejects missing content with 400', async ({ request }) => {
    const res = await request.post(`${API}/canned-responses`, {
      headers: auth(),
      data: { name: 'no-content' },
    });
    expect(res.status()).toBe(400);
  });

  test('happy path — create + update + delete', async ({ request }) => {
    const created = await createResponse(request);
    expect(created.id).toBeTruthy();
    expect(created.category).toBe('Support');

    const upd = await request.put(`${API}/canned-responses/${created.id}`, {
      headers: auth(),
      data: { content: 'Updated content for Arjun Patel.', category: 'Sales' },
    });
    expect(upd.status()).toBe(200);
    const updBody = await upd.json();
    expect(updBody.content).toMatch(/Arjun/);
    expect(updBody.category).toBe('Sales');

    await deleteResponse(request, created.id);

    // Confirm 404 after delete
    const after = await request.put(`${API}/canned-responses/${created.id}`, {
      headers: auth(),
      data: { name: 'no-op' },
    });
    expect(after.status()).toBe(404);
  });

  test('PUT /:id rejects non-numeric id with 400', async ({ request }) => {
    const res = await request.put(`${API}/canned-responses/not-a-number`, {
      headers: auth(),
      data: { content: 'x' },
    });
    expect(res.status()).toBe(400);
  });

  test('DELETE /:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/canned-responses/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
