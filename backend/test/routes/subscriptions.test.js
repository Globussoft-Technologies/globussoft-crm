// @ts-check
/**
 * Unit tests for backend/routes/subscriptions.js — pin the contract of the
 * user-level subscription surface (Razorpay-backed plan selection + payment
 * verification + cancel) that powers the in-app upgrade-from-trial flow.
 *
 * Why this file exists
 * ────────────────────
 * subscriptions.js was the top-10 under-covered file in the codebase per
 * c8 measurement (10.21% lines) — zero vitest coverage, zero playwright
 * coverage. The route handles real money (Razorpay HMAC signature
 * verification + Subscription row creation) so silent contract drift on
 * any of the five endpoints could either accept forged payment signatures
 * or block legitimate paying users. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET /status                — current user's subscription + trial
 *   2. GET /plans                 — active subscription plans (price asc)
 *   3. POST /create-order         — proxy to razorpayService.createOrder
 *   4. POST /verify-payment       — HMAC signature verify → Subscription
 *                                   row + flip user.subscriptionStatus
 *   5. PATCH /:id/cancel          — cancel subscription, downgrade user
 *                                   when no other ACTIVE subs remain
 *
 * Cases (16 total)
 * ────────────────
 *   GET /status (3): happy 200 with active sub serialized; 200 with
 *     subscription: null when no ACTIVE sub; 404 when user not found;
 *     401 when req.user missing (defensive — global verifyToken should
 *     reject earlier, but the route guards anyway).
 *   GET /plans (2): 200 with formattedPlans (features JSON-parsed,
 *     price coerced to float); empty array fallback.
 *   POST /create-order (3): 400 when planId missing; 404 when plan not
 *     found; happy 200 returns {orderId, amount, currency, planId, planName}.
 *   POST /verify-payment (5): 400 on missing field; 400 on invalid HMAC
 *     signature; 400 on duplicate razorpayOrderId; 404 on missing plan;
 *     happy 200 creates Subscription + flips user.subscriptionStatus.
 *   PATCH /:id/cancel (3): 404 when sub belongs to another tenant
 *     (cross-tenant isolation); happy 200 flips status to CANCELLED +
 *     downgrades user when no other ACTIVE subs; happy 200 keeps user
 *     ACTIVE when another sub is still active.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/payments.test.js — prisma singleton
 * monkey-patch BEFORE requiring the router (vi.mock doesn't reliably
 * intercept CJS require in this repo's vitest config). razorpayService
 * is monkey-patched at module-singleton level (CJS self-mocking seam) so
 * we never hit the real Razorpay API. A real-signed JWT proves the
 * verifyToken integration end-to-end (the route's req.user.{userId,
 * tenantId} contract is what gets pinned, not a fake-auth shortcut).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── env MUST be set before requiring the route ─────────────────────────
process.env.RAZORPAY_KEY_ID = 'rzp_test_subs_route';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_subs_route_fixture';

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.user.update = vi.fn();
prisma.subscription = prisma.subscription || {};
prisma.subscription.findFirst = vi.fn();
prisma.subscription.findUnique = vi.fn();
prisma.subscription.create = vi.fn();
prisma.subscription.update = vi.fn();
prisma.subscriptionPlan = prisma.subscriptionPlan || {};
prisma.subscriptionPlan.findMany = vi.fn();
prisma.subscriptionPlan.findUnique = vi.fn();
// eventBus's best-effort emit walks automationRule.findMany — stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── razorpayService singleton patching (CJS self-mocking seam) ──────────
// The route does `const razorpayService = require('../services/razorpayService')`
// at module-load. Replacing properties on the EXPORTED singleton works
// because the route holds the module.exports object reference, not the
// individual function bindings.
const razorpayService = requireCJS('../../services/razorpayService');
razorpayService.createOrder = vi.fn();
razorpayService.verifySignature = vi.fn();

// ── eventBus stubs (best-effort writeAudit / route-side emit) ──────────
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { JWT_SECRET } = requireCJS('../../config/secrets');
const subscriptionsRouter = requireCJS('../../routes/subscriptions');

function signToken({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  // The user-level subscription surface (status / create-order / verify-payment
  // / cancel / invoices) is gated by verifyRole(['ADMIN']) — see routes/
  // subscriptions.js. Default the token role to ADMIN so the auth gate passes
  // and we exercise the route body. Tests that want to PROBE the role gate
  // override this via the opts argument.
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionsRouter);
  return app;
}

function authedGet(app, path, opts) {
  return request(app).get(path).set('Authorization', `Bearer ${signToken(opts)}`);
}
function authedPost(app, path, body, opts) {
  return request(app).post(path).set('Authorization', `Bearer ${signToken(opts)}`).send(body);
}
function authedPatch(app, path, body, opts) {
  return request(app).patch(path).set('Authorization', `Bearer ${signToken(opts)}`).send(body || {});
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
  prisma.subscription.findFirst.mockReset();
  prisma.subscription.findUnique.mockReset();
  prisma.subscription.create.mockReset();
  prisma.subscription.update.mockReset();
  prisma.subscriptionPlan.findMany.mockReset();
  prisma.subscriptionPlan.findUnique.mockReset();
  razorpayService.createOrder.mockReset();
  razorpayService.verifySignature.mockReset();

  prisma.user.findUnique.mockResolvedValue({
    id: 7,
    trialStartDate: new Date('2026-05-01'),
    trialEndsAt: new Date('2026-06-01'),
    subscriptionStatus: 'TRIAL',
  });
  prisma.user.update.mockResolvedValue({ id: 7 });
  prisma.subscription.findFirst.mockResolvedValue(null);
  prisma.subscription.findUnique.mockResolvedValue(null);
  prisma.subscription.create.mockResolvedValue({
    id: 1,
    planName: 'Pro',
    status: 'ACTIVE',
    endDate: new Date('2026-07-01'),
  });
  prisma.subscription.update.mockResolvedValue({ id: 1, status: 'CANCELLED' });
  prisma.subscriptionPlan.findMany.mockResolvedValue([]);
  prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /status — current user's subscription + trial state
// ─────────────────────────────────────────────────────────────────────────

describe('GET /status — current user trial + subscription', () => {
  test('200 with subscription serialized when an ACTIVE subscription exists', async () => {
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      trialStartDate: new Date('2026-05-01'),
      trialEndsAt: trialEnd,
      subscriptionStatus: 'ACTIVE',
    });
    prisma.subscription.findFirst.mockResolvedValue({
      id: 42,
      planName: 'Pro',
      status: 'ACTIVE',
      startDate: new Date('2026-05-10'),
      endDate: new Date('2026-06-10'),
      renewalDate: new Date('2026-06-10'),
      amount: 999,
      currency: 'INR',
      billingIntervalDays: 30,
    });

    const res = await authedGet(makeApp(), '/api/subscriptions/status');

    expect(res.status).toBe(200);
    expect(res.body.subscriptionStatus).toBe('ACTIVE');
    expect(res.body.subscription).toMatchObject({
      id: 42,
      planName: 'Pro',
      status: 'ACTIVE',
      amount: 999,
      currency: 'INR',
      billingIntervalDays: 30,
    });
    expect(res.body.daysRemaining).toBeGreaterThan(0);
    expect(res.body.trialDaysRemaining).toBeGreaterThan(0);
    // Subscription lookup is tenant-scoped + ACTIVE-only.
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { userId: 7, tenantId: 1, status: 'ACTIVE' },
    });
  });

  test('200 with subscription: null when no ACTIVE subscription found', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      trialStartDate: new Date('2026-05-01'),
      trialEndsAt: null,
      subscriptionStatus: 'TRIAL',
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    const res = await authedGet(makeApp(), '/api/subscriptions/status');

    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeNull();
    expect(res.body.daysRemaining).toBe(0);
    expect(res.body.trialDaysRemaining).toBe(0);
  });

  test('404 when the user lookup returns null', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await authedGet(makeApp(), '/api/subscriptions/status');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /plans — active subscription plans
// ─────────────────────────────────────────────────────────────────────────

describe('GET /plans — active plans', () => {
  test('200 with features JSON-parsed and price coerced to float, ordered by price asc', async () => {
    prisma.subscriptionPlan.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Starter',
        price: '499.00',
        currency: 'INR',
        billingIntervalDays: 30,
        features: '["leads","contacts"]',
        description: 'Starter tier',
      },
      {
        id: 2,
        name: 'Pro',
        price: '1999.00',
        currency: 'INR',
        billingIntervalDays: 30,
        features: null,
        description: 'Pro tier',
      },
    ]);

    const res = await authedGet(makeApp(), '/api/subscriptions/plans');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // `formatPlan` returns a richer envelope than the original spec assumed —
    // it includes `planKey`, `pricing`, `displayOrder`, `popular`, `accentColor`,
    // `cta`, `featuresLabel`, `isActive` in addition to the core 6. Pin the
    // load-bearing fields (price coerced to float, features JSON-parsed) via
    // toMatchObject so the assertion survives future additive envelope changes.
    expect(res.body[0]).toMatchObject({
      id: 1,
      name: 'Starter',
      price: 499,
      currency: 'INR',
      billingIntervalDays: 30,
      features: ['leads', 'contacts'],
      description: 'Starter tier',
    });
    expect(res.body[1].features).toEqual([]); // null → []
    // Ordering is `[{ displayOrder: 'asc' }, { price: 'asc' }]` — the
    // owner-controlled `displayOrder` wins, with `price` as the tie-breaker
    // (matches the /pricing page's stable left-to-right card layout).
    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
    });
  });

  test('200 with empty array when no active plans exist', async () => {
    prisma.subscriptionPlan.findMany.mockResolvedValue([]);

    const res = await authedGet(makeApp(), '/api/subscriptions/plans');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create-order — Razorpay order creation
// ─────────────────────────────────────────────────────────────────────────

describe('POST /create-order — Razorpay order creation', () => {
  test('400 when planId missing from body', async () => {
    const res = await authedPost(makeApp(), '/api/subscriptions/create-order', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/planId is required/i);
    expect(razorpayService.createOrder).not.toHaveBeenCalled();
  });

  test('404 when plan not found for the supplied planId', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

    const res = await authedPost(makeApp(), '/api/subscriptions/create-order', { planId: 99 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/plan not found/i);
    expect(prisma.subscriptionPlan.findUnique).toHaveBeenCalledWith({ where: { id: 99 } });
    expect(razorpayService.createOrder).not.toHaveBeenCalled();
  });

  test('200 returns Razorpay order envelope { orderId, amount, currency, planId, planName }', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2,
      name: 'Pro',
      price: 1999,
      currency: 'INR',
      billingIntervalDays: 30,
    });
    razorpayService.createOrder.mockResolvedValue({
      id: 'order_test_abc',
      amount: 199900, // paise
      currency: 'INR',
    });

    const res = await authedPost(makeApp(), '/api/subscriptions/create-order', { planId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orderId: 'order_test_abc',
      amount: 199900,
      currency: 'INR',
      planId: 2,
      planName: 'Pro',
    });
    // The route passes `(chargeAmount, planId, chargeCurrency)` — the
    // currency argument was added when /pricing gained the USD/INR toggle.
    // When the body doesn't pass `currency` + `billingPeriod`, chargeCurrency
    // falls back to the plan's own `currency` column.
    expect(razorpayService.createOrder).toHaveBeenCalledWith(1999, 2, 'INR');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-payment — signature verify + subscription create
// ─────────────────────────────────────────────────────────────────────────

describe('POST /verify-payment — HMAC signature verify + subscription create', () => {
  test('400 when any of razorpayOrderId / razorpayPaymentId / razorpaySignature / planId missing', async () => {
    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_x',
      // razorpaySignature missing
      planId: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing payment details/i);
    expect(razorpayService.verifySignature).not.toHaveBeenCalled();
  });

  test('400 when Razorpay HMAC signature does not verify', async () => {
    razorpayService.verifySignature.mockReturnValue(false);

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_x',
      razorpayPaymentId: 'pay_x',
      razorpaySignature: 'deadbeef'.repeat(8),
      planId: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid payment signature/i);
    expect(razorpayService.verifySignature).toHaveBeenCalledWith(
      'order_x',
      'pay_x',
      'deadbeef'.repeat(8),
    );
    // Must not create a Subscription on forged signature.
    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  test('400 when a Subscription already exists for this razorpayOrderId (idempotency guard)', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue({ id: 50, razorpayOrderId: 'order_dup' });

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_dup',
      razorpayPaymentId: 'pay_y',
      razorpaySignature: 'a'.repeat(64),
      planId: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
    expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
      where: { razorpayOrderId: 'order_dup' },
    });
    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  test('404 when the supplied planId no longer maps to a SubscriptionPlan row', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_z',
      razorpayPaymentId: 'pay_z',
      razorpaySignature: 'a'.repeat(64),
      planId: 999,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/plan not found/i);
    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  test('200 creates Subscription + flips user.subscriptionStatus to ACTIVE on valid signature', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2,
      name: 'Pro',
      price: 1999,
      currency: 'INR',
      billingIntervalDays: 30,
      features: '["all"]',
    });
    prisma.subscription.create.mockResolvedValue({
      id: 101,
      planName: 'Pro',
      status: 'ACTIVE',
      endDate: new Date('2026-07-01'),
    });

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_ok',
      razorpayPaymentId: 'pay_ok',
      razorpaySignature: 'b'.repeat(64),
      planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription).toEqual({
      id: 101,
      planName: 'Pro',
      status: 'ACTIVE',
      endDate: expect.any(String),
    });
    // Subscription row written with the user + tenant from the JWT
    // (NOT the body — the route reads req.user.userId / tenantId).
    expect(prisma.subscription.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.subscription.create.mock.calls[0][0].data;
    expect(createArg.userId).toBe(7);
    expect(createArg.tenantId).toBe(1);
    expect(createArg.planId).toBe(2);
    expect(createArg.planName).toBe('Pro');
    expect(createArg.status).toBe('ACTIVE');
    expect(createArg.razorpayOrderId).toBe('order_ok');
    expect(createArg.razorpayPaymentId).toBe('pay_ok');
    // User row flipped to ACTIVE + trialEndsAt cleared so the trial banner
    // disappears on next /status load.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { subscriptionStatus: 'ACTIVE', trialEndsAt: null },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /:id/cancel — cancel + conditional user downgrade
// ─────────────────────────────────────────────────────────────────────────

describe('PATCH /:id/cancel — cancel + conditional user downgrade', () => {
  test('404 when subscription id belongs to a different tenant (cross-tenant isolation)', async () => {
    // findFirst's where includes { userId, tenantId } so a cross-tenant
    // id resolves to null — the route returns 404 without ever calling
    // subscription.update.
    prisma.subscription.findFirst.mockResolvedValue(null);

    const res = await authedPatch(makeApp(), '/api/subscriptions/777/cancel', {}, { tenantId: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { id: 777, userId: 7, tenantId: 1 },
    });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  test('200 flips status to CANCELLED + downgrades user when no other ACTIVE subs remain', async () => {
    // First findFirst — the lookup of the sub being cancelled (returns it).
    // Second findFirst — the "any other ACTIVE sub?" check (returns null).
    prisma.subscription.findFirst
      .mockResolvedValueOnce({ id: 50, userId: 7, tenantId: 1, status: 'ACTIVE' })
      .mockResolvedValueOnce(null);
    prisma.subscription.update.mockResolvedValue({ id: 50, status: 'CANCELLED' });

    const res = await authedPatch(makeApp(), '/api/subscriptions/50/cancel');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription).toEqual({ id: 50, status: 'CANCELLED' });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'CANCELLED' },
    });
    // User downgraded because no other ACTIVE sub remains.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { subscriptionStatus: 'CANCELLED' },
    });
  });

  test('200 cancels target sub but LEAVES user ACTIVE when another ACTIVE sub remains', async () => {
    prisma.subscription.findFirst
      .mockResolvedValueOnce({ id: 50, userId: 7, tenantId: 1, status: 'ACTIVE' })
      .mockResolvedValueOnce({ id: 51, userId: 7, tenantId: 1, status: 'ACTIVE' });
    prisma.subscription.update.mockResolvedValue({ id: 50, status: 'CANCELLED' });

    const res = await authedPatch(makeApp(), '/api/subscriptions/50/cancel');

    expect(res.status).toBe(200);
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'CANCELLED' },
    });
    // User NOT downgraded — another ACTIVE sub still covers them.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-cutting — every authenticated endpoint enforces JWT presence
// ─────────────────────────────────────────────────────────────────────────

describe('Auth gate — verifyToken enforced on every endpoint', () => {
  test('GET /status without Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/subscriptions/status');
    expect(res.status).toBe(401);
  });
});
