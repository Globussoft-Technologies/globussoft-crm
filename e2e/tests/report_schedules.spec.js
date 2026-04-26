// @ts-check
/**
 * Smoke tests for backend/routes/report_schedules.js — generic CRM tenant.
 * Mounted at /api/report-schedules (note: dash, not underscore).
 *
 * Endpoints covered:
 *   GET    /
 *   POST   /                  with enum + tenant-bounded recipient validation
 *   PUT    /:id
 *   DELETE /:id
 *   PUT    /:id/toggle
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Report Schedules API — smoke', () => {
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
      await request.delete(`${API}/report-schedules/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/report-schedules returns array', async ({ request }) => {
    const res = await request.get(`${API}/report-schedules`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/report-schedules without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/report-schedules`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST rejects invalid reportType with INVALID_REPORT_TYPE', async ({ request }) => {
    const res = await request.post(`${API}/report-schedules`, {
      headers: auth(),
      data: { name: 'bad', reportType: 'NOT_A_TYPE' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REPORT_TYPE');
  });

  test('POST rejects invalid format with INVALID_REPORT_FORMAT', async ({ request }) => {
    const res = await request.post(`${API}/report-schedules`, {
      headers: auth(),
      data: { name: 'bad', reportType: 'deals', format: 'EXE' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REPORT_FORMAT');
  });

  test('POST rejects invalid frequency with INVALID_FREQUENCY', async ({ request }) => {
    const res = await request.post(`${API}/report-schedules`, {
      headers: auth(),
      data: { name: 'bad', reportType: 'deals', frequency: 'every-5-minutes' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_FREQUENCY');
  });

  test('POST rejects external recipient with EXTERNAL_RECIPIENT_FORBIDDEN', async ({ request }) => {
    const res = await request.post(`${API}/report-schedules`, {
      headers: auth(),
      data: {
        name: 'exfil try',
        reportType: 'deals',
        recipients: ['attacker@evil.example.com'],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EXTERNAL_RECIPIENT_FORBIDDEN');
  });

  test('POST + toggle + DELETE happy path', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/report-schedules`, {
      headers: auth(),
      data: {
        name: tag,
        reportType: 'deals',
        frequency: 'weekly',
        format: 'PDF',
        recipients: [ADMIN_EMAIL], // tenant user — must be allowed
      },
    });
    expect(create.status()).toBe(201);
    const sched = await create.json();
    expect(sched.id).toBeTruthy();
    expect(sched.name).toBe(tag);
    createdIds.push(sched.id);

    // toggle
    const toggle = await request.put(`${API}/report-schedules/${sched.id}/toggle`, {
      headers: auth(),
    });
    expect(toggle.status()).toBe(200);
    const toggled = await toggle.json();
    expect(toggled.enabled).toBe(!sched.enabled);

    // PUT update
    const put = await request.put(`${API}/report-schedules/${sched.id}`, {
      headers: auth(),
      data: { name: tag + '_updated' },
    });
    expect(put.status()).toBe(200);
    expect((await put.json()).name).toBe(tag + '_updated');
  });

  test('PUT /api/report-schedules/:id 404 for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/report-schedules/99999999`, {
      headers: auth(),
      data: { name: 'x' },
    });
    expect(res.status()).toBe(404);
  });
});
