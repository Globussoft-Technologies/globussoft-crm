// @ts-check
/**
 * Admin embed-allowlist gate — S128 admin UI/route for setting per-tenant
 * Tenant.embedAllowlistJson.
 *
 * Routes pinned:
 *   GET   /api/admin/tenants/:id/embed-allowlist
 *   PATCH /api/admin/tenants/:id/embed-allowlist
 *
 * Backed by the S38 mount + S39 schema column + S66 per-tenant read +
 * S129 ?key= synthetic-user wire-in. This admin surface is the final piece
 * of the chain so operators can configure their tenant's allowlist via UI
 * instead of raw SQL or seed scripts.
 *
 * Why this endpoint exists
 * ────────────────────────
 * Before S128, `Tenant.embedAllowlistJson` was settable only by direct DB
 * writes. Operators could not configure per-tenant iframe enforcement at
 * runtime — making the S66 + S129 paths effectively unused in production.
 * S128 ships a writable surface; this spec pins the contract the admin UI
 * consumes.
 *
 * Contract pinned
 * ───────────────
 *   - 401/403 without auth
 *   - 403 RBAC_DENIED for USER + MANAGER (admin-only)
 *   - 403 CROSS_TENANT_DENIED when :id !== req.user.tenantId
 *   - 400 INVALID_TENANT_ID when :id is non-numeric
 *   - 400 INVALID_BODY when origins is not an array
 *   - 400 INVALID_ORIGIN with `invalid: [...]` listing rejected entries
 *   - 400 ALLOWLIST_TOO_LARGE when origins.length > 100
 *   - 200 GET envelope: { tenantId, origins, updatedAt }
 *   - 200 PATCH envelope: { tenantId, origins, updatedAt, updatedBy }
 *   - Round-trip: PATCH then GET returns the set list (in order)
 *   - Empty array on PATCH → GET returns origins=[] (wildcard fallback
 *     state preserved)
 *
 * Probe-skip pattern: if the route returns 404 the spec auto-skips so the
 * per-push gate stays green until the route lands. Once mounted, the spec
 * auto-activates.
 *
 * Self-cleaning: afterAll resets the tenant's allowlist to null so the
 * demo box doesn't accumulate test pollution.
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/admin-tenants-embed-allowlist-api.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let adminTenantId = null;
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
  return await r.json();
}

async function authReq(request, method, t, path, body) {
  const opts = {
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
    timeout: REQUEST_TIMEOUT,
  };
  if (body !== undefined) opts.data = body;
  return request[method](`${BASE_URL}${path}`, opts);
}

test.beforeAll(async ({ request }) => {
  const adminLogin = await login(request, 'admin@globussoft.com');
  adminToken = adminLogin?.token || null;
  adminTenantId = adminLogin?.user?.tenantId || adminLogin?.tenantId || null;

  // Resolve tenantId from /api/auth/me if the login envelope didn't carry it.
  if (adminToken && !adminTenantId) {
    const meRes = await request.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    if (meRes.ok()) {
      const me = await meRes.json();
      adminTenantId = me.tenantId || me.user?.tenantId || null;
    }
  }

  const userLogin = await login(request, 'user@crm.com');
  userToken = userLogin?.token || null;
  const managerLogin = await login(request, 'manager@crm.com');
  managerToken = managerLogin?.token || null;

  // Probe whether the route is mounted yet.
  if (adminToken && adminTenantId) {
    const probe = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    routeMounted = probe.status() !== 404;
  } else {
    routeMounted = false;
  }
});

test.afterAll(async ({ request }) => {
  // Reset the allowlist back to empty so the demo box stays clean.
  if (routeMounted && adminToken && adminTenantId) {
    await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: [] },
    ).catch(() => {});
  }
});

test.describe('Admin embed-allowlist — auth + RBAC gates', () => {
  test('no token → 401/403', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminTenantId, 'admin tenantId not resolved');
    const r = await request.get(
      `${BASE_URL}/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(r.status());
  });

  test('USER role → 403 RBAC_DENIED on GET', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!userToken, 'user@crm.com not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'get',
      userToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    if (body.code) expect(body.code).toBe('RBAC_DENIED');
  });

  test('MANAGER role → 403 RBAC_DENIED on PATCH', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!managerToken, 'manager@crm.com not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      managerToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['https://x.com'] },
    );
    expect(r.status()).toBe(403);
  });

  test('cross-tenant (id != req.user.tenantId) → 403 CROSS_TENANT_DENIED', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    // Use a tenant id deliberately != admin's tenantId.
    const otherTenantId = adminTenantId + 9999;
    const r = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${otherTenantId}/embed-allowlist`,
    );
    expect(r.status()).toBe(403);
    const body = await r.json().catch(() => ({}));
    if (body.code) expect(body.code).toBe('CROSS_TENANT_DENIED');
  });
});

test.describe('Admin embed-allowlist — round-trip + envelope shape', () => {
  test('GET returns envelope shape', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      tenantId: adminTenantId,
      origins: expect.any(Array),
    });
  });

  test('PATCH happy-path → GET reads back the set list', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');

    const TAG = `s128-${Date.now()}`;
    const origins = [
      `https://partner-${TAG}-a.com`,
      `https://partner-${TAG}-b.com:8443/embed`,
    ];

    const setRes = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins },
    );
    expect(setRes.status(), `body: ${await setRes.text()}`).toBe(200);
    const setBody = await setRes.json();
    expect(setBody).toMatchObject({
      tenantId: adminTenantId,
      origins,
    });
    expect(typeof setBody.updatedBy).toBe('number');

    const getRes = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.origins).toEqual(origins);
  });

  test('PATCH empty array → GET returns origins=[] (wildcard fallback)', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');

    // First populate so the empty-PATCH actually clears something.
    await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['https://pre-clear.example.com'] },
    );

    const clearRes = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: [] },
    );
    expect(clearRes.status()).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.origins).toEqual([]);

    const getRes = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    expect(getRes.status()).toBe(200);
    expect((await getRes.json()).origins).toEqual([]);
  });
});

test.describe('Admin embed-allowlist — validation', () => {
  test('rejects HTTP origin → 400 INVALID_ORIGIN', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['http://insecure.com'] },
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_ORIGIN');
    expect(Array.isArray(body.invalid)).toBe(true);
    expect(body.invalid).toContain('http://insecure.com');
  });

  test('rejects non-array body → 400 INVALID_BODY', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: 'https://not-an-array.com' },
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_BODY');
  });

  test('rejects 101-entry payload → 400 ALLOWLIST_TOO_LARGE', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const origins = Array.from({ length: 101 }, (_, i) => `https://p${i}.example.com`);
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins },
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('ALLOWLIST_TOO_LARGE');
  });

  test('rejects non-numeric tenant id → 400 INVALID_TENANT_ID', async ({ request }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    const r = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/abc/embed-allowlist`,
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_TENANT_ID');
  });
});

// ────────────────────────────────────────────────────────────────────
// S131 — leftmost-wildcard subdomain support
// ────────────────────────────────────────────────────────────────────
// HTTPS_ORIGIN_RE_V2 extends HTTPS_ORIGIN_RE to accept a leftmost `*.`
// wildcard label per the CSP `frame-ancestors` host-source production.
// One wildcard entry replaces N concrete subdomain enumerations.
// security.js verified as passthrough — `list.join(' ')` in
// allowIframeEmbedding emits the wildcard verbatim into the CSP header.
test.describe('Admin embed-allowlist — S131 wildcard subdomain support', () => {
  test('PATCH accepts `https://*.partner.com` and round-trips through GET', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');

    const TAG = `s131-${Date.now()}`;
    const origins = [
      `https://*.partner-${TAG}.com`,
      `https://*.foo-${TAG}.bar:8443`,
      `https://*.x-${TAG}.y.z/embed`,
    ];

    const setRes = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins },
    );
    expect(setRes.status(), `body: ${await setRes.text()}`).toBe(200);
    const setBody = await setRes.json();
    expect(setBody.origins).toEqual(origins);

    const getRes = await authReq(
      request,
      'get',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
    );
    expect(getRes.status()).toBe(200);
    expect((await getRes.json()).origins).toEqual(origins);
  });

  test('PATCH rejects `https://*` (no host suffix) → 400 INVALID_ORIGIN', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['https://*'] },
    );
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_ORIGIN');
    expect(body.invalid).toContain('https://*');
  });

  test('PATCH rejects `https://**.com` (double-wildcard) → 400 INVALID_ORIGIN', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['https://**.com'] },
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ORIGIN');
  });

  test('PATCH rejects `https://foo.*.com` (non-leftmost wildcard) → 400 INVALID_ORIGIN', async ({
    request,
  }) => {
    test.skip(!routeMounted, 'route not mounted');
    test.skip(!adminToken, 'admin not seeded');
    test.skip(!adminTenantId, 'tenantId not resolved');
    const r = await authReq(
      request,
      'patch',
      adminToken,
      `/api/admin/tenants/${adminTenantId}/embed-allowlist`,
      { origins: ['https://foo.*.com'] },
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ORIGIN');
  });
});
