// @ts-check
/**
 * Customer-facing gift-card storefront API contract.
 *
 * NEW route family added to backend/routes/wellness.js (this commit):
 *
 *   GET    /api/wellness/giftcards/storefront           — any tenant user
 *   POST   /api/wellness/giftcards/:id/purchase/order   — any tenant user,
 *                                                        creates Razorpay
 *                                                        order + Payment
 *   POST   /api/wellness/giftcards/:id/purchase/confirm — any tenant user,
 *                                                        verifies signature,
 *                                                        credits wallet,
 *                                                        marks card redeemed
 *
 * What this spec pins:
 *   - Storefront filter contract: only `status='active'` cards with
 *     `price != null`, `issuedTo == null`, `redeemedAt == null`,
 *     `(expiresAt == null OR expiresAt > now)` appear in the storefront
 *     projection. Code / codeHash / codeLast4 are NEVER returned.
 *   - Issued cards do not appear (admin issuance keeps them off the
 *     storefront).
 *   - Cards without a `price` (admin-issue-only) are hidden from the
 *     storefront.
 *   - /purchase/order validation: 400 on missing patientId,
 *     404 on cross-tenant or unknown patient, 409 when the card is no
 *     longer storefront-eligible.
 *   - /purchase/confirm validation: 400 on missing fields, 400 on
 *     malformed signature, 404 when paymentId doesn't exist.
 *   - Cross-tenant isolation: a generic-tenant admin cannot see or
 *     purchase a wellness-tenant storefront card.
 *
 * Razorpay-keyed flows (actual order creation + verified signature) are
 * BYOK (#848): the order endpoint uses THIS tenant's own Razorpay config
 * (PaymentGatewayConfig), not platform env keys. So the order tests branch
 * on `tenantGatewayActive` (queried at runtime via GET /api/payment-gateways)
 * — 200/502 when the tenant gateway is active, 503 with a clear message when
 * it isn't. Subscription billing (tenant → Globussoft) still uses env keys
 * and is out of scope for this spec.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_STOREFRONT_${Date.now()}`;

const FIXTURES = {
  wellnessAdmin: { email: 'admin@wellness.demo',    password: 'password123' },
  genericAdmin:  { email: 'admin@globussoft.com',   password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: fixture,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return { token: null, userId: null };
  const j = await r.json();
  tokenCache[who] = j.token;
  userIdCache[who] = j.user.id;
  return { token: j.token, userId: j.user.id };
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function patchReq(request, token, path, body) {
  return request.patch(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// #848 — does THIS tenant have an active, fully-configured Razorpay gateway?
// Customer-payment endpoints (BYOK) succeed only when it does, so the
// storefront order tests branch on this rather than on a platform env flag.
async function tenantGatewayActive(request) {
  try {
    const r = await get(request, wellnessToken, '/api/payment-gateways');
    if (!r.ok()) return false;
    const rows = await r.json();
    const rzp = Array.isArray(rows) ? rows.find((c) => c.provider === 'razorpay') : null;
    return !!(rzp && rzp.isActive && rzp.keyId && rzp.keySecret && rzp.keySecret.configured);
  } catch (_e) {
    return false;
  }
}

// State carried across the serial describe blocks.
let wellnessToken = null;
let genericToken = null;
let testPatientId = null;
let storefrontCardId = null;     // active, priced, unissued — should show up
let noPriceCardId = null;        // active, NO price — should be hidden
let issuedCardId = null;         // issued to a patient — should be hidden
const PHONE_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+91 98765 ${suffix}`;
}

test.beforeAll(async ({ request }) => {
  const w = await login(request, 'wellnessAdmin');
  const g = await login(request, 'genericAdmin');
  wellnessToken = w.token;
  genericToken = g.token;
  if (!wellnessToken) {
    test.skip(true, 'wellness admin login failed — cannot exercise storefront contract');
    return;
  }

  // #848 — customer payments are BYOK; the order endpoint succeeds only when
  // THIS tenant has an active, configured Razorpay gateway. Cache it once.
  gatewayActive = await tenantGatewayActive(request);

  // Create a Patient for use as the wallet recipient.
  const patientRes = await post(request, wellnessToken, '/api/wellness/patients', {
    name: `${RUN_TAG} Patient`,
    phone: nextPhone(),
  });
  if (!patientRes.ok()) {
    test.skip(true, 'patient seed failed — storefront tests cannot run');
    return;
  }
  testPatientId = (await patientRes.json()).id;

  // Storefront-eligible card: active, priced, unissued, no expiry.
  const storefrontRes = await post(request, wellnessToken, '/api/wellness/giftcards', {
    name: `${RUN_TAG} Storefront`,
    amount: 2500,
    price: 2000,
    validityDays: 90,
    color: '#0ea5e9',
  });
  if (storefrontRes.ok()) {
    storefrontCardId = (await storefrontRes.json()).id;
  }

  // Hidden #1: active, NO price (admin-issue-only template).
  const noPriceRes = await post(request, wellnessToken, '/api/wellness/giftcards', {
    name: `${RUN_TAG} NoPrice`,
    amount: 1500,
    // no `price` — admin-issue-only
  });
  if (noPriceRes.ok()) {
    noPriceCardId = (await noPriceRes.json()).id;
  }

  // Hidden #2: card issued to a patient (issuedTo set).
  const issuedRes = await post(request, wellnessToken, '/api/wellness/giftcards', {
    name: `${RUN_TAG} Issued`,
    amount: 1000,
    price: 800,
    issuedTo: testPatientId,
  });
  if (issuedRes.ok()) {
    issuedCardId = (await issuedRes.json()).id;
  }
});

test.afterAll(async ({ request }) => {
  if (!wellnessToken) return;
  // Cancel + rename the seed patient. The gift cards we created cascade
  // off Tenant; ledger/test-data sweeps in demo-hygiene reap them.
  for (const id of [storefrontCardId, noPriceCardId, issuedCardId]) {
    if (id) {
      await patchReq(request, wellnessToken, `/api/wellness/giftcards/${id}`, {
        status: 'cancelled',
      }).catch(() => {});
    }
  }
  if (testPatientId) {
    await request
      .put(`${BASE_URL}/api/wellness/patients/${testPatientId}`, {
        headers: headers(wellnessToken),
        data: { name: `_teardown_${RUN_TAG}` },
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

test.describe('GET /api/wellness/giftcards/storefront', () => {
  test('requires authentication (401 when no token)', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/wellness/giftcards/storefront`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test('returns the eligible storefront card', async ({ request }) => {
    test.skip(!storefrontCardId, 'storefront seed card not created — skipping');
    const r = await get(request, wellnessToken, '/api/wellness/giftcards/storefront');
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.giftCards)).toBe(true);
    const ids = body.giftCards.map((c) => c.id);
    expect(ids).toContain(storefrontCardId);
  });

  test('hides cards with no price (admin-issue-only templates)', async ({ request }) => {
    test.skip(!noPriceCardId, 'no-price seed card not created — skipping');
    const r = await get(request, wellnessToken, '/api/wellness/giftcards/storefront');
    const body = await r.json();
    const ids = body.giftCards.map((c) => c.id);
    expect(ids).not.toContain(noPriceCardId);
  });

  test('hides cards already issued to a patient', async ({ request }) => {
    test.skip(!issuedCardId, 'issued seed card not created — skipping');
    const r = await get(request, wellnessToken, '/api/wellness/giftcards/storefront');
    const body = await r.json();
    const ids = body.giftCards.map((c) => c.id);
    expect(ids).not.toContain(issuedCardId);
  });

  test('does NOT leak code / codeHash / codeLast4 fields', async ({ request }) => {
    const r = await get(request, wellnessToken, '/api/wellness/giftcards/storefront');
    const body = await r.json();
    for (const card of body.giftCards) {
      // The buyer doesn't need the redemption secret — the confirm
      // handler credits the wallet directly. Pin so a refactor that
      // widens the projection can't accidentally expose redemption codes.
      expect(card).not.toHaveProperty('code');
      expect(card).not.toHaveProperty('codeHash');
      expect(card).not.toHaveProperty('codeLast4');
    }
  });

  test('cross-tenant: generic admin does NOT see wellness-tenant storefront cards', async ({ request }) => {
    test.skip(!genericToken || !storefrontCardId, 'cross-tenant token missing');
    const r = await get(request, genericToken, '/api/wellness/giftcards/storefront');
    // Either non-wellness vertical returns 403 / empty, OR returns its
    // own (different-tenant) cards. The pinning contract: the wellness
    // storefront card MUST NOT appear in another tenant's response.
    if (r.ok()) {
      const body = await r.json();
      const ids = (body.giftCards || []).map((c) => c.id);
      expect(ids).not.toContain(storefrontCardId);
    } else {
      expect([401, 403, 404]).toContain(r.status());
    }
  });
});

test.describe('POST /api/wellness/giftcards/:id/purchase/order', () => {
  test('requires authentication (401 without token)', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    const r = await request.post(
      `${BASE_URL}/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { data: { patientId: testPatientId }, timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(r.status());
  });

  test('omitting patientId buys for SELF (200 with Razorpay, 503 without)', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    // No patientId means "buy for myself" — the server resolves (or lazily
    // creates) the caller's own Patient and credits that wallet. The
    // Razorpay config check runs FIRST, so without it the route 503s before
    // ever touching patient resolution.
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      {},
    );
    expect([200, 503]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      // Self-resolved recipient comes back on the order response.
      expect(typeof body.patientId).toBe('number');
      expect(body.giftCardId).toBe(storefrontCardId);
    }
  });

  test('400 on a malformed patientId when gifting (Razorpay configured)', async ({ request }) => {
    test.skip(!storefrontCardId || !gatewayActive, 'requires Razorpay configured for this branch');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { patientId: -5 },
    );
    expect(r.status()).toBe(400);
  });

  test('404 when the patient does not exist in this tenant', async ({ request }) => {
    test.skip(!storefrontCardId || !gatewayActive, 'requires Razorpay configured for this branch');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { patientId: 999999999 },
    );
    expect(r.status()).toBe(404);
  });

  test('404 when the gift card does not exist', async ({ request }) => {
    test.skip(!gatewayActive, 'requires Razorpay configured for this branch');
    const r = await post(
      request,
      wellnessToken,
      '/api/wellness/giftcards/999999999/purchase/order',
      { patientId: testPatientId },
    );
    expect([404, 503]).toContain(r.status());
  });

  test('409 when card is no longer storefront-eligible (already issued)', async ({ request }) => {
    test.skip(!issuedCardId || !gatewayActive, 'requires Razorpay configured + issued seed card');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${issuedCardId}/purchase/order`,
      { patientId: testPatientId },
    );
    expect(r.status()).toBe(409);
  });

  // #848 — customer payments now use the TENANT's OWN Razorpay config (BYOK),
  // not platform env keys. So the order endpoint's outcome depends on whether
  // THIS tenant has an active gateway config, not on env. Both branches are
  // valid contract outcomes; we assert the right shape for whichever applies
  // rather than assuming an env flag. (502 covers an active-but-invalid key
  // rejected by Razorpay.)
  test('purchase/order: 503 with a clear message when the tenant gateway is NOT active', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    test.skip(gatewayActive, 'tenant gateway IS active — opposite branch');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { patientId: testPatientId },
    );
    expect(r.status()).toBe(503);
    const body = await r.json();
    expect(String(body.error || '')).toMatch(/Razorpay|payment/i);
  });

  test('happy path: returns { orderId, paymentId, key, amount, currency } when the tenant gateway is active', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    test.skip(!gatewayActive, 'requires an active tenant Razorpay config');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { patientId: testPatientId },
    );
    // 200 on success; 502 if the configured keys are rejected by Razorpay.
    expect([200, 502]).toContain(r.status());
    if (r.status() !== 200) return;
    const body = await r.json();
    expect(typeof body.orderId).toBe('string');
    expect(typeof body.paymentId).toBe('number');
    expect(typeof body.key).toBe('string');
    expect(typeof body.amount).toBe('number');
    expect(body.amount).toBe(2000 * 100); // paise
    expect(body.giftCardId).toBe(storefrontCardId);
    expect(body.patientId).toBe(testPatientId);
  });
});

test.describe('POST /api/wellness/giftcards/:id/purchase/confirm', () => {
  test('requires authentication (401 without token)', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    const r = await request.post(
      `${BASE_URL}/api/wellness/giftcards/${storefrontCardId}/purchase/confirm`,
      { data: {}, timeout: REQUEST_TIMEOUT },
    );
    expect([401, 403]).toContain(r.status());
  });

  test('400 when any required Razorpay field is missing', async ({ request }) => {
    test.skip(!storefrontCardId, 'no card to target');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/confirm`,
      { paymentId: 1 }, // missing razorpay_* fields
    );
    // 400 from our validator OR 503 if Razorpay isn't configured.
    expect([400, 503]).toContain(r.status());
  });

  test('400 with malformed Razorpay signature', async ({ request }) => {
    test.skip(!storefrontCardId || !gatewayActive, 'requires Razorpay configured');
    // Create a real order first so paymentId is real.
    const orderRes = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/order`,
      { patientId: testPatientId },
    );
    test.skip(!orderRes.ok(), 'could not create order to attack');
    const order = await orderRes.json();
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/confirm`,
      {
        paymentId: order.paymentId,
        razorpay_order_id: order.orderId,
        razorpay_payment_id: 'pay_fake',
        razorpay_signature: 'definitely-not-a-real-hmac',
      },
    );
    // Signature verification failure returns 400.
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(String(body.error || '')).toMatch(/signature/i);
  });

  test('404 when paymentId does not exist', async ({ request }) => {
    test.skip(!storefrontCardId || !gatewayActive, 'requires Razorpay configured');
    const r = await post(
      request,
      wellnessToken,
      `/api/wellness/giftcards/${storefrontCardId}/purchase/confirm`,
      {
        paymentId: 999999999,
        razorpay_order_id: 'order_x',
        razorpay_payment_id: 'pay_x',
        razorpay_signature: 'abc',
      },
    );
    expect(r.status()).toBe(404);
  });
});
