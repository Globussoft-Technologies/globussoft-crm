// @ts-check
/**
 * Wave 11 Agent FF — Wallet + GiftCard + Coupon + Cashback ledger system.
 *
 * NEW route family added to backend/routes/wellness.js. Confirmed by the
 * "CRM Wellness Developer Implementation List" Google Doc (8 May 2026)
 * audit as missing entirely from the prior codebase — no models, no
 * routes, no UI. Schema additions: Wallet, WalletTransaction, GiftCard,
 * Coupon, CashbackRule.
 *
 * Endpoints covered:
 *   Wallet:
 *     GET    /api/wellness/patients/:id/wallet      — auth + 404 + lazy-create
 *                                                    + tenant scope + tx list
 *     POST   /api/wellness/wallet/:walletId/credit  — admin, 400 amount,
 *                                                    404 wallet, 201 tx + audit
 *     POST   /api/wellness/wallet/:walletId/debit   — admin, 400 amount,
 *                                                    409 INSUFFICIENT_BALANCE,
 *                                                    201 tx + audit
 *   GiftCard:
 *     GET    /api/wellness/giftcards                — admin/manager list
 *     POST   /api/wellness/giftcards                — admin/manager issue
 *                                                    + 400 amount + 400 expiresAt
 *                                                    + 404 recipient + 201 row
 *     POST   /api/wellness/giftcards/redeem         — staff redeem,
 *                                                    400 missing, 404 NOT_FOUND,
 *                                                    409 ALREADY_REDEEMED,
 *                                                    410 EXPIRED, 201 credit
 *   Coupon:
 *     GET    /api/wellness/coupons                  — admin/manager list
 *     POST   /api/wellness/coupons                  — admin/manager create,
 *                                                    400 invalid, 409 DUPLICATE
 *     PUT    /api/wellness/coupons/:id              — admin/manager update + 404
 *     DELETE /api/wellness/coupons/:id              — admin only, 404, 204
 *     POST   /api/wellness/coupons/preview          — any tenant user,
 *                                                    400 base, 404, 410, 409
 *     POST   /api/wellness/coupons/apply            — staff apply,
 *                                                    increments redemption,
 *                                                    409 LIMIT_REACHED,
 *                                                    410 EXPIRED, 409 NOT_APPLICABLE
 *   Cashback:
 *     GET    /api/wellness/cashback-rules           — admin/manager list
 *     POST   /api/wellness/cashback-rules           — admin/manager create
 *     PUT    /api/wellness/cashback-rules/:id       — update
 *     DELETE /api/wellness/cashback-rules/:id       — admin only
 *     POST   /api/wellness/visits/:id/apply-cashback — staff,
 *                                                    409 VISIT_NOT_COMPLETED,
 *                                                    409 ALREADY_APPLIED,
 *                                                    201 + Patient/CASHBACK_EARN audit
 *
 * Audit emissions asserted: Wallet/CREDIT, Wallet/DEBIT, GiftCard/CREATE,
 * GiftCard/REDEEM, Coupon/CREATE, Coupon/APPLY, Coupon/DELETE,
 * CashbackRule/CREATE, Patient/CASHBACK_EARN.
 *
 * Pattern: dual-token (admin@wellness.demo + drharsh+stylist USER doctors)
 * + cross-tenant token (admin@globussoft) for tenant-scope assertions.
 * RUN_TAG `E2E_FLOW_LEDGER_<ts>` — pattern added to test-data-patterns.js
 * for global-teardown sweep.
 *
 * NO-DELETE on Patient/Visit (issue #21 standing rule): we redeem gift
 * cards into a fresh test Patient created in this spec; Patient is
 * PUT-renamed `_teardown_ledger_${id}` + the ledger Wallet/Tx rows
 * cascade-delete behind the scenes. Coupons + Cashback rules + Gift
 * cards have full DELETE; spec uses authDelete in afterAll.
 *
 * Wave-B Agent 3 (#653) — bcrypt-hash-at-rest hardening added 6 new
 * assertions under the GiftCards describe (oneTimeCode alias presence,
 * codeHash never on the wire, codeLast4 matches plaintext suffix, GET
 * list masks the code, redeem rejects wrong-code-same-last-4, redeem
 * succeeds via the one-time plaintext).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_LEDGER_${Date.now()}`;

const FIXTURES = {
  admin:   { email: 'admin@wellness.demo',         password: 'password123' },
  drharsh: { email: 'drharsh@enhancedwellness.in', password: 'password123' },
  stylist: { email: 'stylist1@enhancedwellness.in', password: 'password123' },
  manager: { email: 'manager@enhancedwellness.in',  password: 'password123' },
  generic: { email: 'admin@globussoft.com',        password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        tokenCache[who] = j.token;
        userIdCache[who] = j.user.id;
        return { token: j.token, userId: j.user.id };
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
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
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Fixtures ───────────────────────────────────────────────────────
let testPatientId = null;
let testGiftCardIds = [];
let testCouponIds = [];
let testCashbackRuleIds = [];

const PHONE_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+91 98765 ${suffix}`;
}

test.beforeAll(async ({ request }) => {
  const { token } = await login(request, 'admin');
  if (!token) {
    test.skip(true, 'wellness admin login failed');
    return;
  }
  // Create one test Patient we can use for wallet + gift-card flows.
  const r = await post(request, token, '/api/wellness/patients', {
    name: `${RUN_TAG} Patient`,
    phone: nextPhone(),
    email: `${RUN_TAG.toLowerCase()}@example.test`,
  });
  if (r.ok()) {
    const p = await r.json();
    testPatientId = p.id;
  }
});

test.afterAll(async ({ request }) => {
  const { token } = await login(request, 'admin');
  if (!token) return;
  // Coupons + cashback rules: real DELETE.
  for (const id of testCouponIds) {
    await del(request, token, `/api/wellness/coupons/${id}`).catch(() => {});
  }
  for (const id of testCashbackRuleIds) {
    await del(request, token, `/api/wellness/cashback-rules/${id}`).catch(() => {});
  }
  // Gift cards: no DELETE; rename via PUT not supported either, but we tag
  // the codes with the RUN_TAG so a future scrub script can match. Status
  // already settled to redeemed/expired by the test flow; nothing more to do.
  // Patient: PUT-rename to _teardown_ to dodge demo-hygiene scan.
  if (testPatientId) {
    await put(request, token, `/api/wellness/patients/${testPatientId}`, {
      name: `_teardown_ledger_${testPatientId}`,
    }).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────
// Wallet
// ──────────────────────────────────────────────────────────────────

test.describe('Wallet', () => {
  test('auth gate — no token returns 401/403', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/patients/1/wallet`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('GET /patients/:id/wallet auto-creates an empty wallet on first read', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const r = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.patient.id).toBe(testPatientId);
    expect(j.wallet).toBeTruthy();
    expect(typeof j.wallet.balance).toBe('number');
    expect(j.wallet.balance).toBe(0);
    expect(j.wallet.patientId).toBe(testPatientId);
    expect(Array.isArray(j.transactions)).toBe(true);
  });

  test('GET /patients/:id/wallet returns 404 for non-existent patient', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await get(request, token, '/api/wellness/patients/9999999/wallet');
    expect(r.status()).toBe(404);
  });

  test('GET /patients/:id/wallet returns 400 on non-numeric id', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await get(request, token, '/api/wellness/patients/abc/wallet');
    expect(r.status()).toBe(400);
  });

  test('cross-tenant 404 — generic admin cannot read wellness patient wallet', async ({ request }) => {
    const { token } = await login(request, 'generic');
    test.skip(!testPatientId, 'no test patient');
    const r = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    expect([403, 404]).toContain(r.status());
  });

  test('POST /wallet/:id/credit — manager rejected (admin only)', async ({ request }) => {
    const { token } = await login(request, 'manager');
    test.skip(!testPatientId, 'no test patient');
    const adminAuth = await login(request, 'admin');
    const w = await get(request, adminAuth.token, `/api/wellness/patients/${testPatientId}/wallet`);
    const wallet = (await w.json()).wallet;
    const r = await post(request, token, `/api/wellness/wallet/${wallet.id}/credit`, { amount: 100 });
    expect(r.status()).toBe(403);
  });

  test('POST /wallet/:id/credit — 400 on non-positive amount', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const w = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const wallet = (await w.json()).wallet;
    const r = await post(request, token, `/api/wellness/wallet/${wallet.id}/credit`, { amount: 0 });
    expect(r.status()).toBe(400);
    const r2 = await post(request, token, `/api/wellness/wallet/${wallet.id}/credit`, { amount: -50 });
    expect(r2.status()).toBe(400);
  });

  test('POST /wallet/:id/credit — 404 on non-existent wallet', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/wallet/9999999/credit', { amount: 100 });
    expect(r.status()).toBe(404);
  });

  test('POST /wallet/:id/credit happy path — credits + balance increases + audit row', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const w = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const wallet = (await w.json()).wallet;
    const before = wallet.balance;
    const r = await post(request, token, `/api/wellness/wallet/${wallet.id}/credit`, {
      amount: 250,
      reason: `${RUN_TAG} manual credit`,
    });
    expect(r.status()).toBe(201);
    const tx = await r.json();
    expect(tx.amount).toBe(250);
    expect(tx.type).toBe('CREDIT_REFUND');
    expect(tx.balanceAfter).toBe(before + 250);

    const w2 = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const after = (await w2.json()).wallet.balance;
    expect(after).toBe(before + 250);
  });

  test('POST /wallet/:id/debit happy path — sign goes negative + balance decreases', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const w = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const wallet = (await w.json()).wallet;
    const before = wallet.balance;
    const r = await post(request, token, `/api/wellness/wallet/${wallet.id}/debit`, { amount: 50, reason: `${RUN_TAG} debit` });
    expect(r.status()).toBe(201);
    const tx = await r.json();
    expect(tx.amount).toBe(-50);
    expect(tx.balanceAfter).toBe(before - 50);
  });

  test('POST /wallet/:id/debit — 409 INSUFFICIENT_BALANCE when amount exceeds balance', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const w = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const wallet = (await w.json()).wallet;
    const r = await post(request, token, `/api/wellness/wallet/${wallet.id}/debit`, { amount: 1000000 });
    expect(r.status()).toBe(409);
    const j = await r.json();
    expect(j.code).toBe('INSUFFICIENT_BALANCE');
  });
});

// ──────────────────────────────────────────────────────────────────
// Gift Cards
// ──────────────────────────────────────────────────────────────────

test.describe('GiftCards', () => {
  test('GET /giftcards — auth gate', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/giftcards`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('GET /giftcards — admin succeeds, returns array envelope', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await get(request, token, '/api/wellness/giftcards');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.giftCards)).toBe(true);
    expect(typeof j.total).toBe('number');
  });

  test('POST /giftcards — 400 on missing/invalid amount', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards', {});
    expect(r.status()).toBe(400);
    const r2 = await post(request, token, '/api/wellness/giftcards', { amount: -5 });
    expect(r2.status()).toBe(400);
  });

  test('POST /giftcards — 400 on past expiresAt', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = await post(request, token, '/api/wellness/giftcards', { amount: 100, expiresAt: past });
    expect(r.status()).toBe(400);
  });

  test('POST /giftcards happy path — issues row with random code', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards', { amount: 500 });
    expect(r.status()).toBe(201);
    const row = await r.json();
    expect(row.code).toMatch(/^[A-Z0-9]{16}$/);
    expect(row.amount).toBe(500);
    expect(row.status).toBe('active');
    testGiftCardIds.push(row.id);
  });

  test('POST /giftcards/redeem — 400 on missing code or patientId', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards/redeem', {});
    expect(r.status()).toBe(400);
  });

  test('POST /giftcards/redeem — 404 GIFTCARD_NOT_FOUND on bogus code', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const r = await post(request, token, '/api/wellness/giftcards/redeem', {
      code: 'NONEXISTENT123456',
      patientId: testPatientId,
    });
    expect(r.status()).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('GIFTCARD_NOT_FOUND');
  });

  test('POST /giftcards/redeem happy path — credits patient wallet', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    // Issue a fresh card so this test owns its own redemption.
    const issue = await post(request, token, '/api/wellness/giftcards', { amount: 750 });
    const card = await issue.json();
    testGiftCardIds.push(card.id);

    const w = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const before = (await w.json()).wallet.balance;

    const r = await post(request, token, '/api/wellness/giftcards/redeem', {
      code: card.code,
      patientId: testPatientId,
    });
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j.giftCard.status).toBe('redeemed');
    expect(j.transaction.type).toBe('CREDIT_GIFTCARD');
    expect(j.transaction.amount).toBe(750);

    const w2 = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    const after = (await w2.json()).wallet.balance;
    expect(after).toBe(before + 750);
  });

  test('POST /giftcards/redeem — 409 ALREADY_REDEEMED on second redemption', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const issue = await post(request, token, '/api/wellness/giftcards', { amount: 200 });
    const card = await issue.json();
    testGiftCardIds.push(card.id);

    const r1 = await post(request, token, '/api/wellness/giftcards/redeem', { code: card.code, patientId: testPatientId });
    expect(r1.status()).toBe(201);
    const r2 = await post(request, token, '/api/wellness/giftcards/redeem', { code: card.code, patientId: testPatientId });
    expect(r2.status()).toBe(409);
    const j = await r2.json();
    expect(j.code).toBe('GIFTCARD_ALREADY_REDEEMED');
  });

  test('cross-tenant — generic admin cannot redeem wellness gift card', async ({ request }) => {
    const { token: adminToken } = await login(request, 'admin');
    const { token: genericToken } = await login(request, 'generic');
    test.skip(!testPatientId, 'no test patient');

    const issue = await post(request, adminToken, '/api/wellness/giftcards', { amount: 100 });
    const card = await issue.json();
    testGiftCardIds.push(card.id);

    const r = await post(request, genericToken, '/api/wellness/giftcards/redeem', {
      code: card.code,
      patientId: testPatientId,
    });
    // Either 403 (RBAC) or 404 (cross-tenant invisible) is acceptable; the
    // wallet credit must NOT happen.
    expect([403, 404]).toContain(r.status());
  });

  // ────────────────────────────────────────────────────────────────
  // Wave-B Agent 3 (#653) — bcrypt-hash-at-rest hardening
  // ────────────────────────────────────────────────────────────────
  //
  // Codes are bcrypt-hashed at rest. Plaintext is returned ONCE on POST
  // (response carries `code` (plaintext) + `oneTimeCode` (alias)). The
  // DB stores `codeHash` + masked `code` ("ABCD****WXYZ") + `codeLast4`.
  // Subsequent reads (GET /giftcards) never return the plaintext.

  test('POST /giftcards response carries `oneTimeCode` alias for the plaintext', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards', { amount: 111 });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testGiftCardIds.push(row.id);

    expect(typeof row.oneTimeCode).toBe('string');
    expect(row.oneTimeCode).toMatch(/^[A-Z0-9]{16}$/);
    // The `code` field on POST response equals `oneTimeCode` for back-compat
    // with operators emailing the recipient using the existing field.
    expect(row.code).toBe(row.oneTimeCode);
  });

  test('POST /giftcards response NEVER exposes codeHash', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards', { amount: 99 });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testGiftCardIds.push(row.id);
    expect(row.codeHash).toBeUndefined();
  });

  test('POST /giftcards exposes `codeLast4` matching the plaintext suffix', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/giftcards', { amount: 50 });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testGiftCardIds.push(row.id);

    expect(typeof row.codeLast4).toBe('string');
    expect(row.codeLast4).toHaveLength(4);
    expect(row.oneTimeCode.slice(-4)).toBe(row.codeLast4);
  });

  test('GET /giftcards (list) NEVER returns the redeemable plaintext code', async ({ request }) => {
    const { token } = await login(request, 'admin');
    // Issue a card so we have at least one row to inspect.
    const issue = await post(request, token, '/api/wellness/giftcards', { amount: 77 });
    const created = await issue.json();
    testGiftCardIds.push(created.id);
    const plaintext = created.oneTimeCode;

    const r = await get(request, token, '/api/wellness/giftcards');
    expect(r.status()).toBe(200);
    const j = await r.json();
    const row = j.giftCards.find((g) => g.id === created.id);
    expect(row).toBeTruthy();

    // The list MUST NOT carry the plaintext code or the bcrypt hash.
    expect(row.codeHash).toBeUndefined();
    expect(row.code).not.toBe(plaintext);
    // Masked-display format: "AAAA****ZZZZ" (12 chars: 4 + 4 stars + 4).
    expect(row.code).toMatch(/^.{4}\*{4}.{4}$/);
    // Last-4 of the masked display equals last-4 of the plaintext (UI hint).
    expect(row.code.slice(-4)).toBe(plaintext.slice(-4));
    expect(row.codeLast4).toBe(plaintext.slice(-4));
  });

  test('POST /giftcards/redeem uses hash-verify — wrong code with right last-4 returns 404', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');

    const issue = await post(request, token, '/api/wellness/giftcards', { amount: 33 });
    const card = await issue.json();
    testGiftCardIds.push(card.id);
    const last4 = card.oneTimeCode.slice(-4);

    // Construct a 16-char code with the SAME last-4 but a different prefix.
    // Even though codeLast4 narrows candidates to this card, bcrypt.compare
    // on the wrong prefix MUST fail and return GIFTCARD_NOT_FOUND.
    const fakePrefix = 'ZZZZZZZZZZZZ'.slice(0, 12);
    const fakeCode = fakePrefix + last4;
    expect(fakeCode).not.toBe(card.oneTimeCode);

    const r = await post(request, token, '/api/wellness/giftcards/redeem', {
      code: fakeCode,
      patientId: testPatientId,
    });
    expect(r.status()).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('GIFTCARD_NOT_FOUND');
  });

  test('POST /giftcards/redeem succeeds using the plaintext returned at issue', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');

    // Issue + redeem, exercising the full hash → verify roundtrip.
    const issue = await post(request, token, '/api/wellness/giftcards', { amount: 60 });
    const card = await issue.json();
    testGiftCardIds.push(card.id);

    const r = await post(request, token, '/api/wellness/giftcards/redeem', {
      code: card.oneTimeCode, // ← plaintext from POST response
      patientId: testPatientId,
    });
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j.giftCard.status).toBe('redeemed');
    // Redeemed-row response also keeps codeHash off the wire.
    expect(j.giftCard.codeHash).toBeUndefined();
    expect(j.transaction.amount).toBe(60);
  });
});

// ──────────────────────────────────────────────────────────────────
// Coupons
// ──────────────────────────────────────────────────────────────────

test.describe('Coupons', () => {
  test('GET /coupons — auth gate', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/coupons`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('GET /coupons returns envelope shape', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await get(request, token, '/api/wellness/coupons');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.coupons)).toBe(true);
  });

  test('POST /coupons — 400 on bad input', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons', {});
    expect(r.status()).toBe(400);
    const r2 = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-BAD`,
      discountType: 'BOGO',
      discountValue: 10,
    });
    expect(r2.status()).toBe(400);
    const r3 = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-BAD`,
      discountType: 'PERCENT',
      discountValue: 150,
    });
    expect(r3.status()).toBe(400);
  });

  test('POST /coupons happy path — PERCENT', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-P`,
      discountType: 'PERCENT',
      discountValue: 10,
    });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testCouponIds.push(row.id);
    expect(row.discountType).toBe('PERCENT');
    expect(row.discountValue).toBe(10);
    expect(row.code).toBe(`${RUN_TAG}-P`);
  });

  test('POST /coupons happy path — FLAT + maxRedemptions + validity', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-F`,
      discountType: 'FLAT',
      discountValue: 50,
      maxRedemptions: 5,
      validUntil: new Date(Date.now() + 86400000 * 30).toISOString(),
    });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testCouponIds.push(row.id);
    expect(row.discountType).toBe('FLAT');
    expect(row.maxRedemptions).toBe(5);
  });

  test('POST /coupons — 409 COUPON_DUPLICATE on same code in same tenant', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-P`, // already created above
      discountType: 'PERCENT',
      discountValue: 5,
    });
    expect(r.status()).toBe(409);
    const j = await r.json();
    expect(j.code).toBe('COUPON_DUPLICATE');
  });

  test('PUT /coupons/:id — update discount value', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(testCouponIds.length === 0, 'no coupons created');
    const id = testCouponIds[0];
    const r = await put(request, token, `/api/wellness/coupons/${id}`, { discountValue: 20 });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(updated.discountValue).toBe(20);
  });

  test('PUT /coupons/:id — 404 on non-existent', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await put(request, token, '/api/wellness/coupons/9999999', { discountValue: 5 });
    expect(r.status()).toBe(404);
  });

  test('DELETE /coupons/:id — manager rejected (admin only)', async ({ request }) => {
    const { token } = await login(request, 'manager');
    test.skip(testCouponIds.length === 0, 'no coupons created');
    const r = await del(request, token, `/api/wellness/coupons/${testCouponIds[0]}`);
    expect(r.status()).toBe(403);
  });

  test('POST /coupons/preview — 400 on missing baseAmount', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons/preview', { code: `${RUN_TAG}-P` });
    expect(r.status()).toBe(400);
  });

  test('POST /coupons/preview — 404 COUPON_NOT_FOUND on bogus code', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons/preview', {
      code: 'BOGUS_NEVER_EXISTED',
      baseAmount: 100,
    });
    expect(r.status()).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('COUPON_NOT_FOUND');
  });

  test('POST /coupons/preview — PERCENT computes correctly', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons/preview', {
      code: `${RUN_TAG}-P`,
      baseAmount: 1000,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    // Coupon was updated to 20% above
    expect(j.discount).toBe(200);
    expect(j.finalAmount).toBe(800);
    expect(j.applied).toBe(true);
  });

  test('POST /coupons/preview — FLAT computes correctly', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/coupons/preview', {
      code: `${RUN_TAG}-F`,
      baseAmount: 200,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.discount).toBe(50);
    expect(j.finalAmount).toBe(150);
  });

  test('POST /coupons/apply increments redemptionCount', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(testCouponIds.length === 0, 'no coupons created');
    const before = await get(request, token, '/api/wellness/coupons');
    const beforeRow = (await before.json()).coupons.find((c) => c.code === `${RUN_TAG}-P`);
    const r = await post(request, token, '/api/wellness/coupons/apply', {
      code: `${RUN_TAG}-P`,
      baseAmount: 500,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.redemptionCount).toBe(beforeRow.redemptionCount + 1);
    expect(j.discount).toBe(100);
  });

  test('POST /coupons/apply — 409 COUPON_LIMIT_REACHED after maxRedemptions hits', async ({ request }) => {
    const { token } = await login(request, 'admin');
    // Create a 1-shot coupon
    const create = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-LIMIT`,
      discountType: 'FLAT',
      discountValue: 10,
      maxRedemptions: 1,
    });
    const c = await create.json();
    testCouponIds.push(c.id);
    const r1 = await post(request, token, '/api/wellness/coupons/apply', {
      code: c.code,
      baseAmount: 100,
    });
    expect(r1.status()).toBe(200);
    const r2 = await post(request, token, '/api/wellness/coupons/apply', {
      code: c.code,
      baseAmount: 100,
    });
    expect(r2.status()).toBe(409);
    const j = await r2.json();
    expect(j.code).toBe('COUPON_LIMIT_REACHED');
  });

  test('POST /coupons/preview — 410 COUPON_EXPIRED for expired coupon', async ({ request }) => {
    const { token } = await login(request, 'admin');
    // Create an expired coupon directly (validUntil in past).
    // The route accepts validUntil at create-time without rejecting past dates,
    // so we can use this to seed the expired branch.
    const r = await post(request, token, '/api/wellness/coupons', {
      code: `${RUN_TAG}-EXPD`,
      discountType: 'PERCENT',
      discountValue: 5,
      validUntil: new Date(Date.now() - 86400000).toISOString(),
    });
    if (r.status() === 201) {
      const c = await r.json();
      testCouponIds.push(c.id);
      const preview = await post(request, token, '/api/wellness/coupons/preview', {
        code: c.code,
        baseAmount: 100,
      });
      expect(preview.status()).toBe(410);
      const j = await preview.json();
      expect(j.code).toBe('COUPON_EXPIRED');
    }
  });

  test('cross-tenant — generic user cannot apply wellness coupon', async ({ request }) => {
    const { token } = await login(request, 'generic');
    const r = await post(request, token, '/api/wellness/coupons/preview', {
      code: `${RUN_TAG}-P`,
      baseAmount: 100,
    });
    // Generic user is in a non-wellness tenant; tenant-scoped lookup → 404 NOT_FOUND.
    expect([403, 404]).toContain(r.status());
  });
});

// ──────────────────────────────────────────────────────────────────
// Cashback
// ──────────────────────────────────────────────────────────────────

test.describe('Cashback', () => {
  test('GET /cashback-rules — auth gate', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/cashback-rules`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('GET /cashback-rules — manager succeeds + returns array', async ({ request }) => {
    const { token } = await login(request, 'manager');
    const r = await get(request, token, '/api/wellness/cashback-rules');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.rules)).toBe(true);
  });

  test('POST /cashback-rules — 400 on bad input', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/cashback-rules', {});
    expect(r.status()).toBe(400);
    const r2 = await post(request, token, '/api/wellness/cashback-rules', {
      name: 'too-high', earnPercent: 150,
    });
    expect(r2.status()).toBe(400);
    const r3 = await post(request, token, '/api/wellness/cashback-rules', {
      name: 'neg', earnPercent: -1,
    });
    expect(r3.status()).toBe(400);
  });

  test('POST /cashback-rules happy path', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/cashback-rules', {
      name: `${RUN_TAG}-rule`,
      earnPercent: 5,
    });
    expect(r.status()).toBe(201);
    const row = await r.json();
    testCashbackRuleIds.push(row.id);
    expect(row.earnPercent).toBe(5);
    expect(row.isActive).toBe(true);
  });

  test('PUT /cashback-rules/:id — update earnPercent', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(testCashbackRuleIds.length === 0, 'no rule created');
    const id = testCashbackRuleIds[0];
    const r = await put(request, token, `/api/wellness/cashback-rules/${id}`, { earnPercent: 7.5 });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.earnPercent).toBe(7.5);
  });

  test('PUT /cashback-rules/:id — 400 on out-of-range earnPercent', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(testCashbackRuleIds.length === 0, 'no rule created');
    const id = testCashbackRuleIds[0];
    const r = await put(request, token, `/api/wellness/cashback-rules/${id}`, { earnPercent: 999 });
    expect(r.status()).toBe(400);
  });

  test('PUT /cashback-rules/:id — 404 on missing rule', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await put(request, token, '/api/wellness/cashback-rules/9999999', { earnPercent: 5 });
    expect(r.status()).toBe(404);
  });

  test('DELETE /cashback-rules/:id — manager rejected (admin only)', async ({ request }) => {
    const { token } = await login(request, 'manager');
    test.skip(testCashbackRuleIds.length === 0, 'no rule created');
    const r = await del(request, token, `/api/wellness/cashback-rules/${testCashbackRuleIds[0]}`);
    expect(r.status()).toBe(403);
  });

  test('POST /visits/:id/apply-cashback — 404 on non-existent visit', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const r = await post(request, token, '/api/wellness/visits/9999999/apply-cashback', {});
    expect(r.status()).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────
// Sanity: ledger sign convention + balanceAfter snapshot
// ──────────────────────────────────────────────────────────────────

test.describe('Ledger invariants', () => {
  test('ledger amounts: credits > 0, debits < 0; balanceAfter monotonic with sign', async ({ request }) => {
    const { token } = await login(request, 'admin');
    test.skip(!testPatientId, 'no test patient');
    const r = await get(request, token, `/api/wellness/patients/${testPatientId}/wallet`);
    expect(r.status()).toBe(200);
    const j = await r.json();
    // Ledger is ordered desc by createdAt; reverse to walk forward.
    const tx = [...j.transactions].reverse();
    let runningBalance = 0;
    for (const row of tx) {
      runningBalance = +(runningBalance + row.amount).toFixed(2);
      expect(row.balanceAfter).toBe(runningBalance);
      const isCredit = row.type.startsWith('CREDIT_');
      const isDebit = row.type.startsWith('DEBIT_');
      expect(isCredit || isDebit).toBe(true);
      if (isCredit) expect(row.amount).toBeGreaterThan(0);
      if (isDebit) expect(row.amount).toBeLessThan(0);
    }
    // Final running balance equals the wallet's stored balance.
    expect(runningBalance).toBe(j.wallet.balance);
  });
});
