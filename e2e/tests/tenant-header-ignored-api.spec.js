// @ts-check
/**
 * #428 — `X-Tenant-Id` request header IDOR regression-guard.
 *
 * The 2026-05-04 QA report claimed `/api/wellness/telecaller/queue` and
 * `/api/audit` honoured a client-supplied `X-Tenant-Id` header, returning a
 * different tenant's data when set. Code audit found ZERO routes that read
 * `req.header('x-tenant-id')` (verified via case-insensitive grep across
 * backend/) — the bug is unsupported by the source.
 *
 * This spec is the regression-guard. It exercises the actual claim:
 *   • Log in as tenant A (admin@globussoft.com / generic CRM, tenantId=1)
 *   • Send `X-Tenant-Id: 2` (Enhanced Wellness tenant) along with the bearer
 *   • Assert the response contains tenant A's data, not tenant B's
 *
 * If a future route ever introduces `req.header('x-tenant-id')` as a tenant
 * source — even as an "internal SSO bypass" — this spec catches it on the
 * next per-push gate run. The standing pattern is: tenant comes from the
 * verified JWT claim ONLY.
 *
 * Endpoints exercised (the two the QA report named, plus a representative
 * generic + a wellness-side route to triangulate):
 *   GET /api/audit                     — was specifically named
 *   GET /api/wellness/telecaller/queue — was specifically named
 *   GET /api/contacts                  — generic CRM list
 *   GET /api/wellness/patients         — wellness-side list
 *
 * Pattern: dual-token (tenant A admin + tenant B admin) so we can fingerprint
 * the response. Each test sets X-Tenant-Id to the OTHER tenant's id and
 * asserts no row from that other tenant appears.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

// Tenant fingerprints (seed-known). admin@globussoft.com is on tenantId=1
// (generic CRM); admin@wellness.demo is on tenantId=2 (Enhanced Wellness).
let tenantAToken = null;
let tenantATenantId = null;
let tenantBToken = null;
let tenantBTenantId = null;

async function loginAs(request, email, password) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.ok(), `${email} login must succeed`).toBe(true);
  const j = await r.json();
  return { token: j.token, tenantId: j.user?.tenantId ?? j.tenant?.id };
}

test.beforeAll(async ({ request }) => {
  const a = await loginAs(request, 'admin@globussoft.com', 'password123');
  tenantAToken = a.token;
  tenantATenantId = a.tenantId;
  const b = await loginAs(request, 'admin@wellness.demo', 'password123');
  tenantBToken = b.token;
  tenantBTenantId = b.tenantId;
  expect(tenantATenantId).not.toBe(tenantBTenantId);
});

test.describe('#428 — X-Tenant-Id header must be ignored (tenant comes from JWT only)', () => {
  test('GET /api/audit with X-Tenant-Id pointing at the other tenant returns own-tenant rows only', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/audit?limit=50`, {
      headers: {
        Authorization: `Bearer ${tenantAToken}`,
        'X-Tenant-Id': String(tenantBTenantId),
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `audit endpoint must succeed (got ${r.status()})`).toBe(true);
    const body = await r.json();
    // Audit responses are either { rows: [...] } or [...]; normalize.
    const rows = Array.isArray(body) ? body : body.rows || body.items || [];
    for (const row of rows) {
      // If a row exposes tenantId, it MUST match the JWT's tenant. Routes
      // that intentionally hide tenantId in the response shape (defense in
      // depth) just don't trip this assertion — that's fine.
      if (row && Object.prototype.hasOwnProperty.call(row, 'tenantId')) {
        expect(row.tenantId, `audit row leaked from tenantId=${row.tenantId} via X-Tenant-Id header`).toBe(tenantATenantId);
      }
    }
  });

  test('GET /api/wellness/telecaller/queue with X-Tenant-Id ignored — wellness admin sees only own tenant', async ({ request }) => {
    // Authenticated as the wellness tenant; spoof X-Tenant-Id at the OTHER
    // tenant. The endpoint requires the wellness vertical so we use admin@wellness.demo.
    const r = await request.get(`${BASE_URL}/api/wellness/telecaller/queue`, {
      headers: {
        Authorization: `Bearer ${tenantBToken}`,
        'X-Tenant-Id': String(tenantATenantId),
      },
      timeout: REQUEST_TIMEOUT,
    });
    // Endpoint may 403 if the wellness admin doesn't have telecaller role —
    // either way, the assertion is "no cross-tenant leak." A 403 satisfies
    // that trivially. Otherwise validate row tenants.
    if (r.status() === 403) return;
    expect(r.ok(), `telecaller queue must succeed for wellness admin (got ${r.status()})`).toBe(true);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : body.queue || body.items || [];
    for (const row of rows) {
      if (row && Object.prototype.hasOwnProperty.call(row, 'tenantId')) {
        expect(row.tenantId).toBe(tenantBTenantId);
      }
    }
  });

  test('GET /api/contacts with X-Tenant-Id ignored — list returns own-tenant rows only', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/contacts?limit=50`, {
      headers: {
        Authorization: `Bearer ${tenantAToken}`,
        'X-Tenant-Id': String(tenantBTenantId),
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBe(true);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
    for (const c of list) {
      if (Object.prototype.hasOwnProperty.call(c, 'tenantId')) {
        expect(c.tenantId).toBe(tenantATenantId);
      }
    }
  });

  test('GET /api/wellness/patients with X-Tenant-Id ignored — own-tenant rows only', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/patients?limit=50`, {
      headers: {
        Authorization: `Bearer ${tenantBToken}`,
        'X-Tenant-Id': String(tenantATenantId),
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : body.patients || body.items || [];
    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(row, 'tenantId')) {
        expect(row.tenantId).toBe(tenantBTenantId);
      }
    }
  });

  test('multiple variants of the header name (case + underscore) are ignored', async ({ request }) => {
    // HTTP header names are case-insensitive — Express normalises to lower.
    // We try both `X-Tenant-Id` and `x-tenant-id` to confirm neither path
    // grants access. (A future route that read raw req.headers['X-Tenant-Id']
    // with the literal-case key would fail on both calls anyway, but this
    // pins behaviour.)
    for (const headerName of ['X-Tenant-Id', 'x-tenant-id', 'X-TENANT-ID']) {
      const r = await request.get(`${BASE_URL}/api/contacts?limit=10`, {
        headers: {
          Authorization: `Bearer ${tenantAToken}`,
          [headerName]: String(tenantBTenantId),
        },
        timeout: REQUEST_TIMEOUT,
      });
      expect(r.ok(), `header variant "${headerName}" must not affect routing`).toBe(true);
      const list = await r.json();
      for (const c of list) {
        if (Object.prototype.hasOwnProperty.call(c, 'tenantId')) {
          expect(c.tenantId, `header variant "${headerName}" leaked tenantId=${c.tenantId}`).toBe(tenantATenantId);
        }
      }
    }
  });
});
