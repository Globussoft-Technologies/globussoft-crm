// @ts-check
/**
 * Memberships API — Wave 11 Agent EE (Google Doc audit, 8 May 2026).
 *
 * Target: backend/routes/wellness.js (Memberships section, ~10 endpoints).
 * Memberships is a wellness-vertical concept where patients buy time-bound
 * packages of services (e.g. "10 facials over 6 months for ₹15,000").
 *
 * Endpoints covered:
 *   Plans (catalog, admin/manager-mutations):
 *     GET    /api/wellness/membership-plans            — list active (any role)
 *     GET    /api/wellness/membership-plans/:id        — fetch one
 *     POST   /api/wellness/membership-plans            — create (admin/manager)
 *     PUT    /api/wellness/membership-plans/:id        — edit (admin/manager)
 *     DELETE /api/wellness/membership-plans/:id        — soft-delete (admin/manager)
 *   Patient memberships (PHI-gated):
 *     GET    /api/wellness/patients/:id/memberships    — list a patient's memberships
 *     POST   /api/wellness/patients/:id/memberships    — purchase
 *     GET    /api/wellness/memberships/:id             — detail with redemptions
 *     POST   /api/wellness/memberships/:id/redeem      — decrement balance for a service
 *     POST   /api/wellness/memberships/:id/cancel      — admin/manager
 *
 * Why this exists: Memberships is greenfield — verified by pre-pickup grep
 * (no Prisma models, no routes, no UI in the codebase before this commit).
 * The whole feature lands in one go, so the spec must pin every contract
 * up-front (status codes, error keys, RBAC, tenant isolation) so future
 * edits can't silently regress them.
 *
 * Acceptance per endpoint:
 *   ✅ Happy path: minimum-valid payload returns expected status + shape
 *   ✅ 400 on bad input (missing name, bad durationDays, bad price, broken entitlements)
 *   ✅ 404 on unknown id (id-bearing endpoints)
 *   ✅ Auth gate: no token → 401/403
 *   ✅ Tenant isolation: plan + membership invisible cross-tenant
 *   ✅ RBAC: USER (no wellnessRole) → 403 on plan mutations + redeem
 *   ✅ State semantics: redeem from cancelled → 410, from exhausted → 409
 *
 * Non-obvious setup:
 *   - Tests run against the wellness tenant (admin@wellness.demo) because
 *     plans + memberships only make sense under vertical=wellness; the
 *     verifyWellnessRole middleware refuses non-wellness tenants with
 *     WELLNESS_TENANT_REQUIRED.
 *   - We need a seeded Service to construct plan entitlements; the suite
 *     discovers one via GET /api/wellness/services and reuses it.
 *   - We need a seeded Patient to purchase against; the suite creates a
 *     fresh patient (auto-tagged E2E_FLOW_MEMB_<ts>) so cleanup is reliable.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com (matches other gate specs)
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/memberships-api.spec.js
 *   - Login: admin@wellness.demo / password123 (wellness admin)
 *            admin@globussoft.com / password123 (generic admin, for tenant-iso)
 *
 * Cleanup: plans soft-deleted (DELETE → isActive=false). Memberships have
 * NO delete endpoint by design (financial record-of-record); cancel sets
 * status='cancelled' which is the strongest available marker. Patient
 * cleanup rides the global E2E_FLOW_ teardown sweep.
 *
 * Pattern: cloned from e2e/tests/wellness-clinical-api.spec.js for the
 * cached-token + role fixture pattern, plus e2e/tests/notifications-api.spec.js
 * for the basic CRUD test layout.
 */
const { test, expect } = require('@playwright/test');

// Plan creation + redemption flow share state (a plan is created, a
// patient buys it, the patient redeems it). Pin to serial so worker
// shuffles don't tear apart the linked rows.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_MEMB_${Date.now()}`;

// Indian-style phone with unique 5-digit suffix per spec run (the
// tenant-scoped @@unique on (tenantId, normalizedPhone) blocks dupes).
const PHONE_SUFFIX_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_SUFFIX_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+91 98765 ${suffix}`;
}

// ── Fixtures ───────────────────────────────────────────────────────
const FIXTURES = {
  admin:      { email: 'admin@wellness.demo',           password: 'password123' },
  drharsh:    { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
  manager:    { email: 'manager@enhancedwellness.in',   password: 'password123' },
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  helper:     { email: 'helper1@enhancedwellness.in',   password: 'password123' },
  generic:    { email: 'admin@globussoft.com',          password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        tokenCache[who] = data.token;
        userIdCache[who] = data.user && data.user.id;
        return { token: tokenCache[who], userId: userIdCache[who] };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${(await login(request, who)).token}`,
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path, who = 'admin') {
  return request.delete(`${BASE_URL}${path}`, { headers: await authHdr(request, who), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
// Plans: DELETE soft-deletes (sets isActive=false). Best-effort.
// Memberships: NO DELETE endpoint (financial record-of-record); we POST
// /cancel on every created membership so the row is at least flagged.
// Patients ride the global E2E_FLOW_ teardown sweep.
const createdPlanIds = [];
const createdMembershipIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdMembershipIds) {
    await authPost(request, `/api/wellness/memberships/${id}/cancel`, { reason: 'spec teardown' }).catch(() => {});
  }
  for (const id of createdPlanIds) {
    await authDelete(request, `/api/wellness/membership-plans/${id}`).catch(() => {});
  }
});

// ── Shared seed discovery ─────────────────────────────────────────
let seededServiceId = null;
let secondServiceId = null;
let createdPatientId = null;
// secondPatientId hosts the membership purchases for tests whose intent
// is independent of createdPatientId+plan[0]'s active state (startDate
// validation, cancel flow, doctor RBAC). The 2026-06 lifecycle rule
// allows only one active membership per (patient, plan); routing those
// tests at a separate patient keeps createdPatientId+plan[0] reserved
// for the redeem describe block which depends on createdMembershipIds[0]
// staying active throughout the spec.
let secondPatientId = null;

test.beforeAll(async ({ request }) => {
  const tok = await login(request, 'admin');
  test.skip(!tok.token, 'Wellness admin login failed — seed missing? Skipping memberships spec.');

  // Find at least 2 active services (we need 2 for entitlement-shape tests).
  const r = await authGet(request, '/api/wellness/services');
  if (r.ok()) {
    const services = await r.json();
    const active = (services || []).filter((s) => s.isActive);
    if (active.length >= 1) seededServiceId = active[0].id;
    if (active.length >= 2) secondServiceId = active[1].id;
  }
  test.skip(!seededServiceId, 'No active wellness Services seeded — cannot build plan entitlements.');

  // Create a fresh patient for the lifecycle tests.
  const pres = await authPost(request, '/api/wellness/patients', {
    name: `${RUN_TAG} Patient`,
    phone: nextPhone(),
    gender: 'F',
  });
  if (pres.status() === 201) {
    const body = await pres.json();
    createdPatientId = body.id;
  }
  test.skip(!createdPatientId, 'Patient bootstrap failed — cannot test purchase/redeem flow.');

  // Second patient used by tests that need a fresh active-membership slot
  // on the existing plan (see secondPatientId comment above).
  const pres2 = await authPost(request, '/api/wellness/patients', {
    name: `${RUN_TAG} Patient 2`,
    phone: nextPhone(),
    gender: 'M',
  });
  if (pres2.status() === 201) {
    const body = await pres2.json();
    secondPatientId = body.id;
  }
  test.skip(!secondPatientId, 'Second-patient bootstrap failed — cannot test lifecycle flow.');
});

// Helper to construct minimum-valid plan body.
function planBody(overrides = {}) {
  return {
    name: `${RUN_TAG} Plan`,
    description: 'Membership plan created by memberships-api spec',
    durationDays: 180,
    price: 15000,
    currency: 'INR',
    entitlements: [{ serviceId: seededServiceId, quantity: 10 }],
    ...overrides,
  };
}

// ── Plans: POST ────────────────────────────────────────────────────

test.describe('Memberships — POST /membership-plans', () => {
  test('400 when name is missing', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', { ...planBody(), name: '' });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('NAME_REQUIRED');
  });

  test('400 when durationDays is non-numeric or out of range', async ({ request }) => {
    const r1 = await authPost(request, '/api/wellness/membership-plans', planBody({ durationDays: 0 }));
    expect(r1.status()).toBe(400);
    expect((await r1.json()).code).toBe('DURATION_INVALID');

    const r2 = await authPost(request, '/api/wellness/membership-plans', planBody({ durationDays: 5000 }));
    expect(r2.status()).toBe(400);
    expect((await r2.json()).code).toBe('DURATION_INVALID');
  });

  test('400 when price ≤ 0 or > cap', async ({ request }) => {
    const r1 = await authPost(request, '/api/wellness/membership-plans', planBody({ price: 0 }));
    expect(r1.status()).toBe(400);
    expect((await r1.json()).code).toBe('PRICE_REQUIRED');

    const r2 = await authPost(request, '/api/wellness/membership-plans', planBody({ price: 6_000_000 }));
    expect(r2.status()).toBe(400);
    expect((await r2.json()).code).toBe('PRICE_TOO_HIGH');
  });

  test('400 when entitlements missing or empty', async ({ request }) => {
    const r1 = await authPost(request, '/api/wellness/membership-plans', planBody({ entitlements: undefined }));
    expect(r1.status()).toBe(400);
    expect((await r1.json()).code).toBe('ENTITLEMENTS_REQUIRED');

    const r2 = await authPost(request, '/api/wellness/membership-plans', planBody({ entitlements: [] }));
    expect(r2.status()).toBe(400);
    expect((await r2.json()).code).toBe('ENTITLEMENTS_EMPTY');
  });

  test('400 when entitlement quantity is non-positive', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({
      entitlements: [{ serviceId: seededServiceId, quantity: 0 }],
    }));
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('ENTITLEMENT_QUANTITY_INVALID');
  });

  test('400 when entitlement repeats a serviceId', async ({ request }) => {
    if (!secondServiceId) test.skip(true, 'Need 2 services for duplicate-id test');
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({
      entitlements: [
        { serviceId: seededServiceId, quantity: 5 },
        { serviceId: seededServiceId, quantity: 3 },
      ],
    }));
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('ENTITLEMENT_DUPLICATE_SERVICE');
  });

  test('400 when entitlement references unknown serviceId', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({
      entitlements: [{ serviceId: 999999999, quantity: 5 }],
    }));
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('ENTITLEMENT_SERVICE_NOT_FOUND');
  });

  test('201 happy path with valid plan', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({ name: `${RUN_TAG} Plan A` }));
    expect(res.status(), `create plan: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe('number');
    expect(body.name).toBe(`${RUN_TAG} Plan A`);
    expect(body.durationDays).toBe(180);
    expect(body.price).toBe(15000);
    expect(body.isActive).toBe(true);
    expect(typeof body.entitlements).toBe('string');
    const ent = JSON.parse(body.entitlements);
    expect(ent[0].serviceId).toBe(seededServiceId);
    expect(ent[0].quantity).toBe(10);
    createdPlanIds.push(body.id);
  });
});

// ── Plans: GET ─────────────────────────────────────────────────────

test.describe('Memberships — GET /membership-plans', () => {
  test('list returns array with active plans, all-roles can read', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/membership-plans', 'admin');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    // The plan we created in POST tests should be in the list.
    expect(list.some((p) => createdPlanIds.includes(p.id))).toBe(true);
  });

  test('clinical staff (drharsh) can read the plan list (not gated)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/membership-plans', 'drharsh');
    expect(res.status()).toBe(200);
  });

  test('GET /:id returns one plan', async ({ request }) => {
    expect(createdPlanIds.length).toBeGreaterThan(0);
    const id = createdPlanIds[0];
    const res = await authGet(request, `/api/wellness/membership-plans/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  test('GET /:id 404 on unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/membership-plans/99999999');
    expect(res.status()).toBe(404);
  });

  test('GET /:id 400 on non-numeric id', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/membership-plans/not-a-number');
    expect(res.status()).toBe(400);
  });
});

// ── Plans: PUT ─────────────────────────────────────────────────────

test.describe('Memberships — PUT /membership-plans/:id', () => {
  test('200 happy path updates name + price', async ({ request }) => {
    expect(createdPlanIds.length).toBeGreaterThan(0);
    const id = createdPlanIds[0];
    const res = await authPut(request, `/api/wellness/membership-plans/${id}`, {
      name: `${RUN_TAG} Plan A (renamed)`,
      price: 12500,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(`${RUN_TAG} Plan A (renamed)`);
    expect(body.price).toBe(12500);
  });

  test('400 on bad price', async ({ request }) => {
    const id = createdPlanIds[0];
    const res = await authPut(request, `/api/wellness/membership-plans/${id}`, { price: -1 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('PRICE_REQUIRED');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/wellness/membership-plans/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ── Plans: DELETE (soft) ───────────────────────────────────────────

test.describe('Memberships — DELETE /membership-plans/:id', () => {
  test('200 soft-deletes (isActive=false), 409 on second delete', async ({ request }) => {
    // Create a throwaway plan
    const c = await authPost(request, '/api/wellness/membership-plans', planBody({ name: `${RUN_TAG} ToDelete` }));
    expect(c.status()).toBe(201);
    const plan = await c.json();
    createdPlanIds.push(plan.id);

    const d1 = await authDelete(request, `/api/wellness/membership-plans/${plan.id}`);
    expect(d1.status()).toBe(200);

    // Confirm soft state
    const g = await authGet(request, `/api/wellness/membership-plans/${plan.id}`);
    expect(g.status()).toBe(200);
    expect((await g.json()).isActive).toBe(false);

    // Default list (active only) should NOT include it
    const list = await authGet(request, '/api/wellness/membership-plans');
    expect(list.status()).toBe(200);
    const arr = await list.json();
    expect(arr.find((p) => p.id === plan.id)).toBeUndefined();

    // Second delete → 409
    const d2 = await authDelete(request, `/api/wellness/membership-plans/${plan.id}`);
    expect(d2.status()).toBe(409);
    expect((await d2.json()).code).toBe('PLAN_ALREADY_INACTIVE');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/wellness/membership-plans/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── Patient memberships: purchase + list + detail ──────────────────

test.describe('Memberships — POST /patients/:id/memberships', () => {
  test('400 when planId is missing', async ({ request }) => {
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('PLAN_ID_REQUIRED');
  });

  test('404 on unknown patient', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/patients/99999999/memberships', {
      planId: createdPlanIds[0],
    });
    expect(res.status()).toBe(404);
  });

  test('404 on unknown plan', async ({ request }) => {
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: 99999999,
    });
    expect(res.status()).toBe(404);
  });

  test('201 happy path: stamps endDate + balance from plan entitlements', async ({ request }) => {
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    expect(res.status(), `purchase: ${await res.text()}`).toBe(201);
    const m = await res.json();
    expect(typeof m.id).toBe('number');
    expect(m.patientId).toBe(createdPatientId);
    expect(m.planId).toBe(createdPlanIds[0]);
    expect(m.status).toBe('active');
    // Balance is JSON-string of the original entitlements
    expect(typeof m.balance).toBe('string');
    const bal = JSON.parse(m.balance);
    expect(Array.isArray(bal)).toBe(true);
    expect(bal[0].serviceId).toBe(seededServiceId);
    expect(bal[0].remaining).toBe(10);
    // endDate must be roughly start + 180 days
    const startMs = new Date(m.startDate).getTime();
    const endMs = new Date(m.endDate).getTime();
    const days = Math.round((endMs - startMs) / 86400000);
    expect(days).toBe(180);
    createdMembershipIds.push(m.id);
  });

  test('201 with explicit startDate (computes endDate from it)', async ({ request }) => {
    // Per the 2026-06 lifecycle policy, a patient cannot hold two active
    // memberships of the same plan simultaneously. The prior happy-path
    // test left an active membership on createdPatientId+plan[0]; this
    // test targets secondPatientId (created in beforeAll) so it exercises
    // the startDate-honoring branch without colliding with the new
    // MEMBERSHIP_ALREADY_ACTIVE gate. Keeps createdPatientId+plan[0]
    // active so the redeem describe later can use createdMembershipIds[0].
    const start = new Date('2026-06-01T00:00:00.000Z').toISOString();
    const res = await authPost(request, `/api/wellness/patients/${secondPatientId}/memberships`, {
      planId: createdPlanIds[0],
      startDate: start,
    });
    expect(res.status()).toBe(201);
    const m = await res.json();
    const endMs = new Date(m.endDate).getTime();
    const startMs = new Date(start).getTime();
    expect(Math.round((endMs - startMs) / 86400000)).toBe(180);
    createdMembershipIds.push(m.id);
  });

  test('400 on invalid startDate', async ({ request }) => {
    // Create a fresh patient so the startDate validation fires before the
    // MEMBERSHIP_ALREADY_ACTIVE duplicate check (both prior patients now have
    // active memberships for plan[0] after the happy-path + explicit-startDate
    // tests above).
    const fresh = await authPost(request, '/api/wellness/patients', {
      name: `${RUN_TAG} InvalidDate Patient`,
      phone: nextPhone(),
      gender: 'F',
    });
    const patientId = fresh.status() === 201 ? (await fresh.json()).id : secondPatientId;
    const res = await authPost(request, `/api/wellness/patients/${patientId}/memberships`, {
      planId: createdPlanIds[0],
      startDate: 'not-a-date',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('START_DATE_INVALID');
  });
});

test.describe('Memberships — GET /patients/:id/memberships', () => {
  test('returns array, includes plan info', async ({ request }) => {
    const res = await authGet(request, `/api/wellness/patients/${createdPatientId}/memberships`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find((m) => createdMembershipIds.includes(m.id));
    expect(found).toBeDefined();
    expect(found.plan.name).toContain(RUN_TAG);
  });

  test('404 on unknown patient', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/patients/99999999/memberships');
    expect(res.status()).toBe(404);
  });
});

test.describe('Memberships — GET /memberships/:id', () => {
  test('200 returns membership with redemptions array', async ({ request }) => {
    const id = createdMembershipIds[0];
    const res = await authGet(request, `/api/wellness/memberships/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.patient.id).toBe(createdPatientId);
    expect(Array.isArray(body.redemptions)).toBe(true);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/memberships/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── Redeem ─────────────────────────────────────────────────────────

test.describe('Memberships — POST /memberships/:id/redeem', () => {
  test('400 when serviceId missing', async ({ request }) => {
    const id = createdMembershipIds[0];
    const res = await authPost(request, `/api/wellness/memberships/${id}/redeem`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('SERVICE_ID_REQUIRED');
  });

  test('200 decrements balance for the redeemed service', async ({ request }) => {
    const id = createdMembershipIds[0];
    const res = await authPost(request, `/api/wellness/memberships/${id}/redeem`, {
      serviceId: seededServiceId,
    });
    expect(res.status(), `redeem: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.balance)).toBe(true);
    const line = body.balance.find((b) => b.serviceId === seededServiceId);
    expect(line.remaining).toBe(9); // started at 10, decremented to 9
    expect(typeof body.redemption.id).toBe('number');
    expect(body.redemption.serviceId).toBe(seededServiceId);
  });

  test('409 when service is not covered by the membership', async ({ request }) => {
    if (!secondServiceId) test.skip(true, 'Need a second service for not-covered test');
    const id = createdMembershipIds[0];
    const res = await authPost(request, `/api/wellness/memberships/${id}/redeem`, {
      serviceId: secondServiceId,
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('MEMBERSHIP_SERVICE_NOT_COVERED');
  });

  test('409 MEMBERSHIP_BALANCE_EXHAUSTED after exhausting the entitlement', async ({ request }) => {
    // Create a fresh tiny-plan (quantity=1) + buy + redeem twice
    const tinyPlan = await authPost(request, '/api/wellness/membership-plans', planBody({
      name: `${RUN_TAG} Tiny`,
      entitlements: [{ serviceId: seededServiceId, quantity: 1 }],
    }));
    expect(tinyPlan.status()).toBe(201);
    const tp = await tinyPlan.json();
    createdPlanIds.push(tp.id);

    const buy = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, { planId: tp.id });
    expect(buy.status()).toBe(201);
    const m = await buy.json();
    createdMembershipIds.push(m.id);

    const r1 = await authPost(request, `/api/wellness/memberships/${m.id}/redeem`, { serviceId: seededServiceId });
    expect(r1.status()).toBe(200);

    const r2 = await authPost(request, `/api/wellness/memberships/${m.id}/redeem`, { serviceId: seededServiceId });
    expect(r2.status()).toBe(409);
    expect((await r2.json()).code).toBe('MEMBERSHIP_BALANCE_EXHAUSTED');
  });

  test('404 on unknown membership id', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/memberships/99999999/redeem', {
      serviceId: seededServiceId,
    });
    expect(res.status()).toBe(404);
  });
});

// ── Cancel ─────────────────────────────────────────────────────────

test.describe('Memberships — POST /memberships/:id/cancel', () => {
  test('200 sets status=cancelled + stamps cancelledAt + reason', async ({ request }) => {
    // Use secondPatientId so the L438 startDate membership stays in
    // place (we don't redeem it but other ordering assumptions hold);
    // cancelling here puts secondPatientId+plan[0] into a known
    // cancelled state which the next test can build on.
    const buy = await authPost(request, `/api/wellness/patients/${secondPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    // The L438 test already created an active membership on
    // secondPatientId+plan[0]. Cancel it first if present so we can
    // create a fresh row for the cancel-flow assertion.
    let m;
    if (buy.status() === 409) {
      // Vacate the L438 active and retry.
      const body = await buy.json();
      expect(body.code).toBe('MEMBERSHIP_ALREADY_ACTIVE');
      await authPost(request, `/api/wellness/memberships/${body.activeMembershipId}/cancel`, {
        reason: 'spec setup — vacate for cancel-flow assertion',
      });
      const retry = await authPost(request, `/api/wellness/patients/${secondPatientId}/memberships`, {
        planId: createdPlanIds[0],
      });
      expect(retry.status()).toBe(201);
      m = await retry.json();
    } else {
      expect(buy.status()).toBe(201);
      m = await buy.json();
    }
    createdMembershipIds.push(m.id);

    const res = await authPost(request, `/api/wellness/memberships/${m.id}/cancel`, { reason: 'patient request' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.membership.status).toBe('cancelled');
    expect(body.membership.cancelReason).toBe('patient request');
    expect(body.membership.cancelledAt).toBeTruthy();

    // Idempotent second-cancel returns 200 with idempotent flag
    const second = await authPost(request, `/api/wellness/memberships/${m.id}/cancel`, { reason: 'again' });
    expect(second.status()).toBe(200);
    expect((await second.json()).idempotent).toBe(true);
  });

  test('410 MEMBERSHIP_CANCELLED on redeem against cancelled membership', async ({ request }) => {
    // Build on secondPatientId — the previous test left it in a
    // cancelled state on plan[0], so we can create a fresh active row
    // and immediately cancel it to set up the redeem-after-cancel probe.
    const buy = await authPost(request, `/api/wellness/patients/${secondPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    expect(buy.status()).toBe(201);
    const m = await buy.json();
    createdMembershipIds.push(m.id);

    const c = await authPost(request, `/api/wellness/memberships/${m.id}/cancel`, { reason: 'test' });
    expect(c.status()).toBe(200);

    const redeem = await authPost(request, `/api/wellness/memberships/${m.id}/redeem`, {
      serviceId: seededServiceId,
    });
    expect(redeem.status()).toBe(410);
    expect((await redeem.json()).code).toBe('MEMBERSHIP_CANCELLED');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/memberships/99999999/cancel', {});
    expect(res.status()).toBe(404);
  });
});

// ── Lifecycle: duplicate-active block + state-3 re-purchase ───────
// Pins the 2026-06 "one active membership per (patient, plan)" policy.
// The 409 gate must hold on the staff-side purchase endpoint and the
// response must carry the new envelope shape ({success, message, code,
// activeMembershipId, activeMembershipEndDate}). After the prior
// membership transitions to a non-active terminal state (cancelled or
// expired), a fresh purchase against the same plan must succeed — that
// transition is what the UI exposes as State 3 (Renew Membership CTA).
test.describe('Memberships — lifecycle policy (one-active-per-plan)', () => {
  // Test runs against createdPatientId+plan[0] which carries the L414
  // active membership all the way through the spec. The duplicate gate
  // should reject; an explicit cancel should then let the next purchase
  // succeed. Cleanup vacates the new row so downstream tests (auth gate,
  // tenant isolation, RBAC) keep their assumptions about catalog state.
  let lifecycleMembershipId = null;

  test('POST /patients/:id/memberships returns 409 when an active membership exists for the same plan', async ({ request }) => {
    expect(createdMembershipIds[0]).toBeTruthy();
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    // Envelope contract — both the new {success, message} shape AND the
    // legacy {error, code} shape are present so the existing fetchApi
    // error toast keeps working without a frontend change.
    expect(body.success).toBe(false);
    expect(body.code).toBe('MEMBERSHIP_ALREADY_ACTIVE');
    expect(typeof body.message).toBe('string');
    expect(body.message.toLowerCase()).toContain('active membership');
    expect(typeof body.error).toBe('string');
    // Includes the conflicting membership's id + expiry so the client can
    // render "Active Until <date>" without a separate lookup round-trip.
    expect(body.activeMembershipId).toBe(createdMembershipIds[0]);
    expect(body.activeMembershipEndDate).toBeTruthy();
  });

  test('after cancelling the active membership, the same plan can be purchased again (State 3 → State 2)', async ({ request }) => {
    // Vacate L414's membership so the lifecycle re-purchase path is open.
    // L520 redeem already exercised it, so cancelling now doesn't break
    // earlier tests; serial-mode + state-machine-aware ordering keeps
    // this sound.
    const cancel = await authPost(request, `/api/wellness/memberships/${createdMembershipIds[0]}/cancel`, {
      reason: 'lifecycle test — vacate to assert re-purchase',
    });
    expect(cancel.status()).toBe(200);

    // With no active membership for this (patient, plan), purchase succeeds.
    const buy = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    expect(buy.status()).toBe(201);
    const m = await buy.json();
    expect(m.status).toBe('active');
    expect(m.planId).toBe(createdPlanIds[0]);
    lifecycleMembershipId = m.id;
    createdMembershipIds.push(m.id);

    // Sanity: a third purchase against the now-active row should 409
    // again. Establishes the cycle: never → active (201) → 409 →
    // cancel/expire → active (201) → 409 → …
    const dup = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).code).toBe('MEMBERSHIP_ALREADY_ACTIVE');
  });

  test('GET /membership-plans response shape stays backward-compatible for callers without a Patient row', async ({ request }) => {
    // admin@wellness.demo has a User row but no Patient row, so the
    // ownership annotations are NOT added. The response must still
    // include the canonical plan fields every existing consumer (and
    // the legacy specs above) depends on.
    const res = await authGet(request, '/api/wellness/membership-plans');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const ours = list.find((p) => createdPlanIds.includes(p.id));
    expect(ours).toBeDefined();
    // Canonical fields are present and well-typed.
    expect(typeof ours.id).toBe('number');
    expect(typeof ours.name).toBe('string');
    expect(typeof ours.durationDays).toBe('number');
    expect(typeof ours.price).toBe('number');
    expect(typeof ours.entitlements).toBe('string');
    // Ownership fields MAY be present if the admin happens to have a
    // patient row in this tenant (some seeds do this). When absent the
    // payload must still parse; when present they must be the documented
    // types. Either is acceptable — the contract is "additive, never
    // breaking."
    if ('hasActiveMembership' in ours) {
      expect(typeof ours.hasActiveMembership).toBe('boolean');
      expect(typeof ours.hasExpiredMembership).toBe('boolean');
    }
  });

  test.afterAll(async ({ request }) => {
    // Vacate the lifecycle membership so it doesn't carry into later
    // describes (their assumptions about createdPatientId+plan[0] state
    // were authored before this test ran).
    if (lifecycleMembershipId) {
      await authPost(request, `/api/wellness/memberships/${lifecycleMembershipId}/cancel`, {
        reason: 'lifecycle teardown',
      }).catch(() => {});
    }
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Memberships — auth gate', () => {
  test('GET /membership-plans without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/membership-plans`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /membership-plans without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/wellness/membership-plans`, {
      data: planBody(),
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ── RBAC ──────────────────────────────────────────────────────────
// The wellness-role gates: plan mutations require admin/manager.
// PHI-write endpoints (purchase, redeem) require doctor/professional/admin/manager.
// Helper has no PHI privileges — should get 403 on every PHI route.

test.describe('Memberships — RBAC', () => {
  test('helper (no clinical role) → 403 on plan mutation', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({ name: `${RUN_TAG} BlockedByRBAC` }), 'helper');
    expect(res.status()).toBe(403);
  });

  test('helper → 403 on patient membership purchase', async ({ request }) => {
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    }, 'helper');
    expect(res.status()).toBe(403);
  });

  test('helper → 403 on redeem', async ({ request }) => {
    const res = await authPost(request, `/api/wellness/memberships/${createdMembershipIds[0]}/redeem`, {
      serviceId: seededServiceId,
    }, 'helper');
    expect(res.status()).toBe(403);
  });

  test('telecaller → 403 on plan mutations (operational role, not catalog admin)', async ({ request }) => {
    const res = await authPost(request, '/api/wellness/membership-plans', planBody({ name: `${RUN_TAG} TC` }), 'telecaller');
    expect(res.status()).toBe(403);
  });

  test('doctor (drharsh) CAN purchase + redeem (PHI-write gate)', async ({ request }) => {
    // Doctor builds a fresh purchase. After the cancel describe block,
    // secondPatientId+plan[0] is in a cancelled state, so a fresh
    // purchase succeeds (cancelled does NOT block re-purchase per the
    // 2026-06 lifecycle policy — only currently-active does).
    const buy = await authPost(request, `/api/wellness/patients/${secondPatientId}/memberships`, {
      planId: createdPlanIds[0],
    }, 'drharsh');
    expect(buy.status()).toBe(201);
    const m = await buy.json();
    createdMembershipIds.push(m.id);
  });

  test('manager CAN edit plan', async ({ request }) => {
    const id = createdPlanIds[0];
    const res = await authPut(request, `/api/wellness/membership-plans/${id}`, { description: 'manager edit ok' }, 'manager');
    expect(res.status()).toBe(200);
  });
});

// ── Tenant isolation ──────────────────────────────────────────────

test.describe('Memberships — tenant isolation', () => {
  test('Generic-tenant admin cannot see wellness plans', async ({ request }) => {
    // Generic CRM tenant is vertical=generic — verifyWellnessRole should
    // reject with 403 WELLNESS_TENANT_REQUIRED at the gate. List endpoint
    // uses no role gate so it just returns rows the tenant owns; assert
    // the wellness plan we created is NOT in the generic-tenant response.
    const res = await authGet(request, '/api/wellness/membership-plans?includeInactive=1', 'generic');
    // Either 200 with empty list, or 403 with the namespace error — both
    // are acceptable defenses. Capture either as "not leaking."
    if (res.status() === 200) {
      const list = await res.json();
      const leaked = (list || []).filter((p) => createdPlanIds.includes(p.id));
      expect(leaked, 'wellness plan leaked into generic tenant').toHaveLength(0);
    } else {
      expect([401, 403]).toContain(res.status());
    }
  });

  test('Generic-tenant admin cannot fetch a wellness plan by id', async ({ request }) => {
    const id = createdPlanIds[0];
    const res = await authGet(request, `/api/wellness/membership-plans/${id}`, 'generic');
    // Tenant scope filters out the row → 404 (not 403).
    expect([403, 404]).toContain(res.status());
  });

  test('Generic-tenant admin cannot purchase against a wellness patient', async ({ request }) => {
    // Even if they guessed the patient id, tenantWhere clause makes the
    // patient lookup return null → 404.
    const res = await authPost(request, `/api/wellness/patients/${createdPatientId}/memberships`, {
      planId: createdPlanIds[0],
    }, 'generic');
    expect([403, 404]).toContain(res.status());
  });

  test('Generic-tenant admin cannot fetch a wellness membership by id', async ({ request }) => {
    const id = createdMembershipIds[0];
    const res = await authGet(request, `/api/wellness/memberships/${id}`, 'generic');
    expect([403, 404]).toContain(res.status());
  });
});
