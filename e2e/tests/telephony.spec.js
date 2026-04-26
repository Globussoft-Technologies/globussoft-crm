// @ts-check
/**
 * Telephony routes — /api/telephony/*
 *   Public:  POST /webhook/myoperator, /webhook/knowlarity (CDR webhooks)
 *   Auth:    POST /click-to-call, GET /recordings/:callLogId
 *   Admin:   GET /config, PUT /config/:provider
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const upsertedProviders = [];

test.describe.configure({ mode: 'serial' });

test.describe('telephony.js — click-to-call + provider webhooks + admin config', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
  });

  test.afterAll(async ({ request }) => {
    for (const provider of upsertedProviders) {
      await request.put(`${API}/telephony/config/${provider}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { isActive: false },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /telephony/config requires auth', async ({ request }) => {
    const res = await request.get(`${API}/telephony/config`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /telephony/config (admin) returns array with masked secrets', async ({ request }) => {
    const res = await request.get(`${API}/telephony/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const cfg of body) {
      if (cfg.apiSecret) expect(cfg.apiSecret).toBe('****');
      if (cfg.apiKey) expect(cfg.apiKey).toMatch(/\*\*\*\*$/);
    }
  });

  test('PUT /telephony/config/:provider rejects unsupported provider', async ({ request }) => {
    const res = await request.put(`${API}/telephony/config/exotel`, {
      headers: auth(),
      data: { apiKey: 'x' },
    });
    expect(res.status()).toBe(400);
  });

  test('PUT /telephony/config/myoperator upserts (inactive)', async ({ request }) => {
    const res = await request.put(`${API}/telephony/config/myoperator`, {
      headers: auth(),
      data: {
        apiKey: 'E2E_AUDIT_apikey',
        apiSecret: 'E2E_AUDIT_secret',
        virtualNumber: '+911234567890',
        agentNumber: '+919900112233',
        isActive: false,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('myoperator');
    upsertedProviders.push('myoperator');
  });

  test('POST /telephony/click-to-call rejects missing "to"', async ({ request }) => {
    const res = await request.post(`${API}/telephony/click-to-call`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /telephony/click-to-call returns 400 when no active provider', async ({ request }) => {
    // We left config inactive in upsert above; so this should be "no active provider"
    const res = await request.post(`${API}/telephony/click-to-call`, {
      headers: auth(),
      data: { to: '+919900445566' },
    });
    expect([400, 502]).toContain(res.status());
  });

  test('POST /telephony/webhook/myoperator accepts a CDR payload (public)', async ({ request }) => {
    const res = await request.post(`${API}/telephony/webhook/myoperator`, {
      data: {
        caller_number: '+919900112233',
        callee_number: '+919900445566',
        duration: 42,
        status: 'completed',
        call_id: `e2e-audit-${Date.now()}`,
        direction: 'outbound',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('POST /telephony/webhook/knowlarity accepts a CDR payload (public)', async ({ request }) => {
    const res = await request.post(`${API}/telephony/webhook/knowlarity`, {
      data: {
        caller_id: '+919900112233',
        destination: '+919900445566',
        call_duration: 33,
        call_status: 'completed',
        call_id: `e2e-audit-knw-${Date.now()}`,
        direction: 'outbound',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /telephony/recordings/:id 404s for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/telephony/recordings/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
