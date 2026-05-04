// @ts-check
/**
 * Wellness read-audit contract — T2.2 from TODOS.md.
 *
 * Pins the PHI-read audit-trail invariant for routes/wellness.js. PRD §11
 * (HIPAA / DPDP Act) requires every read of a patient record to surface in
 * AuditLog. Patient / Patient/:id / Patient/:id/{visits,prescriptions,
 * consents,treatment-plans} / Visit/:id detail / Prescription PDF /
 * Consent PDF / portal/me / portal/visits / portal/prescriptions were
 * already wired (commits during v3.2.1 + v3.2.5 audit landings). The 6
 * endpoints below were the residual gap — staff-side cross-patient list
 * views + the consumption + treatment-plan detail paths — none of which
 * fired writeAudit until v3.4.7 follow-up:
 *
 *   GET /api/wellness/visits                       → VISIT_LIST_READ
 *   GET /api/wellness/visits/:id/consumptions      → VISIT_CONSUMPTIONS_READ
 *   GET /api/wellness/prescriptions                → PRESCRIPTION_LIST_READ
 *   GET /api/wellness/consents                     → CONSENT_LIST_READ
 *   GET /api/wellness/treatment-plans              → TREATMENT_PLAN_LIST_READ
 *   GET /api/wellness/treatment-plans/:id          → TREATMENT_PLAN_READ
 *
 * Spec contract:
 *   - Each read endpoint MUST emit exactly one audit row per request.
 *   - Audit row tenantId === requesting wellness admin's tenantId.
 *   - userId === requesting admin's User.id (no actorType=patient on staff path).
 *   - details payload contains the documented filter/echo fields (count for
 *     lists, ids for details).
 *   - Audit failure must NEVER surface as an HTTP 500 — the user-facing
 *     response is unaffected by audit-write hiccups (writeAudit catches
 *     internally, but we assert 200 even when audit isn't reachable
 *     conceptually — every assertion below pairs an expected 200 with
 *     audit-row presence).
 *
 * Why this spec is in the per-push gate, not e2e-full:
 *   This is the regression-guard for compliance. A future refactor that
 *   accidentally drops a writeAudit call (or moves it before the early
 *   return on 404) breaks the PRD §11 invariant — the per-push gate
 *   surfaces it within ~3 minutes instead of waiting for the next tag.
 *
 * Pattern: cached-token + post/get helpers identical to audit-api.spec.js.
 * Test data tagged `E2E_WC_AUDIT_<ts>` — caught by the shared
 * NAME_REGEX_SQL in e2e/test-data-patterns.js (the `^E2E_WC_` prefix is
 * already on the list).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_WC_AUDIT_${Date.now()}`;

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
        return { token: j.token, userId: j.user && j.user.id, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null, tenantId: null };
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

// Find the most-recent audit row for (entity, action) in the requester's
// tenant whose createdAt >= afterMs. Returns null if not found within
// the first /api/audit page (cap=100 per routes/audit.js).
async function findAuditRow(request, token, entity, action, afterMs) {
  const r = await get(request, token, `/api/audit?entity=${encodeURIComponent(entity)}&action=${encodeURIComponent(action)}`);
  if (!r.ok()) return null;
  const rows = await r.json();
  const list = Array.isArray(rows) ? rows : (rows.audit || rows.data || []);
  const candidates = list.filter((row) => {
    const created = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    return created >= afterMs;
  });
  // Newest first (server returns desc) — pick the first match.
  return candidates[0] || null;
}

// Track ids for rename-on-cleanup teardown. Patient/Visit/TreatmentPlan
// have no DELETE per #21 (clinical-no-delete cluster). Names start
// with E2E_WC_AUDIT_ so global-teardown.js's NAME_REGEX_SQL deletes
// them on the next CI tear-down (the `^E2E_WC_` prefix is already on
// the canonical pattern list).
const seededIds = { patientId: null, visitId: null, planId: null };

test.beforeAll(async ({ request }) => {
  const { token, tenantId } = await getWellnessAdmin(request);
  expect(token, 'wellness admin token').toBeTruthy();
  expect(tenantId, 'wellness admin tenantId').toBeGreaterThan(0);

  // Seed Patient → Visit → TreatmentPlan so detail endpoints have real ids.
  const ts = Date.now();
  const phone = `+91876${String(ts).slice(-7)}`;
  const pRes = await post(request, token, '/api/wellness/patients', {
    name: `${RUN_TAG} Patient`,
    phone,
  });
  expect(pRes.status(), 'seed patient').toBeLessThan(300);
  seededIds.patientId = (await pRes.json()).id;

  // Pick any active service for the visit (don't depend on a specific id).
  const sRes = await get(request, token, '/api/wellness/services?limit=1');
  const services = sRes.ok() ? await sRes.json() : [];
  const serviceId = (services[0] || {}).id || null;

  // Seed Visit. routes/wellness.js POST /visits (lines 859-864) requires
  // BOTH serviceId AND doctorId when status is "completed" (or "in-treatment").
  // We don't care about the visit's clinical correctness for this audit
  // contract spec — we just need a Visit row to exist so VISIT_LIST_READ
  // returns a non-empty list and the audit row is generated.
  // Using status:'booked' bypasses the completed-visit constraints
  // (per the same lines, "Booked/cancelled/no-show statuses can be partial").
  const vRes = await post(request, token, '/api/wellness/visits', {
    patientId: seededIds.patientId,
    serviceId,
    visitDate: new Date().toISOString(),
    status: 'booked',
    amountCharged: 1000,
  });
  expect(vRes.status(), 'seed visit').toBeLessThan(300);
  seededIds.visitId = (await vRes.json()).id;

  // Seed a treatment plan referencing the patient.
  const planRes = await post(request, token, '/api/wellness/treatment-plans', {
    name: `${RUN_TAG} Plan`,
    totalSessions: 4,
    totalPrice: 5000,
    patientId: seededIds.patientId,
    serviceId,
  });
  expect(planRes.status(), 'seed treatment-plan').toBeLessThan(300);
  seededIds.planId = (await planRes.json()).id;
});

test.afterAll(async ({ request }) => {
  const { token } = await getWellnessAdmin(request);
  if (!token) return;
  // Visit + Patient + TreatmentPlan have no DELETE. Names already start
  // with E2E_WC_AUDIT_ so global-teardown.js scrubs them on next CI run.
  // Best-effort: rename to make the residue self-evident on demo if the
  // CI scrub doesn't run before the next QA pass.
  if (seededIds.planId) {
    await put(request, token, `/api/wellness/treatment-plans/${seededIds.planId}`, {
      name: `_teardown_wc_audit_${seededIds.planId}`,
    }).catch(() => {});
  }
  if (seededIds.patientId) {
    await put(request, token, `/api/wellness/patients/${seededIds.patientId}`, {
      name: `_teardown_wc_audit_${seededIds.patientId}`,
    }).catch(() => {});
  }
});

test.describe('Wellness PHI-read audit contract — T2.2', () => {
  test('GET /visits emits VISIT_LIST_READ with count + filters', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    const before = Date.now();
    const r = await get(request, token, '/api/wellness/visits?limit=10');
    expect(r.status(), 'GET /visits OK').toBe(200);

    // Wait briefly for the audit row to be persisted (writeAudit is awaited
    // inside the handler but the routes/audit.js read may race against the
    // INSERT commit on a busy demo).
    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'Visit', 'VISIT_LIST_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'VISIT_LIST_READ audit row exists').toBeTruthy();
    expect(row.tenantId, 'audit tenantId scoped to requester').toBe(tenantId);
    expect(row.userId, 'audit userId is the staff actor').toBe(userId);
    expect(row.entity).toBe('Visit');
    expect(row.action).toBe('VISIT_LIST_READ');
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    expect(typeof details.count, 'details.count').toBe('number');
    expect(details.filters, 'details.filters present').toBeTruthy();
  });

  test('GET /visits/:id/consumptions emits VISIT_CONSUMPTIONS_READ tied to visitId', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    expect(seededIds.visitId, 'seeded visit id').toBeGreaterThan(0);
    const before = Date.now();
    const r = await get(request, token, `/api/wellness/visits/${seededIds.visitId}/consumptions`);
    expect(r.status(), 'GET consumptions OK').toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'Visit', 'VISIT_CONSUMPTIONS_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'VISIT_CONSUMPTIONS_READ audit row exists').toBeTruthy();
    expect(row.tenantId).toBe(tenantId);
    expect(row.userId).toBe(userId);
    expect(row.entityId, 'entityId === visitId').toBe(seededIds.visitId);
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    expect(details.visitId).toBe(seededIds.visitId);
    expect(typeof details.count).toBe('number');
  });

  test('GET /prescriptions emits PRESCRIPTION_LIST_READ', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    const before = Date.now();
    const r = await get(request, token, '/api/wellness/prescriptions?limit=10');
    expect(r.status(), 'GET /prescriptions OK').toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'Prescription', 'PRESCRIPTION_LIST_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'PRESCRIPTION_LIST_READ audit row exists').toBeTruthy();
    expect(row.tenantId).toBe(tenantId);
    expect(row.userId).toBe(userId);
    expect(row.entity).toBe('Prescription');
  });

  test('GET /consents emits CONSENT_LIST_READ', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    const before = Date.now();
    const r = await get(request, token, '/api/wellness/consents?limit=10');
    expect(r.status(), 'GET /consents OK').toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'ConsentForm', 'CONSENT_LIST_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'CONSENT_LIST_READ audit row exists').toBeTruthy();
    expect(row.tenantId).toBe(tenantId);
    expect(row.userId).toBe(userId);
    expect(row.entity).toBe('ConsentForm');
  });

  test('GET /treatment-plans emits TREATMENT_PLAN_LIST_READ', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    const before = Date.now();
    const r = await get(request, token, '/api/wellness/treatment-plans');
    expect(r.status(), 'GET /treatment-plans OK').toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'TreatmentPlan', 'TREATMENT_PLAN_LIST_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'TREATMENT_PLAN_LIST_READ audit row exists').toBeTruthy();
    expect(row.tenantId).toBe(tenantId);
    expect(row.userId).toBe(userId);
    expect(row.entity).toBe('TreatmentPlan');
  });

  test('GET /treatment-plans/:id emits TREATMENT_PLAN_READ tied to plan id', async ({ request }) => {
    const { token, userId, tenantId } = await getWellnessAdmin(request);
    expect(seededIds.planId, 'seeded plan id').toBeGreaterThan(0);
    const before = Date.now();
    const r = await get(request, token, `/api/wellness/treatment-plans/${seededIds.planId}`);
    expect(r.status(), 'GET treatment-plan detail OK').toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'TreatmentPlan', 'TREATMENT_PLAN_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }

    expect(row, 'TREATMENT_PLAN_READ audit row exists').toBeTruthy();
    expect(row.tenantId).toBe(tenantId);
    expect(row.userId).toBe(userId);
    expect(row.entityId, 'entityId === planId').toBe(seededIds.planId);
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    expect(details.treatmentPlanId).toBe(seededIds.planId);
    expect(details.patientId).toBe(seededIds.patientId);
  });

  test('staff actorType is implicit user (no _actorType / _patientActorId in details)', async ({ request }) => {
    const { token } = await getWellnessAdmin(request);
    // Sanity check that the patient-portal indicator stays absent on staff
    // path. PATIENT_DETAIL_READ from /portal/me has _actorType:'patient',
    // _patientActorId:<id> in details; staff reads must NOT carry those
    // markers (otherwise the actor split is meaningless).
    const before = Date.now();
    const r = await get(request, token, '/api/wellness/visits?limit=1');
    expect(r.status()).toBe(200);

    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      row = await findAuditRow(request, token, 'Visit', 'VISIT_LIST_READ', before);
      if (!row) await new Promise((res) => setTimeout(res, 200));
    }
    expect(row, 'staff VISIT_LIST_READ row found').toBeTruthy();
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    expect(details._actorType, 'staff path must NOT mark actorType=patient').toBeUndefined();
    expect(details._patientActorId, 'staff path must NOT carry _patientActorId').toBeUndefined();
  });
});
