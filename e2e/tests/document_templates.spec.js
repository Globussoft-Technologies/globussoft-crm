// @ts-check
/**
 * Smoke spec for backend/routes/document_templates.js (8 handlers).
 * Mounted at /api/document-templates.
 *
 *   GET    /            — list (?type= filter)
 *   POST   /            — create
 *   GET    /:id         — read
 *   PUT    /:id         — update
 *   DELETE /:id         — delete
 *   POST   /:id/render        — substitute {{vars}} → HTML
 *   POST   /:id/render-pdf    — printable HTML payload
 *   POST   /:id/send-email    — render + Mailgun (we test validation only)
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
const createdTemplateIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('document-templates routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTemplateIds) {
      await request
        .delete(`${API}/document-templates/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } })
        .catch(() => {});
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/document-templates requires auth', async ({ request }) => {
    const res = await request.get(`${API}/document-templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/document-templates returns array', async ({ request }) => {
    const res = await request.get(`${API}/document-templates`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/document-templates?type=PROPOSAL filters', async ({ request }) => {
    const res = await request.get(`${API}/document-templates?type=PROPOSAL`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const t of body) expect(t.type).toBe('PROPOSAL');
  });

  test('POST /api/document-templates rejects missing name with 400', async ({ request }) => {
    const res = await request.post(`${API}/document-templates`, {
      headers: auth(),
      data: { content: 'Hello {{contact.name}}' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/document-templates rejects missing content with 400', async ({ request }) => {
    const res = await request.post(`${API}/document-templates`, {
      headers: auth(),
      data: { name: 'No content' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/document-templates creates a proposal template', async ({ request }) => {
    const res = await request.post(`${API}/document-templates`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT_${Date.now()}_priya_proposal`,
        type: 'PROPOSAL',
        content:
          '<h1>Hello {{contact.name}}</h1><p>From {{user.name}} at {{tenant.name}}.</p>' +
          '<p>Deal value: {{deal.amount}} {{deal.currency}}.</p>',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toContain('E2E_AUDIT_');
    expect(body.type).toBe('PROPOSAL');
    createdTemplateIds.push(body.id);
  });

  test('GET /api/document-templates/:id returns the template', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.get(`${API}/document-templates/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  test('GET /api/document-templates/9999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/document-templates/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('PUT /api/document-templates/:id updates name', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.put(`${API}/document-templates/${id}`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_${Date.now()}_renamed_proposal` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toContain('renamed_proposal');
  });

  test('POST /api/document-templates/:id/render substitutes overrides', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.post(`${API}/document-templates/${id}/render`, {
      headers: auth(),
      data: {
        variables: {
          'contact.name': 'Priya Sharma',
          'user.name': 'Arjun Patel',
          'tenant.name': 'Globussoft',
          'deal.amount': '50000',
          'deal.currency': 'INR',
        },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.html).toContain('Priya Sharma');
    expect(body.html).toContain('Arjun Patel');
    expect(body.html).toContain('50000');
    expect(body.html).toContain('INR');
    expect(body.template.id).toBe(id);
  });

  test('POST /api/document-templates/:id/render-pdf returns printable HTML', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.post(`${API}/document-templates/${id}/render-pdf`, {
      headers: auth(),
      data: { variables: { 'contact.name': 'Sneha Iyer' } },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.html).toContain('<!doctype html>');
    expect(body.html).toContain('Sneha Iyer');
    expect(body.downloadable).toBe(true);
    expect(body.filename).toMatch(/\.html$/);
  });

  test('POST /api/document-templates/:id/send-email rejects missing subject with 400', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.post(`${API}/document-templates/${id}/send-email`, {
      headers: auth(),
      data: { to: 'priya@example.com' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/subject/i);
  });

  test('POST /api/document-templates/:id/send-email rejects missing recipient with 400', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.post(`${API}/document-templates/${id}/send-email`, {
      headers: auth(),
      data: { subject: 'hello' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/recipient|contactId|to/i);
  });

  test('POST /api/document-templates/9999999/render returns 404', async ({ request }) => {
    const res = await request.post(`${API}/document-templates/9999999/render`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /api/document-templates/:id removes the template', async ({ request }) => {
    const id = createdTemplateIds[0];
    test.skip(!id, 'no template from previous test');
    const res = await request.delete(`${API}/document-templates/${id}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    createdTemplateIds.length = 0;

    const after = await request.get(`${API}/document-templates/${id}`, { headers: auth() });
    expect(after.status()).toBe(404);
  });
});
