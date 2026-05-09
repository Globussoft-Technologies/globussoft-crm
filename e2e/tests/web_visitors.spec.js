// @ts-check
/**
 * Web visitors routes — /api/web-visitors/*
 *   Public:  POST /track (page-view ingest)
 *   Auth:    POST /identify, GET /stats, GET /, GET /:id
 *
 * Note: server.js openPaths only includes "/web-visitors/track" — /identify
 * runs under the global verifyToken guard.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';
// Wellness admin — used to discover wellness tenantId for cross-tenant
// body-routing assertions (#646).
const WELLNESS_EMAIL = 'admin@wellness.demo';
const WELLNESS_PASSWORD = 'password123';

let adminToken = '';
let genericTenantId = 0;
let wellnessTenantId = 0;
const seededSessionIds = [];
const seededWellnessSessionIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('web_visitors.js — visitor tracking + identify + admin list', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    genericTenantId = body.tenant && body.tenant.id;
    expect(genericTenantId, 'generic tenant id must resolve from login').toBeGreaterThan(0);

    const wLogin = await request.post(`${API}/auth/login`, {
      data: { email: WELLNESS_EMAIL, password: WELLNESS_PASSWORD },
    });
    if (wLogin.ok()) {
      const wBody = await wLogin.json();
      wellnessTenantId = wBody.tenant && wBody.tenant.id;
    }
  });

  // No DELETE endpoint exposed on this surface — visitors created here will
  // remain in the tenant's history. We tag sessionId with E2E_AUDIT for grep.

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /web-visitors requires auth', async ({ request }) => {
    const res = await request.get(`${API}/web-visitors`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /web-visitors/stats requires auth', async ({ request }) => {
    const res = await request.get(`${API}/web-visitors/stats`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /web-visitors returns array', async ({ request }) => {
    const res = await request.get(`${API}/web-visitors`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /web-visitors/stats returns counters', async ({ request }) => {
    const res = await request.get(`${API}/web-visitors/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.today).toBe('number');
    expect(typeof body.week).toBe('number');
    expect(typeof body.month).toBe('number');
    expect(typeof body.identified).toBe('number');
    expect(typeof body.total).toBe('number');
  });

  test('POST /web-visitors/track without sessionId returns 400 (public)', async ({ request }) => {
    const res = await request.post(`${API}/web-visitors/track`, {
      data: { url: '/', siteTenantId: genericTenantId },
    });
    expect(res.status()).toBe(400);
  });

  // #646: missing siteTenantId must 400 (no silent fallback to 1).
  test('POST /web-visitors/track without siteTenantId returns 400 (#646)', async ({ request }) => {
    const sessionId = `E2E_AUDIT_no_tenant_${Date.now()}`;
    const res = await request.post(`${API}/web-visitors/track`, {
      data: { sessionId, url: '/' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/siteTenantId/i);
  });

  // #646: posting the OLD `tenantId` field is silently stripped by
  // stripDangerous middleware → must STILL 400, proving the rename closed
  // the bug rather than letting the legacy field through.
  test('POST /web-visitors/track with legacy tenantId field returns 400 (#646)', async ({ request }) => {
    const sessionId = `E2E_AUDIT_legacy_${Date.now()}`;
    const res = await request.post(`${API}/web-visitors/track`, {
      data: { sessionId, url: '/', tenantId: genericTenantId }, // stripped server-side
    });
    expect(res.status()).toBe(400);
  });

  test('POST /web-visitors/track creates a visitor (public, no auth)', async ({ request }) => {
    const sessionId = `E2E_AUDIT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await request.post(`${API}/web-visitors/track`, {
      data: {
        sessionId,
        siteTenantId: genericTenantId, // #646: was tenantId — stripDangerous strips that
        url: '/pricing',
        userAgent: 'E2E-Audit/1.0',
        country: 'IN',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe(sessionId);
    expect(body.pageCount).toBe(1);
    seededSessionIds.push(sessionId);
  });

  test('POST /web-visitors/track is idempotent on the same sessionId (appends pages)', async ({ request }) => {
    const sessionId = seededSessionIds[0];
    test.skip(!sessionId, 'no seeded session');
    const res = await request.post(`${API}/web-visitors/track`, {
      data: { sessionId, siteTenantId: genericTenantId, url: '/contact' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.pageCount).toBeGreaterThanOrEqual(2);
  });

  // #646: cross-tenant body routing — POSTing siteTenantId=<wellness> must
  // route the visitor row to the wellness tenant, NOT generic and NOT the
  // route's old fallback of 1. Verified by listing visitors as wellness
  // admin and finding the seeded sessionId there.
  test('POST /web-visitors/track respects siteTenantId for cross-tenant routing (#646)', async ({ request }) => {
    test.skip(!wellnessTenantId || wellnessTenantId === genericTenantId,
      'wellness tenant unavailable or matches generic');
    const sessionId = `E2E_AUDIT_xtenant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await request.post(`${API}/web-visitors/track`, {
      data: {
        sessionId,
        siteTenantId: wellnessTenantId,
        url: '/wellness-landing',
        userAgent: 'E2E-Audit/1.0',
      },
    });
    expect(res.status()).toBe(200);
    seededWellnessSessionIds.push(sessionId);

    // Verify the visitor row landed on the wellness tenant by querying as
    // wellness admin. Generic admin's list MUST NOT contain the sessionId.
    const wLogin = await request.post(`${API}/auth/login`, {
      data: { email: WELLNESS_EMAIL, password: WELLNESS_PASSWORD },
    });
    expect(wLogin.ok()).toBeTruthy();
    const wToken = (await wLogin.json()).token;

    const wList = await request.get(`${API}/web-visitors?days=1`, {
      headers: { Authorization: `Bearer ${wToken}` },
    });
    expect(wList.status()).toBe(200);
    const wItems = await wList.json();
    const found = wItems.find((x) => x.sessionId === sessionId);
    expect(found, 'wellness admin must see the cross-tenant visitor').toBeTruthy();

    // Generic admin must NOT see the wellness-tenant visitor.
    const gList = await request.get(`${API}/web-visitors?days=1`, { headers: auth() });
    expect(gList.status()).toBe(200);
    const gItems = await gList.json();
    const leak = gItems.find((x) => x.sessionId === sessionId);
    expect(leak, 'generic admin must NOT see the wellness-tenant visitor (cross-tenant leak)').toBeUndefined();
  });

  test('GET /web-visitors/:id returns visitor detail with pages array', async ({ request }) => {
    const sessionId = seededSessionIds[0];
    test.skip(!sessionId, 'no seeded session');
    // Find visitor by listing then matching sessionId.
    const list = await request.get(`${API}/web-visitors?days=1`, { headers: auth() });
    const items = await list.json();
    const v = items.find((x) => x.sessionId === sessionId);
    test.skip(!v, 'visitor not in last-1-day list');
    const detail = await request.get(`${API}/web-visitors/${v.id}`, { headers: auth() });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.id).toBe(v.id);
    expect(Array.isArray(body.pages)).toBe(true);
    expect(body.pages.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /web-visitors/:id 404s for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/web-visitors/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /web-visitors/identify validates sessionId+email (auth-gated)', async ({ request }) => {
    const res = await request.post(`${API}/web-visitors/identify`, {
      headers: auth(),
      data: { sessionId: seededSessionIds[0] || 'x' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /web-visitors/identify 404s for unknown sessionId', async ({ request }) => {
    const res = await request.post(`${API}/web-visitors/identify`, {
      headers: auth(),
      data: { sessionId: `does_not_exist_${Date.now()}`, email: 'aarav@example.in' },
    });
    expect(res.status()).toBe(404);
  });
});
