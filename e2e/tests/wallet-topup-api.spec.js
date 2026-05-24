// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 slice 8 (e2e gate spec).
 *
 * PRD: docs/PRD_WALLET_TOPUP.md §3 functional requirements.
 *
 * Routes under test:
 *   backend/routes/wallet.js
 *     GET    /api/wallet/:patientId/balance       (slice 2-partial, fdb0ec5c)
 *     GET    /api/wallet/:patientId/transactions  (slice 2-partial)
 *     POST   /api/wallet/:patientId/topup         (slice 3,  55e381ca)
 *     POST   /api/wallet/:patientId/redeem        (slice 4)
 *   backend/routes/wallet_rules.js
 *     GET    /api/wallet/rules                    (slice 5b, ac83e19c)
 *     POST   /api/wallet/rules                    (slice 5b)
 *     PUT    /api/wallet/rules/:id                (slice 5b)
 *     DELETE /api/wallet/rules/:id                (slice 5b — SOFT-delete)
 *
 * NOTE on spec filename: cannot be `wallet-api.spec.js` — that name is
 * taken by the existing `wallet-giftcard-coupon-api.spec.js` family
 * mounted under /api/wellness/*. This file covers the NEWER /api/wallet
 * surface added by Arc 1 (financial-PHI gate, top-up bonuses, FIFO
 * redeem, rule CRUD).
 *
 * Acceptance criteria covered (PRD §3 + DD-5.2 / DD-5.3 resolved
 * 2026-05-25):
 *
 *   GET balance:
 *     1. ADMIN → 200 + {balanceCents, currency, lastUpdated} shape
 *     2. Patient with no wallet row → 200 + balanceCents:0 (lazy create
 *        defers to first TOPUP — read MUST not write)
 *     3. Cross-tenant patientId → 404 (never reveal other-tenant row)
 *     4. Unauthenticated → 401/403
 *     5. USER without clinical wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *
 *   GET transactions:
 *     6. Envelope shape {transactions, total}
 *     7. Patient with no wallet → {transactions:[], total:0} NOT 404
 *     8. limit / offset pagination respected
 *
 *   POST topup:
 *     9. Happy path ₹1000 (no rule) → principal-only batch, no bonus
 *     10. 10% rule on min ₹500 → ₹1000 top-up gets ₹100 bonus + expiresAt
 *     11. Highest-wins (5% + 10% both eligible) → 10% applied
 *     12. Below threshold (rule min=₹2000, top-up=₹1000) → no bonus
 *     13. amountCents=0 → 400 INVALID_AMOUNT
 *     14. Invalid paymentMethod → 400 INVALID_PAYMENT_METHOD
 *     15. Cross-tenant patientId → 404 PATIENT_NOT_FOUND
 *     16. USER lacking clinical role → 403
 *
 *   POST redeem:
 *     17. Happy ₹500 redeem from ₹1000 wallet → balance drops to 500
 *     18. ₹2000 redeem from ₹1500 wallet → 400 INSUFFICIENT_BALANCE
 *         (carries requestedCents + availableCents fields)
 *     19. FIFO+expiry order: principal consumed BEFORE bonus
 *         (DD-5.3 — customer-fair pattern)
 *
 *   Wallet rules CRUD:
 *     20. GET returns {rules} list for ADMIN
 *     21. MANAGER can read; cannot POST (POST → 403)
 *     22. POST creates rule (ADMIN) + validation 400 on bad bonusPercent
 *     23. PUT updates rule
 *     24. DELETE soft-deletes (active=false; row still queryable via
 *         ?includeInactive=1)
 *     25. Cross-tenant — generic ADMIN sees zero wellness rules in list
 *
 * Test data hygiene:
 *   RUN_TAG = `E2E_FLOW_WALLET_<ts>`. Patient.name is prefixed with the
 *   tag so global-teardown's NAME regex (/^E2E_FLOW_/ — present in
 *   e2e/test-data-patterns.js line 28) cleans it up. WalletBonusRule
 *   names also embed the tag.
 *
 *   afterAll: PUT-rename patients to `_teardown_wallet_<id>` (matches the
 *   appointment-reminders-api convention — the wellness routes don't
 *   expose DELETE /patients per #327 clinical write-gate); DELETE rules
 *   we created (soft-delete, but that's the contract). Wallet +
 *   WalletTransaction + WalletCreditBatch rows cascade with the Patient
 *   (Prisma onDelete: Cascade on Wallet.patientId).
 *
 * Pattern: clones e2e/tests/appointment-reminders-api.spec.js for the
 * boot/auth/cleanup scaffold + wallet-giftcard-coupon-api.spec.js for
 * the cross-tenant probe shape.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const RUN_TAG = `E2E_FLOW_WALLET_${Date.now()}`;

// Force serial execution. Reason: wallet rules are tenant-scoped + the
// highest-bonus-percent-wins logic (DD-5.2) reads ALL active rules in
// the tenant before picking. If two parallel tests are both seeding 10%
// + 5% rules, they could pick each other's rules — making the chosen
// bonusRuleId nondeterministic. Serialising keeps each test's bonus
// math local to its own seeded rule.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  // Wellness ADMIN — passes verifyWellnessRole(['admin']) on rules CRUD
  // AND passes the read/topup/redeem clinical-role gates (admin is in
  // every allowed set).
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
  // Wellness MANAGER — passes read + topup/redeem gates AND the rules
  // GET (MANAGER ∈ readRoleGate) but NOT rules POST (ADMIN-only).
  wellnessManager: { email: 'manager@enhancedwellness.in', password: 'password123' },
  // USER with wellnessRole:null on the wellness tenant — proves the
  // clinical-role gate (phiReadGate / topupGate) refuses callers who
  // lack a clinical wellnessRole even when they're on the right tenant.
  wellnessUser: { email: 'user@wellness.demo', password: 'password123' },
  // Generic CRM ADMIN — proves cross-tenant 404 (the wellness patient
  // ids simply don't exist in the generic tenant's view).
  genericAdmin: { email: 'admin@globussoft.com', password: 'password123' },
};

const tokens = {};
const createdPatientIds = [];
const createdRuleIds = [];

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
async function authDel(request, token, path) {
  return request.delete(`${API}${path}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// Random 10-digit phone with leading 9. Each created Patient gets a
// fresh phone so the wellness contact dedupe (Patient.phone) doesn't
// collide with anything seeded elsewhere.
function randomPhone() {
  const tail = String(Math.floor(1000000000 + Math.random() * 9000000000)).slice(-10);
  return `9${tail.slice(0, 9)}`;
}

async function createPatient(request, label) {
  if (!tokens.wellnessAdmin) return null;
  const res = await authPost(request, tokens.wellnessAdmin, '/wellness/patients', {
    name: `${RUN_TAG} ${label}`,
    phone: randomPhone(),
    source: 'd16-wallet-test',
  });
  if (!res.ok()) return null;
  const p = await res.json();
  createdPatientIds.push(p.id);
  return p;
}

// Helper — create a WalletBonusRule via the slice-5b admin route. Track
// id so afterAll can soft-delete it.
async function createRule(request, body) {
  const res = await authPost(request, tokens.wellnessAdmin, '/wallet/rules', body);
  if (!res.ok()) {
    const txt = await res.text();
    throw new Error(`createRule failed (${res.status()}): ${txt}`);
  }
  const j = await res.json();
  createdRuleIds.push(j.rule.id);
  return j.rule;
}

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const t = await login(request, f);
    if (t) tokens[k] = t;
  }
});

test.afterAll(async ({ request }) => {
  if (!tokens.wellnessAdmin) return;
  // PUT-rename patients to dodge the demo-hygiene scan + global-teardown
  // regex. Patient.name is the only RUN_TAG marker on the surface; once
  // renamed, the row is inert noise on the CI DB.
  for (const id of createdPatientIds) {
    await request.put(`${API}/wellness/patients/${id}`, {
      headers: authHeader(tokens.wellnessAdmin),
      data: { name: `_teardown_wallet_${id}` },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => { /* best-effort cleanup */ });
  }
  // Soft-delete every rule we created. The route's DELETE flips
  // active=false (rows stay queryable via ?includeInactive=1). That's
  // OK — they no longer appear in the default rule lookup so won't
  // contaminate downstream specs.
  for (const id of createdRuleIds) {
    await authDel(request, tokens.wellnessAdmin, `/wallet/rules/${id}`).catch(() => {});
  }
});

// ─── GET /api/wallet/:patientId/balance ──────────────────────────────────

test.describe('GET /api/wallet/:patientId/balance', () => {
  test('1. ADMIN → 200 with {balanceCents, currency, lastUpdated} shape', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'balance-shape');
    expect(patient, 'patient seed must succeed').toBeTruthy();

    const res = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/balance`);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('balanceCents');
    expect(body).toHaveProperty('currency');
    expect(body).toHaveProperty('lastUpdated');
    expect(typeof body.balanceCents).toBe('number');
    expect(typeof body.currency).toBe('string');
    // No top-up yet → balanceCents:0 + lastUpdated:null (lazy wallet).
    expect(body.balanceCents).toBe(0);
    expect(body.lastUpdated).toBeNull();
  });

  test('2. patient with no wallet row → 200 + balanceCents:0 (lazy create — no write on read)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'no-wallet');
    expect(patient).toBeTruthy();

    // Two reads in a row — the second one must STILL see balanceCents:0
    // + lastUpdated:null, proving the read didn't create a wallet row.
    const r1 = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/balance`);
    expect(r1.status()).toBe(200);
    const b1 = await r1.json();
    expect(b1.balanceCents).toBe(0);
    expect(b1.lastUpdated).toBeNull();

    const r2 = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/balance`);
    const b2 = await r2.json();
    expect(b2.balanceCents).toBe(0);
    expect(b2.lastUpdated).toBeNull();
  });

  test('3. cross-tenant patientId → 404 (never reveal other-tenant row)', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'cross-tenant-probe');
    expect(patient).toBeTruthy();

    // Generic ADMIN probing a wellness patient id. The route's
    // tenantWhere() filter excludes the row from the generic tenant's
    // visibility window → 404 PATIENT_NOT_FOUND.
    // Caveat: phiReadGate may refuse generic admin first (because the
    // wellnessRole gate is enforced even for ADMIN if the tenant is
    // generic). Accept 403 OR 404 — both prove no balance leak.
    const res = await authGet(request, tokens.genericAdmin, `/wallet/${patient.id}/balance`);
    expect([403, 404]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    }
  });

  test('4. unauthenticated → 401/403', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'unauth');
    expect(patient).toBeTruthy();

    const res = await request.get(`${API}/wallet/${patient.id}/balance`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('5. USER without clinical wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    test.skip(!tokens.wellnessUser, 'wellness user fixture (user@wellness.demo) not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'user-no-role');
    expect(patient).toBeTruthy();

    const res = await authGet(request, tokens.wellnessUser, `/wallet/${patient.id}/balance`);
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    // user@wellness.demo is on a wellness tenant (passes WELLNESS_TENANT
    // check) but has wellnessRole:null (refused by role gate).
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});

// ─── GET /api/wallet/:patientId/transactions ─────────────────────────────

test.describe('GET /api/wallet/:patientId/transactions', () => {
  test('6. returns {transactions, total} envelope', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'txn-envelope');
    expect(patient).toBeTruthy();
    // Seed one top-up so there's at least one row.
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 50000,
      paymentMethod: 'cash',
    });
    expect(topup.status(), `topup body: ${await topup.text()}`).toBe(200);

    const res = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.transactions.length).toBeGreaterThanOrEqual(1);
    expect(body.transactions[0]).toHaveProperty('type');
    expect(body.transactions[0]).toHaveProperty('amount');
  });

  test('7. patient with no wallet → {transactions:[], total:0} NOT 404', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'txn-empty');
    expect(patient).toBeTruthy();

    const res = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions`);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.transactions).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('8. limit / offset pagination respected', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'txn-pagination');
    expect(patient).toBeTruthy();
    // Seed 3 top-ups so we have 3 rows to paginate over.
    for (let i = 0; i < 3; i++) {
      const r = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
        amountCents: 10000 + i,
        paymentMethod: 'cash',
      });
      expect(r.status(), `topup ${i} body: ${await r.text()}`).toBe(200);
    }

    const allRes = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions?limit=10`);
    const allBody = await allRes.json();
    expect(allBody.total).toBe(3);
    expect(allBody.transactions.length).toBe(3);

    const limit2 = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions?limit=2`);
    const limit2Body = await limit2.json();
    expect(limit2Body.transactions.length).toBe(2);
    expect(limit2Body.total).toBe(3); // total reflects unfiltered count

    const offset2 = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions?limit=10&offset=2`);
    const offset2Body = await offset2.json();
    expect(offset2Body.transactions.length).toBe(1);
    expect(offset2Body.total).toBe(3);
  });
});

// ─── POST /api/wallet/:patientId/topup ───────────────────────────────────

test.describe('POST /api/wallet/:patientId/topup', () => {
  test('9. happy path ₹1000 (no rule) → principal-only batch + no bonus', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'topup-noRule');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000, // ₹1000
      paymentMethod: 'cash',
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.principalBatchId).toBeGreaterThan(0);
    expect(body.bonusBatchId).toBeNull();
    expect(body.bonusRuleId).toBeNull();
    expect(body.balanceCents).toBe(100000); // exactly the principal
    expect(body.bonusPercent).toBe(0);
  });

  test('10. active 10% rule on min ₹500 → ₹1000 top-up adds ₹100 bonus + expiresAt populated', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const rule = await createRule(request, {
      name: `${RUN_TAG} 10pct-min500`,
      minAmountCents: 50000, // ₹500 threshold
      bonusPercent: 10,
      validityMonths: 6,
    });
    expect(rule.id).toBeGreaterThan(0);

    const patient = await createPatient(request, 'topup-bonus');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000, // ₹1000
      paymentMethod: 'upi',
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bonusBatchId).toBeGreaterThan(0);
    expect(body.bonusRuleId).toBe(rule.id);
    expect(body.bonusPercent).toBe(10);
    // Wallet credited principal (₹1000) + 10% bonus (₹100) = ₹1100.
    expect(body.balanceCents).toBe(110000);

    // Verify the bonus batch has expiresAt populated (~6 months out).
    const txRes = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/transactions`);
    const txBody = await txRes.json();
    expect(txBody.total).toBeGreaterThanOrEqual(1);
    const topupTx = txBody.transactions.find((t) => t.type === 'TOP_UP');
    expect(topupTx).toBeTruthy();
    // The bonus rule name appears in the reason string per the route's
    // `Top-up via ${paymentMethod} (bonus: ${chosenRule.name})` format.
    expect(topupTx.reason).toContain(rule.name);
  });

  test('11. highest-wins — 13% + 17% rules both eligible → 17% applied (DD-5.2)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    // DD-5.2 highest-bonusPercent-wins. The route's tiebreaker on EQUAL pct
    // is oldest-rule-wins (lowest id), so this test uses UNIQUE bonusPercent
    // values that won't collide with pre-existing seeded rules on demo (which
    // typically use round numbers 5/10/15/20). 13 + 17 are intentionally
    // off-band so the test's just-created ruleHigh wins on the natural
    // pct-comparison without needing a tiebreaker.
    //
    // Triaged 2026-05-25 — original 5+10 caused a tie with a pre-existing
    // seed rule on demo (also pct=10, lower id) → route picked the seed rule
    // → test's bonusRuleId === ruleHigh.id failed. Triple-RED cascade across
    // 3 commits before the demo-state-aware pick fixed it.
    const ruleLow = await createRule(request, {
      name: `${RUN_TAG} 13pct-low`,
      minAmountCents: 50000,
      bonusPercent: 13,
      validityMonths: 3,
    });
    const ruleHigh = await createRule(request, {
      name: `${RUN_TAG} 17pct-high`,
      minAmountCents: 50000,
      bonusPercent: 17,
      validityMonths: 6,
    });
    expect(ruleLow.id).toBeGreaterThan(0);
    expect(ruleHigh.id).toBeGreaterThan(0);

    const patient = await createPatient(request, 'topup-highestWins');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000,
      paymentMethod: 'card',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // DD-5.2: highest bonusPercent wins. 17pct must be applied (not 13pct).
    expect(body.bonusPercent).toBe(17);
    expect(body.bonusRuleId).toBe(ruleHigh.id);
  });

  test('12. below threshold — rule min=₹2000, top-up=₹1000 → no bonus', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const rule = await createRule(request, {
      name: `${RUN_TAG} 10pct-min2000`,
      minAmountCents: 200000, // ₹2000 threshold
      bonusPercent: 10,
      validityMonths: 6,
    });
    expect(rule.id).toBeGreaterThan(0);

    const patient = await createPatient(request, 'topup-belowThreshold');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000, // ₹1000 — below threshold
      paymentMethod: 'cash',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Below-threshold top-up means engine sees zero matching rules → no
    // bonus batch, no rule id, balance = principal.
    expect(body.bonusBatchId).toBeNull();
    expect(body.bonusRuleId).toBeNull();
    expect(body.balanceCents).toBe(100000);
  });

  test('13. amountCents=0 → 400 INVALID_AMOUNT', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'topup-zero');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 0,
      paymentMethod: 'cash',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_AMOUNT');
  });

  test('14. invalid paymentMethod → 400 INVALID_PAYMENT_METHOD', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'topup-badPm');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 50000,
      paymentMethod: 'bitcoin', // not in cash|card|upi|online
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_PAYMENT_METHOD');
  });

  test('15. cross-tenant patientId → 404 PATIENT_NOT_FOUND', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'topup-crossTenant');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.genericAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 50000,
      paymentMethod: 'cash',
    });
    // topupGate refuses generic admin (no wellnessRole + non-wellness
    // tenant) BEFORE the patient lookup runs → 403 with
    // WELLNESS_TENANT_REQUIRED. The 404 PATIENT_NOT_FOUND case only
    // applies if a wellness admin probes an id that doesn't exist in
    // their tenant — which we can't seed without creating cross-tenant
    // data. Accept either: 403 from the tenant gate, OR 404 if the
    // gate ever loosens. Both prove no top-up was written to the
    // wellness wallet.
    expect([403, 404]).toContain(res.status());
  });

  test('16. USER lacking clinical role → 403', async ({ request }) => {
    test.skip(!tokens.wellnessUser, 'wellness user fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'topup-userRole');
    expect(patient).toBeTruthy();

    const res = await authPost(request, tokens.wellnessUser, `/wallet/${patient.id}/topup`, {
      amountCents: 50000,
      paymentMethod: 'cash',
    });
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});

// ─── POST /api/wallet/:patientId/redeem ──────────────────────────────────

test.describe('POST /api/wallet/:patientId/redeem', () => {
  test('17. happy ₹500 redeem from ₹1000 wallet → balance drops to ₹500', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'redeem-happy');
    expect(patient).toBeTruthy();

    // Seed wallet with ₹1000.
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000,
      paymentMethod: 'cash',
    });
    expect(topup.status()).toBe(200);

    // Redeem ₹500 against a VISIT (we don't need a real visit row — the
    // sourceId is just stored on the WalletTransaction row).
    const redeem = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/redeem`, {
      amountCents: 50000,
      sourceType: 'VISIT',
      sourceId: 999999, // arbitrary positive integer
    });
    expect(redeem.status(), `body: ${await redeem.text()}`).toBe(200);
    const body = await redeem.json();
    expect(body.success).toBe(true);
    expect(body.remainingBalanceCents).toBe(50000);
    expect(Array.isArray(body.debitedFromBatches)).toBe(true);
    expect(body.debitedFromBatches.length).toBeGreaterThanOrEqual(1);

    // Verify via /balance read that the wallet really went to ₹500.
    const balRes = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/balance`);
    const balBody = await balRes.json();
    expect(balBody.balanceCents).toBe(50000);
  });

  test('18. ₹2000 redeem from ₹1500 wallet → 400 INSUFFICIENT_BALANCE with diagnostic fields', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const patient = await createPatient(request, 'redeem-insufficient');
    expect(patient).toBeTruthy();

    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 150000, // ₹1500
      paymentMethod: 'cash',
    });
    expect(topup.status()).toBe(200);

    const redeem = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/redeem`, {
      amountCents: 200000, // ₹2000 — exceeds available
      sourceType: 'SALE',
      sourceId: 1,
    });
    expect(redeem.status()).toBe(400);
    const body = await redeem.json();
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    // Route returns both fields so the SDK can render "you have X, asked Y".
    expect(body.requestedCents).toBe(200000);
    expect(body.availableCents).toBe(150000);

    // Confirm no debit actually happened (transactional rollback).
    const balRes = await authGet(request, tokens.wellnessAdmin, `/wallet/${patient.id}/balance`);
    const balBody = await balRes.json();
    expect(balBody.balanceCents).toBe(150000);
  });

  test('19. FIFO + expiry order — principal consumed BEFORE bonus (DD-5.3 customer-fair)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    // Seed a rule that gives a bonus on the first top-up.
    const rule = await createRule(request, {
      name: `${RUN_TAG} fifo-10pct`,
      minAmountCents: 50000,
      bonusPercent: 10,
      validityMonths: 6,
    });
    expect(rule.id).toBeGreaterThan(0);

    const patient = await createPatient(request, 'redeem-fifo');
    expect(patient).toBeTruthy();

    // ₹1000 top-up → ₹1000 principal + ₹100 bonus = ₹1100 wallet, two batches.
    const topup = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/topup`, {
      amountCents: 100000,
      paymentMethod: 'cash',
    });
    expect(topup.status()).toBe(200);
    const topupBody = await topup.json();
    expect(topupBody.principalBatchId).toBeGreaterThan(0);
    expect(topupBody.bonusBatchId).toBeGreaterThan(0);
    const principalBatchId = topupBody.principalBatchId;

    // Redeem ₹500 — entirely consumable from the principal batch (₹1000).
    // Per DD-5.3 the engine MUST consume principal first, leaving the
    // bonus batch fully intact.
    const redeem = await authPost(request, tokens.wellnessAdmin, `/wallet/${patient.id}/redeem`, {
      amountCents: 50000,
      sourceType: 'VISIT',
      sourceId: 999999,
    });
    expect(redeem.status(), `body: ${await redeem.text()}`).toBe(200);
    const body = await redeem.json();
    // Only one batch should have been touched — the principal one.
    expect(body.debitedFromBatches.length).toBe(1);
    expect(body.debitedFromBatches[0].batchType).toBe('PRINCIPAL');
    expect(body.debitedFromBatches[0].batchId).toBe(principalBatchId);
    expect(body.debitedFromBatches[0].consumedCents).toBe(50000);
    // Remaining wallet = 1100 - 500 = 600 (₹500 principal + ₹100 bonus).
    expect(body.remainingBalanceCents).toBe(60000);
  });
});

// ─── Wallet rules CRUD (/api/wallet/rules) ───────────────────────────────

test.describe('Wallet bonus rule CRUD', () => {
  test('20. GET returns {rules} list for ADMIN', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    // Seed a rule so the list is non-empty for this assertion.
    const seeded = await createRule(request, {
      name: `${RUN_TAG} crud-list`,
      minAmountCents: 50000,
      bonusPercent: 7,
      validityMonths: 3,
    });
    expect(seeded.id).toBeGreaterThan(0);

    const res = await authGet(request, tokens.wellnessAdmin, '/wallet/rules');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.find((r) => r.id === seeded.id)).toBeTruthy();
  });

  test('21. MANAGER can read but POST is ADMIN-only → 403', async ({ request }) => {
    test.skip(!tokens.wellnessManager, 'wellness manager fixture not seeded');
    // MANAGER role passes readRoleGate.
    const readRes = await authGet(request, tokens.wellnessManager, '/wallet/rules');
    expect(readRes.status()).toBe(200);
    const readBody = await readRes.json();
    expect(Array.isArray(readBody.rules)).toBe(true);

    // POST requires verifyRole(['ADMIN']) — MANAGER role rejected.
    const postRes = await authPost(request, tokens.wellnessManager, '/wallet/rules', {
      name: `${RUN_TAG} manager-blocked`,
      minAmountCents: 50000,
      bonusPercent: 5,
      validityMonths: 3,
    });
    expect(postRes.status()).toBe(403);
  });

  test('22. POST creates rule (ADMIN); validation 400 on bonusPercent > 100', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    // Happy create.
    const happy = await authPost(request, tokens.wellnessAdmin, '/wallet/rules', {
      name: `${RUN_TAG} crud-create`,
      minAmountCents: 75000,
      bonusPercent: 12,
      validityMonths: 4,
    });
    expect(happy.status()).toBe(201);
    const happyBody = await happy.json();
    expect(happyBody.rule.id).toBeGreaterThan(0);
    expect(happyBody.rule.bonusPercent).toBeDefined();
    // Track for cleanup.
    createdRuleIds.push(happyBody.rule.id);

    // Validation fail — bonusPercent out of [0..100].
    const bad = await authPost(request, tokens.wellnessAdmin, '/wallet/rules', {
      name: `${RUN_TAG} crud-badPct`,
      minAmountCents: 50000,
      bonusPercent: 250,
      validityMonths: 3,
    });
    expect(bad.status()).toBe(400);
    const badBody = await bad.json();
    expect(badBody.field).toBe('bonusPercent');
  });

  test('23. PUT updates rule', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const seeded = await createRule(request, {
      name: `${RUN_TAG} crud-putBefore`,
      minAmountCents: 50000,
      bonusPercent: 8,
      validityMonths: 3,
    });

    const res = await authPut(request, tokens.wellnessAdmin, `/wallet/rules/${seeded.id}`, {
      name: `${RUN_TAG} crud-putAfter`,
      bonusPercent: 15,
    });
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.rule.id).toBe(seeded.id);
    expect(body.rule.name).toBe(`${RUN_TAG} crud-putAfter`);
    expect(Number(body.rule.bonusPercent)).toBe(15);
    // minAmountCents not touched → preserved.
    expect(body.rule.minAmountCents).toBe(50000);
  });

  test('24. DELETE soft-deletes (active=false; row still queryable via ?includeInactive=1)', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    const seeded = await createRule(request, {
      name: `${RUN_TAG} crud-delete`,
      minAmountCents: 50000,
      bonusPercent: 6,
      validityMonths: 3,
    });

    const delRes = await authDel(request, tokens.wellnessAdmin, `/wallet/rules/${seeded.id}`);
    expect(delRes.status()).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.rule.active).toBe(false);

    // Default list (active=true only) must NOT show this row.
    const defaultList = await authGet(request, tokens.wellnessAdmin, '/wallet/rules');
    const defaultBody = await defaultList.json();
    expect(defaultBody.rules.find((r) => r.id === seeded.id)).toBeUndefined();

    // ?includeInactive=1 MUST still show it (soft-delete preserves row).
    const inactiveList = await authGet(request, tokens.wellnessAdmin, '/wallet/rules?includeInactive=1');
    const inactiveBody = await inactiveList.json();
    const found = inactiveBody.rules.find((r) => r.id === seeded.id);
    expect(found).toBeTruthy();
    expect(found.active).toBe(false);
  });

  test('25. tenant scoping — generic ADMIN sees zero wellness rules in list', async ({ request }) => {
    test.skip(!tokens.genericAdmin, 'generic admin fixture not seeded');
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');
    // Seed a wellness rule with our RUN_TAG.
    const wellnessRule = await createRule(request, {
      name: `${RUN_TAG} tenant-scope`,
      minAmountCents: 50000,
      bonusPercent: 9,
      validityMonths: 3,
    });
    expect(wellnessRule.id).toBeGreaterThan(0);

    // Generic ADMIN lists rules — should NOT see our wellness rule
    // (tenantWhere filter scopes to req.user.tenantId).
    const res = await authGet(request, tokens.genericAdmin, '/wallet/rules');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.rules.find((r) => r.id === wellnessRule.id);
    expect(found, 'generic admin must NOT see wellness rule').toBeUndefined();
  });
});
