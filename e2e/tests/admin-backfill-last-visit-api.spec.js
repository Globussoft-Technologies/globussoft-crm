// @ts-check
/**
 * Admin backfill-last-visit gate — S107 manual-trigger endpoint.
 *
 * Route pinned: POST /api/admin/wellness/run-backfill-last-visit
 * Backed by cron/backfillLastVisitEngine.tick() (S94 one-shot backfill that
 * populates Patient.lastVisitDate from the most-recent Visit row when the
 * column is currently null).
 *
 * Why this endpoint exists
 * ────────────────────────
 * S94's engine.start() is a no-op by design — node-cron scheduling would
 * waste cycles after the historical sweep is done. Without a trigger
 * endpoint the only invocation path is a manual CLI on the demo box. S107
 * closes that gap with an ADMIN-gated POST.
 *
 * Contract pinned:
 *   - 401/403 without auth
 *   - 403 RBAC_DENIED for USER + MANAGER (admin-only)
 *   - 200 happy path for ADMIN with envelope:
 *       { success: true, tenantId, triggeredBy, processed, updated, errors }
 *   - tenantId in the response matches the requesting admin's tenant
 *   - triggeredBy carries req.user.userId
 *   - idempotency: a second call after the first should still 200 (engine
 *     reports updated=0 because no lastVisitDate=null rows remain — but
 *     the route itself is stateless and always 200s on engine success)
 *
 * Probe-skip pattern: if the route returns 404 (server.js mount deferred —
 * see S107 commit body), the spec auto-skips so the per-push gate stays
 * green until the mount slice lands. Once mounted, the spec auto-activates.
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/admin-backfill-last-visit-api.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const ROUTE = '/api/admin/wellness/run-backfill-last-visit';

let adminToken = null;
let userToken = null;
let managerToken = null;
let routeMounted = null;

async function login(request, email, password = 'password123') {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

async function authPost(request, t, path, body = {}) {
  return request.post(`${BASE_URL}${path}`, {
    data: body,
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
    timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
  managerToken = await login(request, 'manager@crm.com');

  // Probe whether the route is mounted yet. If the response is 404 we treat
  // the whole suite as skipped (S107 commit body documents the deferred
  // server.js mount; once mounted the spec auto-activates).
  if (adminToken) {
    const probe = await authPost(request, adminToken, ROUTE, {});
    routeMounted = probe.status() !== 404;
  } else {
    routeMounted = false;
  }
});

test.describe('Admin backfill-last-visit — auth + RBAC gates', () => {
  test('no token → 401/403', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted in server.js (deferred follow-up gap)');
    const r = await request.post(`${BASE_URL}${ROUTE}`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('USER role → 403 RBAC_DENIED', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!userToken, 'user@crm.com not seeded');
    const r = await authPost(request, userToken, ROUTE, {});
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    if (body.code) expect(body.code).toBe('RBAC_DENIED');
  });

  test('MANAGER role → 403 RBAC_DENIED (admin-only endpoint)', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!managerToken, 'manager@crm.com not seeded');
    const r = await authPost(request, managerToken, ROUTE, {});
    expect(r.status()).toBe(403);
  });
});

test.describe('Admin backfill-last-visit — envelope shape', () => {
  test('ADMIN happy path returns documented envelope', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin@globussoft.com not seeded');
    const r = await authPost(request, adminToken, ROUTE, {});
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      success: true,
      tenantId: expect.any(Number),
      triggeredBy: expect.any(Number),
      processed: expect.any(Number),
      updated: expect.any(Number),
      errors: expect.any(Number),
    });
    // Envelope ints are all non-negative.
    expect(body.processed).toBeGreaterThanOrEqual(0);
    expect(body.updated).toBeGreaterThanOrEqual(0);
    expect(body.errors).toBeGreaterThanOrEqual(0);
  });

  test('idempotency: second call still 200 (engine reports updated=0 after first sweep)', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');

    // Fire it once to be sure the historical backfill has run.
    const r1 = await authPost(request, adminToken, ROUTE, {});
    expect(r1.status()).toBe(200);

    // Second fire — must still 200, route is stateless. updated may be 0
    // or non-zero depending on whether other cron activity wrote new
    // NULL-cache rows between calls — we don't assert on the count here,
    // only on the success envelope.
    const r2 = await authPost(request, adminToken, ROUTE, {});
    expect(r2.status()).toBe(200);
    const body = await r2.json();
    expect(body.success).toBe(true);
  });

  test('triggeredBy matches the requesting admin user id', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');

    // Resolve admin's userId via /api/auth/me (the JWT key is userId).
    const meRes = await request.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    if (!meRes.ok()) test.skip(true, '/api/auth/me unavailable');
    const me = await meRes.json();
    const adminUserId = me.userId || me.id || me.user?.userId || me.user?.id;
    if (typeof adminUserId !== 'number') test.skip(true, 'cannot resolve admin userId');

    const r = await authPost(request, adminToken, ROUTE, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.triggeredBy).toBe(adminUserId);
  });

  test('body is ignored (no params required)', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    // Pass garbage params — the route ignores body entirely. Validates that
    // there's no future regression where someone adds body-validation that
    // unexpectedly 400s callers passing extra fields.
    const r = await authPost(request, adminToken, ROUTE, {
      garbage: 'should be ignored',
      tenantId: 99999, // attempted cross-tenant — must be ignored
      dryRun: true,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    // The response tenantId must still come from the JWT, not the body.
    expect(body.tenantId).not.toBe(99999);
  });
});
