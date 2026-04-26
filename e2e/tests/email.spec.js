// @ts-check
/**
 * Smoke spec for backend/routes/email.js (3 handlers).
 * Mounted at /api/email — read-only summary endpoints over EmailMessage +
 * ScheduledEmail.
 *
 *   GET /api/email/threads     — grouped email threads (last 50)
 *   GET /api/email/stats       — counts: total, unread, sent, received
 *   GET /api/email/scheduled   — pending ScheduledEmail rows
 *
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. No fixture mutation — these are pure list endpoints.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('email summary routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/email/threads requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email/threads`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email/threads returns array (max 50 threads)', async ({ request }) => {
    const res = await request.get(`${API}/email/threads`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(50);
    if (body.length > 0) {
      const t = body[0];
      expect(t).toHaveProperty('threadId');
      expect(t).toHaveProperty('messages');
      expect(t).toHaveProperty('lastAt');
      expect(t).toHaveProperty('unread');
      expect(Array.isArray(t.messages)).toBe(true);
    }
  });

  test('GET /api/email/stats requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email/stats`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email/stats returns counts', async ({ request }) => {
    const res = await request.get(`${API}/email/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('unread');
    expect(body).toHaveProperty('sent');
    expect(body).toHaveProperty('received');
    expect(typeof body.total).toBe('number');
    expect(typeof body.unread).toBe('number');
    expect(typeof body.sent).toBe('number');
    expect(typeof body.received).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  test('GET /api/email/scheduled requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email/scheduled`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email/scheduled returns pending scheduled emails', async ({ request }) => {
    const res = await request.get(`${API}/email/scheduled`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const s of body) {
      expect(s.status).toBe('PENDING');
    }
  });
});
