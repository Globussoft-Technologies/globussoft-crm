// @ts-check
/**
 * Smoke tests for backend/routes/portal.js — generic client portal API.
 * Mounted at /api/portal. Authenticated via a separate PORTAL JWT (not the
 * admin JWT). The seed does NOT plant a portal password for any contact, so
 * we verify all the public/unauthenticated paths and validation gates only.
 *
 * Endpoints covered:
 *   POST /login           public
 *   POST /set-password    public (sort of)
 *   POST /forgot          public (always 200 to prevent enumeration)
 *   POST /reset           public (token-based)
 *   GET  /me              portal-token gated
 *   GET  /tickets         portal-token gated
 *   POST /tickets         portal-token gated
 *   GET  /invoices        portal-token gated
 *   GET  /contracts       portal-token gated
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

test.describe('Portal API — public + auth gates', () => {
  test('POST /api/portal/login without body returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/login`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/login with unknown email returns 401', async ({ request }) => {
    const res = await request.post(`${API}/portal/login`, {
      data: { email: 'rohan.unknown@example.com', password: 'whatever' },
    });
    expect(res.status()).toBe(401);
  });

  // /portal/set-password is NOT in server.js openPaths — it requires staff
  // auth (admin/manager promotes a contact to a portal user). Without a token
  // the global auth guard returns 403 before set-password's own validators run.
  test('POST /api/portal/set-password without staff token returns 403', async ({ request }) => {
    const res = await request.post(`${API}/portal/set-password`, {
      data: { email: 'someone@example.com', newPassword: 'newpass123' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /api/portal/forgot without email returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/forgot`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/forgot with unknown email still returns 200 (no enumeration)', async ({ request }) => {
    const res = await request.post(`${API}/portal/forgot`, {
      data: { email: 'enum.probe.' + Date.now() + '@example.com' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.message).toBeTruthy();
  });

  test('POST /api/portal/reset without fields returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/reset`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/reset with bogus token returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/reset`, {
      data: { token: 'not-a-real-token', newPassword: 'newpass123' },
    });
    expect(res.status()).toBe(400);
  });

  // The portal-token-protected endpoints are NOT in server.js openPaths, so
  // the global staff auth guard runs first and returns 403 for missing token.
  // The portal-token middleware (returning 401) only runs for staff-authed
  // requests with the wrong token type.
  test('GET /api/portal/me without any token returns 403', async ({ request }) => {
    const res = await request.get(`${API}/portal/me`);
    expect(res.status()).toBe(403);
  });

  test('GET /api/portal/me with admin JWT (wrong type) returns 401 from portal middleware', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
    });
    const adminToken = (await login.json()).token;
    const res = await request.get(`${API}/portal/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    // Staff token passes the global guard; portal middleware then rejects
    // because decoded.type !== "PORTAL".
    expect(res.status()).toBe(401);
  });

  test('GET /api/portal/tickets without token returns 403', async ({ request }) => {
    const res = await request.get(`${API}/portal/tickets`);
    expect(res.status()).toBe(403);
  });

  test('POST /api/portal/tickets without token returns 403', async ({ request }) => {
    const res = await request.post(`${API}/portal/tickets`, {
      data: { subject: 'help' },
    });
    expect(res.status()).toBe(403);
  });

  test('GET /api/portal/invoices without token returns 403', async ({ request }) => {
    const res = await request.get(`${API}/portal/invoices`);
    expect(res.status()).toBe(403);
  });

  test('GET /api/portal/contracts without token returns 403', async ({ request }) => {
    const res = await request.get(`${API}/portal/contracts`);
    expect(res.status()).toBe(403);
  });
});
