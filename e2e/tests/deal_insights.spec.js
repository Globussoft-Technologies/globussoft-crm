// @ts-check
/**
 * Smoke spec for backend/routes/deal_insights.js (6 handlers).
 * Mounted at /api/deal-insights.
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. The /generate/:dealId endpoint may invoke Gemini — we only call it
 * once and tolerate AI failures (the heuristic engine still runs).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let seedDealId = null;

test.describe.configure({ mode: 'serial' });

test.describe('deal-insights routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();

    const dealsRes = await request.get(`${API}/deals?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (dealsRes.ok()) {
      const list = await dealsRes.json();
      const arr = Array.isArray(list) ? list : (list.data || list.deals || []);
      if (arr[0]) seedDealId = arr[0].id;
    }
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/deal-insights requires auth', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/deal-insights returns array of insights', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/deal-insights?severity=CRITICAL filters', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights?severity=CRITICAL`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const i of body) {
      expect(i.severity).toBe('CRITICAL');
    }
  });

  test('GET /api/deal-insights?isResolved=false filters', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights?isResolved=false`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const i of body) expect(i.isResolved).toBe(false);
  });

  test('GET /api/deal-insights/stats returns aggregates', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('byType');
    expect(body).toHaveProperty('bySeverity');
    expect(body).toHaveProperty('openCount');
    expect(body).toHaveProperty('resolvedCount');
    expect(Array.isArray(body.byType)).toBe(true);
    expect(Array.isArray(body.bySeverity)).toBe(true);
  });

  test('GET /api/deal-insights/deal/:dealId with invalid id returns 400', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights/deal/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/deal-insights/deal/9999999 returns 404', async ({ request }) => {
    const res = await request.get(`${API}/deal-insights/deal/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('GET /api/deal-insights/deal/:dealId returns insights for a real deal', async ({ request }) => {
    test.skip(!seedDealId, 'no seed deal available in tenant');
    const res = await request.get(`${API}/deal-insights/deal/${seedDealId}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  // The generate endpoint may invoke Gemini. We call it once against a real
  // deal and accept either 200 (heuristic-only or AI-augmented) or 500 if
  // Gemini upstream is having a bad day. We still assert the route exists.
  test('POST /api/deal-insights/generate/:dealId runs heuristic rules', async ({ request }) => {
    test.skip(!seedDealId, 'no seed deal available in tenant');
    const res = await request.post(`${API}/deal-insights/generate/${seedDealId}`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('generated');
    expect(body).toHaveProperty('insights');
    expect(body).toHaveProperty('evaluated');
    expect(Array.isArray(body.insights)).toBe(true);

    // Cleanup any insights we just generated to keep the dataset tidy.
    for (const ins of body.insights) {
      await request.delete(`${API}/deal-insights/${ins.id}`, { headers: auth() }).catch(() => {});
    }
  });

  test('POST /api/deal-insights/generate/abc returns 400', async ({ request }) => {
    const res = await request.post(`${API}/deal-insights/generate/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /api/deal-insights/9999999/resolve returns 404', async ({ request }) => {
    const res = await request.post(`${API}/deal-insights/9999999/resolve`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('DELETE /api/deal-insights/9999999 returns 404', async ({ request }) => {
    const res = await request.delete(`${API}/deal-insights/9999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('resolve + delete cycle on a fresh insight', async ({ request }) => {
    test.skip(!seedDealId, 'no seed deal available in tenant');
    // Generate insights to get a real id we can mutate.
    const gen = await request.post(`${API}/deal-insights/generate/${seedDealId}`, { headers: auth() });
    expect(gen.status()).toBe(200);
    const genBody = await gen.json();
    let insight = genBody.insights[0];
    if (!insight) {
      // No fresh insight created (dedup) — fall back to listing existing
      const list = await request.get(`${API}/deal-insights?dealId=${seedDealId}&isResolved=false`, { headers: auth() });
      const items = await list.json();
      insight = items[0];
    }
    test.skip(!insight, 'no insight available to resolve');

    const resolved = await request.post(`${API}/deal-insights/${insight.id}/resolve`, { headers: auth() });
    expect(resolved.status()).toBe(200);
    const resolvedBody = await resolved.json();
    expect(resolvedBody.isResolved).toBe(true);

    const del = await request.delete(`${API}/deal-insights/${insight.id}`, { headers: auth() });
    expect(del.status()).toBe(200);
  });
});
