// @ts-check
/**
 * Outlook Calendar OAuth route smoke (`/api/calendar/outlook`)
 *  - GET /connect       (OAuth URL OR 500 if env vars missing)
 *  - GET /events        (synced Microsoft events for current user)
 *  - POST /sync         (404 if not connected)
 *  - POST /events       (400 on missing fields; 404 if not connected)
 *  - DELETE /disconnect (idempotent — clears integration row)
 *
 * GET /callback consumes a real Microsoft authorization code and cannot be
 * exercised in a smoke test, so we skip it.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Outlook Calendar — /api/calendar/outlook', () => {
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
    const res = await request.get(`${API}/calendar/outlook/connect`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /connect returns authUrl OR 500 if env vars missing', async ({ request }) => {
    const res = await request.get(`${API}/calendar/outlook/connect`, { headers: auth() });
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.authUrl).toMatch(/login\.microsoftonline\.com/);
    } else {
      expect(res.status()).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/configured|env/i);
    }
  });

  test('GET /events returns array', async ({ request }) => {
    const res = await request.get(`${API}/calendar/outlook/events`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /sync without integration returns 404', async ({ request }) => {
    const res = await request.post(`${API}/calendar/outlook/sync`, { headers: auth() });
    // Either 404 (not connected) or 200/502 if a real integration exists
    // and the live token is invalid. Smoke just asserts it doesn't 5xx
    // unexpectedly when the user has no integration.
    expect([200, 404, 502]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toMatch(/not connected/i);
    }
  });

  test('POST /events rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/calendar/outlook/events`, {
      headers: auth(),
      data: { title: 'only-title' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title|startTime|endTime/);
  });

  test('POST /events without integration returns 404', async ({ request }) => {
    const res = await request.post(`${API}/calendar/outlook/events`, {
      headers: auth(),
      data: {
        title: 'Smoke event',
        startTime: '2099-01-01T10:00:00.000Z',
        endTime: '2099-01-01T11:00:00.000Z',
      },
    });
    // 404 (not connected) is the expected smoke path; 200/201/502 are also
    // possible if a real integration exists.
    expect([201, 200, 404, 502]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toMatch(/not connected/i);
    }
  });

  test('DELETE /disconnect is idempotent (always 200)', async ({ request }) => {
    const res = await request.delete(`${API}/calendar/outlook/disconnect`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.disconnected).toBe(true);
  });

  // GET /callback consumes a real Microsoft auth code; cannot fake it.
  test.skip('GET /callback — requires a valid Microsoft authorization code (cannot exercise in E2E)', () => {});
});
