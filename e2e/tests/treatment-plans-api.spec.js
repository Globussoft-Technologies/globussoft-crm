// @ts-check
/**
 * Treatment Plans — backend coverage push for controllers/treatmentPlanController.js.
 *
 * Pre-spec coverage on controllers/treatmentPlanController.js was 8.98% (8/89
 * lines). The controller has only two handlers but ~89 lines of error-paths,
 * audit calls, tenant-scope guards, and shape-validation branches. This suite
 * exercises every branch in both handlers plus the related route surface in
 * routes/wellness.js (POST /treatments, PUT /treatment-plans/:id,
 * GET /activetreatment, GET /patients/:id/treatment-plans).
 *
 * Endpoints covered:
 *   GET    /api/wellness/activetreatment              — controller getAllTreatmentPlans
 *   PUT    /api/wellness/treatment-plans/:id          — controller updateTreatmentPlan
 *   POST   /api/wellness/treatments                   — route create
 *   GET    /api/wellness/treatments                   — route list (filter sanity)
 *   GET    /api/wellness/patients/:id/treatment-plans — nested-resource read (#346)
 *
 * Branches exercised in controllers/treatmentPlanController.js:
 *   getAllTreatmentPlans:
 *     - happy path: returns {success, count, data:[…]} with patient + service joined
 *     - tenant-scope WHERE: only the caller's tenantId rows
 *     - orderBy id desc (newest first since schema lacks createdAt)
 *     - 401 when token has no tenant (we cannot easily forge that, so we
 *       assert the no-token gate which collapses to the same outcome — see
 *       the auth-gate describe block)
 *   updateTreatmentPlan:
 *     - 400 when status missing in body
 *     - 400 when id is missing — covered indirectly by Express routing (a
 *       missing :id won't match the route at all, so this branch is
 *       defensive-only; we cover the remaining error paths instead)
 *     - 404 when id is unknown OR belongs to another tenant
 *     - happy path: status flip returns {success, data:{patient,service,…}}
 *     - audit row written (we don't read the audit table directly, but the
 *       try/catch around writeAudit is exercised on the happy path)
 *     - 500-safe: a malformed numeric id is parsed by parseInt; a string id
 *       like "not-a-number" yields NaN → findFirst({id:NaN}) → null → 404
 *
 * RBAC gates (#280/#324/#326 — closed earlier today):
 *   GET  /activetreatment       — verifyWellnessRole(["doctor","professional","manager","admin"])
 *   PUT  /treatment-plans/:id   — requireClinicalRole (doctor or ADMIN only)
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js.
 * Test data is tagged `E2E_TP_<ts>` so global-teardown can scrub plus the
 * afterAll cleanup explicitly nulls/marks our rows. TreatmentPlan has no
 * DELETE endpoint by policy (clinical-artefact retention; see the comment
 * block at routes/wellness.js:171-196), so cleanup re-purposes status to
 * `cancelled` instead of hard-delete.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

// Cache one token per fixture so we don't slam /auth/login on every test.
const tokenCache = {};
const RUN_TAG = `E2E_TP_${Date.now()}`;

const FIXTURES = {
  // Wellness owner — ADMIN role, no wellnessRole. Passes verifyWellnessRole
  // ("admin" special token) and requireClinicalRole (ADMIN bypass).
  rishu:      { email: 'rishu@enhancedwellness.in',     password: 'password123' },
  // Clinical doctor — USER + wellnessRole=doctor. Passes both gates.
  drharsh:    { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
  // Clinic manager — MANAGER role, no wellnessRole. Passes verifyWellnessRole
  // (manager token) on GET /activetreatment but FAILS requireClinicalRole.
  manager:    { email: 'manager@enhancedwellness.in',   password: 'password123' },
  // Telecaller — USER + wellnessRole=telecaller. Fails BOTH gates.
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  // Helper — USER + wellnessRole=helper. Fails BOTH gates.
  helper:     { email: 'helper1@enhancedwellness.in',   password: 'password123' },
  // Stylist (professional) — passes GET /activetreatment but FAILS PUT.
  stylist:    { email: 'stylist1@enhancedwellness.in',  password: 'password123' },
  // Generic-tenant admin — different tenantId, used for tenant-scope test.
  generic:    { email: 'admin@globussoft.com',          password: 'password123' },
};

async function login(request, fixtureKey) {
  if (tokenCache[fixtureKey]) return tokenCache[fixtureKey];
  const fixture = FIXTURES[fixtureKey];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        tokenCache[fixtureKey] = data.token;
        return tokenCache[fixtureKey];
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = async (request, who = 'rishu') => ({
  Authorization: `Bearer ${await login(request, who)}`,
});

async function authGet(request, path, who = 'rishu') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'rishu') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body, who = 'rishu') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path, who = 'rishu') {
  return request.delete(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}

// Track every treatment-plan id we create. afterAll marks them
// status=cancelled (the only "delete" the policy permits — clinical-artefact
// retention forbids hard-delete; see routes/wellness.js:171-196).
const createdPlanIds = [];
const createdPatientIds = [];

// State that depends on seeded data being present.
let seededPatientId = null;
let seededServiceId = null;

test.beforeAll(async ({ request }) => {
  // Discover a seeded patient + service to attach test plans to. The seed
  // (`prisma/seed-wellness.js`) creates several of each; we don't care which.
  const pats = await authGet(request, '/api/wellness/patients?limit=5');
  expect(pats.status(), 'patients list seeded').toBe(200);
  const patBody = await pats.json();
  const list = Array.isArray(patBody) ? patBody : patBody.patients;
  expect(list && list.length > 0, 'seed-wellness must have created at least one patient').toBeTruthy();
  seededPatientId = list[0].id;

  const svc = await authGet(request, '/api/wellness/services');
  expect(svc.status()).toBe(200);
  const services = await svc.json();
  expect(services.length, 'seed-wellness must have created at least one service').toBeGreaterThan(0);
  seededServiceId = services[0].id;
});

test.afterAll(async ({ request }) => {
  // Best-effort cleanup. TreatmentPlan rows are NEVER hard-deleted — flag
  // them via the controller's PUT so they are clearly out-of-band test data.
  for (const id of createdPlanIds) {
    await authPut(request, `/api/wellness/treatment-plans/${id}`, { status: 'cancelled' }).catch(() => {});
  }
  for (const id of createdPatientIds) {
    // Patient cleanup — also out-of-band; PUT with name marker so any human
    // reviewing the row can tell it was test data even if PATCH/DELETE aren't
    // permitted by the production policy.
    await authPut(request, `/api/wellness/patients/${id}`, {
      name: `${RUN_TAG}_CLEANED_${id}`,
    }).catch(() => {});
  }
});

// ── factories ──────────────────────────────────────────────────────────

async function createPlan(request, overrides = {}) {
  const res = await authPost(request, '/api/wellness/treatments', {
    name: `${RUN_TAG} ${overrides.name || 'plan'}`,
    totalSessions: overrides.totalSessions ?? 6,
    totalPrice: overrides.totalPrice ?? 12000,
    patientId: overrides.patientId ?? seededPatientId,
    serviceId: overrides.serviceId ?? seededServiceId,
    nextDueAt: overrides.nextDueAt,
  });
  expect(res.status(), `plan create: ${await res.text()}`).toBe(201);
  const p = await res.json();
  createdPlanIds.push(p.id);
  return p;
}

// ─── GET /activetreatment (controller — getAllTreatmentPlans) ───────────

test.describe('TreatmentPlan controller — GET /activetreatment', () => {
  test('admin owner: returns {success,count,data} envelope', async ({ request }) => {
    // Pre-create one so count is deterministically >= 1.
    await createPlan(request, { name: 'envelope' });
    const res = await authGet(request, '/api/wellness/activetreatment');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.count).toBe(body.data.length);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  test('row shape includes patient + service joined', async ({ request }) => {
    const plan = await createPlan(request, { name: 'shape' });
    const res = await authGet(request, '/api/wellness/activetreatment');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const mine = body.data.find((p) => p.id === plan.id);
    expect(mine, 'created plan must appear in activetreatment list').toBeTruthy();
    expect(mine.patient).toBeTruthy();
    expect(mine.patient.id).toBe(seededPatientId);
    if (plan.serviceId) {
      expect(mine.service).toBeTruthy();
      expect(mine.service.id).toBe(plan.serviceId);
    }
  });

  test('orderBy id desc — newest plan appears first among ours', async ({ request }) => {
    const a = await createPlan(request, { name: 'order-A' });
    const b = await createPlan(request, { name: 'order-B' });
    const res = await authGet(request, '/api/wellness/activetreatment');
    const body = await res.json();
    const idxA = body.data.findIndex((p) => p.id === a.id);
    const idxB = body.data.findIndex((p) => p.id === b.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    // b was created after a → b.id > a.id → b appears earlier (smaller index).
    expect(idxB).toBeLessThan(idxA);
  });

  test('doctor wellnessRole: 200 (clinical read allowed)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/activetreatment', 'drharsh');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('manager: 200 (manager token bypasses verifyWellnessRole)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/activetreatment', 'manager');
    expect(res.status()).toBe(200);
  });

  test('professional (stylist): 200 (allowed by gate)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/activetreatment', 'stylist');
    expect(res.status()).toBe(200);
  });

  test('telecaller: 403 with WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/activetreatment', 'telecaller');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('helper: 403 with WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/activetreatment', 'helper');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('no auth header: 401/403 (global auth guard)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/activetreatment`);
    expect([401, 403]).toContain(res.status());
  });
});

// ─── PUT /treatment-plans/:id (controller — updateTreatmentPlan) ────────

test.describe('TreatmentPlan controller — PUT /treatment-plans/:id', () => {
  test('admin: flips status, returns {success,data:{patient,service,…}}', async ({ request }) => {
    const plan = await createPlan(request, { name: 'flip-status' });
    const res = await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, {
      status: 'paused',
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
    expect(body.data.id).toBe(plan.id);
    expect(body.data.status).toBe('paused');
    expect(body.data.patient).toBeTruthy();
    // service may be null if seededServiceId was undefined; otherwise present.
    if (plan.serviceId) expect(body.data.service).toBeTruthy();
  });

  test('doctor wellnessRole: passes requireClinicalRole and updates', async ({ request }) => {
    const plan = await createPlan(request, { name: 'doctor-update' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'completed' },
      'drharsh',
    );
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.status).toBe('completed');
  });

  test('manager: 403 CLINICAL_ROLE_REQUIRED (managers do not write clinical)', async ({ request }) => {
    const plan = await createPlan(request, { name: 'manager-blocked' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'paused' },
      'manager',
    );
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CLINICAL_ROLE_REQUIRED');
  });

  test('telecaller: 403 CLINICAL_ROLE_REQUIRED', async ({ request }) => {
    const plan = await createPlan(request, { name: 'telecaller-blocked' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'paused' },
      'telecaller',
    );
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CLINICAL_ROLE_REQUIRED');
  });

  test('professional (stylist): 403 CLINICAL_ROLE_REQUIRED', async ({ request }) => {
    const plan = await createPlan(request, { name: 'stylist-blocked' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'paused' },
      'stylist',
    );
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('CLINICAL_ROLE_REQUIRED');
  });

  test('helper: 403 CLINICAL_ROLE_REQUIRED', async ({ request }) => {
    const plan = await createPlan(request, { name: 'helper-blocked' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'paused' },
      'helper',
    );
    expect(res.status()).toBe(403);
  });

  test('400 when status missing from body', async ({ request }) => {
    const plan = await createPlan(request, { name: 'no-status' });
    const res = await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status required/i);
  });

  test('400 when status is empty string (falsy guard)', async ({ request }) => {
    const plan = await createPlan(request, { name: 'empty-status' });
    const res = await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, { status: '' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/status required/i);
  });

  test('404 on unknown plan id', async ({ request }) => {
    const res = await authPut(request, '/api/wellness/treatment-plans/99999999', {
      status: 'paused',
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('400 on non-numeric id (matches generic id validator on this router)', async ({ request }) => {
    // routes/wellness.js installs a router-level :id positive-int gate.
    // A string id never reaches the controller — gate returns 400 INVALID_ID.
    const res = await authPut(request, '/api/wellness/treatment-plans/not-a-number', {
      status: 'paused',
    });
    expect([400, 404]).toContain(res.status());
  });

  test('cross-tenant: generic admin cannot update wellness tenant plan (404)', async ({ request }) => {
    // Create as wellness owner, attempt update with generic-tenant admin —
    // verifyWellnessRole gate fails first (manager/admin special tokens key
    // off req.user.role; the generic admin IS ADMIN so it actually PASSES
    // verifyWellnessRole — but the controller's tenantId scope rejects).
    const plan = await createPlan(request, { name: 'cross-tenant' });
    const res = await authPut(
      request,
      `/api/wellness/treatment-plans/${plan.id}`,
      { status: 'paused' },
      'generic',
    );
    // findFirst({id, tenantId:<generic>}) → null → 404. (If the generic
    // admin lacks the wellness vertical entirely, server may also 403.)
    expect([403, 404]).toContain(res.status());
  });

  test('repeated update (idempotent): same status twice returns 200 both times', async ({ request }) => {
    const plan = await createPlan(request, { name: 'idempotent' });
    const r1 = await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, {
      status: 'paused',
    });
    expect(r1.status()).toBe(200);
    const r2 = await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, {
      status: 'paused',
    });
    expect(r2.status()).toBe(200);
    expect((await r2.json()).data.status).toBe('paused');
  });

  test('no auth header: 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/wellness/treatment-plans/1`, {
      data: { status: 'paused' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── POST /treatments (route — create) ──────────────────────────────────

test.describe('Treatment routes — POST /treatments', () => {
  test('happy path: creates a plan and returns 201 with id', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} happy`,
      totalSessions: 4,
      totalPrice: 8000,
      patientId: seededPatientId,
      serviceId: seededServiceId,
    });
    expect(res.status()).toBe(201);
    const plan = await res.json();
    createdPlanIds.push(plan.id);
    expect(plan.id).toBeTruthy();
    expect(plan.totalSessions).toBe(4);
    expect(parseFloat(plan.totalPrice)).toBeCloseTo(8000, 2);
    expect(plan.patientId).toBe(seededPatientId);
  });

  test('400 when name missing', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      totalSessions: 4,
      patientId: seededPatientId,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name.*totalSessions.*patientId/i);
  });

  test('400 when patientId missing', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} no-pat`,
      totalSessions: 4,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when totalSessions missing', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} no-sessions`,
      patientId: seededPatientId,
    });
    expect(res.status()).toBe(400);
  });

  test('400 when totalSessions is 0 (falsy)', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} zero-sessions`,
      totalSessions: 0,
      patientId: seededPatientId,
    });
    // The route validator does `!totalSessions` so 0 is rejected. If the
    // schema later changes to allow 0, this test will need updating.
    expect(res.status()).toBe(400);
  });

  test('serviceId optional: omit → null on the row', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} no-service`,
      totalSessions: 2,
      patientId: seededPatientId,
    });
    expect(res.status()).toBe(201);
    const plan = await res.json();
    createdPlanIds.push(plan.id);
    expect(plan.serviceId == null).toBe(true);
  });

  test('totalPrice defaults to 0 when omitted', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} no-price`,
      totalSessions: 3,
      patientId: seededPatientId,
    });
    expect(res.status()).toBe(201);
    const plan = await res.json();
    createdPlanIds.push(plan.id);
    expect(parseFloat(plan.totalPrice || 0)).toBe(0);
  });

  test('nextDueAt accepted as ISO string', async ({ request }) => {
    const due = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} due`,
      totalSessions: 5,
      patientId: seededPatientId,
      nextDueAt: due,
    });
    expect(res.status()).toBe(201);
    const plan = await res.json();
    createdPlanIds.push(plan.id);
    expect(plan.nextDueAt).toBeTruthy();
  });

  test('tenantId is server-stamped — request body cannot override it', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/treatments', {
      name: `${RUN_TAG} tenant-stamp`,
      totalSessions: 2,
      patientId: seededPatientId,
      tenantId: 99999, // ignored by handler
    });
    expect(res.status()).toBe(201);
    const plan = await res.json();
    createdPlanIds.push(plan.id);
    expect(plan.tenantId).not.toBe(99999);
  });
});

// ─── GET /treatments (route — list) ─────────────────────────────────────

test.describe('Treatment routes — GET /treatments', () => {
  test('returns array with patient + service trimmed selects', async ({ request }) => {
    const plan = await createPlan(request, { name: 'list-includes' });
    const res = await authGet(request, '/api/wellness/treatments');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const mine = list.find((p) => p.id === plan.id);
    expect(mine).toBeTruthy();
    expect(mine.patient).toMatchObject({ id: seededPatientId });
    // The list endpoint uses `select` not `include` — phone is exposed but
    // other PHI fields are NOT.
    expect(Object.keys(mine.patient).sort()).toEqual(['id', 'name', 'phone'].sort());
  });

  test('?patientId filter narrows the result set', async ({ request }) => {
    await createPlan(request, { name: 'filter-A' });
    const res = await authGet(request, `/api/wellness/treatments?patientId=${seededPatientId}`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    for (const row of list) {
      expect(row.patientId).toBe(seededPatientId);
    }
  });

  test('?status filter applied against created status (default may be null/active)', async ({ request }) => {
    // Create plan, set its status, then filter — round-trip exercise.
    const plan = await createPlan(request, { name: 'status-filter' });
    await authPut(request, `/api/wellness/treatment-plans/${plan.id}`, { status: 'paused' });
    const res = await authGet(request, '/api/wellness/treatments?status=paused');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.find((p) => p.id === plan.id)).toBeTruthy();
    for (const row of list) expect(row.status).toBe('paused');
  });
});

// ─── GET /patients/:id/treatment-plans (#346 nested-resource) ───────────

test.describe('Treatment routes — GET /patients/:id/treatment-plans', () => {
  test('returns array for an existing patient', async ({ request }) => {
    const plan = await createPlan(request, { name: 'nested' });
    const res = await authGet(
      request,
      `/api/wellness/patients/${seededPatientId}/treatment-plans`,
    );
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((p) => p.id === plan.id)).toBeTruthy();
  });

  test('every row carries the trimmed patient + service select', async ({ request }) => {
    await createPlan(request, { name: 'nested-shape' });
    const list = await (
      await authGet(request, `/api/wellness/patients/${seededPatientId}/treatment-plans`)
    ).json();
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(row.patient).toMatchObject({ id: seededPatientId });
      // service may be null when serviceId is null
      if (row.serviceId) {
        expect(row.service).toBeTruthy();
        expect(typeof row.service.name).toBe('string');
      }
    }
  });

  test('404 on unknown patient id', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/patients/99999999/treatment-plans');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('400 on non-numeric patient id (router :id gate)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/patients/abc/treatment-plans');
    expect([400, 404]).toContain(res.status());
  });

  test('telecaller: route is not in the wellness-role gated list — should still 401/403/200', async ({ request }) => {
    // The nested-resource endpoint inherits the global auth guard but does
    // NOT carry an explicit verifyWellnessRole gate. We simply assert it
    // does not 5xx for a non-admin wellness user; tenant scope is honored.
    const res = await authGet(
      request,
      `/api/wellness/patients/${seededPatientId}/treatment-plans`,
      'telecaller',
    );
    expect([200, 401, 403]).toContain(res.status());
  });
});

// ─── Tenant scope — controller getAllTreatmentPlans ─────────────────────

test.describe('TreatmentPlan controller — tenant scope', () => {
  test('generic admin sees zero (or none of) wellness-tenant plans', async ({ request }) => {
    // Plant a wellness-tenant plan with our distinctive RUN_TAG.
    const plan = await createPlan(request, { name: 'tenant-isolation' });
    const res = await authGet(request, '/api/wellness/activetreatment', 'generic');
    // Two acceptable outcomes:
    //   (a) 403 — generic admin lacks wellness vertical, gate denies. The
    //       verifyWellnessRole "admin" alias passes for ANY ADMIN, so this
    //       is unlikely UNLESS a higher-level tenant-vertical gate fires.
    //   (b) 200 with body.data filtered to that admin's tenant only — our
    //       wellness plan must NOT appear.
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.data.find((p) => p.id === plan.id)).toBeFalsy();
    } else {
      expect([401, 403]).toContain(res.status());
    }
  });
});
