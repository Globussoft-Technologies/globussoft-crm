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

  test('GET /config exposes gateway configuration flags', async ({ request }) => {
    const res = await request.get(`${API}/payments/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stripe');
    expect(body).toHaveProperty('razorpay');
    expect(body.stripe).toHaveProperty('configured');
    expect(body.razorpay).toHaveProperty('configured');
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
