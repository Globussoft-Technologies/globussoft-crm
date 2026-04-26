// @ts-check
/**
 * Smoke spec for backend/routes/document_views.js (6 handlers).
 * Mounted at /api/document-views.
 *
 *   Public (no auth):
 *     GET  /track/:trackingId            — record view, return loading HTML
 *     POST /track/:trackingId/duration   — record duration
 *
 *   Authenticated:
 *     POST /create                       — issue tracking link
 *     GET  /                             — list views (?documentType, ?documentId)
 *     GET  /document/:type/:id           — per-document summary
 *     GET  /stats                        — tenant-wide stats
 *
 * Hits BASE_URL (default https://crm.globusdemos.com) using the generic-tenant
 * admin. Tracking rows we create are not exposed via a delete endpoint —
 * they're orphaned tracking ids tied to fake document ids, so they self-decay.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';
let trackingId = '';

test.describe.configure({ mode: 'serial' });

test.describe('document-views routes', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), `admin login must succeed: ${await login.text()}`).toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('GET /api/document-views requires auth', async ({ request }) => {
    const res = await request.get(`${API}/document-views`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/document-views/create rejects bad documentType with 400', async ({ request }) => {
    const res = await request.post(`${API}/document-views/create`, {
      headers: auth(),
      data: { documentType: 'NotARealType', documentId: 1 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/documentType/i);
  });

  test('POST /api/document-views/create rejects missing documentId with 400', async ({ request }) => {
    const res = await request.post(`${API}/document-views/create`, {
      headers: auth(),
      data: { documentType: 'Quote' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/documentId/i);
  });

  test('POST /api/document-views/create issues a tracking link', async ({ request }) => {
    const res = await request.post(`${API}/document-views/create`, {
      headers: auth(),
      data: {
        documentType: 'Quote',
        documentId: 1,
        viewerEmail: `priya.sharma+e2e+${Date.now()}@globussoft.com`,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.trackingId).toBeTruthy();
    expect(body.trackingUrl).toContain('/api/document-views/track/');
    trackingId = body.trackingId;
  });

  test('GET /api/document-views/track/:id is public and records a view', async ({ request }) => {
    test.skip(!trackingId, 'no trackingId from previous test');
    const res = await request.get(`${API}/document-views/track/${trackingId}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('Loading document');
    expect(res.headers()['content-type']).toMatch(/text\/html/);
  });

  test('GET /api/document-views/track/badid returns 404 HTML', async ({ request }) => {
    const res = await request.get(`${API}/document-views/track/this-id-does-not-exist`);
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('not found');
  });

  test('POST /api/document-views/track/:id/duration with bad payload returns 400', async ({ request }) => {
    test.skip(!trackingId, 'no trackingId from previous test');
    const res = await request.post(`${API}/document-views/track/${trackingId}/duration`, {
      data: { duration: -5 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/document-views/track/:id/duration with bad id returns 404', async ({ request }) => {
    const res = await request.post(`${API}/document-views/track/no-such-id/duration`, {
      data: { duration: 30 },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/document-views/track/:id/duration accumulates duration', async ({ request }) => {
    test.skip(!trackingId, 'no trackingId from previous test');
    const res = await request.post(`${API}/document-views/track/${trackingId}/duration`, {
      data: { duration: 12 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.duration).toBeGreaterThanOrEqual(12);
  });

  test('GET /api/document-views returns array of views', async ({ request }) => {
    const res = await request.get(`${API}/document-views`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/document-views?documentType=Quote filters', async ({ request }) => {
    const res = await request.get(`${API}/document-views?documentType=Quote`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const v of body) expect(v.documentType).toBe('Quote');
  });

  test('GET /api/document-views/document/Quote/1 returns summary', async ({ request }) => {
    const res = await request.get(`${API}/document-views/document/Quote/1`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('views');
    expect(body.summary.documentType).toBe('Quote');
    expect(body.summary.documentId).toBe(1);
    expect(typeof body.summary.totalRecipients).toBe('number');
  });

  test('GET /api/document-views/document/BadType/1 returns 400', async ({ request }) => {
    const res = await request.get(`${API}/document-views/document/BadType/1`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/document-views/document/Quote/abc returns 400', async ({ request }) => {
    const res = await request.get(`${API}/document-views/document/Quote/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/document-views/stats returns tenant-wide stats', async ({ request }) => {
    const res = await request.get(`${API}/document-views/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('documentsTracked');
    expect(body).toHaveProperty('totalRecipients');
    expect(body).toHaveProperty('totalViews');
    expect(body).toHaveProperty('uniqueViewers');
    expect(body).toHaveProperty('avgViewDuration');
  });
});
