// @ts-check
/**
 * Gmail integration — API gate coverage for routes/gmail.js.
 *
 * The OAuth handshake (connect → Google consent → callback → token exchange)
 * cannot run in CI: there are no Google credentials and no human to grant
 * consent. So this spec pins the parts that ARE deterministic without a live
 * Google connection — the auth gate, request validation, and the
 * not-configured / not-connected contract that the frontend depends on:
 *
 *   GET    /api/gmail/connect      — 200 { authUrl } when creds present,
 *                                    else 500 NOT_CONFIGURED; 401 unauth
 *   GET    /api/gmail/status       — 200 { connected:false } for a user who
 *                                    hasn't connected; 401 unauth
 *   DELETE /api/gmail/disconnect   — 200 { success:true } (idempotent); 401 unauth
 *   GET    /api/gmail/messages     — 404 NOT_CONNECTED (auth ok, no mailbox); 401 unauth
 *   GET    /api/gmail/messages/:id — 404 NOT_CONNECTED; 401 unauth
 *   POST   /api/gmail/send         — 400 MISSING_FIELDS (no `to` / no body),
 *                                    404 NOT_CONNECTED once a valid body passes
 *                                    validation; 401 unauth
 *
 * Creates no data → no afterAll cleanup. Single USER token (user@crm.com) is
 * enough; nothing here is role-gated beyond "logged in".
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let userToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token };
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
  }
  return userToken;
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.describe('Gmail integration API — auth gate', () => {
  test('every endpoint 401s without a token', async ({ request }) => {
    const noAuth = { headers: { 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT };
    const calls = [
      request.get(`${BASE_URL}/api/gmail/connect`, noAuth),
      request.get(`${BASE_URL}/api/gmail/status`, noAuth),
      request.get(`${BASE_URL}/api/gmail/messages`, noAuth),
      request.get(`${BASE_URL}/api/gmail/messages/abc123`, noAuth),
      request.post(`${BASE_URL}/api/gmail/send`, { ...noAuth, data: { to: 'x@y.com', text: 'hi' } }),
      request.delete(`${BASE_URL}/api/gmail/disconnect`, noAuth),
    ];
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r.status()).toBe(401);
    }
  });
});

test.describe('Gmail integration API — connected-status contract', () => {
  test('GET /status returns { connected:false } for a user with no mailbox linked', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.get(`${BASE_URL}/api/gmail/status`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.connected).toBe(false);
  });

  test('GET /connect returns an authUrl when configured, else 500 NOT_CONFIGURED', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.get(`${BASE_URL}/api/gmail/connect`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
    const body = await r.json();
    if (r.status() === 200) {
      expect(typeof body.authUrl).toBe('string');
      expect(body.authUrl).toContain('accounts.google.com');
    } else {
      // CI / any env without GOOGLE_CLIENT_ID|SECRET takes this branch.
      expect(r.status()).toBe(500);
      expect(body.code).toBe('NOT_CONFIGURED');
    }
  });

  test('DELETE /disconnect is idempotent (200) even when nothing is connected', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.delete(`${BASE_URL}/api/gmail/disconnect`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
  });

  test('GET /messages 404s NOT_CONNECTED when the user has no mailbox linked', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.get(`${BASE_URL}/api/gmail/messages`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('NOT_CONNECTED');
  });

  test('GET /messages/:id 404s NOT_CONNECTED when the user has no mailbox linked', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.get(`${BASE_URL}/api/gmail/messages/abc123`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('NOT_CONNECTED');
  });
});

test.describe('Gmail integration API — POST /send validation', () => {
  test('400 MISSING_FIELDS when `to` is absent', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.post(`${BASE_URL}/api/gmail/send`, {
      headers: authHeaders(token),
      data: { subject: 'Hi', text: 'body' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('MISSING_FIELDS');
  });

  test('400 MISSING_FIELDS when neither text nor html body is provided', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.post(`${BASE_URL}/api/gmail/send`, {
      headers: authHeaders(token),
      data: { to: 'client@example.com', subject: 'Hi' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('MISSING_FIELDS');
  });

  test('a valid body passes validation and then 404s NOT_CONNECTED (no mailbox)', async ({ request }) => {
    const token = await getUser(request);
    const r = await request.post(`${BASE_URL}/api/gmail/send`, {
      headers: authHeaders(token),
      data: { to: 'client@example.com', subject: 'Hi', text: 'See you soon' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('NOT_CONNECTED');
  });
});
