// @ts-check
/**
 * Google Calendar OAuth route smoke (`/api/calendar/google`)
 *  - GET /connect    (OAuth URL generation OR 500 if creds not configured)
 *  - GET /events     (synced Google events for current user)
 *  - POST /sync      (returns 404 if not connected — safe to assert)
 *  - DELETE /disconnect (idempotent — returns success even if not connected)
 *  - POST /events    (returns 400 on missing fields; 404 if not connected)
 *
 * GET /callback is the public OAuth redirect endpoint and is impossible to
 * exercise without a real Google authorization code, so we skip it.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Google Calendar — /api/calendar/google', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('auth gate — GET /connect without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/calendar/google/connect`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /connect returns authUrl OR 500 if creds are not configured', async ({ request }) => {
    const res = await request.get(`${API}/calendar/google/connect`, { headers: auth() });
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.authUrl).toMatch(/accounts\.google\.com\/o\/oauth2/);
    } else {
      expect(res.status()).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/credentials/i);
    }
  });

  test('GET /events returns array', async ({ request }) => {
    const res = await request.get(`${API}/calendar/google/events`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /sync without an integration returns 404', async ({ request }) => {
    const res = await request.post(`${API}/calendar/google/sync`, { headers: auth() });
    // 404 (not connected) or 200 (connected). Both are valid for an admin
    // account that may or may not have a previous Google connection.
    expect([200, 404]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toMatch(/not connected/i);
    }
  });

  test('POST /events rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/calendar/google/events`, {
      headers: auth(),
      data: { title: 'only-title' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title|startTime|endTime/);
  });

  test('DELETE /disconnect is idempotent (always 200)', async ({ request }) => {
    const res = await request.delete(`${API}/calendar/google/disconnect`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // GET /callback ingests a real Google auth code; we cannot fake one.
  test.skip('GET /callback — requires a valid Google authorization code (cannot exercise in E2E)', () => {});
});
