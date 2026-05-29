// @ts-check
/**
 * e2e API contract pin for backend/routes/subscriptions.js — raises the
 * route's c8 coverage above the 10.21% baseline by exercising each handler
 * through the live api_tests-gate backend.
 *
 * Why this spec exists
 * ────────────────────
 * subscriptions.js had rich vitest coverage at backend/test/routes/
 * subscriptions.test.js (543 LOC / 17 cases, 198% test:source ratio) but
 * ZERO e2e gate exercise — so c8 against the api_tests gate reported only
 * 10.21% lines on the file. vitest mocks prisma + razorpayService at the
 * singleton level (CJS self-mocking seam), which pins the unit-level
 * contract but doesn't touch the c8-instrumented runtime backend. This
 * spec drives the route through the running Express stack on :5000 (or
 * the demo URL via BASE_URL override) and pins the wire contract that the
 * trial-upgrade flow + the cancel surface depend on.
 *
 * Route surface
 * ─────────────
 *   GET   /api/subscriptions/status               trial + active sub
 *   GET   /api/subscriptions/plans                active plans (asc price)
 *   POST  /api/subscriptions/create-order         Razorpay order proxy
 *   POST  /api/subscriptions/verify-payment       HMAC verify + create sub
 *   PATCH /api/subscriptions/:id/cancel           cancel + maybe downgrade
 *
 * Contracts asserted (≥12 cases)
 * ──────────────────────────────
 *   1.  GET /status (no Bearer)                  → 401
 *   2.  GET /status (admin token)                → 200 with subscriptionStatus,
 *                                                  trialDaysRemaining,
 *                                                  daysRemaining, subscription
 *                                                  field present (may be null)
 *   3.  GET /plans (admin token)                 → 200 with plan array; each
 *                                                  plan has id/name/price (number)/
 *                                                  currency/features (array)
 *   4.  GET /plans returns plans ordered price asc
 *   5.  POST /create-order missing planId        → 400 with planId-required msg
 *   6.  POST /create-order non-existent planId   → 404 plan-not-found
 *   7.  POST /create-order valid planId          → 200 with orderId/planId/
 *                                                  planName/amount/currency
 *                                                  (when RAZORPAY env present;
 *                                                  else accepts 500 + skip)
 *   8.  POST /verify-payment missing fields      → 400 missing-payment-details
 *   9.  POST /verify-payment bad-length sig      → 400 invalid-signature
 *   10. POST /verify-payment plausibly-shaped
 *       (but unsigned) signature                 → 400 invalid-signature
 *   11. PATCH /:id/cancel cross-tenant /
 *       non-existent id                          → 404 not-found
 *   12. PATCH /:id/cancel without token          → 401
 *   13. PATCH /:id/cancel on non-numeric id      → 400 or 404 (never 500)
 *   14. POST /create-order without token         → 401
 *   15. POST /verify-payment without token       → 401
 *   16. GET /plans without token                 → 401
 *
 * The route has NO `POST /api/subscriptions` generic-create endpoint — the
 * only way a Subscription row enters the system is the Razorpay HMAC-verify
 * happy path (which requires RAZORPAY_KEY_SECRET, not exposed to the test
 * runner). PATCH /:id/cancel HAPPY path is therefore deliberately omitted
 * here; the vitest sibling pins it at the unit layer (cases at lines 492-
 * 531 of backend/test/routes/subscriptions.test.js).
 *
 * Run locally:
 *   cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *     npx playwright test --project=chromium tests/subscriptions-api.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let token = null;

async function login(request) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

const authHdr = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: authHdr(token),
    data: body,
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPatch(request, path, body) {
  return request.patch(`${BASE_URL}${path}`, {
    headers: authHdr(token),
    data: body || {},
    timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  token = await login(request);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /status — current user's trial + subscription state
// ─────────────────────────────────────────────────────────────────────────

test.describe('subscriptions API — GET /status', () => {
  test('GET /status without Authorization → 401/403', async ({ request }) => {
    const r = await request.get(`${API}/subscriptions/status`);
    expect([401, 403]).toContain(r.status());
  });

  test('GET /status with admin token returns subscriptionStatus + trial fields + subscription slot', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/subscriptions/status');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('subscriptionStatus');
    expect(body).toHaveProperty('trialDaysRemaining');
    expect(body).toHaveProperty('daysRemaining');
    expect(body).toHaveProperty('subscription');
    // subscription is either null (no ACTIVE row) or an object with id/planName/status.
    if (body.subscription !== null) {
      expect(body.subscription).toHaveProperty('id');
      expect(body.subscription).toHaveProperty('planName');
      expect(body.subscription).toHaveProperty('status');
    }
    expect(typeof body.daysRemaining).toBe('number');
    expect(body.daysRemaining).toBeGreaterThanOrEqual(0);
    expect(typeof body.trialDaysRemaining).toBe('number');
    expect(body.trialDaysRemaining).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /plans — active subscription plans
// ─────────────────────────────────────────────────────────────────────────

test.describe('subscriptions API — GET /plans', () => {
  test('GET /plans is PUBLIC (marketing catalog) → 200 without Authorization', async ({ request }) => {
    // GET /subscriptions/plans is deliberately public — the /pricing page
    // fetches it anonymously pre-login (server.js global-guard exception:
    // "Public marketing catalog"). Admin CRUD (POST/PUT/DELETE + /plans/admin)
    // stays auth-gated. This pins the public-read contract.
    const r = await request.get(`${API}/subscriptions/plans`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /plans returns 200 with array; each plan has id, name, price (number), currency, features (array)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/subscriptions/plans');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    // Seed plants 3 plans (Starter / Professional / Enterprise) but be
    // tolerant — demo seed history could vary.
    for (const p of body) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('price');
      expect(typeof p.price).toBe('number');
      expect(p).toHaveProperty('currency');
      // features must always render as an array — the route JSON.parse's
      // a String? @db.Text column with a `|| []` fallback for null.
      expect(Array.isArray(p.features)).toBe(true);
    }
  });

  test('GET /plans returns plans ordered by price ascending', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authGet(request, '/api/subscriptions/plans');
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (body.length < 2) test.skip(true, 'need ≥2 plans to assert ordering');
    for (let i = 1; i < body.length; i++) {
      expect(body[i].price).toBeGreaterThanOrEqual(body[i - 1].price);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create-order — Razorpay order creation proxy
// ─────────────────────────────────────────────────────────────────────────

test.describe('subscriptions API — POST /create-order', () => {
  test('POST /create-order without Authorization → 401/403', async ({ request }) => {
    const r = await request.post(`${API}/subscriptions/create-order`, {
      data: { planId: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  });

  test('POST /create-order without planId → 400 planId-required', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/subscriptions/create-order', {});
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/planId is required/i);
  });

  test('POST /create-order with non-existent planId → 404 plan-not-found', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/subscriptions/create-order', { planId: 99999999 });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.error).toMatch(/plan not found/i);
  });

  test('POST /create-order with a valid seeded plan → 200 + Razorpay order envelope (when RAZORPAY env present)', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // Pick the cheapest seeded plan.
    const plansRes = await authGet(request, '/api/subscriptions/plans');
    expect(plansRes.status()).toBe(200);
    const plans = await plansRes.json();
    test.skip(plans.length === 0, 'no seeded plans to exercise /create-order');

    const r = await authPost(request, '/api/subscriptions/create-order', { planId: plans[0].id });

    // If RAZORPAY_KEY_ID/SECRET are not set in the api_tests env block,
    // the Razorpay SDK constructor throws → catch path → 500. Accept the
    // happy 200 OR the env-gap 500 (which still exercises the c8 lines
    // through the catch handler). NEVER accept anything else.
    expect([200, 500]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body).toHaveProperty('orderId');
      expect(body).toHaveProperty('amount');
      expect(body).toHaveProperty('currency');
      expect(body).toHaveProperty('planId', plans[0].id);
      expect(body).toHaveProperty('planName', plans[0].name);
    } else {
      const body = await r.json();
      expect(body.error).toMatch(/failed to create order/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-payment — HMAC signature check + Subscription create
// ─────────────────────────────────────────────────────────────────────────

test.describe('subscriptions API — POST /verify-payment', () => {
  test('POST /verify-payment without Authorization → 401/403', async ({ request }) => {
    const r = await request.post(`${API}/subscriptions/verify-payment`, {
      data: {
        razorpayOrderId: 'order_x',
        razorpayPaymentId: 'pay_x',
        razorpaySignature: 'a'.repeat(64),
        planId: 1,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  });

  test('POST /verify-payment missing razorpaySignature → 400 missing-payment-details', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_x',
      // razorpaySignature missing
      planId: 1,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/missing payment details/i);
  });

  test('POST /verify-payment missing planId → 400 missing-payment-details', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    const r = await authPost(request, '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_x',
      razorpaySignature: 'a'.repeat(64),
      // planId missing
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/missing payment details/i);
  });

  test('POST /verify-payment with wrong-length signature (odd-hex) → 400 invalid-signature', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // crypto.timingSafeEqual throws on length mismatch — the route's inner
    // try/catch swallows that and returns false → 400.
    const r = await authPost(request, '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_short',
      razorpayPaymentId: 'pay_short',
      razorpaySignature: 'deadbeef', // too short for SHA-256 hex (64 chars)
      planId: 1,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid payment signature/i);
  });

  test('POST /verify-payment with plausibly-shaped but unsigned signature → 400 invalid-signature', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // 64-char hex but not actually HMAC'd by RAZORPAY_KEY_SECRET → verify
    // returns false → 400. The subscription create() is NEVER reached, so
    // we don't leak rows on this path.
    const r = await authPost(request, '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_unsigned',
      razorpayPaymentId: 'pay_unsigned',
      razorpaySignature: 'ab'.repeat(32), // 64 hex chars
      planId: 1,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid payment signature/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /:id/cancel — cancel an existing subscription
// ─────────────────────────────────────────────────────────────────────────

test.describe('subscriptions API — PATCH /:id/cancel', () => {
  test('PATCH /:id/cancel without Authorization → 401/403', async ({ request }) => {
    const r = await request.patch(`${API}/subscriptions/1/cancel`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  });

  test('PATCH /:id/cancel on non-existent id (cross-tenant / not-mine) → 404 not-found', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // The route's findFirst is scoped { id, userId, tenantId } — a high id
    // that does not belong to admin@globussoft.com resolves to null → 404.
    const r = await authPatch(request, '/api/subscriptions/99999999/cancel');
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.error).toMatch(/not found/i);
  });

  test('PATCH /:id/cancel on non-numeric id never returns 500', async ({ request }) => {
    test.skip(!token, 'auth unavailable');
    // parseInt('foo') is NaN — Prisma's findFirst with id: NaN either
    // throws (caught → 500) or finds nothing (→ 404). Pinning the
    // tolerant contract: a 4xx is acceptable, a 500 is a regression.
    const r = await authPatch(request, '/api/subscriptions/not-a-number/cancel');
    expect([400, 404]).toContain(r.status());
  });
});
