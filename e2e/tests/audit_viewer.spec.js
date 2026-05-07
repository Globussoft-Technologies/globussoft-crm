// @ts-check
/**
 * Audit log viewer route smoke (`/api/audit-viewer`)
 *  - GET /            (paginated audit logs)
 *  - GET /stats       (30-day aggregate)
 *  - GET /entity/:entity/:id  (single-record trail)
 *  - GET /export.csv  (CSV blob)
 *
 * The whole router is gated by ADMIN-only (verifyToken + verifyRole(['ADMIN']))
 * per #621 — Manager + User receive 403 with the canonical RBAC_DENIED
 * envelope from #590/#591. We assert both the unauthenticated and the
 * MANAGER-denied paths alongside the happy-path shape pins.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';
const MANAGER_EMAIL = 'manager@crm.com';
const MANAGER_PASSWORD = 'password123';

let adminToken = '';
let managerToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Audit log viewer — /api/audit-viewer', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;

    const mgrLogin = await request.post(`${API}/auth/login`, {
      data: { email: MANAGER_EMAIL, password: MANAGER_PASSWORD },
    });
    expect(mgrLogin.ok(), 'manager login must succeed').toBeTruthy();
    const mgrBody = await mgrLogin.json();
    managerToken = mgrBody.token;
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });
  const mgrAuth = () => ({ Authorization: `Bearer ${managerToken}` });

  test('auth gate — GET / without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer`);
    expect([401, 403]).toContain(res.status());
  });

  // #621: MANAGER role MUST be denied. Pre-fix the route allowed
  // ['ADMIN', 'MANAGER']; tightened to ['ADMIN'] only so the role
  // contract is consistent with the sidebar adminOnly flag and the
  // RoleGuard redirect on /audit-log.
  test('auth gate — MANAGER token returns 403 with RBAC_DENIED code', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer`, { headers: mgrAuth() });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('RBAC_DENIED');
    expect(typeof body.error).toBe('string');
  });

  test('auth gate — MANAGER blocked from /stats', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/stats`, { headers: mgrAuth() });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('RBAC_DENIED');
  });

  test('auth gate — MANAGER blocked from /export.csv', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/export.csv`, { headers: mgrAuth() });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('RBAC_DENIED');
  });

  test('GET / returns paginated shape', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?page=1&limit=10`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(typeof body.pages).toBe('number');
  });

  test('GET / honours filter params (entity, action)', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?entity=Contact&action=CREATE&limit=5`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    for (const log of body.logs) {
      expect(log.entity).toBe('Contact');
      expect(log.action).toBe('CREATE');
    }
  });

  test('GET / clamps limit to 200', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?limit=999`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(200);
  });

  test('GET /stats returns 30-day aggregate shape', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(body.byAction).toBeTruthy();
    expect(typeof body.byAction.CREATE).toBe('number');
    expect(typeof body.byAction.UPDATE).toBe('number');
    expect(typeof body.byAction.DELETE).toBe('number');
    expect(Array.isArray(body.byEntity)).toBe(true);
    expect(Array.isArray(body.topUsers)).toBe(true);
  });

  test('GET /entity/:entity/:id with non-numeric id returns 400', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/entity/Contact/not-a-number`, {
      headers: auth(),
    });
    expect(res.status()).toBe(400);
  });

  test('GET /entity/:entity/:id returns trail shape (may be empty)', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/entity/Contact/1`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.entity).toBe('Contact');
    expect(body.entityId).toBe(1);
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test('GET /export.csv returns text/csv', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/export.csv?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/csv/);
    const text = await res.text();
    // #387 datetime callsite-sweep: header now includes TimestampLocal
    // (viewer-TZ rendered, with label) alongside the raw ISO Timestamp.
    expect(text).toMatch(/^ID,Timestamp,TimestampLocal,Action,Entity,EntityId,UserName,UserEmail,Details/);
  });

  // #387 — the GET / and /entity/:entity/:id responses must include a
  // viewer-TZ-rendered timestamp on every row + the resolved zone on the
  // envelope. AuditLog.jsx consumes these for forensic-clear display.
  test('GET / decorates rows with createdAtFormatted + envelope viewerTimezone', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer?page=1&limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.viewerTimezone).toBe('string');
    expect(body.viewerTimezone.length).toBeGreaterThan(0);
    if (body.logs.length === 0) return; // empty tenant — shape pin still satisfied
    for (const log of body.logs) {
      expect(typeof log.createdAt).toBe('string');
      expect(typeof log.createdAtFormatted).toBe('string');
      // wall-clock prefix + non-empty TZ label (cross-ICU shape pin).
      // helper outputs "YYYY-MM-DD HH:mm <label>" or '—' for null.
      expect(log.createdAtFormatted).toMatch(/^(?:—|\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+)$/);
      expect(log.viewerTimezone).toBe(body.viewerTimezone);
    }
  });

  test('GET /entity/:entity/:id decorates rows with createdAtFormatted', async ({ request }) => {
    const res = await request.get(`${API}/audit-viewer/entity/Contact/1`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.viewerTimezone).toBe('string');
    expect(Array.isArray(body.logs)).toBe(true);
    for (const log of body.logs) {
      expect(log.createdAtFormatted).toMatch(/^(?:—|\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+)$/);
    }
  });
});
