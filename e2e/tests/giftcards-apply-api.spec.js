// @ts-check
/**
 * Admin-applied gift-card credit — POST /api/wellness/giftcards/:id/apply.
 *
 * Background: the existing /giftcards/redeem path requires the plaintext
 * code (recipient flow — SMS/email/printed card → patient portal). When
 * the operator loses the one-time plaintext (DB only retains masked +
 * bcrypt-hash per #653), there's no way to use the card through that
 * path. This endpoint is the parallel operator flow: an ADMIN or MANAGER
 * applies a gift card by row id to a patient's wallet, no code needed.
 * Trust boundary is the authenticated session + audit log + role check.
 *
 * Coverage:
 *   • Auth gate    — no token returns 401/403
 *   • Role gate    — USER role (doctor) returns 403
 *   • 400          — missing/invalid patientId
 *   • 404          — patient not found
 *   • 404          — giftcard not found
 *   • Happy path   — admin issues, applies, status flips to "redeemed",
 *                    wallet balance grows by amount, transaction row
 *                    exists with type=CREDIT_GIFTCARD
 *   • 409          — apply same card twice → GIFTCARD_ALREADY_REDEEMED
 *   • Manager role — succeeds (parity with admin)
 *
 * Reuses RUN_TAG prefix `E2E_FLOW_LEDGER_` already in
 * e2e/test-data-patterns.js so the teardown sweep covers this spec.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_LEDGER_APPLY_${Date.now()}`;

const FIXTURES = {
  admin:   { email: 'admin@wellness.demo',         password: 'password123' },
  manager: { email: 'manager@enhancedwellness.in', password: 'password123' },
  doctor:  { email: 'drharsh@enhancedwellness.in', password: 'password123' }, // USER role
};

const tokenCache = {};

async function login(request, who) {
  if (tokenCache[who]) return tokenCache[who];
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: FIXTURES[who],
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  const j = await r.json();
  tokenCache[who] = j.token;
  return j.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

const PHONE_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+91 98765 ${suffix}`;
}

let patientId = null;
let secondPatientId = null;
let adminToken = null;
let managerToken = null;
let doctorToken = null;

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin');
  managerToken = await login(request, 'manager');
  doctorToken = await login(request, 'doctor');
  if (!adminToken) {
    test.skip(true, 'wellness admin login failed — gate spec cannot run');
    return;
  }
  // Two test patients — one for the happy-path apply, one as a generic
  // target for the 4xx assertions (so we don't accidentally redeem the
  // happy-path card twice during error-path probing).
  const p1 = await request.post(`${BASE_URL}/api/wellness/patients`, {
    headers: auth(adminToken),
    data: { name: `${RUN_TAG} P1`, phone: nextPhone(), email: `${RUN_TAG.toLowerCase()}-1@example.test` },
    timeout: REQUEST_TIMEOUT,
  });
  if (p1.ok()) patientId = (await p1.json()).id;
  const p2 = await request.post(`${BASE_URL}/api/wellness/patients`, {
    headers: auth(adminToken),
    data: { name: `${RUN_TAG} P2`, phone: nextPhone(), email: `${RUN_TAG.toLowerCase()}-2@example.test` },
    timeout: REQUEST_TIMEOUT,
  });
  if (p2.ok()) secondPatientId = (await p2.json()).id;
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  // PUT-rename patients to dodge demo-hygiene scan (no DELETE on Patient).
  for (const id of [patientId, secondPatientId].filter(Boolean)) {
    await request.put(`${BASE_URL}/api/wellness/patients/${id}`, {
      headers: auth(adminToken),
      data: { name: `_teardown_ledger_apply_${id}` },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
});

async function issueCard(request, amount = 500, opts = {}) {
  const r = await request.post(`${BASE_URL}/api/wellness/giftcards`, {
    headers: auth(adminToken),
    data: { amount, ...opts },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status()).toBe(201);
  return r.json();
}

test.describe('POST /api/wellness/giftcards/:id/apply', () => {
  test('auth gate — no token returns 401/403', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/1/apply`, {
      data: { patientId: 1 }, timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('role gate — USER role (doctor) returns 403', async ({ request }) => {
    test.skip(!doctorToken, 'doctor login failed');
    const card = await issueCard(request);
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(doctorToken),
      data: { patientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  test('400 — patientId missing returns PATIENT_REQUIRED', async ({ request }) => {
    const card = await issueCard(request);
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(adminToken),
      data: {},
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('PATIENT_REQUIRED');
  });

  test('404 — patient not found', async ({ request }) => {
    const card = await issueCard(request);
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(adminToken),
      data: { patientId: 999999999 },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('PATIENT_NOT_FOUND');
  });

  test('404 — giftcard not found', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/999999999/apply`, {
      headers: auth(adminToken),
      data: { patientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('GIFTCARD_NOT_FOUND');
  });

  test('happy path — admin applies, status flips to redeemed, wallet credited', async ({ request }) => {
    test.skip(!patientId, 'no test patient');
    const before = await request.get(`${BASE_URL}/api/wellness/patients/${patientId}/wallet`, {
      headers: auth(adminToken), timeout: REQUEST_TIMEOUT,
    });
    const beforeBal = before.ok() ? (await before.json()).wallet?.balance ?? 0 : 0;

    const card = await issueCard(request, 750);
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(adminToken),
      data: { patientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const j = await r.json();

    expect(j.giftCard.id).toBe(card.id);
    expect(j.giftCard.status).toBe('redeemed');
    expect(j.giftCard.redeemedBy).toBe(patientId);
    expect(j.giftCard.redeemedAt).toBeTruthy();
    // Response select strips the bcrypt hash — never on the wire.
    expect(j.giftCard).not.toHaveProperty('codeHash');

    expect(j.transaction).toBeTruthy();
    expect(j.transaction.type).toBe('CREDIT_GIFTCARD');
    // WalletTransaction.amount sign convention: credits positive.
    expect(Number(j.transaction.amount)).toBeCloseTo(750, 2);

    // Wallet balance grew by amount.
    const after = await request.get(`${BASE_URL}/api/wellness/patients/${patientId}/wallet`, {
      headers: auth(adminToken), timeout: REQUEST_TIMEOUT,
    });
    expect(after.status()).toBe(200);
    const afterBal = (await after.json()).wallet.balance;
    expect(afterBal - beforeBal).toBeCloseTo(750, 2);
  });

  test('409 — apply same card twice returns GIFTCARD_ALREADY_REDEEMED', async ({ request }) => {
    test.skip(!patientId, 'no test patient');
    const card = await issueCard(request, 100);
    const first = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(adminToken),
      data: { patientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(first.status()).toBe(201);
    const second = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(adminToken),
      data: { patientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(second.status()).toBe(409);
    const j = await second.json();
    expect(j.code).toBe('GIFTCARD_ALREADY_REDEEMED');
  });

  test('manager role — succeeds (parity with admin)', async ({ request }) => {
    test.skip(!managerToken || !secondPatientId, 'manager login or second patient missing');
    const card = await issueCard(request, 250);
    const r = await request.post(`${BASE_URL}/api/wellness/giftcards/${card.id}/apply`, {
      headers: auth(managerToken),
      data: { patientId: secondPatientId },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j.giftCard.status).toBe('redeemed');
    expect(j.giftCard.redeemedBy).toBe(secondPatientId);
  });
});
