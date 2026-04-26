// @ts-check
/**
 * Approvals route smoke (`/api/approvals`)
 *  - GET / list, /pending-count, /my-requests, /to-approve
 *  - POST / create  (validation gates + happy path)
 *  - POST /:id/approve (RBAC + state machine)
 *  - POST /:id/reject (RBAC + comment-required gate)
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Approvals — /api/approvals', () => {
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

  async function createApproval(request, overrides = {}) {
    const res = await request.post(`${API}/approvals`, {
      headers: auth(),
      data: {
        entity: 'Deal',
        entityId: 1,
        reason: `E2E_APPROVAL_${Date.now()} discount waiver for Priya Sharma`,
        ...overrides,
      },
    });
    expect(res.status(), `create approval: ${await res.text()}`).toBe(201);
    return await res.json();
  }

  test('auth gate — GET / without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/approvals`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns array shape', async ({ request }) => {
    const res = await request.get(`${API}/approvals`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /pending-count returns a numeric count', async ({ request }) => {
    const res = await request.get(`${API}/approvals/pending-count`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe('number');
  });

  test('GET /my-requests returns array', async ({ request }) => {
    const res = await request.get(`${API}/approvals/my-requests`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /to-approve returns array (admin allowed)', async ({ request }) => {
    const res = await request.get(`${API}/approvals/to-approve`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST / rejects missing entity with 400', async ({ request }) => {
    const res = await request.post(`${API}/approvals`, {
      headers: auth(),
      data: { entityId: 1 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/entity/i);
  });

  test('POST / rejects non-integer entityId with 400', async ({ request }) => {
    const res = await request.post(`${API}/approvals`, {
      headers: auth(),
      data: { entity: 'Deal', entityId: 'abc' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/integer/i);
  });

  test('happy path — create + approve', async ({ request }) => {
    const created = await createApproval(request);
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('PENDING');

    const approve = await request.post(`${API}/approvals/${created.id}/approve`, {
      headers: auth(),
      data: { comment: 'looks good' },
    });
    expect(approve.status()).toBe(200);
    const body = await approve.json();
    expect(body.status).toBe('APPROVED');
  });

  test('cannot re-approve an already-approved request (400)', async ({ request }) => {
    const created = await createApproval(request);
    await request.post(`${API}/approvals/${created.id}/approve`, {
      headers: auth(),
      data: { comment: 'first' },
    });
    const second = await request.post(`${API}/approvals/${created.id}/approve`, {
      headers: auth(),
      data: { comment: 'again' },
    });
    expect(second.status()).toBe(400);
  });

  test('POST /:id/reject requires comment with 400', async ({ request }) => {
    const created = await createApproval(request);
    const res = await request.post(`${API}/approvals/${created.id}/reject`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/comment/i);
  });

  test('POST /:id/reject with comment moves PENDING → REJECTED', async ({ request }) => {
    const created = await createApproval(request);
    const res = await request.post(`${API}/approvals/${created.id}/reject`, {
      headers: auth(),
      data: { comment: 'declined — out of policy' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('REJECTED');
    expect(body.comment).toMatch(/declined/i);
  });

  test('POST /:id/approve with non-existent id returns 404', async ({ request }) => {
    const res = await request.post(`${API}/approvals/99999999/approve`, {
      headers: auth(),
      data: { comment: 'noop' },
    });
    expect(res.status()).toBe(404);
  });
});
