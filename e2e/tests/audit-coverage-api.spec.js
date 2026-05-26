// @ts-check
/**
 * Audit-coverage regression — per-push gate spec.
 *
 * Item #5 of docs/regression-coverage-backlog.md. Closes GitHub issues
 * #134 / #167 / #179 / #180.
 *
 * WHY THIS EXISTS:
 *   The original audit-api.spec.js (G-5, commit f5e9c7c) covers the
 *   READ surface of routes/audit.js — RBAC, tenant isolation, response
 *   shape. It does NOT prove every mutating endpoint actually emits an
 *   AuditLog row. Pre-#179 the only audited entity was Deal; #179 wired
 *   writeAudit() through Contact / Patient / Invoice / Estimate / Task /
 *   Notification, and #167 added the SOFT_DELETE row on the four soft-
 *   deletable entities (Contact, Deal, Estimate, Task). This regression
 *   spec pins each emission as a contract — if a future refactor drops
 *   a writeAudit call, the per-push gate goes red within 30s of the bug
 *   landing instead of waiting for an HIPAA / DPDP audit to surface it.
 *
 *   Compliance posture: every PHI / PII mutation MUST be discoverable
 *   through GET /api/audit. The eight entity classes covered here span
 *   the complete generic + wellness write surface that compliance cares
 *   about (Pipeline is included as a "control" entity — it has NO
 *   writeAudit calls today, so the test reads as `gap-tracking` rather
 *   than `regression-pin`. See pipeline describe block below).
 *
 * MUTATING ENDPOINTS COVERED (action verb pinned to actual route emission):
 *
 *   Contact (routes/contacts.js):
 *     POST   /api/contacts                  → AuditLog 'Contact'  'CREATE'
 *     PUT    /api/contacts/:id              → AuditLog 'Contact'  'UPDATE'
 *     DELETE /api/contacts/:id (soft, #167) → AuditLog 'Contact'  'SOFT_DELETE'
 *
 *   Deal (routes/deals.js):
 *     POST   /api/deals                     → AuditLog 'Deal'     'CREATE'
 *     PUT    /api/deals/:id                 → AuditLog 'Deal'     'UPDATE'
 *     DELETE /api/deals/:id (soft, #167)    → AuditLog 'Deal'     'SOFT_DELETE'
 *
 *   Patient (routes/wellness.js, hard-delete with FK guard #539):
 *     POST   /api/wellness/patients         → AuditLog 'Patient'  'CREATE'
 *     PUT    /api/wellness/patients/:id     → AuditLog 'Patient'  'UPDATE'
 *     DELETE /api/wellness/patients/:id     → AuditLog 'Patient'  'DELETE'
 *       (#539: 409 PATIENT_HAS_CHILDREN on FK-bound rows — the test
 *        uses a freshly-created patient with no children so the happy
 *        path triggers; we do NOT assert audit on the 409 path because
 *        delete didn't happen.)
 *
 *   Invoice (routes/billing.js):
 *     POST   /api/billing                   → AuditLog 'Invoice'  'CREATE'
 *     PATCH  /api/billing/:id (no PUT)      → AuditLog 'Invoice'  'INVOICE_UPDATE'
 *       Note: routes/billing.js exposes PATCH not PUT for general updates;
 *       PUT /:id/pay etc. are state-machine actions with their own audit
 *       verbs (MARK_PAID, VOID, REFUND). DELETE → voidInvoiceHandler →
 *       AuditLog 'Invoice' 'VOID' (not a generic DELETE verb).
 *
 *   Estimate (routes/estimates.js):
 *     POST   /api/estimates                 → AuditLog 'Estimate' 'CREATE'
 *     PUT    /api/estimates/:id             → AuditLog 'Estimate' 'UPDATE'
 *     DELETE /api/estimates/:id (soft #167) → AuditLog 'Estimate' 'SOFT_DELETE'
 *
 *   Task (routes/tasks.js):
 *     POST   /api/tasks                     → AuditLog 'Task'     'CREATE'
 *     PUT    /api/tasks/:id                 → AuditLog 'Task'     'UPDATE'
 *     DELETE /api/tasks/:id (soft #167)     → AuditLog 'Task'     'SOFT_DELETE'
 *
 *   Pipeline (routes/pipelines.js — closed by #568):
 *     POST   /api/pipelines                 → AuditLog 'Pipeline' 'CREATE'
 *     PUT    /api/pipelines/:id             → AuditLog 'Pipeline' 'UPDATE'
 *     DELETE /api/pipelines/:id             → AuditLog 'Pipeline' 'DELETE'
 *       (hard-delete — Pipeline has no soft-delete column. The route
 *        already gates 400 on isDefault and 400 on non-empty pipelines,
 *        so the audited path is the genuine "empty + non-default"
 *        delete success.)
 *
 *   Notification (routes/notifications.js):
 *     POST   /api/notifications             → AuditLog 'Notification' 'CREATE'
 *                                             (or 'BROADCAST' on tenant blast)
 *     DELETE /api/notifications/:id         → AuditLog 'Notification' 'DELETE'
 *     (no PUT for notifications — read-state mutations don't audit)
 *
 *   Auth (routes/auth.js — closed by #569):
 *     POST   /api/auth/logout               → AuditLog 'User' 'LOGOUT'
 *     The handler emits the audit row alongside the RevokedToken upsert.
 *     Both halves are now hard-asserted: JWT revocation (security
 *     primitive) + audit emission (discoverability).
 *
 * NEGATIVE-CASE ASSERTIONS:
 *   - 400 validation-failed POST /api/contacts (missing email) → NO new
 *     audit row for the failed request.
 *   - 404 PUT on bogus contact id → NO new audit row.
 *   - Idempotent DELETE re-call on already-soft-deleted contact → NO
 *     duplicate audit row (the route returns idempotent:true and
 *     skips the writeAudit call entirely).
 *
 * ENDPOINTS USED FOR ASSERTIONS:
 *   GET /api/audit?entity=<Entity>&action=<ACTION>
 *     ADMIN-only. Returns last 100 rows for the requester's tenant.
 *     We filter post-fetch by entityId === createdId because
 *     routes/audit.js does NOT support an entityId query param.
 *
 * STANDING RULES IN PLAY:
 *   - JWT key is `req.user.userId` (not `id`).
 *   - stripDangerous middleware deletes id/createdAt/updatedAt/
 *     tenantId/userId/isAdmin/passwordHash/portalPasswordHash from
 *     every request body. We don't reference those fields.
 *   - Patient POST requires phone (#536 fix); fixtures use a real
 *     +91 format like '+919876543210'.
 *   - DELETE → 204 sweep (#550) — Notifications DELETE returns 204,
 *     other entity DELETEs still return 200 + envelope. Spec accepts
 *     both 200 and 204 where ambiguous.
 *
 * RUN_TAG: `E2E_AUDIT_COV_<ts>` — matches `/^E2E_AUDIT_/` in
 * e2e/test-data-patterns.js. Cleanup uses `_teardown_` prefix per the
 * canonical wellness-rbac-regression-api convention to avoid demo-
 * hygiene residue regex hits during the cleanup window.
 *
 * Test environment expectations:
 *   - BASE_URL: http://127.0.0.1:5000 (per-push CI / local stack) OR
 *     https://crm.globusdemos.com (release-validation only).
 *   - Seeded users: admin@globussoft.com (generic ADMIN) +
 *     admin@wellness.demo (wellness ADMIN) — both at password123.
 *
 * REVERT-AND-PROVE EVIDENCE (in commit body):
 *   - Stripped `await writeAudit('Contact', 'CREATE', ...)` from
 *     contacts.js POST (line 121) → the contact-CREATE test went RED
 *     with "no audit row found for Contact CREATE entityId=<n>".
 *   - Stripped `await writeAudit('Patient', 'DELETE', ...)` from
 *     wellness.js DELETE (line 794) → the patient-DELETE test went
 *     RED with the same shape error.
 *   - Restored both → all green.
 */
const { test, expect } = require('@playwright/test');

// Tests in this file rely on AuditLog row reads ordered by createdAt
// desc. With fullyParallel: true + 2 workers, the read fan-out can race
// against another test's writes (a sibling spec creating a Contact in
// the same tenant in parallel inserts an audit row that pushes ours
// off the top-100 cap). Pin to serial; the suite ships in <30s.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_AUDIT_COV_${Date.now()}`;
// Demo (e2e-full target) audit-poll budget is too tight under 8-shard contention
// (was 13.7s vs 5s budget on run 26057150278). Skip on demo; per-push gate still
// runs it against the local stack with deterministic <5s behavior.
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

// ── Auth fixtures ──────────────────────────────────────────────────
let genericAdminToken = null;
let genericAdminUserId = null;
let genericAdminTenantId = null;
let wellnessAdminToken = null;
let wellnessAdminUserId = null;
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
          userId: j.user && j.user.id,
          tenantId: (j.tenant && j.tenant.id) || (j.user && j.user.tenantId),
        };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null, tenantId: null };
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericAdminToken = r.token;
    genericAdminUserId = r.userId;
    genericAdminTenantId = r.tenantId;
  }
  return { token: genericAdminToken, userId: genericAdminUserId, tenantId: genericAdminTenantId };
}

async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessAdminToken = r.token;
    wellnessAdminUserId = r.userId;
    wellnessAdminTenantId = r.tenantId;
  }
  return { token: wellnessAdminToken, userId: wellnessAdminUserId, tenantId: wellnessAdminTenantId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function patch(request, token, path, body) {
  return request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Helper: fetch the audit row matching (entity, action, entityId)
// from the requester's tenant. Polls briefly to absorb the writeAudit
// async flush — the helper at lib/audit.js wraps the prisma.create in
// a try/catch and never blocks the request. In practice it's instant,
// but allow up to 1s of slack for slower CI.
async function findAuditRow(request, token, entity, action, entityId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const res = await get(request, token, `/api/audit?entity=${entity}&action=${action}`);
    if (res.status() === 200) {
      const rows = await res.json();
      const match = rows.find((r) => r.entity === entity && r.action === action && r.entityId === entityId);
      if (match) return match;
    }
    // Short re-poll without a hard sleep (keeps CI fast when row is already there)
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// Common assertion: the matched audit row carries actor + tenant scope.
function expectAuditShape(row, expected) {
  expect(row, 'audit row not found').not.toBeNull();
  expect(row.entity).toBe(expected.entity);
  expect(row.action).toBe(expected.action);
  expect(row.entityId).toBe(expected.entityId);
  expect(row.userId, 'actor userId on audit row').toBe(expected.userId);
  expect(row.tenantId, 'tenant scope on audit row').toBe(expected.tenantId);
  expect(row.createdAt, 'audit row has timestamp').toBeTruthy();
}

// ── Cleanup tracking ───────────────────────────────────────────────
//
// AuditLog rows themselves are not deletable through any public API
// (by design — compliance + immutability). The RUN_TAG matches
// `/^E2E_AUDIT_/` in e2e/test-data-patterns.js so the post-suite
// scrub script will sweep them. We DO clean up the parent rows we
// created (Contact, Deal, Patient, Invoice, etc.) so demo-hygiene's
// fixture-residue check stays green.
const created = {
  generic: {
    contacts: [], // ids — cleaned via DELETE (route does soft-delete)
    deals: [],
    invoices: [], // PATCH-rename only; no public hard-delete
    estimates: [],
    tasks: [],
    notifications: [],
    pipelines: [],
  },
  wellness: {
    patients: [], // PUT-rename + delete attempt (FK-restricted)
  },
};

test.afterAll(async ({ request }) => {
  const ga = await getGenericAdmin(request);
  if (ga.token) {
    for (const id of created.generic.contacts) {
      await del(request, ga.token, `/api/contacts/${id}`).catch(() => {});
    }
    for (const id of created.generic.deals) {
      await del(request, ga.token, `/api/deals/${id}`).catch(() => {});
    }
    for (const id of created.generic.estimates) {
      await del(request, ga.token, `/api/estimates/${id}`).catch(() => {});
    }
    for (const id of created.generic.tasks) {
      await del(request, ga.token, `/api/tasks/${id}`).catch(() => {});
    }
    for (const id of created.generic.notifications) {
      await del(request, ga.token, `/api/notifications/${id}`).catch(() => {});
    }
    for (const id of created.generic.pipelines) {
      await del(request, ga.token, `/api/pipelines/${id}`).catch(() => {});
    }
    // Invoices have no public hard-delete — rename to _teardown_ so
    // demo-hygiene's E2E_-prefix regex misses them. Only INV-prefixed
    // invoiceNum is required, so we just leave them (the audit-log
    // rows tie back to a real INV-### number — sweep script handles).
  }
  const wa = await getWellnessAdmin(request);
  if (wa.token) {
    for (const id of created.wellness.patients) {
      // PUT-rename to _teardown_<id> so the residue regex misses,
      // then attempt DELETE (may 409 if any FK children leaked).
      await put(request, wa.token, `/api/wellness/patients/${id}`, {
        name: `_teardown_audit_cov_${id}`,
        phone: `+9199${String(id).padStart(8, '0').slice(-8)}`,
      }).catch(() => {});
      await del(request, wa.token, `/api/wellness/patients/${id}`).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// Contact audit emissions
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Contact', () => {
  test('POST /api/contacts emits AuditLog Contact CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    expect(token).toBeTruthy();
    const ts = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} contact-create`,
      email: `${RUN_TAG.toLowerCase()}-create-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(res.status(), `contact create: ${await res.text()}`).toBe(201);
    const c = await res.json();
    created.generic.contacts.push(c.id);

    const row = await findAuditRow(request, token, 'Contact', 'CREATE', c.id);
    expectAuditShape(row, { entity: 'Contact', action: 'CREATE', entityId: c.id, userId, tenantId });
  });

  test('PUT /api/contacts/:id emits AuditLog Contact UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const ts = Date.now();
    const create = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} contact-update`,
      email: `${RUN_TAG.toLowerCase()}-update-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(create.status()).toBe(201);
    const c = await create.json();
    created.generic.contacts.push(c.id);

    const upd = await put(request, token, `/api/contacts/${c.id}`, { title: `Updated ${RUN_TAG}` });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Contact', 'UPDATE', c.id);
    expectAuditShape(row, { entity: 'Contact', action: 'UPDATE', entityId: c.id, userId, tenantId });
  });

  test('DELETE /api/contacts/:id emits AuditLog Contact SOFT_DELETE row (#167)', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const ts = Date.now();
    const create = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} contact-delete`,
      email: `${RUN_TAG.toLowerCase()}-delete-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(create.status()).toBe(201);
    const c = await create.json();
    // Don't push to cleanup; DELETE is the test action

    const delRes = await del(request, token, `/api/contacts/${c.id}`);
    // Routes/contacts.js soft-delete returns 200 + body with softDeleted:true
    expect([200, 204]).toContain(delRes.status());

    const row = await findAuditRow(request, token, 'Contact', 'SOFT_DELETE', c.id);
    expectAuditShape(row, { entity: 'Contact', action: 'SOFT_DELETE', entityId: c.id, userId, tenantId });
  });

  test('idempotent re-DELETE on already-soft-deleted contact does NOT create duplicate audit row', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const ts = Date.now();
    const create = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} contact-idem`,
      email: `${RUN_TAG.toLowerCase()}-idem-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(create.status()).toBe(201);
    const c = await create.json();

    // First DELETE → emits audit
    await del(request, token, `/api/contacts/${c.id}`);
    const before = await get(request, token, `/api/audit?entity=Contact&action=SOFT_DELETE`);
    const beforeRows = (await before.json()).filter((r) => r.entityId === c.id);

    // Second DELETE → idempotent, no new audit row
    const second = await del(request, token, `/api/contacts/${c.id}`);
    expect([200, 204]).toContain(second.status());

    const after = await get(request, token, `/api/audit?entity=Contact&action=SOFT_DELETE`);
    const afterRows = (await after.json()).filter((r) => r.entityId === c.id);
    expect(afterRows.length).toBe(beforeRows.length);
  });

  test('400-validation POST /api/contacts (missing email) does NOT create an audit row', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    // Snapshot count before
    const before = await get(request, token, `/api/audit?entity=Contact&action=CREATE`);
    const beforeBody = await before.json();
    const beforeBaseline = beforeBody.length;

    const bad = await post(request, token, '/api/contacts', {
      // Missing email — route returns 400.
      name: `${RUN_TAG} bad-validation`,
    });
    // Route returns 400 OR 422 OR 500 depending on where the validator
    // catches it; the audit-row-not-emitted contract holds regardless.
    expect(bad.status()).toBeGreaterThanOrEqual(400);

    // Audit-row count for Contact CREATE in our tenant should not have
    // grown by this 400 attempt. Other parallel tests in this file may
    // bump it — accept >= rather than == to keep CI stable.
    const after = await get(request, token, `/api/audit?entity=Contact&action=CREATE`);
    const afterBody = await after.json();
    // The audit cap is 100, so after >= before only IF the 400 didn't
    // emit. If the 400 DID emit, we'd see a "bad-validation" row in
    // afterBody[0].details. Probe that:
    const leaked = afterBody.find((r) => {
      try {
        const det = typeof r.details === 'string' ? JSON.parse(r.details) : r.details;
        return det && det.name === `${RUN_TAG} bad-validation`;
      } catch (_) { return false; }
    });
    expect(leaked, 'failed-validation POST should NOT emit an audit row').toBeUndefined();
    // Count sanity: cap is 100 so after.length is <= 100 either way.
    expect(afterBody.length).toBeGreaterThanOrEqual(0);
    expect(beforeBaseline).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Deal audit emissions
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Deal', () => {
  test('POST /api/deals emits AuditLog Deal CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/deals', {
      title: `${RUN_TAG} deal-create`,
      amount: 1000,
      stage: 'lead',
    });
    expect(res.status(), `deal create: ${await res.text()}`).toBe(201);
    const d = await res.json();
    created.generic.deals.push(d.id);

    const row = await findAuditRow(request, token, 'Deal', 'CREATE', d.id);
    expectAuditShape(row, { entity: 'Deal', action: 'CREATE', entityId: d.id, userId, tenantId });
  });

  test('PUT /api/deals/:id emits AuditLog Deal UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/deals', {
      title: `${RUN_TAG} deal-update`,
      amount: 1000,
      stage: 'lead',
    });
    expect(create.status()).toBe(201);
    const d = await create.json();
    created.generic.deals.push(d.id);

    const upd = await put(request, token, `/api/deals/${d.id}`, { amount: 2500 });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Deal', 'UPDATE', d.id);
    expectAuditShape(row, { entity: 'Deal', action: 'UPDATE', entityId: d.id, userId, tenantId });
  });

  test('DELETE /api/deals/:id emits AuditLog Deal SOFT_DELETE row (#167)', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/deals', {
      title: `${RUN_TAG} deal-delete`,
      amount: 500,
      stage: 'lead',
    });
    expect(create.status()).toBe(201);
    const d = await create.json();

    const delRes = await del(request, token, `/api/deals/${d.id}`);
    expect([200, 204]).toContain(delRes.status());

    const row = await findAuditRow(request, token, 'Deal', 'SOFT_DELETE', d.id);
    expectAuditShape(row, { entity: 'Deal', action: 'SOFT_DELETE', entityId: d.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Patient audit emissions (wellness tenant — PHI compliance class)
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Patient', () => {
  test('POST /api/wellness/patients emits AuditLog Patient CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    expect(token).toBeTruthy();
    // #536: phone is required on POST. Use a real +91 format.
    const ts = Date.now();
    const phoneTail = String(ts).slice(-9); // 9 digits + 1 leading = 10 total digits after +91
    const res = await post(request, token, '/api/wellness/patients', {
      name: `${RUN_TAG} patient-create`,
      phone: `+919${phoneTail}`,
      source: 'walkin',
    });
    expect(res.status(), `patient create: ${await res.text()}`).toBe(201);
    const p = await res.json();
    created.wellness.patients.push(p.id);

    const row = await findAuditRow(request, token, 'Patient', 'CREATE', p.id);
    expectAuditShape(row, { entity: 'Patient', action: 'CREATE', entityId: p.id, userId, tenantId });
  });

  test('PUT /api/wellness/patients/:id emits AuditLog Patient UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    const ts = Date.now();
    const phoneTail = String(ts + 1).slice(-9);
    const create = await post(request, token, '/api/wellness/patients', {
      name: `${RUN_TAG} patient-update`,
      phone: `+919${phoneTail}`,
      source: 'walkin',
    });
    expect(create.status()).toBe(201);
    const p = await create.json();
    created.wellness.patients.push(p.id);

    const upd = await put(request, token, `/api/wellness/patients/${p.id}`, {
      notes: `audit-cov UPDATE probe at ${ts}`,
    });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Patient', 'UPDATE', p.id);
    expectAuditShape(row, { entity: 'Patient', action: 'UPDATE', entityId: p.id, userId, tenantId });
  });

  test('DELETE /api/wellness/patients/:id emits AuditLog Patient SOFT_DELETE row (#539, #628)', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    // Create a fresh patient with NO FK children so DELETE succeeds.
    const ts = Date.now();
    const phoneTail = String(ts + 2).slice(-9);
    const create = await post(request, token, '/api/wellness/patients', {
      name: `${RUN_TAG} patient-delete`,
      phone: `+919${phoneTail}`,
      source: 'walkin',
    });
    expect(create.status()).toBe(201);
    const p = await create.json();

    const delRes = await del(request, token, `/api/wellness/patients/${p.id}`);
    // #539: 409 PATIENT_HAS_CHILDREN if FK-bound, 200 success otherwise.
    // Fresh patient has no children → expect 200.
    // #628: DELETE switched from hard to soft-delete; audit action changed
    // from DELETE → SOFT_DELETE to match Contact/Deal soft-delete shape.
    expect(delRes.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Patient', 'SOFT_DELETE', p.id);
    expectAuditShape(row, { entity: 'Patient', action: 'SOFT_DELETE', entityId: p.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invoice audit emissions (billing.js)
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Invoice', () => {
  let probeContactId = null;

  test('seed: Contact for invoice anchor', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const ts = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} invoice-anchor`,
      email: `${RUN_TAG.toLowerCase()}-inv-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Customer',
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    probeContactId = c.id;
    created.generic.contacts.push(c.id);
  });

  test('POST /api/billing emits AuditLog Invoice CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    expect(probeContactId, 'invoice anchor contact must exist').toBeTruthy();
    const futureDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await post(request, token, '/api/billing', {
      amount: 100.50,
      dueDate: futureDue,
      contactId: probeContactId,
    });
    expect(res.status(), `invoice create: ${await res.text()}`).toBe(201);
    const inv = await res.json();
    created.generic.invoices.push(inv.id);

    const row = await findAuditRow(request, token, 'Invoice', 'CREATE', inv.id);
    expectAuditShape(row, { entity: 'Invoice', action: 'CREATE', entityId: inv.id, userId, tenantId });
  });

  test('PATCH /api/billing/:id emits AuditLog Invoice INVOICE_UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    expect(probeContactId).toBeTruthy();
    const futureDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const create = await post(request, token, '/api/billing', {
      amount: 75.25,
      dueDate: futureDue,
      contactId: probeContactId,
    });
    expect(create.status()).toBe(201);
    const inv = await create.json();
    created.generic.invoices.push(inv.id);

    const newDue = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const upd = await patch(request, token, `/api/billing/${inv.id}`, { dueDate: newDue });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Invoice', 'INVOICE_UPDATE', inv.id);
    expectAuditShape(row, { entity: 'Invoice', action: 'INVOICE_UPDATE', entityId: inv.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Estimate audit emissions
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Estimate', () => {
  let probeContactId = null;

  test('seed: Contact for estimate anchor', async ({ request }) => {
    const { token } = await getGenericAdmin(request);
    const ts = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} estimate-anchor`,
      email: `${RUN_TAG.toLowerCase()}-est-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Customer',
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    probeContactId = c.id;
    created.generic.contacts.push(c.id);
  });

  test('POST /api/estimates emits AuditLog Estimate CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/estimates', {
      title: `${RUN_TAG} est-create`,
      contactId: probeContactId,
      lineItems: [{ description: 'Probe item', quantity: 1, unitPrice: 50 }],
    });
    expect(res.status(), `estimate create: ${await res.text()}`).toBe(201);
    const est = await res.json();
    created.generic.estimates.push(est.id);

    const row = await findAuditRow(request, token, 'Estimate', 'CREATE', est.id);
    expectAuditShape(row, { entity: 'Estimate', action: 'CREATE', entityId: est.id, userId, tenantId });
  });

  test('PUT /api/estimates/:id emits AuditLog Estimate UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/estimates', {
      title: `${RUN_TAG} est-update`,
      contactId: probeContactId,
      lineItems: [{ description: 'Probe item', quantity: 1, unitPrice: 50 }],
    });
    expect(create.status()).toBe(201);
    const est = await create.json();
    created.generic.estimates.push(est.id);

    const upd = await put(request, token, `/api/estimates/${est.id}`, {
      title: `${RUN_TAG} est-update-renamed`,
    });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Estimate', 'UPDATE', est.id);
    expectAuditShape(row, { entity: 'Estimate', action: 'UPDATE', entityId: est.id, userId, tenantId });
  });

  test('DELETE /api/estimates/:id emits AuditLog Estimate SOFT_DELETE row (#167)', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/estimates', {
      title: `${RUN_TAG} est-delete`,
      contactId: probeContactId,
      lineItems: [{ description: 'Probe item', quantity: 1, unitPrice: 50 }],
    });
    expect(create.status()).toBe(201);
    const est = await create.json();

    const delRes = await del(request, token, `/api/estimates/${est.id}`);
    expect([200, 204]).toContain(delRes.status());

    const row = await findAuditRow(request, token, 'Estimate', 'SOFT_DELETE', est.id);
    expectAuditShape(row, { entity: 'Estimate', action: 'SOFT_DELETE', entityId: est.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Task audit emissions
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Task', () => {
  test('POST /api/tasks emits AuditLog Task CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/tasks', {
      title: `${RUN_TAG} task-create`,
      priority: 'Medium',
    });
    expect(res.status(), `task create: ${await res.text()}`).toBe(201);
    const t = await res.json();
    created.generic.tasks.push(t.id);

    const row = await findAuditRow(request, token, 'Task', 'CREATE', t.id);
    expectAuditShape(row, { entity: 'Task', action: 'CREATE', entityId: t.id, userId, tenantId });
  });

  test('PUT /api/tasks/:id emits AuditLog Task UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/tasks', {
      title: `${RUN_TAG} task-update`,
      priority: 'Medium',
    });
    expect(create.status()).toBe(201);
    const t = await create.json();
    created.generic.tasks.push(t.id);

    const upd = await put(request, token, `/api/tasks/${t.id}`, { priority: 'High' });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Task', 'UPDATE', t.id);
    expectAuditShape(row, { entity: 'Task', action: 'UPDATE', entityId: t.id, userId, tenantId });
  });

  test('DELETE /api/tasks/:id emits AuditLog Task SOFT_DELETE row (#167)', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/tasks', {
      title: `${RUN_TAG} task-delete`,
    });
    expect(create.status()).toBe(201);
    const t = await create.json();

    const delRes = await del(request, token, `/api/tasks/${t.id}`);
    expect([200, 204]).toContain(delRes.status());

    const row = await findAuditRow(request, token, 'Task', 'SOFT_DELETE', t.id);
    expectAuditShape(row, { entity: 'Task', action: 'SOFT_DELETE', entityId: t.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Notification audit emissions
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Notification', () => {
  test('POST /api/notifications (admin → other user) emits AuditLog Notification CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    // Self-targeted notify is intentionally NOT audited per #179
    // (too noisy). Cross-user IS audited. Use a different known user
    // in the same tenant: user@crm.com.
    const ulogin = await loginAs(request, 'user@crm.com', 'password123');
    expect(ulogin.userId, 'cross-user target seed login').toBeTruthy();
    const res = await post(request, token, '/api/notifications', {
      targetUserId: ulogin.userId,
      title: `${RUN_TAG} notif-create`,
      message: 'Audit-coverage probe — cross-user notification',
      type: 'info',
    });
    expect(res.status(), `notification create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    // Response shape from notify(): the created Notification row
    const notifId = body.id || (body.notification && body.notification.id);
    expect(notifId, `notification id surfaced in response: ${JSON.stringify(body).slice(0, 200)}`).toBeTruthy();
    created.generic.notifications.push(notifId);

    const row = await findAuditRow(request, token, 'Notification', 'CREATE', notifId);
    expectAuditShape(row, { entity: 'Notification', action: 'CREATE', entityId: notifId, userId, tenantId });
  });

  test('DELETE /api/notifications/:id emits AuditLog Notification DELETE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    // Self-target so we own the row — self-target is NOT audited on
    // CREATE (per #179 rule), so the only audit row for this id should
    // be the DELETE one. Perfect anchor.
    const res = await post(request, token, '/api/notifications', {
      targetUserId: userId,
      title: `${RUN_TAG} notif-delete`,
      message: 'Audit-coverage probe — self-notify for delete',
      type: 'info',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    const notifId = body.id || (body.notification && body.notification.id);
    expect(notifId).toBeTruthy();

    const delRes = await del(request, token, `/api/notifications/${notifId}`);
    // #550: notifications DELETE → 204 No Content
    expect([200, 204]).toContain(delRes.status());

    const row = await findAuditRow(request, token, 'Notification', 'DELETE', notifId);
    expectAuditShape(row, { entity: 'Notification', action: 'DELETE', entityId: notifId, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pipeline audit emissions (closed by #568)
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Pipeline', () => {
  test('POST /api/pipelines emits AuditLog Pipeline CREATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const res = await post(request, token, '/api/pipelines', {
      name: `${RUN_TAG} pipeline-create`,
      description: 'Audit-coverage probe',
    });
    expect(res.status(), `pipeline create: ${await res.text()}`).toBe(201);
    const p = await res.json();
    created.generic.pipelines.push(p.id);

    const row = await findAuditRow(request, token, 'Pipeline', 'CREATE', p.id);
    expectAuditShape(row, { entity: 'Pipeline', action: 'CREATE', entityId: p.id, userId, tenantId });
  });

  test('PUT /api/pipelines/:id emits AuditLog Pipeline UPDATE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    const create = await post(request, token, '/api/pipelines', {
      name: `${RUN_TAG} pipeline-update`,
    });
    expect(create.status()).toBe(201);
    const p = await create.json();
    created.generic.pipelines.push(p.id);

    const upd = await put(request, token, `/api/pipelines/${p.id}`, {
      description: 'Updated by audit-coverage probe',
    });
    expect(upd.status()).toBe(200);

    const row = await findAuditRow(request, token, 'Pipeline', 'UPDATE', p.id);
    expectAuditShape(row, { entity: 'Pipeline', action: 'UPDATE', entityId: p.id, userId, tenantId });
  });

  test('DELETE /api/pipelines/:id emits AuditLog Pipeline DELETE row', async ({ request }) => {
    const { token, userId, tenantId } = await getGenericAdmin(request);
    // Create a fresh non-default pipeline with no deals so DELETE succeeds.
    const create = await post(request, token, '/api/pipelines', {
      name: `${RUN_TAG} pipeline-delete`,
      description: 'Deletion probe',
    });
    expect(create.status()).toBe(201);
    const p = await create.json();
    // Don't push to cleanup — DELETE is the test action.

    // The route blocks deleting the default pipeline (400). A fresh tenant's
    // first pipeline becomes default; subsequent ones do not. The generic
    // tenant already has a default seed pipeline, so this one is non-default
    // and child-free → 200 success path.
    const delRes = await del(request, token, `/api/pipelines/${p.id}`);
    expect(delRes.status(), `pipeline delete: ${await delRes.text()}`).toBe(200);

    const row = await findAuditRow(request, token, 'Pipeline', 'DELETE', p.id);
    expectAuditShape(row, { entity: 'Pipeline', action: 'DELETE', entityId: p.id, userId, tenantId });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Auth logout — tracked-not-gated per #180
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — Auth logout (#569)', () => {
  test('POST /api/auth/logout emits AuditLog User LOGOUT row', async ({ request }) => {
    // Get a fresh token to revoke (don't burn the cached admin token).
    const fresh = await loginAs(request, 'admin@globussoft.com', 'password123');
    expect(fresh.token, 'fresh login for logout probe').toBeTruthy();

    const logoutRes = await request.post(`${BASE_URL}/api/auth/logout`, {
      headers: headers(fresh.token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(logoutRes.status()).toBe(200);
    const body = await logoutRes.json();
    expect(body.ok).toBe(true);

    // #569: routes/auth.js logout handler now emits writeAudit('User',
    // 'LOGOUT', ...) alongside the RevokedToken upsert. Hard-assert the
    // row exists, scoped to this fresh-login user. Use cached admin
    // token for the audit read (the fresh token is now revoked).
    const { token, tenantId: adminTenantId } = await getGenericAdmin(request);
    const auditRes = await get(request, token, `/api/audit?entity=User&action=LOGOUT`);
    expect(auditRes.status()).toBe(200);
    const rows = await auditRes.json();
    const recent = rows.find((r) => r.userId === fresh.userId && r.entityId === fresh.userId);
    expectAuditShape(recent, {
      entity: 'User',
      action: 'LOGOUT',
      entityId: fresh.userId,
      userId: fresh.userId,
      tenantId: adminTenantId,
    });
  });

  test('POST /api/auth/logout returns 200 + revokes the JWT (#528 contract)', async ({ request }) => {
    // Independent assertion of the JWT-revocation half of #180. The
    // logout endpoint must mark the token as revoked AND subsequent
    // calls with that token must 401. This is the security-critical
    // half — the audit emission above is the discoverability half.
    const fresh = await loginAs(request, 'admin@globussoft.com', 'password123');
    expect(fresh.token).toBeTruthy();

    const logoutRes = await request.post(`${BASE_URL}/api/auth/logout`, {
      headers: headers(fresh.token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(logoutRes.status()).toBe(200);

    // Subsequent call with the revoked token → 401 (token blacklisted)
    const probe = await request.get(`${BASE_URL}/api/notifications/unread-count`, {
      headers: headers(fresh.token),
      timeout: REQUEST_TIMEOUT,
    });
    // Accept 401 (verifyToken sees revoked jti) or 403 (legacy token
    // path with no jti — still revokable per the route's reason
    // 'legacy_token_no_jti', but the request continues with the cached
    // JWT signature). The test environment uses the new signSessionToken
    // helper so 401 is the expected outcome.
    expect([401, 403]).toContain(probe.status());
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cross-cutting: actor + tenant scope sanity
// ─────────────────────────────────────────────────────────────────────

test.describe('Audit coverage — actor + tenant scope sanity', () => {
  test('audit row userId matches the requester userId', async ({ request }) => {
    const { token, userId } = await getGenericAdmin(request);
    const ts = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} actor-probe`,
      email: `${RUN_TAG.toLowerCase()}-actor-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    created.generic.contacts.push(c.id);

    const row = await findAuditRow(request, token, 'Contact', 'CREATE', c.id);
    expect(row).not.toBeNull();
    expect(row.userId, 'audit row attributes the action to the calling user').toBe(userId);
  });

  test('audit row tenantId matches the requester tenantId', async ({ request }) => {
    const { token, tenantId } = await getGenericAdmin(request);
    const ts = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} tenant-probe`,
      email: `${RUN_TAG.toLowerCase()}-tenant-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    created.generic.contacts.push(c.id);

    const row = await findAuditRow(request, token, 'Contact', 'CREATE', c.id);
    expect(row).not.toBeNull();
    expect(row.tenantId, 'audit row scoped to requester tenant').toBe(tenantId);
  });

  test('audit row lands within 2s of the response (write is non-blocking but synchronous)', async ({ request }) => {
    test.skip(!IS_LOCAL_STACK, 'timing-budget assertion sensitive to 8-shard demo contention — runs in the per-push gate (local stack)');
    const { token } = await getGenericAdmin(request);
    const ts = Date.now();
    const t0 = Date.now();
    const res = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} timing-probe`,
      email: `${RUN_TAG.toLowerCase()}-timing-${ts}@e2e.test`,
      phone: `+1555${String(ts).slice(-7)}`,
      status: 'Lead',
    });
    expect(res.status()).toBe(201);
    const c = await res.json();
    created.generic.contacts.push(c.id);

    const row = await findAuditRow(request, token, 'Contact', 'CREATE', c.id);
    expect(row, 'audit row must be readable within 2s of response').not.toBeNull();
    const elapsed = Date.now() - t0;
    expect(elapsed, `total response+audit-poll under 5s (was ${elapsed}ms)`).toBeLessThan(5000);
  });
});
