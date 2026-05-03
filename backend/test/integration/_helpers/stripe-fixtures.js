// ─────────────────────────────────────────────────────────────────
// Stripe webhook fixtures + signing helpers (G-22)
// ─────────────────────────────────────────────────────────────────
// What this module provides:
//   1. Realistic event payloads matching Stripe's documented
//      `payment_intent.succeeded` / `payment_intent.payment_failed` /
//      `charge.refunded` envelope (https://docs.stripe.com/api/events).
//   2. A signature builder that mirrors the algorithm Stripe uses on
//      the wire so we can drive the route handler with valid AND
//      tampered headers without ever touching api.stripe.com.
//
// Why hand-roll the signature instead of just calling
// `stripe.webhooks.generateTestHeaderString`?
//   We DO use the SDK helper for the canonical "valid signature" case
//   (it's the closest possible to the real Stripe → our server path).
//   The hand-rolled helper is the escape hatch for tampered scenarios:
//   we want a real signature over an old-timestamp + tampered body to
//   reproduce a replay attack, which the SDK helper doesn't support.
//
// Algorithm (from Stripe's docs, verified against
// node_modules/stripe/lib/Webhooks.js):
//   signed_payload = `${timestamp}.${rawBody}`
//   v1 = HMAC_SHA256(signed_payload, webhook_secret).hex
//   header = `t=${timestamp},v1=${v1}`
//
// The route handler reconstructs this and rejects on mismatch via
// `stripe.webhooks.constructEvent(rawBody, header, secret)` which
// throws a `Stripe.errors.StripeSignatureVerificationError` on any
// tampering. The route catches that and returns 400.

const crypto = require('crypto');

const TEST_WEBHOOK_SECRET = 'whsec_test_g22_fixture_secret_do_not_use_in_prod';
const TEST_API_KEY = 'sk_test_g22_fixture_key_do_not_use_in_prod';

/**
 * Build a Stripe-Signature header by hand.
 * @param {string|Buffer} rawBody - the exact bytes the route will see (must
 *   round-trip through HTTP without mutation — this is why the route uses
 *   express.raw()).
 * @param {object} opts
 * @param {string} opts.secret - webhook secret (whsec_...)
 * @param {number} [opts.timestamp] - unix seconds. Defaults to now.
 * @returns {string} - the `t=...,v1=...` header string
 */
function buildSignatureHeader(rawBody, { secret, timestamp } = {}) {
  if (!secret) throw new Error('buildSignatureHeader: secret required');
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedPayload = `${ts}.${bodyStr}`;
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${ts},v1=${v1}`;
}

/**
 * Build a payment_intent.succeeded event payload.
 * Stripe IDs are deterministic so two calls with the same overrides
 * produce the same body — important for the idempotency test.
 */
function paymentIntentSucceeded({ eventId, paymentIntentId, amount = 5000, currency = 'usd', invoiceId } = {}) {
  return {
    id: eventId || 'evt_test_g22_pi_succeeded',
    object: 'event',
    api_version: '2024-06-20',
    created: 1730000000,
    data: {
      object: {
        id: paymentIntentId || 'pi_test_g22_succeeded',
        object: 'payment_intent',
        amount,
        amount_received: amount,
        currency,
        status: 'succeeded',
        metadata: invoiceId ? { invoiceId: String(invoiceId) } : {},
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_test_g22', idempotency_key: null },
    type: 'payment_intent.succeeded',
  };
}

/** Build a payment_intent.payment_failed event payload. */
function paymentIntentFailed({ eventId, paymentIntentId, amount = 5000, currency = 'usd' } = {}) {
  return {
    id: eventId || 'evt_test_g22_pi_failed',
    object: 'event',
    api_version: '2024-06-20',
    created: 1730000000,
    data: {
      object: {
        id: paymentIntentId || 'pi_test_g22_failed',
        object: 'payment_intent',
        amount,
        currency,
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_test_g22_failed' },
    type: 'payment_intent.payment_failed',
  };
}

/**
 * Build an event of an "unknown" type — represents Stripe adding a new
 * event type post-deploy. The route should 200 and no-op.
 */
function unknownEventType({ eventId } = {}) {
  return {
    id: eventId || 'evt_test_g22_unknown',
    object: 'event',
    api_version: '2024-06-20',
    created: 1730000000,
    data: { object: { id: 'unknown_obj_1', object: 'some_future_resource' } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_test_g22_unknown' },
    type: 'tax.settings.updated',  // a real Stripe event our route doesn't handle
  };
}

/**
 * Encode an event object to the exact bytes that hit the wire.
 * Stripe sends `JSON.stringify(event)` with no additional whitespace.
 * Round-tripping through `JSON.stringify` is what the live Stripe servers
 * do, and what the route's `stripe.webhooks.constructEvent` expects.
 */
function encodeBody(event) {
  return Buffer.from(JSON.stringify(event), 'utf8');
}

module.exports = {
  TEST_WEBHOOK_SECRET,
  TEST_API_KEY,
  buildSignatureHeader,
  paymentIntentSucceeded,
  paymentIntentFailed,
  unknownEventType,
  encodeBody,
};
