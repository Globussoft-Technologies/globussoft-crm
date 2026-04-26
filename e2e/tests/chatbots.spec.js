// @ts-check
/**
 * Smoke spec for backend/routes/chatbots.js (9 handlers).
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Each test seeds + cleans its own data so rows don't leak.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let tenantId = null;
const createdBotIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('chatbots routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    tenantId = body.user?.tenantId ?? body.tenantId ?? null;
    expect(adminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdBotIds) {
      await request
        .delete(`${API}/chatbots/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/chatbots requires auth', async ({ request }) => {
    const res = await request.get(`${API}/chatbots`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/chatbots returns an array', async ({ request }) => {
    const res = await request.get(`${API}/chatbots`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/chatbots rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/chatbots`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/chatbots creates a bot (Priya welcome flow)', async ({ request }) => {
    const stamp = Date.now();
    const res = await request.post(`${API}/chatbots`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_${stamp}_priya_bot`,
        flow: {
          nodes: [
            { id: 'n1', type: 'message', content: 'Hi, this is Priya from Globussoft' },
            { id: 'n2', type: 'capture-email', content: 'Please share your email' },
            { id: 'n3', type: 'end' },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      },
    });
    expect(res.status()).toBe(200);
    const bot = await res.json();
    expect(bot.id).toBeTruthy();
    expect(bot.name).toContain('E2E_AUDIT_');
    expect(bot.isActive).toBe(false);
    expect(bot.flow.nodes.length).toBe(3);
    createdBotIds.push(bot.id);
  });

  test('GET /api/chatbots/:id returns the bot with parsed flow', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.get(`${API}/chatbots/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(Array.isArray(body.flow.nodes)).toBe(true);
  });

  test('GET /api/chatbots/99999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/chatbots/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('PUT /api/chatbots/:id updates name', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.put(`${API}/chatbots/${id}`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_${Date.now()}_renamed` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toContain('renamed');
  });

  test('POST /api/chatbots/:id/activate flips isActive=true', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.post(`${API}/chatbots/${id}/activate`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(true);
  });

  test('POST /api/chatbots/:id/deactivate flips isActive=false', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.post(`${API}/chatbots/${id}/deactivate`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  test('GET /api/chatbots/:id/conversations returns an array', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.get(`${API}/chatbots/${id}/conversations`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/chatbots/chat/:botId without visitorId returns 400', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.post(`${API}/chatbots/chat/${id}`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/chatbots/chat/:botId with inactive+wrong tenant returns 403', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    // Bot is currently deactivated. Public visitor (no tenantId override) → 403.
    const res = await request.post(`${API}/chatbots/chat/${id}`, {
      data: { visitorId: `visitor-${Date.now()}`, message: 'hi' },
    });
    expect(res.status()).toBe(403);
  });

  test('DELETE /api/chatbots/:id removes the bot', async ({ request }) => {
    const id = createdBotIds[0];
    test.skip(!id, 'no bot from previous test');
    const res = await request.delete(`${API}/chatbots/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const after = await request.get(`${API}/chatbots/${id}`, { headers: auth() });
    expect(after.status()).toBe(404);

    // Already cleaned up — drop from afterAll list.
    createdBotIds.length = 0;
  });
});
