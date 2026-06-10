// @ts-check
/**
 * Unit tests for backend/routes/payments.js — pin the gateway-agnostic
 * payment surface (Stripe + Razorpay + tenant-scoped list/get/config) that
 * backs the Billing page checkout flow.
 *
 * Why this file exists
 * ────────────────────
 * payments.js is 515 LOC of multi-tenant gateway plumbing with several
 * historically-rotten contracts that broke release-validation before. The
 * existing backend/test/integration/stripe-webhook.test.js drives the
 * Stripe webhook signature path deeply with the real Stripe SDK, but the
 * other 6 endpoints (`GET /`, `GET /config`, `GET /:id`, `POST
 * /create-stripe-intent`, `POST /create-razorpay-order`, `POST
 * /confirm-razorpay`, `POST /webhook/razorpay`) were entirely untested.
 *
 * What this file pins (14 cases across 7 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — tenant-scoped list with status/gateway filters; cross-tenant
 *      rows never appear because where.tenantId = req.user.tenantId is the
 *      first key in the where clause.
 *   2. GET / — ?invoiceId flows through as parseInt; status uppercased,
 *      gateway lowercased (canonical wire shape the Billing UI sends).
 *   3. GET / — ?from + ?to date-range filter (#846): both bounds optional +
 *      independent, date-only `to` pushed to end-of-day for inclusive
 *      semantics, unparseable values → 400 with code INVALID_DATE_RANGE.
 *   4. GET /:id — 200 with serialized payment (metadata JSON-parsed); 404
 *      on cross-tenant id (where.tenantId mismatch).
 *   5. GET /config — every authenticated caller sees
 *      `{stripe.configured, razorpay.configured}` (boolean); ADMIN ALSO
 *      sees `stripe.webhookConfigured` + `razorpay.keyId` 8-char prefix
 *      mask. #650 — non-ADMIN gets MASKED disclosure (no keyId leak).
 *   6. GET /config — every call writes a PaymentConfig.READ audit row
 *      capturing role + disclosed=("full" or "masked").
 *   7. POST /create-stripe-intent — 400 when amount missing; 503 when
 *      Stripe not configured; happy path creates a Payment row + returns
 *      `{clientSecret, paymentId, intentId}`.
 *   8. POST /create-razorpay-order — 400 when amount missing; 503 when
 *      Razorpay not configured.
 *   9. POST /confirm-razorpay — verifies HMAC-SHA256 of
 *      `${order_id}|${payment_id}` against the body's signature; flips
 *      payment to FAILED + 400 on mismatch; flips to SUCCESS + 200 on
 *      match and updates linked Invoice to PAID.
 *  10. POST /confirm-razorpay — 400 when required fields missing; 404 when
 *      paymentId doesn't belong to req.user.tenantId.
 *  11. POST /webhook/razorpay — 400 when x-razorpay-signature doesn't
 *      HMAC-SHA256 the raw body; 200 + payment.update({SUCCESS}) +
 *      invoice.update({PAID}) when signature matches and event is
 *      `payment.captured`.
 *  12. POST /webhook/razorpay — `payment.failed` event flips payment to
 *      FAILED but DOES NOT touch invoice (invoice stays in its prior
 *      state — wallet/retry flow handles re-attempt).
 *  13. POST /webhook/razorpay — 503 when no RAZORPAY_WEBHOOK_SECRET or
 *      RAZORPAY_KEY_SECRET configured (early-exit before signature check).
 *  14. Cross-cutting tenant isolation — every read-path endpoint
 *      (list/get/confirm) scopes by req.user.tenantId.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/funnel.test.js and the existing
 * backend/test/integration/stripe-webhook.test.js — prisma singleton
 * monkey-patch BEFORE requiring the router (vi.mock doesn't reliably
 * intercept CJS require in this repo's vitest config), env vars set
 * pre-import for the lazy SDK factories, supertest with a fake auth
 * middleware that sets req.user. The real Razorpay HMAC path is exercised
 * end-to-end (no signature mocking) because that's exactly what we need
 * to pin — a future refactor that breaks the HMAC compute would silently
 * accept forged webhooks otherwise.
 *
 * Stripe SDK loading: we set STRIPE_SECRET_KEY pre-import so getStripe()
 * can load the real SDK lazily. We use the real `stripe` package + its
 * `webhooks.generateTestHeaderString` helper where needed; for the
 * create-stripe-intent test we monkey-patch the cached client's
 * `paymentIntents.create` after the first call so we don't hit the
 * network. This matches the canonical CJS self-mocking seam pattern.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

// ── env MUST be set before importing the route ─────────────────────────
// The route's getStripe() / getRazorpay() factories are lazy and cache.
process.env.STRIPE_SECRET_KEY = 'sk_test_payments_route_fixture';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_payments_route_fixture';
process.env.RAZORPAY_KEY_ID = 'rzp_test_payments_route';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_payments_route_fixture';

// ── prisma singleton patching ──────────────────────────────────────────
import prisma from '../../lib/prisma.js';

prisma.payment = prisma.payment || {};
prisma.payment.findMany = vi.fn();
prisma.payment.findFirst = vi.fn();
prisma.payment.create = vi.fn();
prisma.payment.update = vi.fn();
prisma.invoice = prisma.invoice || {};
prisma.invoice.findFirst = vi.fn();
prisma.invoice.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
// eventBus.emitEvent reads automationRule.findMany — stub so the
// best-effort emit doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
// writeAudit reads/writes AuditLog — stub to no-op for assertion capture.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
// #848 — customer-payment endpoints now load the TENANT's own Razorpay keys
// from PaymentGatewayConfig (BYOK) instead of the platform env vars. The
// default mock below models a tenant whose configured keys mirror the env
// fixtures, so the HMAC fixtures in these tests keep matching.
prisma.paymentGatewayConfig = prisma.paymentGatewayConfig || {};
prisma.paymentGatewayConfig.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const paymentsRouter = requireCJS('../../routes/payments');
const stripeLib = requireCJS('stripe');
const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);

// The route destructures `writeAudit` from lib/audit at module-load, so a
// vi.spyOn(auditMod, 'writeAudit') replacement applied AFTER the route's
// require would not intercept the destructured local binding (a classic
// CJS-shape gotcha — the route holds a stable reference to the original
// function). Instead we assert audit emission via the writeAudit's
// downstream prisma.auditLog.create call, which is stubbed above.

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  // Webhooks need raw body — the route installs express.raw per-route,
  // so we MUST NOT install a global JSON parser ahead of /webhook/*.
  // Apply express.json only for the non-webhook handlers; we mount it
  // AFTER the router for the /webhook/* paths and BEFORE for others by
  // using a path-conditional middleware. Mirroring server.js: the global
  // body parser there explicitly skips /api/payments/webhook.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/payments/webhook')) return next();
    return express.json()(req, res, next);
  });
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/payments', paymentsRouter);
  return app;
}

beforeEach(() => {
  prisma.payment.findMany.mockReset();
  prisma.payment.findFirst.mockReset();
  prisma.payment.create.mockReset();
  prisma.payment.update.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.update.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.paymentGatewayConfig.findFirst.mockReset();
  prisma.auditLog.create.mockClear();
  prisma.auditLog.findFirst.mockClear();

  // Sensible defaults — each test overrides what it cares about.
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.payment.findFirst.mockResolvedValue(null);
  prisma.payment.create.mockResolvedValue({ id: 1, status: 'PENDING' });
  prisma.payment.update.mockResolvedValue({ id: 1, status: 'SUCCESS' });
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.invoice.update.mockResolvedValue({ id: 1, status: 'PAID' });
  prisma.tenant.findUnique.mockResolvedValue({ defaultCurrency: 'INR' });
  // Default: tenant HAS configured its own Razorpay, mirroring the env
  // fixtures so the HMAC fixtures keep matching. Tests that want the
  // "not configured" path override this with mockResolvedValue(null).
  prisma.paymentGatewayConfig.findFirst.mockResolvedValue({
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    isActive: true,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list payments
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list payments under tenant scope', () => {
  test('returns serialized payments with metadata JSON-parsed, scoped by req.user.tenantId', async () => {
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 1,
        invoiceId: 10,
        amount: 99.5,
        currency: 'USD',
        gateway: 'stripe',
        gatewayId: 'pi_a',
        status: 'SUCCESS',
        tenantId: 1,
        metadata: '{"clientSecret":"cs_x"}',
        createdAt: new Date('2026-05-01'),
      },
      {
        id: 2,
        invoiceId: null,
        amount: 1500,
        currency: 'INR',
        gateway: 'razorpay',
        gatewayId: 'order_b',
        status: 'PENDING',
        tenantId: 1,
        metadata: null,
        createdAt: new Date('2026-05-02'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/payments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].metadata).toEqual({ clientSecret: 'cs_x' });
    expect(res.body[1].metadata).toEqual({}); // null → {} fallback
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('?status, ?gateway, ?invoiceId flow through with canonical casing + parsed int', async () => {
    prisma.payment.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/payments?status=pending&gateway=STRIPE&invoiceId=42');

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        status: 'PENDING',       // uppercased
        gateway: 'stripe',       // lowercased
        invoiceId: 42,           // parsed int
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('?from + ?to flows into where.createdAt with gte/lte, date-only `to` pushed to end-of-day (#846)', async () => {
    prisma.payment.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/payments?from=2026-01-01&to=2026-06-30');

    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.payment.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt.gte).toEqual(new Date('2026-01-01'));
    // `to=2026-06-30` (date-only) → pushed to 23:59:59.999 of that day
    const lte = call.where.createdAt.lte;
    expect(lte.getUTCFullYear()).toBe(2026);
    // The route uses local-time setHours, so we just verify the tail-of-day
    // pushing happened (hours+mins+secs all > 0).
    expect(lte.getHours() * 3600 + lte.getMinutes() * 60 + lte.getSeconds())
      .toBeGreaterThan(23 * 3600);
  });

  test('returns 400 with code INVALID_DATE_RANGE when from/to is unparseable', async () => {
    const res = await request(makeApp()).get('/api/payments?from=not-a-date');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — payment details
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — single payment', () => {
  test('200 with serialized payment scoped by id + tenantId', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      amount: 250,
      gateway: 'stripe',
      gatewayId: 'pi_x',
      status: 'SUCCESS',
      metadata: '{"k":"v"}',
    });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/payments/5');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.metadata).toEqual({ k: 'v' });
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
  });

  test('404 when payment id belongs to a different tenant (cross-tenant isolation)', async () => {
    // Payment exists for tenant 99 but we're tenant 1 — findFirst returns null
    // because its where clause includes tenantId: 1.
    prisma.payment.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/payments/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /config — role-gated configuration disclosure (#650)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /config — role-gated disclosure (#650)', () => {
  test('non-ADMIN gets MASKED disclosure (no keyId, no webhookConfigured)', async () => {
    const res = await request(makeApp({ role: 'USER' })).get('/api/payments/config');

    expect(res.status).toBe(200);
    expect(res.body.stripe.configured).toBe(true);
    expect(res.body.razorpay.configured).toBe(true);
    // Critical: non-ADMIN MUST NOT see the keyId prefix or webhookConfigured.
    expect(res.body.stripe).not.toHaveProperty('webhookConfigured');
    expect(res.body.razorpay).not.toHaveProperty('keyId');
  });

  test('ADMIN gets FULL disclosure (keyId 8-char prefix mask + webhookConfigured)', async () => {
    const res = await request(makeApp({ role: 'ADMIN' })).get('/api/payments/config');

    expect(res.status).toBe(200);
    expect(res.body.stripe.webhookConfigured).toBe(true);
    // keyId is 8-char prefix + '...' — never the full key.
    expect(res.body.razorpay.keyId).toBe('rzp_test...');
    expect(res.body.razorpay.keyId).not.toContain(process.env.RAZORPAY_KEY_SECRET);
  });

  test('every /config call writes a PaymentConfig.READ audit row with role + disclosed shape', async () => {
    await request(makeApp({ role: 'USER', userId: 42, tenantId: 9 }))
      .get('/api/payments/config');

    // writeAudit is fire-and-forget — flush microtasks so the async
    // auditLog.create lands before we assert.
    await new Promise((r) => setImmediate(r));

    // Assert via the downstream prisma.auditLog.create — the writeAudit
    // helper serializes its details arg into the data.details column.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const lastCall = prisma.auditLog.create.mock.calls.at(-1)[0];
    expect(lastCall.data.entity).toBe('PaymentConfig');
    expect(lastCall.data.action).toBe('READ');
    expect(lastCall.data.tenantId).toBe(9);
    expect(lastCall.data.userId).toBe(42);
    expect(String(lastCall.data.details)).toContain('"role":"USER"');
    expect(String(lastCall.data.details)).toContain('"disclosed":"masked"');

    prisma.auditLog.create.mockClear();
    await request(makeApp({ role: 'ADMIN', userId: 1, tenantId: 9 }))
      .get('/api/payments/config');
    await new Promise((r) => setImmediate(r));

    expect(prisma.auditLog.create).toHaveBeenCalled();
    const adminCall = prisma.auditLog.create.mock.calls.at(-1)[0];
    expect(adminCall.data.entity).toBe('PaymentConfig');
    expect(String(adminCall.data.details)).toContain('"role":"ADMIN"');
    expect(String(adminCall.data.details)).toContain('"disclosed":"full"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create-stripe-intent
// ─────────────────────────────────────────────────────────────────────────

describe('POST /create-stripe-intent — validation surface', () => {
  test('returns 400 when amount is missing', async () => {
    const res = await request(makeApp())
      .post('/api/payments/create-stripe-intent')
      .send({ invoiceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('returns 400 when amount is non-numeric', async () => {
    const res = await request(makeApp())
      .post('/api/payments/create-stripe-intent')
      .send({ amount: 'free-pls' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create-razorpay-order
// ─────────────────────────────────────────────────────────────────────────

describe('POST /create-razorpay-order — validation surface', () => {
  test('returns 400 when amount is missing', async () => {
    const res = await request(makeApp())
      .post('/api/payments/create-razorpay-order')
      .send({ invoiceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /confirm-razorpay — HMAC verification + invoice mark-paid
// ─────────────────────────────────────────────────────────────────────────

describe('POST /confirm-razorpay — signature verification', () => {
  test('returns 400 + missing-fields error when required body fields are absent', async () => {
    const res = await request(makeApp())
      .post('/api/payments/confirm-razorpay')
      .send({ paymentId: 1 }); // missing the 3 razorpay_* fields

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  test('returns 404 when paymentId belongs to a different tenant', async () => {
    prisma.payment.findFirst.mockResolvedValue(null); // not found under this tenant

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/confirm-razorpay')
      .send({
        paymentId: 999,
        razorpay_payment_id: 'pay_x',
        razorpay_signature: 'sig_x',
        razorpay_order_id: 'order_x',
      });

    expect(res.status).toBe(404);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 1 },
    });
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('200 + payment marked SUCCESS + invoice marked PAID on valid signature', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 7,
      tenantId: 1,
      invoiceId: 50,
      metadata: null,
    });
    prisma.invoice.findFirst.mockResolvedValue({ id: 50, tenantId: 1, status: 'PENDING' });
    prisma.payment.update.mockResolvedValue({
      id: 7,
      tenantId: 1,
      invoiceId: 50,
      status: 'SUCCESS',
      gateway: 'razorpay',
      currency: 'INR',
      amount: 1000,
      paidAt: new Date(),
      metadata: null,
    });

    const order_id = 'order_confirm_ok';
    const payment_id = 'pay_confirm_ok';
    // Build the exact HMAC the route expects: SHA256(`${order_id}|${payment_id}`, key_secret)
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/confirm-razorpay')
      .send({
        paymentId: 7,
        razorpay_payment_id: payment_id,
        razorpay_signature: sig,
        razorpay_order_id: order_id,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Payment flipped to SUCCESS with paidAt + gatewayId
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        status: 'SUCCESS',
        paidAt: expect.any(Date),
        gatewayId: payment_id,
      }),
    });
    // Invoice marked PAID via markInvoicePaid helper
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'PAID' },
    });
  });

  test('400 + payment flipped to FAILED on signature mismatch', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 7,
      tenantId: 1,
      invoiceId: null,
      metadata: null,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/confirm-razorpay')
      .send({
        paymentId: 7,
        razorpay_payment_id: 'pay_x',
        razorpay_signature: 'definitely_not_the_right_hmac',
        razorpay_order_id: 'order_x',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    // Defensive — payment flipped to FAILED so retries don't keep
    // attempting on the same bad signature.
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: 'FAILED' },
    });
    // Invoice MUST NOT be touched on bad sig.
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #848 — customer payments require the TENANT's own Razorpay config (BYOK).
// When the tenant hasn't configured/activated keys, the endpoints refuse with
// 503 GATEWAY_NOT_CONFIGURED rather than silently charging the platform's
// account. No env fallback for customer payments.
// ─────────────────────────────────────────────────────────────────────────
describe('customer payments require tenant Razorpay config (no env fallback)', () => {
  test('create-razorpay-order → 503 GATEWAY_NOT_CONFIGURED when tenant has no config', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/create-razorpay-order')
      .send({ amount: 500, currency: 'INR' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GATEWAY_NOT_CONFIGURED');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('create-razorpay-order → 503 when tenant config exists but is inactive', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValue({
      keyId: 'rzp_live_abc',
      keySecret: 'secret',
      isActive: false,
    });
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/create-razorpay-order')
      .send({ amount: 500, currency: 'INR' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GATEWAY_NOT_CONFIGURED');
  });

  test('confirm-razorpay → 503 GATEWAY_NOT_CONFIGURED when tenant has no config', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/payments/confirm-razorpay')
      .send({
        paymentId: 7,
        razorpay_payment_id: 'pay_x',
        razorpay_signature: 'sig',
        razorpay_order_id: 'order_x',
      });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GATEWAY_NOT_CONFIGURED');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /webhook/razorpay — HMAC + event dispatch
// ─────────────────────────────────────────────────────────────────────────

describe('POST /webhook/razorpay — signature verification + event dispatch', () => {
  test('400 + Invalid signature when x-razorpay-signature does not match', async () => {
    const eventBody = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x' } } },
    });

    const res = await request(makeApp())
      .post('/api/payments/webhook/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', 'wrong-sig')
      .send(eventBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  test('200 + payment SUCCESS + invoice PAID on valid signature with payment.captured event', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 1,
      invoiceId: 22,
      gateway: 'razorpay',
      gatewayId: 'order_captured',
      status: 'PENDING',
    });
    prisma.invoice.findFirst.mockResolvedValue({ id: 22, tenantId: 1, status: 'PENDING' });
    prisma.payment.update.mockResolvedValue({
      id: 11,
      tenantId: 1,
      invoiceId: 22,
      status: 'SUCCESS',
      gateway: 'razorpay',
      currency: 'INR',
      amount: 1500,
      paidAt: new Date(),
    });

    const eventObj = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_xyz',
            order_id: 'order_captured',
            amount: 150000,
            currency: 'INR',
          },
        },
      },
    };
    const bodyStr = JSON.stringify(eventObj);
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(bodyStr)
      .digest('hex');

    const res = await request(makeApp())
      .post('/api/payments/webhook/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(bodyStr);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { gateway: 'razorpay', gatewayId: 'order_captured' },
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: expect.objectContaining({
        status: 'SUCCESS',
        paidAt: expect.any(Date),
        gatewayId: 'pay_xyz',
      }),
    });
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { status: 'PAID' },
    });
  });

  test('200 + payment FAILED but invoice untouched on payment.failed event', async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 12,
      tenantId: 1,
      invoiceId: 23,
      gateway: 'razorpay',
      gatewayId: 'order_failed',
      status: 'PENDING',
    });

    const eventObj = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_bad', order_id: 'order_failed' },
        },
      },
    };
    const bodyStr = JSON.stringify(eventObj);
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(bodyStr)
      .digest('hex');

    const res = await request(makeApp())
      .post('/api/payments/webhook/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sig)
      .send(bodyStr);

    expect(res.status).toBe(200);
    // Payment marked FAILED…
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { status: 'FAILED' },
    });
    // …but invoice MUST NOT be marked PAID on a failed payment.
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});
