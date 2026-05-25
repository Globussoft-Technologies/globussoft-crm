// @ts-check
/**
 * D17 POS New Sale — Arc 1 slice 9 (e2e gate spec).
 *
 * PRD: docs/PRD_POS_NEW_SALE.md
 *
 * Routes under test (backend/routes/pos.js):
 *   GET  /api/pos/sale-context/:patientId        (slice 2, 617b6e26)
 *   POST /api/pos/sales/finalize                  (slice 8 — shipped by
 *                                                  Agent A this tick; may
 *                                                  not be deployed when
 *                                                  this spec lands —
 *                                                  cascade is OK)
 *
 * Why this spec exists: slice 2 + slice 8 are the New Sale page's two
 * server-side primitives. /sale-context preloads the wallet affordance +
 * future membership/booking enrichments so the cashier picks a patient
 * and the form has everything in one round-trip. /sales/finalize is the
 * atomic checkout endpoint — items + payment-splitter + (optional) wallet
 * debit + grand-total revalidation + per-PRD INVOICE_POLYMORPHISM
 * Invoice row alignment.
 *
 * Acceptance criteria covered:
 *
 *   GET /api/pos/sale-context/:patientId:
 *     1. Wellness ADMIN, patient w/ ₹1500 wallet → 200 + walletBalanceCents:150000
 *     2. Wellness ADMIN, patient w/ no wallet row → 200 + walletBalanceCents:0
 *     3. Cross-tenant patientId (generic admin probing wellness id) → 404 (or 403)
 *     4. USER lacking wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *
 *   POST /api/pos/sales/finalize:
 *     5. Cash-only: items totalling ₹1000 + cash ₹1000 → 200 with saleId
 *     6. Split-tender: ₹500 cash + ₹1000 card (₹1500 of items) → 200
 *     7. Wallet redeem: topup ₹1000 first, finalize sale with ₹500 wallet
 *        + ₹500 cash (₹1000 items) → 200 walletDebitedCents:50000
 *     8. Wallet insufficient: payments include ₹2000 wallet when balance
 *        is ₹500 → 400 INSUFFICIENT_WALLET_BALANCE
 *     9. Mismatched total: items=₹1000 + payments=₹900 → 400 MISMATCHED_TOTAL
 *    10. Empty items → 400 INVALID_ITEMS
 *    11. Empty payments → 400 INVALID_PAYMENTS
 *    12. Patient cross-tenant → 404 (or 403 gate before lookup)
 *    13. USER lacking wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *
 * Demo-state-pollution discipline (tonight's 4-RED triage lesson):
 *   - RUN_TAG scope: every patient name embeds RUN_TAG so the global
 *     teardown can isolate this run's residue from sibling tests.
 *   - patient ids from THIS test's createPatient() — no aggregate "no
 *     other sales exist" or "total wallet balance is N" probes.
 *   - Wallet seed: tests that need a known wallet balance do an EXPLICIT
 *     POST /api/wallet/:id/topup BEFORE finalize. Never assume the
 *     patient's wallet is empty — sibling tests may have left credits.
 *   - For the "wallet insufficient" test, the seeded balance (₹500) is
 *     fresh on a brand-new patient, so the "payments include ₹2000
 *     wallet" probe is deterministic regardless of background activity.
 *   - For the "mismatched total" test, the math is self-contained on the
 *     request body; no shared-state dependency.
 *
 * Test environment:
 *   - BASE_URL defaults to http://127.0.0.1:5000 (the per-push gate uses
 *     local; e2e-full overrides to https://crm.globusdemos.com).
 *   - Wellness admin (admin@wellness.demo) for seed + happy paths; generic
 *     admin (admin@globussoft.com) for cross-tenant 404 probe; wellness
 *     USER (user@wellness.demo, wellnessRole:null) for the 403 gate.
 *   - Needs a seeded Location + Register + OPEN shift to ring sales.
 *     Discovered (or created) at beforeAll. Shift is closed in afterAll
 *     so a re-run starts clean.
 *
 * Cleanup (afterAll):
 *   - PUT-rename every created patient to `_teardown_pos_<id>` (matches
 *     wallet-topup-api convention — the wellness routes don't expose a
 *     DELETE /patients endpoint per #327 clinical write-gate).
 *   - Close the spec's OPEN shift via POST /shifts/:id/close so registers
 *     stay deletable for the next run.
 *   - Best-effort delete the spec-created register (cascade nukes shifts +
 *     sales beneath).
 *
 * Pattern: clones e2e/tests/wallet-topup-api.spec.js for the role-fixture
 * + RUN_TAG + per-test patient-seed shape; e2e/tests/pos-api.spec.js for
 * the register/shift bootstrap.
 *
 * Cascade tolerance: Agent A's finalize endpoint (POST /api/pos/sales/finalize)
 * may not be deployed when this spec first runs. Per-push gate may RED
 * until the matching backend lands — that's intentional, same shape as
 * D16 slice 8.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const RUN_TAG = `E2E_FLOW_POSFINALIZE_${Date.now()}`;

// Serial mode — the spec opens ONE shared shift then rings up multiple
// sales against it. Parallel workers would each try to open their own
// shift on the same register (409 SHIFT_ALREADY_OPEN) or create their
// own register per worker (test data sprawl + register-cleanup
// complication). Serial keeps the lifecycle linear.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  wellnessAdmin:   { email: 'admin@wellness.demo',         password: 'password123' },
  wellnessUser:    { email: 'user@wellness.demo',          password: 'password123' },
  genericAdmin:    { email: 'admin@globussoft.com',        password: 'password123' },
};

const tokens = {};
const createdPatientIds = [];
let sharedLocationId = null;
let sharedRegisterId = null;
let sharedShiftId = null;

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function authGet(request, token, path) {
  return request.get(`${API}${path}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, token, path, body) {
  return request.post(`${API}${path}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPut(request, token, path, body) {
  return request.put(`${API}${path}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// Random 10-digit phone with leading 9 — wellness Patient.phone is
// (effectively) unique per tenant; sibling tests bumping the same phone
// would 409 on create. RUN_TAG-suffixed digits make collisions
// astronomically unlikely.
function randomPhone() {
  const tail = String(Math.floor(1000000000 + Math.random() * 9000000000)).slice(-10);
  return `9${tail.slice(0, 9)}`;
}

async function createPatient(request, label) {
  if (!tokens.wellnessAdmin) return null;
  const res = await authPost(request, tokens.wellnessAdmin, '/wellness/patients', {
    name: `${RUN_TAG} ${label}`,
    phone: randomPhone(),
    source: 'd17-pos-finalize-test',
  });
  if (!res.ok()) return null;
  const p = await res.json();
  createdPatientIds.push(p.id);
  return p;
}

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const t = await login(request, f);
    if (t) tokens[k] = t;
  }
  if (!tokens.wellnessAdmin) return;

  // Discover (or create) a location for the spec's register.
  const locRes = await authGet(request, tokens.wellnessAdmin, '/wellness/locations');
  if (locRes.ok()) {
    const locs = await locRes.json();
    if (Array.isArray(locs) && locs.length > 0) sharedLocationId = locs[0].id;
  }
  if (!sharedLocationId) {
    const created = await authPost(request, tokens.wellnessAdmin, '/wellness/locations', {
      name: `${RUN_TAG} Clinic`,
      addressLine: '1 POS Finalize Test Road',
      city: 'Mumbai',
      pincode: '400001',
      country: 'India',
    });
    if (created.status() === 201) {
      const body = await created.json();
      sharedLocationId = body.id;
    }
  }
  if (!sharedLocationId) return;

  // Create a dedicated register for THIS spec run. Per-spec register
  // (not a shared one) so the shared OPEN-shift assumption holds even
  // under parallel-spec contention against the same tenant.
  const regRes = await authPost(request, tokens.wellnessAdmin, '/pos/registers', {
    name: `${RUN_TAG} Finalize Register`,
    locationId: sharedLocationId,
    openingFloat: 5000,
    isActive: true,
  });
  if (regRes.status() !== 201) return;
  const reg = await regRes.json();
  sharedRegisterId = reg.id;

  // Open one shift for the spec to ring all sales against.
  const shiftRes = await authPost(request, tokens.wellnessAdmin, '/pos/shifts/open', {
    registerId: sharedRegisterId,
    openingFloat: 5000,
  });
  if (shiftRes.status() === 201) {
    const shift = await shiftRes.json();
    sharedShiftId = shift.id;
  }
});

test.afterAll(async ({ request }) => {
  if (!tokens.wellnessAdmin) return;
  // PUT-rename every created patient — defangs the global E2E_FLOW_
  // teardown regex without leaving an orphan Patient row that no API
  // path lets us delete (#327 gate).
  for (const id of createdPatientIds) {
    await authPut(request, tokens.wellnessAdmin, `/wellness/patients/${id}`, {
      name: `_teardown_pos_${id}`,
      isActive: false,
    }).catch(() => {});
  }
  // Close the spec's open shift so the register is deletable + the next
  // run can re-open cleanly without 409 SHIFT_ALREADY_OPEN.
  if (sharedShiftId) {
    await authPost(request, tokens.wellnessAdmin, `/pos/shifts/${sharedShiftId}/close`, {
      closingTotal: 0,
      notes: 'd17-slice9 teardown',
    }).catch(() => {});
  }
  // Best-effort delete the spec-created register (cascade-deletes shifts
  // + sales beneath).
  if (sharedRegisterId) {
    await request.delete(`${API}/pos/registers/${sharedRegisterId}`, {
      headers: authHeader(tokens.wellnessAdmin),
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
});

// ─── GET /api/pos/sale-context/:patientId ────────────────────────────────

test.describe('GET /api/pos/sale-context/:patientId', () => {
  test('1. wellness ADMIN, patient w/ ₹1500 wallet → 200 + walletBalanceCents:150000', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'ctx-walletFull');
    expect(patient, 'patient seed must succeed').toBeTruthy();

    // Seed exactly ₹1500 onto this patient's wallet. Explicit topup —
    // never assume the wallet is empty (sibling tests may have left
    // credits behind).
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 150000,
      paymentMethod: 'cash',
    });
    expect(topup.status(), `topup body: ${await topup.text()}`).toBe(200);

    const res = await authGet(request, tokens.wellnessAdmin, `/pos/sale-context/${patient.id}`);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('patientId');
    expect(body).toHaveProperty('walletBalanceCents');
    expect(body).toHaveProperty('currency');
    expect(body).toHaveProperty('activeMemberships');
    expect(body).toHaveProperty('pendingBookings');
    expect(body.patientId).toBe(patient.id);
    // Topup MAY add a bonus on top depending on demo's seeded bonus
    // rules. Assert the principal is reflected, not the strict equality.
    // The wallet-topup spec triaged the bonus-rule pollution problem at
    // length; for sale-context we just need the balance to be >= the
    // principal we put in.
    expect(body.walletBalanceCents).toBeGreaterThanOrEqual(150000);
    expect(typeof body.currency).toBe('string');
    expect(Array.isArray(body.activeMemberships)).toBe(true);
    expect(Array.isArray(body.pendingBookings)).toBe(true);
  });

  test('2. wellness ADMIN, patient w/ no wallet row → 200 + walletBalanceCents:0', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'ctx-noWallet');
    expect(patient).toBeTruthy();

    // Brand-new patient, no topup → wallet row doesn't exist yet.
    const res = await authGet(request, tokens.wellnessAdmin, `/pos/sale-context/${patient.id}`);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.walletBalanceCents).toBe(0);
    // currency defaults to INR per route comment when wallet missing.
    expect(body.currency).toBe('INR');
    expect(body.activeMemberships).toEqual([]);
    expect(body.pendingBookings).toEqual([]);
  });

  test('3. cross-tenant patientId → 404 (or 403 from wellnessRole gate)', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'ctx-crossTenant');
    expect(patient).toBeTruthy();

    // Generic ADMIN probing a wellness patient id. Either:
    //   - 403 from verifyWellnessRole (generic admin lacks wellnessRole +
    //     non-wellness tenant), OR
    //   - 404 from tenantWhere filter (if the gate ever loosens). Both
    //     prove no balance leak.
    const res = await authGet(request, tokens.genericAdmin, `/pos/sale-context/${patient.id}`);
    expect([403, 404]).toContain(res.status());
  });

  test('4. USER lacking wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    test.skip(!tokens.wellnessUser, 'wellness user fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'ctx-userNoRole');
    expect(patient).toBeTruthy();

    const res = await authGet(request, tokens.wellnessUser, `/pos/sale-context/${patient.id}`);
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});

// ─── POST /api/pos/sales/finalize ────────────────────────────────────────

// Per-test patient seed + per-test wallet seed. Each test's assertions
// are scoped to its own freshly-created patient — never to aggregate
// "demo has N sales" or "tenant wallet total is X" counters.

test.describe('POST /api/pos/sales/finalize', () => {
  test('5. cash-only ₹1000 → 200 with saleId returned', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded — register/shift bootstrap failed');
    const patient = await createPatient(request, 'fin-cashOnly');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Consultation', qty: 1, unitPriceCents: 100000 },
      ],
      payments: [
        { method: 'cash', amountCents: 100000 },
      ],
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('saleId');
    expect(typeof body.saleId).toBe('number');
    expect(body.saleId).toBeGreaterThan(0);
  });

  test('6. split-tender ₹500 cash + ₹1000 card (₹1500 items) → 200', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-split');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Premium Consult', qty: 1, unitPriceCents: 150000 },
      ],
      payments: [
        { method: 'cash', amountCents: 50000 },
        { method: 'card', amountCents: 100000 },
      ],
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.saleId).toBeGreaterThan(0);
  });

  test('7. wallet redeem: topup ₹1000, finalize with ₹500 wallet + ₹500 cash → 200 walletDebitedCents:50000', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-walletRedeem');
    expect(patient).toBeTruthy();

    // Explicit ₹1000 topup BEFORE the redeem-finalize. Never assume a
    // patient's wallet is in any particular state — tonight's 4-RED
    // triage was about exactly this pollution class.
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000,
      paymentMethod: 'cash',
    });
    expect(topup.status(), `topup body: ${await topup.text()}`).toBe(200);

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Massage', qty: 1, unitPriceCents: 100000 },
      ],
      payments: [
        { method: 'wallet', amountCents: 50000 },
        { method: 'cash', amountCents: 50000 },
      ],
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.saleId).toBeGreaterThan(0);
    // walletDebitedCents echoes the wallet portion in cents. ₹500 = 50000.
    expect(body.walletDebitedCents).toBe(50000);
  });

  test('8. wallet insufficient: ₹2000 wallet on ₹500 balance → 400 INSUFFICIENT_WALLET_BALANCE', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-walletInsufficient');
    expect(patient).toBeTruthy();

    // Seed exactly ₹500 — a known-small balance so the ₹2000 redeem is
    // deterministically insufficient regardless of background activity.
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 50000,
      paymentMethod: 'cash',
    });
    expect(topup.status(), `topup body: ${await topup.text()}`).toBe(200);

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Big Service', qty: 1, unitPriceCents: 200000 },
      ],
      payments: [
        { method: 'wallet', amountCents: 200000 },
      ],
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INSUFFICIENT_WALLET_BALANCE');
  });

  test('9. mismatched total: items=₹1000 + payments=₹900 → 400 MISMATCHED_TOTAL', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-mismatch');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Test', qty: 1, unitPriceCents: 100000 },
      ],
      payments: [
        { method: 'cash', amountCents: 90000 },
      ],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISMATCHED_TOTAL');
  });

  test('10. empty items → 400 INVALID_ITEMS', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-emptyItems');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [],
      payments: [
        { method: 'cash', amountCents: 10000 },
      ],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ITEMS');
  });

  test('11. empty payments → 400 INVALID_PAYMENTS', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-emptyPayments');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Test', qty: 1, unitPriceCents: 50000 },
      ],
      payments: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_PAYMENTS');
  });

  test('12. patient cross-tenant → 404 (or 403 gate first)', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-crossTenant');
    expect(patient).toBeTruthy();

    // Generic admin probes a wellness patient. The verifyWellnessRole
    // gate will likely refuse FIRST (generic tenant + no wellnessRole)
    // → 403. If the gate ever loosens, the tenantWhere filter inside
    // finalize returns 404. Either is a valid "no cross-tenant write"
    // proof.
    const res = await authPost(request, tokens.genericAdmin, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Test', qty: 1, unitPriceCents: 10000 },
      ],
      payments: [
        { method: 'cash', amountCents: 10000 },
      ],
    });
    expect([403, 404]).toContain(res.status());
  });

  test('13. USER lacking wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    test.skip(!tokens.wellnessUser, 'wellness user fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    test.skip(!sharedShiftId, 'shared shift not seeded');
    const patient = await createPatient(request, 'fin-userNoRole');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessUser, '/pos/sales/finalize', {
      shiftId: sharedShiftId,
      patientId: patient.id,
      items: [
        { type: 'service', refId: 1, name: 'Test', qty: 1, unitPriceCents: 10000 },
      ],
      payments: [
        { method: 'cash', amountCents: 10000 },
      ],
    });
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});
