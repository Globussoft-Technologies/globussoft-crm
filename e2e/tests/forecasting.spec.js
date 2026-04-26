// @ts-check
/**
 * /api/forecasting — smoke spec covering 5 handlers in
 * backend/routes/forecasting.js. Read-only for the 4 GETs; one POST snapshot.
 *
 *   GET    /current?period=
 *   GET    /pipeline?period=
 *   GET    /trend?months=
 *   POST   /save
 *   GET    /history
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('forecasting API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test('GET /current requires auth', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/current`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /current returns { period, byUser, total }', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/current?period=2026-Q2`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('byUser');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.byUser)).toBe(true);
    expect(body.total).toHaveProperty('expected');
    expect(body.total).toHaveProperty('committed');
    expect(body.total).toHaveProperty('bestCase');
    expect(body.total).toHaveProperty('closed');
  });

  test('GET /current with no period falls back to current quarter', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/current`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.period).toMatch(/^\d{4}-Q[1-4]$/);
  });

  test('GET /current accepts year period', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/current?period=2026`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.period).toBe('2026');
  });

  test('GET /pipeline returns { period, stages }', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/pipeline?period=2026-Q2`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stages');
    expect(Array.isArray(body.stages)).toBe(true);
  });

  test('GET /trend returns { months, trend }', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/trend?months=6`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.months).toBe(6);
    expect(Array.isArray(body.trend)).toBe(true);
    expect(body.trend.length).toBe(6);
    expect(body.trend[0]).toHaveProperty('month');
    expect(body.trend[0]).toHaveProperty('closed');
  });

  test('GET /trend clamps invalid months to safe default', async ({ request }) => {
    const res = await request.get(`${API}/forecasting/trend?months=999`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.months).toBeLessThanOrEqual(60);
  });

  test('POST /save rejects missing period with 400', async ({ request }) => {
    const res = await request.post(`${API}/forecasting/save`, { headers: auth(), data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /save creates a snapshot and GET /history surfaces it', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/forecasting/save`, {
      headers: auth(),
      data: {
        period: tag,
        expectedRevenue: 12345.67,
        committedRevenue: 1000,
        bestCaseRevenue: 20000,
        closedRevenue: 500,
      },
    });
    expect(create.status()).toBe(201);
    const snap = await create.json();
    expect(snap.id).toBeTruthy();
    expect(snap.period).toBe(tag);

    const list = await request.get(`${API}/forecasting/history`, { headers: auth() });
    expect(list.status()).toBe(200);
    const history = await list.json();
    expect(Array.isArray(history)).toBe(true);
    const found = history.find((h) => h.id === snap.id);
    expect(found).toBeTruthy();
    expect(found.period).toBe(tag);
  });
});
