// @ts-check
/**
 * Zapier routes — /api/zapier/*
 *   Public:  GET /triggers, GET /actions, GET /test/:trigger,
 *            POST /actions/:key/execute (Bearer ApiKey),
 *            POST /webhook (apiKey in body)
 *   Auth:    GET /subscriptions, POST /subscribe, DELETE /subscribe/:id
 *
 * The metadata endpoints (triggers/actions/test) are mounted on /api/zapier
 * which is NOT in openPaths — only /zapier/webhook is. So these run under the
 * global verifyToken guard. Confirmed by reading server.js openPaths.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdSubscriptionIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('zapier.js — Zapier metadata + webhook ingress + subscriptions', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdSubscriptionIds) {
      await request.delete(`${API}/zapier/subscribe/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /zapier/subscriptions requires auth', async ({ request }) => {
    const res = await request.get(`${API}/zapier/subscriptions`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /zapier/triggers returns the trigger list', async ({ request }) => {
    const res = await request.get(`${API}/zapier/triggers`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.find((t) => t.key === 'contact_created')).toBeTruthy();
    expect(body.find((t) => t.key === 'deal_won')).toBeTruthy();
  });

  test('GET /zapier/actions returns the action list', async ({ request }) => {
    const res = await request.get(`${API}/zapier/actions`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.find((a) => a.key === 'create_contact')).toBeTruthy();
    expect(body.find((a) => a.key === 'create_deal')).toBeTruthy();
  });

  test('GET /zapier/test/:trigger returns sample list for known trigger', async ({ request }) => {
    const res = await request.get(`${API}/zapier/test/contact_created`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].email).toBeTruthy();
  });

  test('GET /zapier/test/:trigger 404s for unknown trigger', async ({ request }) => {
    const res = await request.get(`${API}/zapier/test/does_not_exist`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /zapier/subscriptions returns array', async ({ request }) => {
    const res = await request.get(`${API}/zapier/subscriptions`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /zapier/subscribe rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API}/zapier/subscribe`, {
      headers: auth(),
      data: { event: 'contact_created' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /zapier/subscribe creates a subscription', async ({ request }) => {
    const res = await request.post(`${API}/zapier/subscribe`, {
      headers: auth(),
      data: {
        event: 'contact_created',
        targetUrl: `https://hooks.zapier.com/hooks/catch/E2E_AUDIT_${Date.now()}`,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.event).toBe('contact_created');
    createdSubscriptionIds.push(body.id);
  });

  test('DELETE /zapier/subscribe/:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/zapier/subscribe/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  // ── Public webhook ingress ──────────────────────────────────────────
  test('POST /zapier/webhook (public) rejects missing triggerKey/apiKey with 400', async ({ request }) => {
    const res = await request.post(`${API}/zapier/webhook`, {
      data: { payload: { name: 'Aarav Nair' } },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /zapier/webhook rejects bogus apiKey with 401', async ({ request }) => {
    const res = await request.post(`${API}/zapier/webhook`, {
      data: {
        triggerKey: 'contact_created',
        apiKey: 'glbs_does_not_exist_e2e_audit',
        payload: { name: 'Aarav Nair', email: 'aarav@example.in' },
      },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /zapier/actions/:key/execute without staff token returns 403 (gate)', async ({ request }) => {
    // /zapier/actions/* is NOT in server.js openPaths, so the global staff
    // auth guard returns 403 before zapier's own API-key middleware. If we
    // ever decide to API-key-auth Zapier inbound calls (like /v1/external),
    // /zapier/actions would need to move into openPaths and this should
    // become 401.
    const res = await request.post(`${API}/zapier/actions/create_contact/execute`, {
      data: { name: 'Aarav', email: 'aarav@example.in' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /zapier/actions/:key/execute 404s for unknown action', async ({ request }) => {
    const res = await request.post(`${API}/zapier/actions/nope_e2e/execute`, {
      headers: { Authorization: 'Bearer glbs_bogus' },
      data: {},
    });
    expect(res.status()).toBe(404);
  });
});
