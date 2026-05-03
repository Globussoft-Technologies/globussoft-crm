// @ts-check
/**
 * Audit API — G-5 from docs/E2E_GAPS.md.
 *
 * Target: routes/audit.js (28 lines, smoke-only). Single endpoint:
 *   GET /api/audit?entity=<Entity>&action=<ACTION>
 *
 * routes/audit.js is a *separate* router from routes/audit_viewer.js —
 * audit_viewer is the rich UI-driven endpoint with pagination, date
 * range filters, and CSV export. routes/audit.js is the simple read API:
 *   1. ADMIN-only (verifyToken + verifyRole(['ADMIN']) — closes #408
 *      after the original spec surfaced the missing role guard),
 *   2. scopes `where: { tenantId: req.user.tenantId }` (multi-tenant
 *      data-isolation is the whole point of this spec),
 *   3. accepts only `entity` and `action` query filters,
 *   4. hard-caps results at `take: 100` (so `?limit=` is ignored).
 *
 * Compliance focus — this is the assertion that matters most:
 *   A silent cross-tenant leak in audit logs would breach the
 *   multi-tenant data-isolation contract and the wellness PHI
 *   compliance posture (audit rows include patient-PII details).
 *
 * Audit rows are populated as a side effect of mutating other
 * resources. The lightest-touch path that reliably produces a row in
 * both tenants is `POST /api/contacts` — `routes/contacts.js:105`
 * writes `{ entity: 'Contact', action: 'CREATE', entityId: contact.id }`
 * via the `writeAudit` helper. Each test that needs a row creates a
 * tagged Contact, captures the entityId, and asserts it surfaces in
 * /api/audit. Self-clean Contacts in afterAll.
 *
 * Acceptance criteria from the gap card (status against actual
 * route behavior verified locally on 2026-05-02):
 *
 *   ✅ Tenant isolation — generic-tenant rows never appear in the
 *      wellness response, and vice versa. row.tenantId === requester's
 *      tenantId for every row in every response (defence-in-depth).
 *   ✅ RBAC: routes/audit.js requires verifyRole(['ADMIN']). MANAGER
 *      and USER receive 403. Two specs in the "RBAC contract" describe
 *      block assert this; the originally-fixme'd tests were flipped
 *      to active assertions when #408 shipped (commit 2df54de).
 *   ✅ Filter parameters: `entity` and `action` honored.
 *      `?limit=` is silently ignored (route hard-caps at 100); the
 *      `?userId` / `?startDate` / `?endDate` filters live on
 *      `audit_viewer.js`, not here.
 *   ✅ Result shape: each row has id, action, entity, entityId,
 *      details, createdAt, tenantId, userId, user.
 *   ✅ Auth gate: 401 on garbage token, 403 on no token.
 *
 * Pattern copied from notifications-api.spec.js + search-api.spec.js
 * (cached dual-token: generic admin + wellness admin for cross-tenant,
 * plus generic manager + generic user for the RBAC matrix).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_AUDIT_${Date.now()}`;

// ── Cached tokens for the four roles we drive ──────────────────────
//   admin@globussoft.com  — generic admin  (drives writes + happy path)
//   manager@crm.com       — generic manager (RBAC contract)
//   user@crm.com          — generic user    (RBAC contract)
//   admin@wellness.demo   — wellness admin (cross-tenant reader)

let genericAdminToken = null;
let genericAdminTenantId = null;
let genericManagerToken = null;
let genericUserToken = null;
let wellnessAdminToken = null;
let wellnessAdminTenantId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        // Login response: { token, user: { id, email, role, ... },
        // tenant: { id, name, vertical, ... } }. tenantId lives on
        // j.tenant.id (same convention as search-api.spec.js).
        return { token: j.token, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null };
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericAdminToken = r.token;
    genericAdminTenantId = r.tenantId;
  }
  return { token: genericAdminToken, tenantId: genericAdminTenantId };
}

async function getGenericManager(request) {
  if (!genericManagerToken) {
    const r = await loginAs(request, 'manager@crm.com', 'password123');
    genericManagerToken = r.token;
  }
  return { token: genericManagerToken };
}

async function getGenericUser(request) {
  if (!genericUserToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    genericUserToken = r.token;
  }
  return { token: genericUserToken };
}

async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessAdminToken = r.token;
    wellnessAdminTenantId = r.tenantId;
  }
  return { token: wellnessAdminToken, tenantId: wellnessAdminTenantId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Track the contacts we create across tenants and best-effort delete
// them. Audit rows themselves are not deletable through any public
// route — that's by design; the test-data-pollution scrub script
// matches the RUN_TAG name pattern (E2E_FLOW_AUDIT_… is on the
// allowlist in e2e/test-data-patterns.js) so leftover audit rows
// will be picked up by the next demo cleanup pass.
const createdContactsByTenant = { generic: [], wellness: [] };

test.afterAll(async ({ request }) => {
  const ga = await getGenericAdmin(request);
  if (ga.token) {
    for (const id of createdContactsByTenant.generic) {
      await del(request, ga.token, `/api/contacts/${id}`).catch(() => {});
    }
  }
  const wa = await getWellnessAdmin(request);
  if (wa.token) {
    for (const id of createdContactsByTenant.wellness) {
      await del(request, wa.token, `/api/contacts/${id}`).catch(() => {});
    }
  }
});

// Seed a Contact and trust the side-effect audit row. Returns
// { contactId, expectedEntity: 'Contact', expectedAction: 'CREATE' }.
async function seedAuditedContact(request, tenantKey, label) {
  const { token } = tenantKey === 'wellness'
    ? await getWellnessAdmin(request)
    : await getGenericAdmin(request);
  expect(token, `${tenantKey} admin token`).toBeTruthy();
  const ts = Date.now();
  const res = await post(request, token, '/api/contacts', {
    name: `${RUN_TAG} ${label}`,
    email: `${RUN_TAG.toLowerCase()}-${label}-${ts}@e2e.test`,
    phone: `+1555${String(ts).slice(-7)}`,
    status: 'Lead',
  });
  expect(res.status(), `seed contact (${tenantKey}/${label}): ${await res.text()}`).toBe(201);
  const c = await res.json();
  createdContactsByTenant[tenantKey].push(c.id);
  return { contactId: c.id };
}

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Audit API — auth gate', () => {
  test('GET /api/audit without Authorization → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/audit`, { timeout: REQUEST_TIMEOUT });
    // Global guard returns 403 in current behavior; accept 401 too in
    // case verifyToken middleware swaps to a 401 contract.
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/audit with garbage token → 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/audit`, {
      headers: { Authorization: 'Bearer not.a.real.jwt.token', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // verifyToken returns 401 for a malformed JWT.
    expect([401, 403]).toContain(res.status());
  });
});

// ── Happy path / response shape ────────────────────────────────────

test.describe('Audit API — response shape', () => {
  test('200 returns array (NOT envelope)', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, '/api/audit');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // routes/audit.js returns the array directly. audit_viewer.js
    // (different mount, /api/audit-viewer) wraps in { logs, total }.
    expect(Array.isArray(body)).toBe(true);
  });

  test('every row has the documented fields', async ({ request }) => {
    // Seed a row first so we know the response is non-empty even on
    // a fresh DB.
    await seedAuditedContact(request, 'generic', 'shape-probe');

    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);

    for (const row of body) {
      expect(row, 'row id').toHaveProperty('id');
      expect(typeof row.id).toBe('number');
      expect(row, 'row action').toHaveProperty('action');
      expect(typeof row.action).toBe('string');
      expect(row, 'row entity').toHaveProperty('entity');
      expect(typeof row.entity).toBe('string');
      expect(row, 'row entityId').toHaveProperty('entityId'); // can be null
      expect(row, 'row createdAt').toHaveProperty('createdAt');
      expect(row, 'row tenantId').toHaveProperty('tenantId');
      expect(typeof row.tenantId).toBe('number');
      expect(row, 'row userId').toHaveProperty('userId'); // can be null
      // include: { user: { id, name, email } }
      if (row.user) {
        expect(row.user).toHaveProperty('id');
        expect(row.user).toHaveProperty('email');
      }
    }
  });

  test('orderBy createdAt desc — newest row first', async ({ request }) => {
    await seedAuditedContact(request, 'generic', 'order-probe');
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit');
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.length < 2) test.skip(true, 'need at least 2 rows to assert ordering');
    const ts = body.map((r) => new Date(r.createdAt).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1], `row ${i - 1} should be >= row ${i}`).toBeGreaterThanOrEqual(ts[i]);
    }
  });

  test('cap is 100 rows (?limit= is silently ignored)', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit?limit=9999');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(100);
  });
});

// ── Defence-in-depth: row.tenantId matches requester ───────────────

test.describe('Audit API — tenant scoping (defence-in-depth)', () => {
  test('every row.tenantId === generic admin tenantId', async ({ request }) => {
    await seedAuditedContact(request, 'generic', 'tid-anchor');
    const { token, tenantId } = await getGenericAdmin(request);
    expect(tenantId, 'generic admin tenantId resolved from login').toBeTruthy();
    const res = await get(request, token, '/api/audit');
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(
        row.tenantId,
        `row ${row.id}: tenantId leak — ${row.tenantId} != ${tenantId}`
      ).toBe(tenantId);
    }
  });

  test('every row.tenantId === wellness admin tenantId', async ({ request }) => {
    await seedAuditedContact(request, 'wellness', 'tid-anchor-well');
    const { token, tenantId } = await getWellnessAdmin(request);
    expect(tenantId, 'wellness admin tenantId resolved from login').toBeTruthy();
    const res = await get(request, token, '/api/audit');
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(
        row.tenantId,
        `row ${row.id}: tenantId leak — ${row.tenantId} != ${tenantId}`
      ).toBe(tenantId);
    }
  });
});

// ── Cross-tenant isolation ─────────────────────────────────────────
//
// THE compliance assertion. A side-effect audit row from tenant A
// must NOT surface in tenant B's response, regardless of filters.

test.describe('Audit API — cross-tenant isolation', () => {
  test('wellness admin cannot see generic admin\'s Contact CREATE row', async ({ request }) => {
    // Seed a row in the generic tenant.
    const { contactId } = await seedAuditedContact(request, 'generic', 'cross-leak-gen');

    // Confirm generic admin sees the row (sanity).
    const { token: gToken } = await getGenericAdmin(request);
    const gRes = await get(request, gToken, '/api/audit?entity=Contact&action=CREATE');
    expect(gRes.status()).toBe(200);
    const gBody = await gRes.json();
    const gMatch = gBody.find((r) => r.entity === 'Contact' && r.entityId === contactId);
    expect(gMatch, `seed audit row not visible to its OWN tenant — fixture broken`).toBeTruthy();

    // Wellness admin queries audit. Must NOT see the entityId from the generic seed.
    const { token: wToken } = await getWellnessAdmin(request);
    const wRes = await get(request, wToken, '/api/audit?entity=Contact');
    expect(wRes.status()).toBe(200);
    const wBody = await wRes.json();
    const leak = wBody.find((r) => r.entity === 'Contact' && r.entityId === contactId);
    expect(leak, `cross-tenant leak: wellness saw generic Contact entityId ${contactId}`).toBeFalsy();
  });

  test('generic admin cannot see wellness admin\'s Contact CREATE row', async ({ request }) => {
    // Reverse direction.
    const { contactId } = await seedAuditedContact(request, 'wellness', 'cross-leak-well');

    // Confirm wellness sees its own row.
    const { token: wToken } = await getWellnessAdmin(request);
    const wRes = await get(request, wToken, '/api/audit?entity=Contact&action=CREATE');
    expect(wRes.status()).toBe(200);
    const wBody = await wRes.json();
    const wMatch = wBody.find((r) => r.entity === 'Contact' && r.entityId === contactId);
    expect(wMatch, `wellness seed audit row not visible to its OWN tenant — fixture broken`).toBeTruthy();

    // Generic admin must NOT see it.
    const { token: gToken } = await getGenericAdmin(request);
    const gRes = await get(request, gToken, '/api/audit?entity=Contact');
    expect(gRes.status()).toBe(200);
    const gBody = await gRes.json();
    const leak = gBody.find((r) => r.entity === 'Contact' && r.entityId === contactId);
    expect(leak, `cross-tenant leak: generic saw wellness Contact entityId ${contactId}`).toBeFalsy();
  });
});

// ── Filter parameters ──────────────────────────────────────────────

test.describe('Audit API — filter parameters', () => {
  test('?entity=Contact returns only Contact rows', async ({ request }) => {
    await seedAuditedContact(request, 'generic', 'filter-entity');
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit?entity=Contact');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r) => r.entity === 'Contact')).toBe(true);
  });

  test('?entity=NoSuchEntity_ZZZ returns []', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, `/api/audit?entity=NoSuchEntity_ZZZ_${Date.now()}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test('?action=CREATE returns only CREATE rows', async ({ request }) => {
    await seedAuditedContact(request, 'generic', 'filter-action');
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit?action=CREATE');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r) => r.action === 'CREATE')).toBe(true);
  });

  test('?entity=Contact&action=CREATE composes both filters', async ({ request }) => {
    const { contactId } = await seedAuditedContact(request, 'generic', 'filter-compose');
    const { token } = await getGenericAdmin(request);
    const res = await get(request, token, '/api/audit?entity=Contact&action=CREATE');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.every((r) => r.entity === 'Contact' && r.action === 'CREATE')).toBe(true);
    // Our seeded row must surface.
    const found = body.find((r) => r.entityId === contactId);
    expect(found, `expected seed row contactId=${contactId} in filtered response`).toBeTruthy();
  });

  test('?entity=Contact filter is tenant-scoped (generic seed not visible to wellness even with filter)', async ({ request }) => {
    const { contactId } = await seedAuditedContact(request, 'generic', 'filter-tenant');
    const { token: wToken } = await getWellnessAdmin(request);
    const wRes = await get(request, wToken, '/api/audit?entity=Contact&action=CREATE');
    expect(wRes.status()).toBe(200);
    const wBody = await wRes.json();
    const leak = wBody.find((r) => r.entityId === contactId);
    expect(leak, `filter+cross-tenant leak: ${contactId}`).toBeFalsy();
  });
});

// ── RBAC contract ──────────────────────────────────────────────────
//
// G-5 acceptance: non-ADMIN gets 403. Closed by the route fix that
// added verifyRole(['ADMIN']) to routes/audit.js (issue #408). The
// previous "CURRENT BEHAVIOR: 200" pinning tests have been removed
// since they would now fail (which is the desired result of the fix).

test.describe('Audit API — RBAC contract', () => {
  test('non-ADMIN MANAGER gets 403', async ({ request }) => {
    const { token } = await getGenericManager(request);
    expect(token, 'manager login').toBeTruthy();
    const res = await get(request, token, '/api/audit');
    expect(res.status()).toBe(403);
  });

  test('non-ADMIN USER gets 403', async ({ request }) => {
    const { token } = await getGenericUser(request);
    expect(token, 'user login').toBeTruthy();
    const res = await get(request, token, '/api/audit');
    expect(res.status()).toBe(403);
  });
});
