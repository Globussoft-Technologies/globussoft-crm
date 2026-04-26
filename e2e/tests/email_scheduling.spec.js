// @ts-check
/**
 * Smoke spec for backend/routes/email_scheduling.js (8 handlers).
 * Mounted at /api/email-scheduling.
 *
 *   GET    /signature           — current user's email signature
 *   PUT    /signature           — update signature
 *   GET    /                    — list (?status=, ?all=true)
 *   POST   /                    — schedule a new email
 *   GET    /:id                 — read
 *   DELETE /:id                 — delete
 *   POST   /:id/cancel          — cancel pending
 *   POST   /:id/send-now        — fire now (Mailgun) — we test 502/200 either way
 *
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Each test seeds + cleans its own data so rows don't leak.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdScheduledIds = [];
let originalSignature = '';

test.describe.configure({ mode: 'serial' });

test.describe('email-scheduling routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();

    // Save current signature so we can restore it.
    const sig = await request.get(`${API}/email-scheduling/signature`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (sig.ok()) {
      const sb = await sig.json();
      originalSignature = sb.signature || '';
    }
  });

  test.afterAll(async ({ request }) => {
    const headers = { Authorization: `Bearer ${adminToken}` };
    for (const id of createdScheduledIds) {
      await request.delete(`${API}/email-scheduling/${id}`, { headers }).catch(() => {});
    }
    // Restore signature.
    await request
      .put(`${API}/email-scheduling/signature`, {
        headers,
        data: { signature: originalSignature },
      })
      .catch(() => {});
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/email-scheduling requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email-scheduling/signature requires auth', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling/signature`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/email-scheduling/signature returns current signature', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling/signature`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.signature).toBe('string');
  });

  test('PUT /api/email-scheduling/signature rejects non-string with 400', async ({ request }) => {
    const res = await request.put(`${API}/email-scheduling/signature`, {
      headers: auth(),
      data: { signature: 12345 },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT /api/email-scheduling/signature updates signature', async ({ request }) => {
    const sig = `-- \nE2E_AUDIT_${Date.now()} | Priya Sharma | Globussoft Sales`;
    const res = await request.put(`${API}/email-scheduling/signature`, {
      headers: auth(),
      data: { signature: sig },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.signature).toBe(sig);
  });

  test('GET /api/email-scheduling returns array of scheduled emails', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/email-scheduling?all=true returns full history', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling?all=true`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/email-scheduling rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/email-scheduling`, {
      headers: auth(),
      data: { to: 'x@y.com' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/email-scheduling rejects invalid date with 400', async ({ request }) => {
    const res = await request.post(`${API}/email-scheduling`, {
      headers: auth(),
      data: {
        to: 'priya.sharma@globussoft.com',
        subject: 'hi',
        body: 'hello',
        scheduledFor: 'not-a-date',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scheduledFor|date/i);
  });

  test('POST /api/email-scheduling rejects past date with 400', async ({ request }) => {
    const res = await request.post(`${API}/email-scheduling`, {
      headers: auth(),
      data: {
        to: 'priya.sharma@globussoft.com',
        subject: 'hi',
        body: 'hello',
        scheduledFor: '2000-01-01T00:00:00.000Z',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/future/i);
  });

  test('POST /api/email-scheduling schedules an email for tomorrow', async ({ request }) => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request.post(`${API}/email-scheduling`, {
      headers: auth(),
      data: {
        to: `priya.sharma+e2e+${Date.now()}@globussoft.com`,
        subject: `E2E_AUDIT_${Date.now()}_scheduled`,
        body: 'Hi Priya, this is a scheduled E2E test email.',
        scheduledFor: tomorrow,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('PENDING');
    expect(body.subject).toContain('E2E_AUDIT_');
    createdScheduledIds.push(body.id);
  });

  test('GET /api/email-scheduling/:id returns the scheduled email', async ({ request }) => {
    const id = createdScheduledIds[0];
    test.skip(!id, 'no scheduled email from previous test');
    const res = await request.get(`${API}/email-scheduling/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  test('GET /api/email-scheduling/9999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/email-scheduling/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/email-scheduling/:id/cancel flips PENDING → CANCELED', async ({ request }) => {
    const id = createdScheduledIds[0];
    test.skip(!id, 'no scheduled email from previous test');
    const res = await request.post(`${API}/email-scheduling/${id}/cancel`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('CANCELED');
  });

  test('POST /api/email-scheduling/:id/cancel rejects non-PENDING with 400', async ({ request }) => {
    const id = createdScheduledIds[0];
    test.skip(!id, 'no scheduled email from previous test');
    const res = await request.post(`${API}/email-scheduling/${id}/cancel`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /api/email-scheduling/:id/send-now requires a non-SENT row', async ({ request }) => {
    // Create a fresh row so we can poke send-now without disturbing the cancel test.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const create = await request.post(`${API}/email-scheduling`, {
      headers: auth(),
      data: {
        to: `arjun.patel+e2e+${Date.now()}@globussoft.com`,
        subject: `E2E_AUDIT_${Date.now()}_send_now`,
        body: 'Send-now smoke',
        scheduledFor: tomorrow,
      },
    });
    expect(create.status()).toBe(201);
    const created = await create.json();
    createdScheduledIds.push(created.id);

    const res = await request.post(`${API}/email-scheduling/${created.id}/send-now`, { headers: auth() });
    // Without Mailgun keys configured the route returns 502 with FAILED status;
    // with keys configured it returns 200/SENT. Either way, the row exists.
    expect([200, 502]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('record');
    expect(['SENT', 'FAILED']).toContain(body.record.status);
  });

  test('DELETE /api/email-scheduling/:id removes the row', async ({ request }) => {
    const id = createdScheduledIds[0];
    test.skip(!id, 'no scheduled email from previous test');
    const res = await request.delete(`${API}/email-scheduling/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    // Drop the deleted id from cleanup list.
    createdScheduledIds.shift();
  });

  test('DELETE /api/email-scheduling/9999999 returns 404', async ({ request }) => {
    const res = await request.delete(`${API}/email-scheduling/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
