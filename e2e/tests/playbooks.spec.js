// @ts-check
/**
 * Smoke tests for backend/routes/playbooks.js — generic CRM tenant.
 * Mounted at /api/playbooks.
 *
 * Endpoints covered:
 *   GET    /stats
 *   GET    /
 *   GET    /deal/:dealId
 *   POST   /deal/:dealId/step
 *   POST   /                       create
 *   GET    /:id
 *   PUT    /:id
 *   DELETE /:id
 *   POST   /:id/duplicate
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Playbooks API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    token = (await login.json()).token;
    expect(token).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${API}/playbooks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/playbooks returns array', async ({ request }) => {
    const res = await request.get(`${API}/playbooks`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/playbooks without auth is rejected', async ({ request }) => {
    const res = await request.get(`${API}/playbooks`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/playbooks/stats returns shape { total, active, stages }', async ({ request }) => {
    const res = await request.get(`${API}/playbooks/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(typeof body.active).toBe('number');
    expect(Array.isArray(body.stages)).toBe(true);
  });

  test('POST /api/playbooks without required fields returns 400', async ({ request }) => {
    const res = await request.post(`${API}/playbooks`, {
      headers: auth(),
      data: { stage: 'qualified' }, // missing name
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/playbooks creates + GET /:id + PUT /:id + duplicate + DELETE', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/playbooks`, {
      headers: auth(),
      data: {
        name: tag,
        stage: 'qualified',
        steps: [
          { title: 'Discovery call with Rohan Iyer', description: 'Understand pain points' },
          { title: 'Send proposal to Anjali Reddy', description: 'Quote turnaround' },
        ],
      },
    });
    expect(create.status()).toBe(201);
    const pb = await create.json();
    createdIds.push(pb.id);
    expect(pb.name).toBe(tag);
    expect(Array.isArray(pb.steps)).toBe(true);
    expect(pb.steps.length).toBe(2);

    // GET single
    const getOne = await request.get(`${API}/playbooks/${pb.id}`, { headers: auth() });
    expect(getOne.status()).toBe(200);
    expect((await getOne.json()).id).toBe(pb.id);

    // PUT
    const put = await request.put(`${API}/playbooks/${pb.id}`, {
      headers: auth(),
      data: { isActive: false },
    });
    expect(put.status()).toBe(200);
    expect((await put.json()).isActive).toBe(false);

    // Duplicate
    const dup = await request.post(`${API}/playbooks/${pb.id}/duplicate`, { headers: auth() });
    expect(dup.status()).toBe(201);
    const dupBody = await dup.json();
    expect(dupBody.id).not.toBe(pb.id);
    expect(dupBody.name).toContain('Copy');
    createdIds.push(dupBody.id);
  });

  test('GET /api/playbooks/:id 400 for non-numeric id', async ({ request }) => {
    const res = await request.get(`${API}/playbooks/not-a-number`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/playbooks/:id 404 for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/playbooks/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /api/playbooks/deal/:dealId 400 for non-numeric id', async ({ request }) => {
    const res = await request.get(`${API}/playbooks/deal/not-a-number`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /api/playbooks/deal/:dealId/step requires playbookId+stepIndex', async ({ request }) => {
    const res = await request.post(`${API}/playbooks/deal/1/step`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });
});
