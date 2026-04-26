// @ts-check
/**
 * /api/industry-templates — smoke spec covering 4 handlers in
 * backend/routes/industry_templates.js.
 *
 *   GET    /
 *   POST   /apply/:industry
 *   POST   /                       (ADMIN)
 *   DELETE /:id                    (ADMIN)
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const createdTemplateIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('industry-templates API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTemplateIds) {
      await request.delete(`${API}/industry-templates/${id}`, { headers: auth() });
    }
  });

  test('GET / requires auth', async ({ request }) => {
    const res = await request.get(`${API}/industry-templates`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns built-in + DB templates', async ({ request }) => {
    const res = await request.get(`${API}/industry-templates`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('industry');
    expect(body[0]).toHaveProperty('name');
    expect(body[0]).toHaveProperty('config');

    const industries = body.map((t) => t.industry);
    expect(industries).toContain('saas');
  });

  test('POST /apply/:industry 404s for unknown industry', async ({ request }) => {
    const res = await request.post(`${API}/industry-templates/apply/this-industry-doesnt-exist`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('POST /apply/:industry succeeds for built-in saas (idempotent)', async ({ request }) => {
    const res = await request.post(`${API}/industry-templates/apply/saas`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.industry).toBe('saas');
    expect(body).toHaveProperty('created');
    expect(body.created).toHaveProperty('pipelines');
    expect(body.created).toHaveProperty('stages');
  });

  test('POST / rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/industry-templates`, {
      headers: auth(),
      data: { industry: 'just-industry' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST / + DELETE /:id round-trip for custom template', async ({ request }) => {
    const stamp = Date.now();
    const industry = `e2e-audit-${stamp}`;
    const create = await request.post(`${API}/industry-templates`, {
      headers: auth(),
      data: {
        industry,
        name: `E2E_AUDIT_${stamp}`,
        description: 'Created by e2e smoke spec',
        config: { pipelines: [], customFields: [], sampleContacts: [] },
      },
    });
    expect(create.status()).toBe(201);
    const tpl = await create.json();
    expect(tpl.id).toBeTruthy();
    createdTemplateIds.push(tpl.id);

    const del = await request.delete(`${API}/industry-templates/${tpl.id}`, { headers: auth() });
    expect(del.status()).toBe(200);
    createdTemplateIds.splice(createdTemplateIds.indexOf(tpl.id), 1);
  });

  test('DELETE /:id 400s for invalid id', async ({ request }) => {
    const res = await request.delete(`${API}/industry-templates/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('DELETE /:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/industry-templates/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
