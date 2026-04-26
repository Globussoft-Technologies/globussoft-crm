// @ts-check
/**
 * Smoke spec for backend/routes/email_inbound.js (3 handlers).
 * Mounted at /api/email/inbound.
 *
 *   POST /            — PUBLIC Mailgun store-and-forward webhook
 *   POST /test        — AUTHED, accepts JSON Mailgun payload (QA path)
 *   POST /verify      — PUBLIC route verification, echoes 200
 *
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. We don't have Mailgun signing keys here, so we validate the webhook
 * via its public form-encoded contract directly (this is what production does
 * for unsigned forwards). The /test path runs the same processor.
 *
 * Each test uses a unique sender email so duplicate inbound rows don't pile up.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('email_inbound routes', () => {
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

  test('POST /api/email/inbound/verify is public and returns ok', async ({ request }) => {
    const res = await request.post(`${API}/email/inbound/verify`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('POST /api/email/inbound (public webhook) rejects payload without sender', async ({ request }) => {
    const form = new URLSearchParams();
    form.append('subject', 'No sender');
    form.append('body-plain', 'this should fail');

    const res = await request.post(`${API}/email/inbound`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form.toString(),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/sender/i);
  });

  test('POST /api/email/inbound (public webhook) accepts a valid Mailgun-shaped form', async ({ request }) => {
    const form = new URLSearchParams();
    form.append('sender', `priya.sharma+e2e+${Date.now()}@example-customer.test`);
    form.append('recipient', 'sales@crm.globusdemos.com');
    form.append('subject', `E2E_AUDIT_${Date.now()}_inbound_test`);
    form.append('body-plain', 'Hi, this is a test inbound email from Priya.');

    const res = await request.post(`${API}/email/inbound`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form.toString(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.emailId).toBeTruthy();
  });

  test('POST /api/email/inbound/test requires auth', async ({ request }) => {
    const res = await request.post(`${API}/email/inbound/test`, {
      data: { sender: 'x@y.com', subject: 's', 'body-plain': 'b' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/email/inbound/test (authed) processes a JSON Mailgun payload', async ({ request }) => {
    const stamp = Date.now();
    const res = await request.post(`${API}/email/inbound/test`, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: {
        sender: `arjun.patel+e2e+${stamp}@partner.test`,
        recipient: 'support@crm.globusdemos.com',
        subject: `E2E_AUDIT_${stamp}_inbound_json`,
        'body-plain': 'JSON body for the QA path',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.emailId).toBeTruthy();
    expect(body).toHaveProperty('tenantId');
  });

  test('POST /api/email/inbound/test rejects payload without sender', async ({ request }) => {
    const res = await request.post(`${API}/email/inbound/test`, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: { subject: 'no sender', 'body-plain': 'fail' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
