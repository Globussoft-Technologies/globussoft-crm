// @ts-check
/**
 * /api/payments — smoke spec covering 6 handlers in
 * backend/routes/payments.js. Webhooks are public; the rest authenticated.
 *
 * Stripe / Razorpay SDK calls (create-stripe-intent, create-razorpay-order)
 * require live keys — they're tested only for the auth gate + missing-amount
 * validation. Webhook signature paths are tested with bogus payloads.
 *
 *   POST   /webhook/stripe            (public — signature-verified)
 *   POST   /webhook/razorpay          (public — HMAC-verified)
 *   GET    /
 *   GET    /config
 *   GET    /:id
 *   POST   /create-stripe-intent
 *   POST   /create-razorpay-order
 *   POST   /confirm-razorpay
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

test.describe.configure({ mode: 'serial' });

test.describe('payments API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test('GET / requires auth', async ({ request }) => {
    const res = await request.get(`${API}/payments`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns array of payments', async ({ request }) => {
    const res = await request.get(`${API}/payments`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET / honors status/gateway/invoiceId filters', async ({ request }) => {
    const res = await request.get(`${API}/payments?gateway=stripe&status=PENDING`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  // ── #846 — date-range filter ────────────────────────────────────
  // GET /api/payments accepts optional `?from=YYYY-MM-DD&to=YYYY-MM-DD`.
  // Both params are independent + optional. Both must be Date-parseable,
  // otherwise the route returns 400 with code INVALID_DATE_RANGE. The
  // `to` boundary is auto-pushed to end-of-day when a date-only string
  // is provided so the range is inclusive of the trailing calendar date.
  test('#846 GET /?from&to filters by createdAt range', async ({ request }) => {
    const res = await request.get(`${API}/payments?from=2026-01-01&to=2026-03-31`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Every returned row's createdAt must fall inside the window. (If the
    // window has zero matching rows for the demo seed, an empty array is
    // a valid + correct response — the filter applied, no row qualified.)
    for (const p of body) {
      const ts = new Date(p.createdAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(new Date('2026-01-01').getTime());
      expect(ts).toBeLessThanOrEqual(new Date('2026-03-31T23:59:59.999').getTime());
    }
  });

  test('#846 GET /?from=invalid returns 400 with INVALID_DATE_RANGE', async ({ request }) => {
    const res = await request.get(`${API}/payments?from=not-a-date`, { headers: auth() });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('code', 'INVALID_DATE_RANGE');
  });

  test('GET /config exposes gateway configuration flags', async ({ request }) => {
    const res = await request.get(`${API}/payments/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stripe');
    expect(body).toHaveProperty('razorpay');
    expect(body.stripe).toHaveProperty('configured');
    expect(body.razorpay).toHaveProperty('configured');
  });

  // ── #650 — role-gated disclosure ────────────────────────────────
  // ADMIN sees `keyId` prefix + `webhookConfigured`; non-ADMIN sees the
  // bare `configured` booleans only. Each call emits a PaymentConfig.READ
  // audit row recording the disclosure shape.
  test('#650 GET /config — ADMIN sees the razorpay keyId prefix + webhookConfigured', async ({ request }) => {
    const res = await request.get(`${API}/payments/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The demo box may or may not have RAZORPAY_KEY_ID set — accept either a
    // non-empty prefix or `null`, but the field MUST be present for ADMIN.
    expect(body.razorpay).toHaveProperty('keyId');
    expect(body.stripe).toHaveProperty('webhookConfigured');
  });

  test('#650 GET /config — non-ADMIN does NOT receive the keyId prefix', async ({ request }) => {
    const userLogin = await request.post(`${API}/auth/login`, {
      data: { email: 'user@crm.com', password: 'password123' },
    });
    expect(userLogin.ok(), 'generic USER login must succeed').toBeTruthy();
    const userToken = (await userLogin.json()).token;

    const res = await request.get(`${API}/payments/config`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.stripe).toHaveProperty('configured');
    expect(body.razorpay).toHaveProperty('configured');
    // The diagnostic-only fields MUST NOT leak to non-ADMIN callers.
    expect(body.razorpay).not.toHaveProperty('keyId');
    expect(body.stripe).not.toHaveProperty('webhookConfigured');
  });

  test('#650 GET /config requires auth (no token → 401/403)', async ({ request }) => {
    const res = await request.get(`${API}/payments/config`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id 404s for unknown payment', async ({ request }) => {
    const res = await request.get(`${API}/payments/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /create-stripe-intent rejects missing amount with 400 (or 503 if Stripe disabled)', async ({ request }) => {
    const res = await request.post(`${API}/payments/create-stripe-intent`, {
      headers: auth(),
      data: {},
    });
    // 503 when STRIPE_SECRET_KEY isn't set on this env; 400 otherwise.
    expect([400, 503]).toContain(res.status());
  });

  test('POST /create-razorpay-order rejects missing amount with 400 (or 503 if RZP disabled)', async ({ request }) => {
    const res = await request.post(`${API}/payments/create-razorpay-order`, {
      headers: auth(),
      data: {},
    });
    expect([400, 503]).toContain(res.status());
  });

  test('POST /confirm-razorpay rejects missing fields with 400 (or 503 if no secret)', async ({ request }) => {
    const res = await request.post(`${API}/payments/confirm-razorpay`, {
      headers: auth(),
      data: {},
    });
    expect([400, 503]).toContain(res.status());
  });

  // ── Public webhooks ──────────────────────────────────────────────
  test('POST /webhook/stripe rejects payloads without a valid signature', async ({ request }) => {
    const res = await request.post(`${API}/payments/webhook/stripe`, {
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'bogus' },
      data: { type: 'payment_intent.succeeded' },
    });
    // 503 if STRIPE_WEBHOOK_SECRET not set; 400 if signature verification fails
    expect([400, 503]).toContain(res.status());
  });

  test('POST /webhook/stripe without signature header', async ({ request }) => {
    const res = await request.post(`${API}/payments/webhook/stripe`, {
      headers: { 'Content-Type': 'application/json' },
      data: { type: 'noop' },
    });
    expect([400, 503]).toContain(res.status());
  });

  test('POST /webhook/razorpay rejects payloads without a valid HMAC', async ({ request }) => {
    const res = await request.post(`${API}/payments/webhook/razorpay`, {
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'bogus' },
      data: { event: 'payment.captured', payload: {} },
    });
    // 503 if no RZP secret configured; 400 if signature verification fails
    expect([400, 503]).toContain(res.status());
  });

  test('POST /webhook/razorpay without signature returns 4xx/503', async ({ request }) => {
    const res = await request.post(`${API}/payments/webhook/razorpay`, {
      headers: { 'Content-Type': 'application/json' },
      data: { event: 'noop' },
    });
    expect([400, 503]).toContain(res.status());
  });
});
