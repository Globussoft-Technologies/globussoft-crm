// ─────────────────────────────────────────────────────────────────
// G-22 — Stripe webhook signing integration tests
// ─────────────────────────────────────────────────────────────────
// What's tested:
//   The POST /api/payments/webhook/stripe handler in
//   backend/routes/payments.js — specifically its signature
//   verification path (`stripe.webhooks.constructEvent`) and its
//   downstream DB side effects when a verified event arrives.
//
// Which module:
//   backend/routes/payments.js  (route handler + raw-body middleware)
//
// Why this matters:
//   Webhook forgery is a real attack class — a malicious client posts
//   a `payment_intent.succeeded` event with a faked Stripe-Signature
//   header to mark fraudulent payments as PAID without ever giving us
//   their card. The route MUST:
//     1. Reject any request whose signature doesn't HMAC-SHA256 to the
//        recomputed `${ts}.${rawBody}` digest using STRIPE_WEBHOOK_SECRET.
//     2. Reject replays where ts is too old (Stripe SDK enforces a
//        300s tolerance window by default).
//     3. Be idempotent — Stripe retries on every non-2xx, so duplicate
//        deliveries of the same event must not double-apply the side
//        effect.
//     4. No-op (200) on event types we don't yet handle, so Stripe
//        adding `tax.settings.updated` post-deploy doesn't 500 our
//        webhook (which would trigger Stripe's retry storm).
//
// Test tier:
//   This is the first member of the new "integration" tier — sits
//   between the vitest unit tests (no I/O) and the Playwright API
//   specs (real MySQL + full server boot). We mount JUST the payments
//   router into a fresh express app, mock `lib/prisma`, and use msw
//   to intercept any rogue outbound HTTP. Runs in <1s, no Docker, no
//   Playwright, no MySQL — plugs into the existing `unit_tests` gate
//   via vitest's auto-discovery of `test/**/*.test.js`.
//
// Mocking notes:
//   - prisma is patched via the singleton-monkey-patch pattern (same
//     as backend/test/cron/*.test.js) — vi.mock doesn't reliably
//     intercept CJS `require('../lib/prisma')` from a route file in
//     this repo's vitest config. We replace `prisma.payment` and
//     `prisma.invoice` namespaces with vi.fn() before any request.
//   - The Stripe SDK is REAL — `stripe.webhooks.constructEvent` is
//     literally the SUT's verification dependency, mocking it would
//     bypass the very thing we're testing.
//   - `stripe.webhooks.generateTestHeaderString` is what we use to
//     build "known-good" Stripe-Signature headers; for tampered/
//     replay scenarios we hand-roll the header in stripe-fixtures.js.
//   - We set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET as env vars
//     BEFORE requiring the route, since the route's `getStripe()`
//     factory is lazy + caches its client.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import {
  TEST_WEBHOOK_SECRET,
  TEST_API_KEY,
  buildSignatureHeader,
  paymentIntentSucceeded,
  paymentIntentFailed,
  unknownEventType,
} from './_helpers/stripe-fixtures.js';

// env MUST be set before importing the route, since payments.js' lazy
// `getStripe()` factory caches its client. STRIPE_WEBHOOK_SECRET is
// read at request-handle time, but setting it pre-import is robust
// against any future top-level snapshot.
process.env.STRIPE_SECRET_KEY = TEST_API_KEY;
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

// ── prisma singleton patching ─────────────────────────────────────
// vi.mock with the route's CJS `require('../lib/prisma')` doesn't
// reliably intercept on this repo's vitest config (verified by
// adding `console.log` inside the mock factory — never fires).
// Pattern that DOES work: import the real prisma singleton, then
// monkey-patch the model namespaces with mock fns BEFORE any request
// hits the route. Because `lib/prisma.js` is a singleton (re-exported
// across the app via `module.exports = prisma`), every module sees
// the same patched instance. The real PrismaClient lazy-connects on
// first query, so as long as we patch before any query call, no
// MySQL connection is ever attempted.
//
// This is the same pattern used by:
//   backend/test/cron/appointmentRemindersEngine.test.js (G-6)
//   backend/test/cron/wellnessOpsEngine.test.js (G-7)
//   backend/test/cron/recurringInvoiceEngine.test.js (G-9)
import prisma from '../../lib/prisma.js';

prisma.payment = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
prisma.invoice = {
  findFirst: vi.fn(),
  update: vi.fn(),
};

// ── msw outbound interceptor ───────────────────────────────────────
import { mswServer } from './_helpers/msw-server.js';

// ── express + supertest + Stripe SDK + the route under test ────────
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

// Stripe SDK is CJS-only and exports a class as `module.exports`.
// ESM `import` interop unwraps it to a namespace object that's not
// callable. Use createRequire for a clean CJS load.
const requireCJS = createRequire(import.meta.url);
const stripeLib = requireCJS('stripe');
const stripe = stripeLib(TEST_API_KEY);

import paymentsRoutes from '../../routes/payments.js';

function makeApp() {
  const app = express();
  // The webhook MUST receive the raw body. The route itself uses
  // express.raw() per-route, so the parent app should NOT install a
  // global JSON parser ahead of it. We mirror server.js' actual
  // mount point: `/api/payments`.
  app.use('/api/payments', paymentsRoutes);
  return app;
}

const app = makeApp();

// ── lifecycle ──────────────────────────────────────────────────────
beforeAll(() => {
  // Intercept outbound HTTP with a smart strategy:
  //   - any unhandled hit to api.stripe.com / api.razorpay.com →
  //     fail loudly (default handlers in msw-server.js return 500
  //     with a clear "register a handler" message).
  //   - any unhandled hit to 127.0.0.1 / localhost (supertest's
  //     ephemeral server) → let it through to the real loopback so
  //     supertest can drive the route handler. This is what
  //     `onUnhandledRequest` warns us about by default.
  mswServer.listen({
    onUnhandledRequest(request, print) {
      const url = new URL(request.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        // supertest loopback — DO NOT intercept
        return;
      }
      // Anything else: hard-fail.
      print.error();
    },
  });
});

afterAll(() => {
  mswServer.close();
});

beforeEach(() => {
  // Hard-reset every mock between tests so a `mockResolvedValueOnce`
  // chain in test N never bleeds into test N+1.
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.update.mockReset();
  // Defaults — every test overrides what it cares about.
  prisma.payment.findFirst.mockResolvedValue(null);
  prisma.payment.update.mockResolvedValue({ id: 0, status: 'SUCCESS' });
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.invoice.update.mockResolvedValue({ id: 0, status: 'PAID' });
});

afterEach(() => {
  mswServer.resetHandlers();
});

// ── helpers ────────────────────────────────────────────────────────
/**
 * POST a webhook with a *valid* Stripe-Signature header generated by
 * the real Stripe SDK helper — this is the closest possible to a
 * production Stripe → server delivery.
 */
async function postValidWebhook(event) {
  // Stripe sends `JSON.stringify(event)` as the wire body. We send the
  // exact string (NOT a Buffer — superagent JSON-serializes Buffers
  // when content-type is application/json, which mutates the bytes
  // and invalidates the signature). The route's express.raw()
  // middleware will read the bytes back into a Buffer regardless.
  const bodyStr = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: bodyStr,
    secret: TEST_WEBHOOK_SECRET,
  });
  return request(app)
    .post('/api/payments/webhook/stripe')
    .set('stripe-signature', signature)
    .set('content-type', 'application/json')
    .send(bodyStr);
}

// ─────────────────────────────────────────────────────────────────
// SCENARIO 1: Valid signature on a real payment_intent.succeeded
// → 200, payment row marked PAID + invoice marked PAID.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 1: valid signature, payment_intent.succeeded', () => {
  test('returns 200 and updates payment + invoice to SUCCESS/PAID', async () => {
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 42,
      gateway: 'stripe',
      gatewayId: 'pi_test_g22_succeeded',
      invoiceId: 7,
      tenantId: 1,
      status: 'PENDING',
    });
    prisma.invoice.findFirst.mockResolvedValueOnce({
      id: 7,
      tenantId: 1,
      status: 'PENDING',
    });

    const event = paymentIntentSucceeded({ invoiceId: 7 });
    const res = await postValidWebhook(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { gateway: 'stripe', gatewayId: 'pi_test_g22_succeeded' },
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: 'SUCCESS', paidAt: expect.any(Date) }),
    });
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: 'PAID' },
    });
  });

  test('returns 200 even when no matching local payment exists (foreign event)', async () => {
    // Stripe accounts can have multiple integrations sharing one webhook
    // endpoint; an event for a paymentIntent we don't have locally is
    // not an error, it's just "not ours". The route must still 200 so
    // Stripe doesn't keep retrying.
    prisma.payment.findFirst.mockResolvedValueOnce(null);

    const event = paymentIntentSucceeded({ paymentIntentId: 'pi_someone_elses' });
    const res = await postValidWebhook(event);

    expect(res.status).toBe(200);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 2: Tampered body, original signature
// → 400, payment unchanged.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 2: tampered body, original signature', () => {
  test('rejects with 400 when body is mutated after signing', async () => {
    const event = paymentIntentSucceeded();
    const originalBodyStr = JSON.stringify(event);
    const goodSig = stripe.webhooks.generateTestHeaderString({
      payload: originalBodyStr,
      secret: TEST_WEBHOOK_SECRET,
    });

    // Attacker mutates the amount AFTER the signature is computed —
    // the classic "free upgrade" attack.
    const tamperedEvent = { ...event };
    tamperedEvent.data = { ...event.data, object: { ...event.data.object, amount: 99999999 } };
    const tamperedBodyStr = JSON.stringify(tamperedEvent);

    const res = await request(app)
      .post('/api/payments/webhook/stripe')
      .set('stripe-signature', goodSig)
      .set('content-type', 'application/json')
      .send(tamperedBodyStr);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Webhook Error/);
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 3: Replay attack — old timestamp, technically valid HMAC
// → 400 (Stripe SDK enforces a 300s tolerance window).
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 3: replay attack with stale timestamp', () => {
  test('rejects with 400 when timestamp is older than the 300s tolerance window', async () => {
    const event = paymentIntentSucceeded({ paymentIntentId: 'pi_test_g22_replay' });
    const bodyStr = JSON.stringify(event);

    // Build a signature that's mathematically valid for the body, but
    // dated 1 hour ago. Stripe SDK's constructEvent with default
    // tolerance (300s) MUST reject this.
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const replayHeader = buildSignatureHeader(bodyStr, {
      secret: TEST_WEBHOOK_SECRET,
      timestamp: oneHourAgo,
    });

    const res = await request(app)
      .post('/api/payments/webhook/stripe')
      .set('stripe-signature', replayHeader)
      .set('content-type', 'application/json')
      .send(bodyStr);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Webhook Error/);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 4: No signature header
// → 400, payment unchanged.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 4: missing signature header', () => {
  test('rejects with 400 when stripe-signature header is absent', async () => {
    const event = paymentIntentSucceeded();
    const bodyStr = JSON.stringify(event);

    const res = await request(app)
      .post('/api/payments/webhook/stripe')
      .set('content-type', 'application/json')
      // intentionally no `stripe-signature`
      .send(bodyStr);

    expect(res.status).toBe(400);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('rejects with 400 when signature header is malformed garbage', async () => {
    const event = paymentIntentSucceeded();
    const bodyStr = JSON.stringify(event);

    const res = await request(app)
      .post('/api/payments/webhook/stripe')
      .set('stripe-signature', 'not-a-real-stripe-sig')
      .set('content-type', 'application/json')
      .send(bodyStr);

    expect(res.status).toBe(400);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 5: Wrong webhook secret (key rotation race)
// → 400, payment unchanged.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 5: signature signed with wrong secret', () => {
  test('rejects with 400 when signature was made with a different secret', async () => {
    const event = paymentIntentSucceeded();
    const bodyStr = JSON.stringify(event);

    // Attacker (or stale Stripe Dashboard config) signs with a
    // different secret. Real Stripe deliveries can also hit this
    // case briefly during a rotate-secret window — must always
    // reject, never half-accept.
    const wrongSecretHeader = buildSignatureHeader(bodyStr, {
      secret: 'whsec_completely_different_secret_value',
    });

    const res = await request(app)
      .post('/api/payments/webhook/stripe')
      .set('stripe-signature', wrongSecretHeader)
      .set('content-type', 'application/json')
      .send(bodyStr);

    expect(res.status).toBe(400);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 6: Idempotency — same event delivered twice
// → both 200, side effect applied at most once.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 6: idempotency on duplicate delivery', () => {
  test('second delivery of same event_id is a no-op (already-PAID short-circuit)', async () => {
    // Stripe retries on any non-2xx and even occasionally double-fires
    // on transient network blips. The route's idempotency guarantee
    // comes from `markInvoicePaid` which checks `status !== "PAID"`
    // before updating — so two valid deliveries should result in:
    //   - 1st delivery: payment.update called (PENDING → SUCCESS),
    //                   invoice.update called (PENDING → PAID)
    //   - 2nd delivery: payment.update STILL called (no status guard
    //                   on the payment row), but invoice.update is
    //                   skipped because invoice is already PAID.
    //
    // We test the more important half: the invoice cannot flip back
    // out of PAID and a "double-credit" doesn't get applied.

    const event = paymentIntentSucceeded({
      eventId: 'evt_test_g22_dedup',
      paymentIntentId: 'pi_test_g22_dedup',
      invoiceId: 9,
    });

    // ── 1st delivery: invoice is PENDING ─────────────────────────
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 100, gateway: 'stripe', gatewayId: 'pi_test_g22_dedup',
      invoiceId: 9, tenantId: 1, status: 'PENDING',
    });
    prisma.invoice.findFirst.mockResolvedValueOnce({
      id: 9, tenantId: 1, status: 'PENDING',
    });

    const res1 = await postValidWebhook(event);
    expect(res1.status).toBe(200);
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);

    // ── 2nd delivery: invoice is already PAID ────────────────────
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 100, gateway: 'stripe', gatewayId: 'pi_test_g22_dedup',
      invoiceId: 9, tenantId: 1, status: 'SUCCESS',
    });
    prisma.invoice.findFirst.mockResolvedValueOnce({
      id: 9, tenantId: 1, status: 'PAID',  // ← already PAID
    });

    const res2 = await postValidWebhook(event);
    expect(res2.status).toBe(200);
    // invoice.update count is unchanged from after delivery 1 — the
    // route's `if (inv && inv.status !== "PAID")` guard fired.
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 7: Unknown event type (forward compatibility)
// → 200 with no-op (no DB writes).
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 7: unknown event type forward-compat', () => {
  test('returns 200 with no DB mutation when event type is unhandled', async () => {
    const event = unknownEventType();
    const res = await postValidWebhook(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  test('returns 200 + marks payment FAILED on payment_intent.payment_failed', async () => {
    // Sister-coverage to scenario 1's success path: same dispatch
    // logic but the failure branch.
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 55, gateway: 'stripe', gatewayId: 'pi_test_g22_failed',
      invoiceId: 11, tenantId: 1, status: 'PENDING',
    });

    const event = paymentIntentFailed();
    const res = await postValidWebhook(event);

    expect(res.status).toBe(200);
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 55 },
      data: { status: 'FAILED' },
    });
    // crucially, invoice is NOT marked PAID on failure
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// SCENARIO 8 (bonus): Missing webhook secret env config
// → 503, never silently accepts.
// ─────────────────────────────────────────────────────────────────
describe('G-22 / scenario 8: misconfigured server', () => {
  test('returns 503 when STRIPE_WEBHOOK_SECRET is unset (fail-closed)', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const event = paymentIntentSucceeded();
      const bodyStr = JSON.stringify(event);
      const res = await request(app)
        .post('/api/payments/webhook/stripe')
        .set('stripe-signature', 't=1,v1=deadbeef')
        .set('content-type', 'application/json')
        .send(bodyStr);

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/secret not configured/i);
      // Critically: NEVER 200. A misconfigured server must not
      // silently accept ANY payload as valid.
      expect(prisma.payment.update).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
