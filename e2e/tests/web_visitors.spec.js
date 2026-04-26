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

let adminToken = '';
const seededSessionIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('web_visitors.js — visitor tracking + identify + admin list', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    adminToken = (await login.json()).token;
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
      data: { url: '/' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /web-visitors/track creates a visitor (public, no auth)', async ({ request }) => {
    const sessionId = `E2E_AUDIT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await request.post(`${API}/web-visitors/track`, {
      data: {
        sessionId,
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
      data: { sessionId, url: '/contact' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.pageCount).toBeGreaterThanOrEqual(2);
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
