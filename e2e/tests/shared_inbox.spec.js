// @ts-check
/**
 * Smoke tests for backend/routes/shared_inbox.js — generic CRM tenant.
 * Mounted at /api/shared-inbox.
 *
 * Endpoints covered:
 *   GET    /
 *   POST   /
 *   PUT    /:id
 *   DELETE /:id
 *   POST   /:id/members
 *   GET    /:id/messages
 *   POST   /:id/assign-message
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Shared Inbox API — smoke', () => {
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
      await request.delete(`${API}/shared-inbox/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/shared-inbox returns array', async ({ request }) => {
    const res = await request.get(`${API}/shared-inbox`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/shared-inbox without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/shared-inbox`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/shared-inbox without name → 400', async ({ request }) => {
    const res = await request.post(`${API}/shared-inbox`, {
      headers: auth(),
      data: { emailAddress: 'support@example.com' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/shared-inbox without emailAddress → 400', async ({ request }) => {
    const res = await request.post(`${API}/shared-inbox`, {
      headers: auth(),
      data: { name: 'Support' },
    });
    expect(res.status()).toBe(400);
  });

  test('Create + list members + thread fetch + delete cycle', async ({ request }) => {
    const ts = Date.now();
    const tag = `E2E_AUDIT_${ts}`;
    const create = await request.post(`${API}/shared-inbox`, {
      headers: auth(),
      data: {
        name: tag,
        emailAddress: `e2e-audit-${ts}@example.com`,
        members: [],
      },
    });
    expect(create.status()).toBe(201);
    const inbox = await create.json();
    expect(inbox.id).toBeTruthy();
    expect(Array.isArray(inbox.members)).toBe(true);
    createdIds.push(inbox.id);

    // PUT update
    const put = await request.put(`${API}/shared-inbox/${inbox.id}`, {
      headers: auth(),
      data: { name: `${tag}_updated` },
    });
    expect(put.status()).toBe(200);
    expect((await put.json()).name).toBe(`${tag}_updated`);

    // POST /:id/members add — invalid action
    const badAction = await request.post(`${API}/shared-inbox/${inbox.id}/members`, {
      headers: auth(),
      data: { userId: 1, action: 'notvalid' },
    });
    expect(badAction.status()).toBe(400);

    // GET /:id/messages — empty thread list is OK
    const msgs = await request.get(`${API}/shared-inbox/${inbox.id}/messages`, {
      headers: auth(),
    });
    expect(msgs.status()).toBe(200);
    const msgsBody = await msgs.json();
    expect(msgsBody.inbox.id).toBe(inbox.id);
    expect(Array.isArray(msgsBody.threads)).toBe(true);

    // POST /:id/assign-message without messageId → 400
    const noMsg = await request.post(`${API}/shared-inbox/${inbox.id}/assign-message`, {
      headers: auth(),
      data: {},
    });
    expect(noMsg.status()).toBe(400);
  });

  test('PUT /api/shared-inbox/:id 404 for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/shared-inbox/99999999`, {
      headers: auth(),
      data: { name: 'x' },
    });
    expect(res.status()).toBe(404);
  });
});
