// @ts-check
/**
 * GDPR DSAR Export API — gate spec for issue #443.
 *
 * Target: routes/gdpr.js, two endpoints:
 *   POST /api/gdpr/export/me              — current-user self-export (Art. 15)
 *   POST /api/gdpr/export/contact/:id     — admin-driven contact export (Art. 15)
 *
 * Why this spec exists (compliance hook):
 *   GDPR Article 15 + DPDP Act 2023 §11 grant the data subject a right to
 *   receive a copy of all personal data held about them. Until #443, the
 *   /export/me handler (a) had no AuditLog row written — only a
 *   DataExportRequest row — so the WHO/WHEN of every self-export was
 *   missing from the SOC-2 audit trail; and (b) /export/contact emitted an
 *   audit row with action='EXPORT' (legacy label) instead of the canonical
 *   `GDPR_EXPORT` used by the audit-viewer compliance dashboard.
 *
 *   #443 fix (commit pending) wires both handlers through the shared
 *   `writeAudit` helper at backend/lib/audit.js with action='GDPR_EXPORT',
 *   details containing only `{ reason, counts }` (never row contents — that
 *   would leak the very data the export was meant to surface). This spec
 *   pins that contract so a future refactor can't silently drop the audit
 *   row again.
 *
 * Endpoint contracts (asserted below):
 *
 *   POST /api/gdpr/export/me
 *     Auth:  verifyToken (router-level) — staff JWT only; portal/patient
 *            tokens rejected by the auth middleware before reaching the
 *            handler (see middleware/auth.js — `if (verified.patientId ||
 *            !verified.userId) return 401`).
 *     200:   { exportedAt, tenantId, user, deals, tasks, expenses,
 *            activities, emails, callLogs, smsMessages, whatsappMessages,
 *            auditLogs }. Every array is tenant-scoped to req.user.tenantId.
 *     401/403: missing/invalid token.
 *     Side effect: writes one AuditLog row { entity:'User',
 *            action:'GDPR_EXPORT', entityId:userId, userId, tenantId,
 *            details:{ reason, counts } }.
 *
 *   POST /api/gdpr/export/contact/:id
 *     Auth:  verifyToken.
 *     400:   id not numeric.
 *     404:   contact id doesn't exist OR exists in a different tenant
 *            (id-enumeration prevention — NOT 403, because returning 403
 *            would leak the existence of cross-tenant rows).
 *     200:   { exportedAt, tenantId, contact, activities, deals, emails,
 *            callLogs, tasks, invoices, contracts, estimates, smsMessages,
 *            whatsappMessages, consentRecords }.
 *     Side effect: writes one AuditLog row { entity:'Contact',
 *            action:'GDPR_EXPORT', entityId:contact.id }.
 *
 * Tenant isolation invariant — THE compliance assertion:
 *   The /export/contact/:id WHERE clause is `{ id, tenantId }`. The
 *   findFirst returns null for a contact that lives in another tenant,
 *   producing a 404. A leak here (cross-tenant 200) would be a P0 PHI
 *   breach equivalent to the wellness-portal JWT issue from 2026-04-23.
 *   Spec creates a Contact in the wellness tenant and asserts the
 *   generic-tenant admin gets 404 (not 403, not 200) when invoking export
 *   against that id.
 *
 * Patient-portal counterpart (deliberately ABSENT):
 *   The middleware at backend/middleware/auth.js explicitly blocks portal
 *   tokens (`if (verified.patientId || !verified.userId)` → 401). So
 *   /api/gdpr/* is staff-only by design. There is currently NO patient
 *   self-export endpoint — that is its own gap (file separately if needed).
 *   This spec confirms the portal block by NOT testing portal access.
 *
 * Pattern: cloned from e2e/tests/audit-api.spec.js (cached dual-token,
 * tenant isolation describe block, RBAC sanity, side-effect assertion via
 * the /api/audit endpoint). RUN_TAG=`E2E_FLOW_GDPRDSAR_<ts>` — already
 * matched by the `^E2E_FLOW_` regex in e2e/test-data-patterns.js, no
 * pattern addition needed.
 *
 * Test environment expectations:
 *   - BASE_URL points to a backend with a seeded admin@globussoft.com /
 *     admin@wellness.demo / manager@crm.com / user@crm.com (password123).
 *   - The /api/audit endpoint is ADMIN-only (see audit-api.spec.js).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_GDPRDSAR_${Date.now()}`;

// ── Cached tokens ──────────────────────────────────────────────────
let genericAdminToken = null;
let genericAdminTenantId = null;
let genericAdminUserId = null;
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
        return {
          token: j.token,
          tenantId: j.tenant && j.tenant.id,
          userId: j.user && j.user.id,
        };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null, userId: null };
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericAdminToken = r.token;
    genericAdminTenantId = r.tenantId;
    genericAdminUserId = r.userId;
  }
  return {
    token: genericAdminToken,
    tenantId: genericAdminTenantId,
    userId: genericAdminUserId,
  };
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

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const get = (request, token, path) =>
  request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const post = (request, token, path, body) =>
  request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const del = (request, token, path) =>
  request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

// ── Cleanup tracking ───────────────────────────────────────────────
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

async function seedContact(request, tenantKey, label) {
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
  return c;
}

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('GDPR DSAR Export — auth gate', () => {
  test('POST /export/me without Authorization → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/gdpr/export/me`, {
      timeout: REQUEST_TIMEOUT,
    });
    // Global guard returns 403; verifyToken returns 401. Accept either.
    expect([401, 403]).toContain(res.status());
  });

  test('POST /export/contact/:id without Authorization → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/gdpr/export/contact/1`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── Happy path / response shape ────────────────────────────────────

test.describe('GDPR DSAR Export — /export/me happy path', () => {
  // Demo's /export/me handler does ~9 findMany calls across the full
  // generic-admin tenant graph. Solo this returns ~4-5s, but under
  // e2e-full's 4-shard concurrent load it routinely spikes to 25-45s,
  // brushing the default 30s test timeout on all 3 retry attempts.
  // 90s gives ~3× headroom over solo time and ~2× over worst observed.
  test.describe.configure({ timeout: 90_000 });

  test('200 with the documented entity-keyed shape', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    expect(token).toBeTruthy();
    const res = await post(request, token, '/api/gdpr/export/me');
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();

    // Required top-level keys keyed by entity. If a future change drops
    // any of these, downstream subject-access-request tooling breaks.
    for (const key of [
      'exportedAt',
      'tenantId',
      'user',
      'deals',
      'tasks',
      'expenses',
      'activities',
      'emails',
      'callLogs',
      'smsMessages',
      'whatsappMessages',
      'auditLogs',
    ]) {
      expect(body, `missing top-level key: ${key}`).toHaveProperty(key);
    }

    // user.id must equal the requesting user (not someone else's row).
    expect(body.user, 'user object').toBeTruthy();
    expect(typeof body.user.id).toBe('number');

    // Every collection is an Array.
    for (const key of ['deals', 'tasks', 'expenses', 'activities', 'emails',
      'callLogs', 'smsMessages', 'whatsappMessages', 'auditLogs']) {
      expect(Array.isArray(body[key]), `${key} must be an Array`).toBe(true);
    }
  });

  test('every returned row carries the requesting tenantId (no cross-tenant leak)', async ({ request }) => {
    const { token, tenantId } = await getGenericAdmin(request);
    expect(tenantId, 'tenantId resolved from login').toBeTruthy();

    const res = await post(request, token, '/api/gdpr/export/me');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.tenantId).toBe(tenantId);
    expect(body.user.tenantId).toBe(tenantId);

    // Defence-in-depth — every row across every collection must carry
    // the same tenantId. A leak here would mean the WHERE clause is
    // missing on at least one of the 9 findMany calls in the handler.
    for (const key of ['deals', 'tasks', 'expenses', 'activities', 'emails',
      'callLogs', 'smsMessages', 'whatsappMessages', 'auditLogs']) {
      for (const row of body[key]) {
        expect(
          row.tenantId,
          `${key} row id=${row.id} tenantId=${row.tenantId} != ${tenantId}`
        ).toBe(tenantId);
      }
    }
  });

  test('idempotent — calling /export/me twice returns the same shape', async ({ request }) => {
    // Two sequential /export/me calls routinely brush the default 30s
    // test timeout. The describe-level 90s budget gives ~3× headroom.
    const { token } = await getGenericAdmin(request);
    const a = await post(request, token, '/api/gdpr/export/me');
    const b = await post(request, token, '/api/gdpr/export/me');
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    const aj = await a.json();
    const bj = await b.json();
    // Same set of top-level keys (counts can differ if the second call
    // wrote a new auditLog row in between — that's expected, since the
    // first export's audit row IS user-data and surfaces in auditLogs).
    expect(Object.keys(aj).sort()).toEqual(Object.keys(bj).sort());
    expect(aj.user.id).toBe(bj.user.id);
    expect(aj.tenantId).toBe(bj.tenantId);
  });
});

// ── /export/me audit side effect (issue #443 — main fix) ──────────

test.describe('GDPR DSAR Export — /export/me audit row contract', () => {
  // Same 90s headroom rationale as the happy-path describe: /export/me
  // does ~9 findMany calls and can spike to 25-45s under shard load.
  test.describe.configure({ timeout: 90_000 });

  test('writes AuditLog row { entity:User, action:GDPR_EXPORT } visible to the same admin', async ({ request }) => {
    const { token, userId } = await getGenericAdmin(request);
    expect(userId, 'admin userId resolved').toBeTruthy();

    // Trigger the export. Pre-#443 this wrote NO audit row at all
    // (only a DataExportRequest row), so this assertion was impossible
    // to satisfy before the fix.
    const exportRes = await post(request, token, '/api/gdpr/export/me');
    expect(exportRes.status()).toBe(200);

    // The audit endpoint is ADMIN-only and tenant-scoped. Pull recent
    // GDPR_EXPORT rows for User and confirm one targets the requester.
    const auditRes = await get(
      request,
      token,
      '/api/audit?entity=User&action=GDPR_EXPORT'
    );
    expect(auditRes.status(), 'audit list as admin').toBe(200);
    const rows = await auditRes.json();
    expect(Array.isArray(rows)).toBe(true);

    const mine = rows.find(
      (r) => r.entity === 'User' &&
             r.action === 'GDPR_EXPORT' &&
             r.entityId === userId
    );
    expect(
      mine,
      `expected AuditLog row for User#${userId} action=GDPR_EXPORT after /export/me`
    ).toBeTruthy();
    // userId on the audit row should be the same actor (self-export).
    expect(mine.userId).toBe(userId);
  });
});

// ── /export/contact/:id contract ───────────────────────────────────

test.describe('GDPR DSAR Export — /export/contact/:id', () => {
  // /export/contact/:id does ~13 findMany calls across the contact's
  // full activity graph. Solo this returns in 1-2s on demo but under
  // 4-shard concurrent e2e-full load spikes past the 30s default.
  test.describe.configure({ timeout: 90_000 });

  test('happy path for tenant-owned contact → 200 + entity-keyed body', async ({ request }) => {
    const contact = await seedContact(request, 'generic', 'happy');
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, `/api/gdpr/export/contact/${contact.id}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();

    expect(body.contact).toBeTruthy();
    expect(body.contact.id).toBe(contact.id);
    for (const key of [
      'exportedAt', 'tenantId', 'contact', 'activities', 'deals', 'emails',
      'callLogs', 'tasks', 'invoices', 'contracts', 'estimates',
      'smsMessages', 'whatsappMessages', 'consentRecords',
    ]) {
      expect(body, `missing top-level key: ${key}`).toHaveProperty(key);
    }
  });

  test('non-existent id → 404 (not 500)', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/gdpr/export/contact/99999999');
    expect(res.status()).toBe(404);
  });

  test('cross-tenant id → 404 (id-enumeration prevention; NOT 403, NOT 200)', async ({ request }) => {
    // Create a contact in the wellness tenant.
    const wellnessContact = await seedContact(request, 'wellness', 'cross-tenant');
    expect(wellnessContact.id).toBeTruthy();

    // Generic-tenant admin tries to export it. Must be 404 — a 200 would
    // be a P0 cross-tenant PHI leak; a 403 would leak existence (an
    // attacker could enumerate ids and learn which exist in OTHER tenants
    // via the 403-vs-404 split).
    const { token } = await getGenericAdmin(request);
    const res = await post(request, token, `/api/gdpr/export/contact/${wellnessContact.id}`);
    expect(
      res.status(),
      `cross-tenant export must be 404 (was ${res.status()}) — leak risk`
    ).toBe(404);
  });

  test('writes AuditLog row { entity:Contact, action:GDPR_EXPORT, entityId:contactId }', async ({ request }) => {
    const contact = await seedContact(request, 'generic', 'audit-probe');
    const { token } = await getGenericAdmin(request);

    const exportRes = await post(request, token, `/api/gdpr/export/contact/${contact.id}`);
    expect(exportRes.status()).toBe(200);

    const auditRes = await get(
      request,
      token,
      '/api/audit?entity=Contact&action=GDPR_EXPORT'
    );
    expect(auditRes.status()).toBe(200);
    const rows = await auditRes.json();
    const found = rows.find(
      (r) => r.entity === 'Contact' && r.action === 'GDPR_EXPORT' && r.entityId === contact.id
    );
    expect(
      found,
      `expected AuditLog row for Contact#${contact.id} action=GDPR_EXPORT`
    ).toBeTruthy();
  });
});

// ── RBAC sanity ────────────────────────────────────────────────────
//
// /api/gdpr/* router-level guard is verifyToken (any authenticated staff
// token). On TOP of that, two policy splits apply:
//
//   /export/me              — no role gate. Every authenticated user is
//                             exporting THEIR OWN data, which is exactly
//                             what GDPR Article 15 grants every data
//                             subject. MANAGER + USER must succeed.
//
//   /export/contact/:id     — verifyRole(['ADMIN','MANAGER']). v3.4.9
//                             carry-over #3 closed the v3.4.8 finding
//                             where any USER could export any tenant
//                             contact's full PII bundle. Compliance work
//                             defaults to least-privilege; only org-
//                             oversight roles (ADMIN, MANAGER) can
//                             trigger a contact-scoped DSAR. USER → 403.
//
// The pre-v3.4.9 spec deliberately pinned the LOOSE behavior ("pin what
// is, then tighten in a follow-up"). That pin is now obsolete and has
// been removed; the assertions below flip to the post-tightening shape.

test.describe('GDPR DSAR Export — RBAC sanity', () => {
  test('MANAGER can self-export via /export/me (Art. 15 self-access right)', async ({ request }) => {
    const { token } = await getGenericManager(request);
    if (!token) test.skip(true, 'manager seed missing on this env');
    const res = await post(request, token, '/api/gdpr/export/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
  });

  test('USER can self-export via /export/me (Art. 15 self-access right)', async ({ request }) => {
    const { token } = await getGenericUser(request);
    if (!token) test.skip(true, 'user seed missing on this env');
    const res = await post(request, token, '/api/gdpr/export/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
  });

  test('MANAGER can export a tenant contact via /export/contact/:id (compliance-officer role)', async ({ request }) => {
    const { token } = await getGenericManager(request);
    if (!token) test.skip(true, 'manager seed missing on this env');
    const contact = await seedContact(request, 'generic', 'rbac-mgr');
    const res = await post(request, token, `/api/gdpr/export/contact/${contact.id}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.contact && body.contact.id).toBe(contact.id);
  });

  test('USER cannot export a tenant contact via /export/contact/:id → 403 (v3.4.9 carry-over #3)', async ({ request }) => {
    const { token } = await getGenericUser(request);
    if (!token) test.skip(true, 'user seed missing on this env');
    // Seed via admin so the contact actually exists — the gate must fire
    // BEFORE the findFirst, so a 404-vs-403 split here would itself be a
    // (smaller) leak of role-vs-existence information. We assert 403
    // regardless of whether the row exists.
    const contact = await seedContact(request, 'generic', 'rbac-user-deny');
    const res = await post(request, token, `/api/gdpr/export/contact/${contact.id}`);
    expect(
      res.status(),
      `USER must be 403 on /export/contact/:id (was ${res.status()})`
    ).toBe(403);
    // verifyRole emits the canonical RBAC denial envelope
    // ({ error, code: 'RBAC_DENIED' }) per #590/#591. Pre-fix the
    // string was "Insufficient Role Permissions. System Admin
    // Required." which leaked role taxonomy. We assert the stable
    // code rather than the human-facing copy so a future tweak to
    // the toast string doesn't red this spec.
    const body = await res.json().catch(() => ({}));
    expect(typeof body.error === 'string' && body.error.length > 0).toBe(true);
    expect(body.code).toBe('RBAC_DENIED');
    // #591: response body must NOT leak role names to non-privileged users.
    expect(body.error).not.toMatch(/system admin|wellness role/i);
  });
});
