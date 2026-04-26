// @ts-check
/**
 * Surveys routes — /api/surveys/*
 *   Public:  GET  /respond/:token, POST /respond/:token
 *   Auth:    GET / (list), POST / (create), PUT /:id, DELETE /:id,
 *            POST /:id/send, GET /:id/responses, GET /:id/stats
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
const createdSurveyIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('surveys.js — public respond + admin CRUD', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdSurveyIds) {
      await request.delete(`${API}/surveys/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /surveys requires auth', async ({ request }) => {
    const res = await request.get(`${API}/surveys`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /surveys returns array with response counts', async ({ request }) => {
    const res = await request.get(`${API}/surveys`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /surveys validates name', async ({ request }) => {
    const res = await request.post(`${API}/surveys`, {
      headers: auth(),
      data: { question: 'How likely are you to recommend us?' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /surveys validates question', async ({ request }) => {
    const res = await request.post(`${API}/surveys`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_${Date.now()}` },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /surveys creates an NPS survey', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const res = await request.post(`${API}/surveys`, {
      headers: auth(),
      data: { name: tag, question: 'How likely to recommend Globussoft to Aarav?', type: 'NPS' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.type).toBe('NPS');
    expect(body.isActive).toBe(true);
    createdSurveyIds.push(body.id);
  });

  test('PUT /surveys/:id updates name and isActive', async ({ request }) => {
    const id = createdSurveyIds[0];
    test.skip(!id, 'no survey to update');
    const res = await request.put(`${API}/surveys/${id}`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_renamed_${Date.now()}`, isActive: false },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  test('GET /surveys/:id/responses returns array', async ({ request }) => {
    const id = createdSurveyIds[0];
    test.skip(!id, 'no survey');
    const res = await request.get(`${API}/surveys/${id}/responses`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /surveys/:id/stats returns count + distribution', async ({ request }) => {
    const id = createdSurveyIds[0];
    test.skip(!id, 'no survey');
    const res = await request.get(`${API}/surveys/${id}/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.distribution)).toBe(true);
    expect(body.distribution.length).toBe(11);
  });

  test('POST /surveys/:id/send rejects empty contactIds', async ({ request }) => {
    const id = createdSurveyIds[0];
    test.skip(!id, 'no survey');

    // Re-activate it first so the inactive guard doesn't fire instead.
    await request.put(`${API}/surveys/${id}`, {
      headers: auth(),
      data: { isActive: true },
    });

    const res = await request.post(`${API}/surveys/${id}/send`, {
      headers: auth(),
      data: { contactIds: [] },
    });
    expect(res.status()).toBe(400);
  });

  // Public token endpoints — invalid token paths
  test('GET /surveys/respond/:token (bogus) returns 404 — public endpoint', async ({ request }) => {
    const res = await request.get(`${API}/surveys/respond/bogusffffffffffffff`);
    expect(res.status()).toBe(404);
  });

  test('POST /surveys/respond/:token (bogus) returns 404 — public endpoint', async ({ request }) => {
    const res = await request.post(`${API}/surveys/respond/bogusffffffffffffff`, {
      data: { score: 9 },
    });
    expect(res.status()).toBe(404);
  });
});
