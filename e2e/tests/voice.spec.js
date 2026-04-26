// @ts-check
/**
 * Voice routes (Twilio softphone) — /api/voice/*
 *   Public:  POST /webhook/status, POST /webhook/twiml
 *   Auth:    POST /token, POST /call, GET /sessions, POST /end/:sessionId
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('voice.js — Twilio softphone integration', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /voice/sessions requires auth', async ({ request }) => {
    const res = await request.get(`${API}/voice/sessions`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /voice/sessions returns an array', async ({ request }) => {
    const res = await request.get(`${API}/voice/sessions`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /voice/token returns either a token or "not configured"', async ({ request }) => {
    const res = await request.post(`${API}/voice/token`, { headers: auth() });
    // Route returns 200 in both configured and unconfigured branches.
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.token) {
      expect(typeof body.token).toBe('string');
      expect(body.identity).toMatch(/^user-/);
    } else {
      expect(body.error).toBe('Twilio not configured');
    }
  });

  test('POST /voice/call rejects missing "to"', async ({ request }) => {
    const res = await request.post(`${API}/voice/call`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /voice/end/:sessionId 404s for unknown session', async ({ request }) => {
    const res = await request.post(`${API}/voice/end/CA_does_not_exist_${Date.now()}`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  // ── Public webhooks ────────────────────────────────────────────────
  test('POST /voice/webhook/status without CallSid returns 400', async ({ request }) => {
    const res = await request.post(`${API}/voice/webhook/status`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /voice/webhook/status with unknown CallSid returns 200 + empty TwiML', async ({ request }) => {
    const res = await request.post(`${API}/voice/webhook/status`, {
      form: {
        CallSid: `CA_e2e_audit_${Date.now()}`,
        CallStatus: 'completed',
        CallDuration: '5',
      },
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('<Response');
  });

  test('POST /voice/webhook/twiml returns Dial TwiML', async ({ request }) => {
    const res = await request.post(`${API}/voice/webhook/twiml`, {
      form: { To: '+919900112233' },
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('<Dial');
    expect(text).toContain('+919900112233');
  });

  test('POST /voice/webhook/twiml escapes hostile chars in To', async ({ request }) => {
    const res = await request.post(`${API}/voice/webhook/twiml`, {
      form: { To: `+9199<script>alert("x")</script>` },
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('<script>');
  });
});
