// @ts-check
/**
 * Unit tests for backend/routes/subscriptions.js â€” pin the contract of the
 * user-level subscription surface (Razorpay-backed plan selection + payment
 * verification + cancel) that powers the in-app upgrade-from-trial flow.
 *
 * Why this file exists
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * subscriptions.js was the top-10 under-covered file in the codebase per
 * c8 measurement (10.21% lines) â€” zero vitest coverage, zero playwright
 * coverage. The route handles real money (Razorpay HMAC signature
 * verification + Subscription row creation) so silent contract drift on
 * any of the five endpoints could either accept forged payment signatures
 * or block legitimate paying users. Pin the wire shape now.
 *
 * Endpoints under test
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   1. GET /status                â€” current user's subscription + trial
 *   2. GET /plans                 â€” active subscription plans (price asc)
 *   3. POST /create-order         â€” proxy to razorpayService.createOrder
 *   4. POST /verify-payment       â€” HMAC signature verify â†’ Subscription
 *                                   row + flip user.subscriptionStatus
 *   5. PATCH /:id/cancel          â€” cancel subscription, downgrade user
 *                                   when no other ACTIVE subs remain
 *
 * Cases (16 total)
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   GET /status (3): happy 200 with active sub serialized; 200 with
 *     subscription: null when no ACTIVE sub; 404 when user not found;
 *     401 when req.user missing (defensive â€” global verifyToken should
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
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Mirrors backend/test/routes/payments.test.js â€” prisma singleton
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
const fs = requireCJS('node:fs');
const path = requireCJS('node:path');
const SERVER_JS = path.resolve(process.cwd(), 'server.js');

// â”€â”€ env MUST be set before requiring the route â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
process.env.RAZORPAY_KEY_ID = 'rzp_test_subs_route';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_subs_route_fixture';

// â”€â”€ prisma singleton patching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const prisma = requireCJS('../../lib/prisma');

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.user.update = vi.fn();
prisma.subscription = prisma.subscription || {};
prisma.subscription.findFirst = vi.fn();
prisma.subscription.findUnique = vi.fn();
prisma.subscription.create = vi.fn();
prisma.subscription.update = vi.fn();
// reconcileSubscriptions() expires elapsed periods via updateMany â€” default to
// a no-op (0 rows touched) so the lazy state machine is inert unless a test
// opts into the stacking/promotion path.
prisma.subscription.updateMany = vi.fn();
prisma.subscriptionPlan = prisma.subscriptionPlan || {};
prisma.subscriptionPlan.findMany = vi.fn();
prisma.subscriptionPlan.findUnique = vi.fn();
prisma.$transaction = vi.fn(async (callback) => callback(prisma));
// eventBus's best-effort emit walks automationRule.findMany â€” stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// â”€â”€ razorpayService singleton patching (CJS self-mocking seam) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The route does `const razorpayService = require('../services/razorpayService')`
// at module-load. Replacing properties on the EXPORTED singleton works
// because the route holds the module.exports object reference, not the
// individual function bindings.
const razorpayService = requireCJS('../../services/razorpayService');
razorpayService.createOrder = vi.fn();
razorpayService.verifySignature = vi.fn();

// â”€â”€ eventBus stubs (best-effort writeAudit / route-side emit) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

// â”€â”€ posExpense stub (verify-payment logs the subscription spend to the POS
// drawer best-effort). The route lazily `require('../lib/posExpense')` then
// destructures recordSubscriptionExpense at call time, so patching the
// exported property here is picked up. Default: not recorded (no open shift).
const posExpense = requireCJS('../../lib/posExpense');
posExpense.recordSubscriptionExpense = vi.fn().mockResolvedValue({ recorded: false, reason: 'NO_OPEN_SHIFT' });
posExpense.recordSubscriptionExpenseEntry = vi.fn().mockResolvedValue({ recorded: true, expense: { id: 77 } });

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { JWT_SECRET } = requireCJS('../../config/secrets');
const subscriptionsRouter = requireCJS('../../routes/subscriptions');

function signToken({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  // The user-level subscription surface (status / create-order / verify-payment
  // / cancel / invoices) is gated by verifyRole(['ADMIN']) â€” see routes/
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
  prisma.subscription.updateMany.mockReset();
  prisma.subscriptionPlan.findMany.mockReset();
  prisma.subscriptionPlan.findUnique.mockReset();
  razorpayService.createOrder.mockReset();
  razorpayService.verifySignature.mockReset();
  posExpense.recordSubscriptionExpense.mockReset();
  posExpense.recordSubscriptionExpense.mockResolvedValue({ recorded: false, reason: 'NO_OPEN_SHIFT' });
  posExpense.recordSubscriptionExpenseEntry.mockReset();
  posExpense.recordSubscriptionExpenseEntry.mockResolvedValue({ recorded: true, expense: { id: 77 } });

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
  prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
  prisma.subscriptionPlan.findMany.mockResolvedValue([]);
  prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
describe('server paywall renewal bypass', () => {
  test('allows subscription self-serve endpoints before checkSubscription runs', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const checkSubscriptionIndex = src.indexOf('return checkSubscription(req, res, next)');

    expect(checkSubscriptionIndex).toBeGreaterThan(0);
    for (const endpoint of [
      '/subscriptions/status',
      '/subscriptions/invoices',
      '/subscriptions/create-order',
      '/subscriptions/verify-payment',
    ]) {
      const endpointIndex = src.indexOf(endpoint);
      expect(endpointIndex, endpoint + ' must bypass the paywall so expired admins can renew').toBeGreaterThan(0);
      expect(endpointIndex, endpoint + ' must be checked before checkSubscription').toBeLessThan(checkSubscriptionIndex);
    }
  });
});

// GET /status â€” current user's subscription + trial state
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('GET /status â€” current user trial + subscription', () => {
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

  test('returns EXPIRED when stored ACTIVE has no active subscription row', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      trialStartDate: new Date('2026-05-01'),
      trialEndsAt: null,
      subscriptionStatus: 'ACTIVE',
    });
    prisma.subscription.findFirst.mockResolvedValue(null);

    const res = await authedGet(makeApp(), '/api/subscriptions/status');

    expect(res.status).toBe(200);
    expect(res.body.subscriptionStatus).toBe('EXPIRED');
    expect(res.body.subscription).toBeNull();
  });

  test('404 when the user lookup returns null', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await authedGet(makeApp(), '/api/subscriptions/status');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /plans â€” active subscription plans
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('GET /plans â€” active plans', () => {
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
    // `formatPlan` returns a richer envelope than the original spec assumed â€”
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
    expect(res.body[1].features).toEqual([]); // null â†’ []
    // Ordering is `[{ displayOrder: 'asc' }, { price: 'asc' }]` â€” the
    // owner-controlled `displayOrder` wins, with `price` as the tie-breaker
    // (matches the /pricing page's stable left-to-right card layout).
    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
      take: 200,
    });
  });

  test('200 with empty array when no active plans exist', async () => {
    prisma.subscriptionPlan.findMany.mockResolvedValue([]);

    const res = await authedGet(makeApp(), '/api/subscriptions/plans');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /create-order â€” Razorpay order creation
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('POST /create-order â€” Razorpay order creation', () => {
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
    // The route passes `(chargeAmount, planId, chargeCurrency)` â€” the
    // currency argument was added when /pricing gained the USD/INR toggle.
    // When the body doesn't pass `currency` + `billingPeriod`, chargeCurrency
    // falls back to the plan's own `currency` column.
    expect(razorpayService.createOrder).toHaveBeenCalledWith(1999, 2, 'INR');
  });

  test('annual billing period multiplies the per-month rate Ã— 12 before charging Razorpay', async () => {
    // The pricing JSON stores `annual: 499` (per-month rate for annual plan).
    // When billingPeriod='annual', the route must charge 499 Ã— 12 = 5988,
    // not 499 â€” matching the annual total shown on the /pricing card.
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 1,
      name: 'Starter',
      price: 499,
      currency: 'INR',
      billingIntervalDays: 365,
      pricing: JSON.stringify({
        inr: { annual: 499, monthly: 649, yearAnnualLabel: 'â‚¹5,988 /user/year', yearMonthlyLabel: 'â‚¹7,788 /user/year' },
        usd: { annual: 6, monthly: 8, yearAnnualLabel: '$72 /user/year', yearMonthlyLabel: '$96 /user/year' },
      }),
    });
    razorpayService.createOrder.mockResolvedValue({
      id: 'order_annual_inr',
      amount: 598800, // 5988 Ã— 100 paise
      currency: 'INR',
    });

    const res = await authedPost(makeApp(), '/api/subscriptions/create-order', {
      planId: 1,
      currency: 'inr',
      billingPeriod: 'annual',
    });

    expect(res.status).toBe(200);
    // chargeAmount must be 499 Ã— 12 = 5988, not 499.
    expect(razorpayService.createOrder).toHaveBeenCalledWith(5988, 1, 'INR');
  });

  test('monthly billing period charges the per-month rate as-is (no Ã—12)', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 1,
      name: 'Starter',
      price: 649,
      currency: 'INR',
      billingIntervalDays: 30,
      pricing: JSON.stringify({
        inr: { annual: 499, monthly: 649, yearAnnualLabel: 'â‚¹5,988 /user/year', yearMonthlyLabel: 'â‚¹7,788 /user/year' },
      }),
    });
    razorpayService.createOrder.mockResolvedValue({
      id: 'order_monthly_inr',
      amount: 64900,
      currency: 'INR',
    });

    const res = await authedPost(makeApp(), '/api/subscriptions/create-order', {
      planId: 1,
      currency: 'inr',
      billingPeriod: 'monthly',
    });

    expect(res.status).toBe(200);
    // Monthly rate used as-is â€” no multiplication.
    expect(razorpayService.createOrder).toHaveBeenCalledWith(649, 1, 'INR');
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /verify-payment â€” signature verify + subscription create
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('POST /verify-payment â€” HMAC signature verify + subscription create', () => {
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
    // (NOT the body â€” the route reads req.user.userId / tenantId).
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

  test('QUEUES a second purchase made while a period is still running (stacked dates, SCHEDULED)', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null); // no dup for this order
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });

    // A period is still running and ends in the future. reconcile's probes see
    // it as ACTIVE (no promotion); the stacking lookup returns it as the tail.
    const activeEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // ~20 days out
    prisma.subscription.findFirst.mockImplementation(({ where }) => {
      if (where && where.status === 'ACTIVE') {
        return Promise.resolve({ id: 90, status: 'ACTIVE', endDate: activeEnd });
      }
      if (where && where.status && where.status.in) {
        // stacking lookup (ACTIVE|SCHEDULED ordered by endDate desc)
        return Promise.resolve({ id: 90, status: 'ACTIVE', endDate: activeEnd });
      }
      return Promise.resolve(null);
    });

    prisma.subscription.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 102, ...data }));

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_stack', razorpayPaymentId: 'pay_stack',
      razorpaySignature: 'e'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scheduled).toBe(true);

    const createArg = prisma.subscription.create.mock.calls[0][0].data;
    // New period is queued, not active...
    expect(createArg.status).toBe('SCHEDULED');
    // ...and starts exactly when the running period ends (no overlap, no waste).
    expect(new Date(createArg.startDate).getTime()).toBe(activeEnd.getTime());
    // ...running a full billing interval (30 days) from that start.
    const expectedEnd = activeEnd.getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(new Date(createArg.endDate).getTime()).toBe(expectedEnd);
    // The admin still has live coverage, so the account stays ACTIVE.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { subscriptionStatus: 'ACTIVE', trialEndsAt: null },
    });
  });

  test('activates immediately (ACTIVE, starts now) when no period is currently running', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });
    // No existing coverage at all (default findFirst â†’ null).
    prisma.subscription.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 103, ...data }));

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_fresh', razorpayPaymentId: 'pay_fresh',
      razorpaySignature: 'f'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(false);
    const createArg = prisma.subscription.create.mock.calls[0][0].data;
    expect(createArg.status).toBe('ACTIVE');
    // startDate is "now" (within a couple seconds of the request).
    expect(Date.now() - new Date(createArg.startDate).getTime()).toBeLessThan(5000);
  });

  test('logs to BOTH the Expense ledger and the POS drawer + surfaces flags', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });
    prisma.subscription.create.mockResolvedValue({
      id: 101, planName: 'Pro', status: 'ACTIVE', endDate: new Date('2026-07-01'), amount: 1999,
    });
    posExpense.recordSubscriptionExpenseEntry.mockResolvedValue({ recorded: true, expense: { id: 77 } });
    posExpense.recordSubscriptionExpense.mockResolvedValue({ recorded: true, shiftId: 5 });

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_pos', razorpayPaymentId: 'pay_pos',
      razorpaySignature: 'c'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.expenseRecorded).toBe(true);
    expect(res.body.posExpenseRecorded).toBe(true);
    // Expense Management ledger â€” plan amount + name, scoped to JWT user/tenant.
    expect(posExpense.recordSubscriptionExpenseEntry).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 1, userId: 7, amount: 1999, planName: 'Pro' }),
    );
    // POS drawer â€” "Subscription: <plan>" reason.
    expect(posExpense.recordSubscriptionExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1, userId: 7, amount: 1999, reason: 'Subscription: Pro',
      }),
    );
  });

  test('expenseRecorded=true even when no POS shift is open (Expense ledger is not shift-scoped)', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });
    prisma.subscription.create.mockResolvedValue({
      id: 101, planName: 'Pro', status: 'ACTIVE', endDate: new Date('2026-07-01'), amount: 1999,
    });
    posExpense.recordSubscriptionExpenseEntry.mockResolvedValue({ recorded: true, expense: { id: 77 } });
    posExpense.recordSubscriptionExpense.mockResolvedValue({ recorded: false, reason: 'NO_OPEN_SHIFT' });

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_noshift2', razorpayPaymentId: 'pay_noshift2',
      razorpaySignature: 'f'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.expenseRecorded).toBe(true);   // shows in Expense Management
    expect(res.body.posExpenseRecorded).toBe(false); // not deducted from a drawer
  });

  test('posExpenseRecorded=false when no shift is open (purchase still succeeds)', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });
    prisma.subscription.create.mockResolvedValue({
      id: 101, planName: 'Pro', status: 'ACTIVE', endDate: new Date('2026-07-01'), amount: 1999,
    });
    // default mock already returns { recorded: false }

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_noshift', razorpayPaymentId: 'pay_noshift',
      razorpaySignature: 'd'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.posExpenseRecorded).toBe(false);
  });

  test('a POS-expense failure never breaks the purchase (best-effort)', async () => {
    razorpayService.verifySignature.mockReturnValue(true);
    prisma.subscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      id: 2, name: 'Pro', price: 1999, currency: 'INR', billingIntervalDays: 30, features: '[]',
    });
    prisma.subscription.create.mockResolvedValue({
      id: 101, planName: 'Pro', status: 'ACTIVE', endDate: new Date('2026-07-01'), amount: 1999,
    });
    posExpense.recordSubscriptionExpense.mockRejectedValue(new Error('drawer exploded'));

    const res = await authedPost(makeApp(), '/api/subscriptions/verify-payment', {
      razorpayOrderId: 'order_err', razorpayPaymentId: 'pay_err',
      razorpaySignature: 'e'.repeat(64), planId: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.posExpenseRecorded).toBe(false);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PATCH /:id/cancel â€” cancel + conditional user downgrade
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PATCH /:id/cancel â€” cancel + conditional user downgrade', () => {
  test('404 when subscription id belongs to a different tenant (cross-tenant isolation)', async () => {
    // findFirst's where includes { userId, tenantId } so a cross-tenant
    // id resolves to null â€” the route returns 404 without ever calling
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

  // The cancel handler issues several findFirst reads: (1) the target-sub
  // lookup (where.id present); (2+) reconcileSubscriptions() settling the
  // timeline; (3) the "any coverage left?" check (where.status.in). Key the
  // mock on the where clause rather than call order so the tests don't bind to
  // the internal sequence.
  function mockCancelFindFirst({ target, coverage }) {
    prisma.subscription.findFirst.mockImplementation(({ where }) => {
      if (where && where.id !== undefined) return Promise.resolve(target);
      // remaining-coverage check (status: { in: [...] }) or reconcile's
      // ACTIVE/SCHEDULED probes â€” return whatever live coverage the test set.
      return Promise.resolve(coverage);
    });
  }

  test('200 flips status to CANCELLED + downgrades user when no other ACTIVE subs remain', async () => {
    mockCancelFindFirst({
      target: { id: 50, userId: 7, tenantId: 1, status: 'ACTIVE' },
      coverage: null, // nothing left after cancelling
    });
    prisma.subscription.update.mockResolvedValue({ id: 50, status: 'CANCELLED' });

    const res = await authedPatch(makeApp(), '/api/subscriptions/50/cancel');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription).toEqual({ id: 50, status: 'CANCELLED' });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'CANCELLED' },
    });
    // User downgraded because no other ACTIVE/SCHEDULED sub remains.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { subscriptionStatus: 'CANCELLED' },
    });
  });

  test('200 cancels target sub but LEAVES user ACTIVE when another ACTIVE sub remains', async () => {
    mockCancelFindFirst({
      target: { id: 50, userId: 7, tenantId: 1, status: 'ACTIVE' },
      coverage: { id: 51, userId: 7, tenantId: 1, status: 'ACTIVE' },
    });
    prisma.subscription.update.mockResolvedValue({ id: 50, status: 'CANCELLED' });

    const res = await authedPatch(makeApp(), '/api/subscriptions/50/cancel');

    expect(res.status).toBe(200);
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'CANCELLED' },
    });
    // User NOT downgraded â€” another ACTIVE sub still covers them.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cross-cutting â€” every authenticated endpoint enforces JWT presence
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Auth gate â€” verifyToken enforced on every endpoint', () => {
  test('GET /status without Authorization header â†’ 401', async () => {
    const res = await request(makeApp()).get('/api/subscriptions/status');
    expect(res.status).toBe(401);
  });
});
