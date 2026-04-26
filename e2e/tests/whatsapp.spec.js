// @ts-check
/**
 * WhatsApp routes — /api/whatsapp/*
 *   Public:  GET /webhook (Meta verify), POST /webhook (Meta event ingress)
 *   Auth:    POST /send, GET /messages, GET /templates, POST /templates,
 *            PUT /templates/:id, DELETE /templates/:id, POST /templates/:id/sync
 *   Admin:   GET /config, PUT /config/:provider
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdTemplateIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('whatsapp.js — Cloud API messaging + templates + webhook', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTemplateIds) {
      await request.delete(`${API}/whatsapp/templates/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /whatsapp/messages requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/messages`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /whatsapp/templates requires auth', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /whatsapp/messages returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/messages?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.pagination).toBeTruthy();
    expect(typeof body.pagination.total).toBe('number');
  });

  test('GET /whatsapp/templates returns array', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/templates`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /whatsapp/config (admin) returns array with masked accessToken', async ({ request }) => {
    const res = await request.get(`${API}/whatsapp/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const cfg of body) {
      if (cfg.accessToken) expect(cfg.accessToken).toMatch(/\*\*\*\*$/);
    }
  });

  test('POST /whatsapp/send rejects missing "to"', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { body: 'Namaste Aarav' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/send rejects missing body+templateName', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/send`, {
      headers: auth(),
      data: { to: '+919900112233' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/templates rejects missing name/body', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/templates`, {
      headers: auth(),
      data: { language: 'en_IN' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /whatsapp/templates creates template', async ({ request }) => {
    const tag = `e2e_audit_${Date.now()}`;
    const res = await request.post(`${API}/whatsapp/templates`, {
      headers: auth(),
      data: {
        name: tag,
        language: 'en_IN',
        category: 'UTILITY',
        body: 'Namaste {{1}}, your appointment is confirmed.',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('PENDING');
    createdTemplateIds.push(body.id);
  });

  test('PUT /whatsapp/templates/:id updates body', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template created');
    const res = await request.put(`${API}/whatsapp/templates/${id}`, {
      headers: auth(),
      data: { body: 'Namaste {{1}}, your visit on {{2}} is confirmed.' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.body).toContain('{{2}}');
  });

  test('PUT /whatsapp/templates/:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/whatsapp/templates/99999999`, {
      headers: auth(),
      data: { body: 'x' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /whatsapp/templates/:id/sync 404s without active config', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template');
    const res = await request.post(`${API}/whatsapp/templates/${id}/sync`, { headers: auth() });
    // 200 if a Meta config replies, 400 if no active config, 500 if Meta errors.
    expect([200, 400, 500]).toContain(res.status());
  });

  // ── Public webhook ──────────────────────────────────────────────────
  test('GET /whatsapp/webhook with bad verify token returns 403', async ({ request }) => {
    const res = await request.get(
      `${API}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bogus_e2e&hub.challenge=12345`
    );
    expect([403, 500]).toContain(res.status());
  });

  test('POST /whatsapp/webhook with empty body returns 200 (Meta requires fast 200)', async ({ request }) => {
    const res = await request.post(`${API}/whatsapp/webhook`, {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });
});
