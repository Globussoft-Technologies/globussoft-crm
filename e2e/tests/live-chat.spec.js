// @ts-check
/**
 * /api/live-chat — smoke spec covering 10 handlers in
 * backend/routes/live_chat.js. Visitor endpoints are public; agent
 * endpoints require auth.
 *
 *   POST   /visitor/start                   (public)
 *   POST   /visitor/:sessionId/message      (public)
 *   GET    /visitor/:sessionId/messages     (public)
 *   POST   /visitor/:sessionId/rate         (public — closes session)
 *   GET    /
 *   GET    /stats
 *   GET    /:id
 *   POST   /:id/assign
 *   POST   /:id/messages
 *   POST   /:id/close
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const createdSessionIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('live-chat API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    // Close any unresolved sessions to keep state clean
    for (const id of createdSessionIds) {
      await request.post(`${API}/live-chat/${id}/close`, { headers: auth() }).catch(() => {});
    }
  });

  // ── Public visitor endpoints ─────────────────────────────────────
  test('POST /visitor/start requires visitorId', async ({ request }) => {
    const res = await request.post(`${API}/live-chat/visitor/start`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /visitor/start creates an open session (no auth)', async ({ request }) => {
    const stamp = Date.now();
    const res = await request.post(`${API}/live-chat/visitor/start`, {
      data: {
        tenantId: 1,
        visitorId: `e2e_audit_${stamp}`,
        visitorName: 'Aarav Sharma',
        visitorEmail: `aarav_${stamp}@example.com`,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.session.status).toBe('OPEN');
    createdSessionIds.push(body.sessionId);
  });

  test('POST /visitor/:sessionId/message rejects empty body', async ({ request }) => {
    test.skip(!createdSessionIds.length, 'no session available');
    const sid = createdSessionIds[0];
    const res = await request.post(`${API}/live-chat/visitor/${sid}/message`, {
      data: { body: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /visitor/:sessionId/message persists a visitor message', async ({ request }) => {
    test.skip(!createdSessionIds.length, 'no session available');
    const sid = createdSessionIds[0];
    const res = await request.post(`${API}/live-chat/visitor/${sid}/message`, {
      data: { body: 'Hello from E2E_AUDIT' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.message.body).toContain('E2E_AUDIT');
  });

  test('GET /visitor/:sessionId/messages returns session + messages', async ({ request }) => {
    test.skip(!createdSessionIds.length, 'no session available');
    const sid = createdSessionIds[0];
    const res = await request.get(`${API}/live-chat/visitor/${sid}/messages`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.session).toBeTruthy();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  test('GET /visitor/:sessionId/messages 404s for unknown session', async ({ request }) => {
    const res = await request.get(`${API}/live-chat/visitor/99999999/messages`);
    expect(res.status()).toBe(404);
  });

  // ── Authenticated agent endpoints ────────────────────────────────
  test('GET / requires auth', async ({ request }) => {
    const res = await request.get(`${API}/live-chat`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns active sessions', async ({ request }) => {
    const res = await request.get(`${API}/live-chat`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /stats returns counts', async ({ request }) => {
    const res = await request.get(`${API}/live-chat/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('open');
    expect(body).toHaveProperty('assigned');
    expect(body).toHaveProperty('closedToday');
  });

  test('GET /:id 404s for unknown session', async ({ request }) => {
    const res = await request.get(`${API}/live-chat/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('Agent flow: assign → send message → close', async ({ request }) => {
    test.skip(!createdSessionIds.length, 'no session available');
    const sid = createdSessionIds[0];

    const assign = await request.post(`${API}/live-chat/${sid}/assign`, {
      headers: auth(),
      data: {},
    });
    expect(assign.status()).toBe(200);
    expect((await assign.json()).session.status).toBe('ASSIGNED');

    const send = await request.post(`${API}/live-chat/${sid}/messages`, {
      headers: auth(),
      data: { body: 'Agent reply E2E_AUDIT' },
    });
    expect(send.status()).toBe(200);

    const close = await request.post(`${API}/live-chat/${sid}/close`, {
      headers: auth(),
      data: { rating: 5 },
    });
    expect(close.status()).toBe(200);
    expect((await close.json()).session.status).toBe('CLOSED');

    // already closed; remove from cleanup list
    createdSessionIds.splice(createdSessionIds.indexOf(sid), 1);
  });

  test('POST /:id/assign 404s for unknown session', async ({ request }) => {
    const res = await request.post(`${API}/live-chat/99999999/assign`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('POST /:id/messages rejects empty body', async ({ request }) => {
    const res = await request.post(`${API}/live-chat/1/messages`, {
      headers: auth(),
      data: { body: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /visitor/:sessionId/rate 404s for unknown session', async ({ request }) => {
    const res = await request.post(`${API}/live-chat/visitor/99999999/rate`, {
      data: { rating: 5 },
    });
    expect(res.status()).toBe(404);
  });
});
