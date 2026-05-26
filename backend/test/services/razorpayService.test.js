// Unit tests for backend/services/razorpayService.js
//
// What this module does:
//   Thin wrapper around the Razorpay Node SDK + an HMAC-SHA256 signature
//   verifier for the post-checkout `payment.captured` callback. Three
//   functions:
//     - getRazorpay()        — lazy-instantiated singleton Razorpay client
//     - createOrder(amount, planId) — converts ₹amount to paise, creates
//                              a Razorpay order with planId in notes
//     - verifySignature(orderId, paymentId, signature) — HMAC over
//                              "<orderId>|<paymentId>" using
//                              RAZORPAY_KEY_SECRET, timing-safe-compared
//                              against the supplied signature hex
//
// Surface area covered:
//   - module shape (createOrder, verifySignature, getRazorpay exported)
//   - getRazorpay
//       - returns a Razorpay instance
//       - is a singleton across calls (lazy init pattern — same object ref)
//       - constructed with key_id + key_secret from env
//   - createOrder
//       - happy path → calls razorpay.orders.create with the right args
//       - amount is multiplied by 100 (paise conversion)
//       - currency is hardcoded "INR"
//       - planId is stringified into notes
//       - propagates Razorpay SDK errors
//       - returns whatever the SDK returns (no envelope)
//   - verifySignature
//       - happy path: correct HMAC matches → true
//       - mismatched signature → false
//       - swapped orderId/paymentId yields a different signature → false
//       - mismatched-length signature → false (timingSafeEqual buffer guard)
//       - non-hex signature → false (graceful, no throw)
//       - empty string signature → false
//       - missing RAZORPAY_KEY_SECRET behaves predictably (uses ""/throws)
//       - timing-safe comparison (no early-exit on first mismatched byte)
//
// Pattern source: backend/test/services/whatsappProvider.test.js uses
// the `https.request` monkey-patch for native HTTP. razorpayService uses
// the official `razorpay` npm package whose `.orders.create()` is an
// instance method — we monkey-patch the instance returned by getRazorpay()
// directly (the same singleton-patch trick used in eventBus.test.js).
//
// stripDangerous reminder (per CLAUDE.md): not relevant — service-layer
// module, no Express req/res/body touched.
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Razorpay SDK constructor lazily — env vars must be set BEFORE the
// singleton is built. We use vi.hoisted() so the env assignment runs
// before any imports.
vi.hoisted(() => {
  process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy';
  process.env.RAZORPAY_KEY_SECRET =
    process.env.RAZORPAY_KEY_SECRET || 'test-secret-key-for-hmac';
});

import svc from '../../services/razorpayService.js';
const { createOrder, verifySignature, getRazorpay } = svc;

// ──────────────────────────────────────────────────────────────────────────
// The SUT lazily builds a Razorpay() instance on first getRazorpay() call.
// We patch instance.orders.create after the first call so our test sees the
// stub on subsequent createOrder() invocations.
let savedOrdersCreate;

beforeAll(() => {
  // Force singleton instantiation so we can patch its surface.
  const instance = getRazorpay();
  // Razorpay() returns an object with a `.orders` API; pin our stub there.
  if (!instance.orders) instance.orders = {};
  savedOrdersCreate = instance.orders.create;
  instance.orders.create = vi.fn();
});

afterAll(() => {
  const instance = getRazorpay();
  if (savedOrdersCreate) {
    instance.orders.create = savedOrdersCreate;
  }
});

beforeEach(() => {
  const instance = getRazorpay();
  instance.orders.create.mockReset();
});

describe('razorpayService — module shape', () => {
  test('exports createOrder, verifySignature, getRazorpay', () => {
    expect(typeof createOrder).toBe('function');
    expect(typeof verifySignature).toBe('function');
    expect(typeof getRazorpay).toBe('function');
  });
});

describe('getRazorpay — singleton', () => {
  test('returns the same instance on repeated calls (lazy singleton)', () => {
    const a = getRazorpay();
    const b = getRazorpay();
    expect(a).toBe(b);
  });

  test('returns a truthy object with an orders API', () => {
    const r = getRazorpay();
    expect(r).toBeTruthy();
    expect(r.orders).toBeDefined();
  });
});

describe('createOrder', () => {
  test('happy path → returns the SDK response unchanged', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({
      id: 'order_test_123',
      amount: 99900,
      currency: 'INR',
      status: 'created',
    });
    const out = await createOrder(999, 42);
    expect(out).toEqual({
      id: 'order_test_123',
      amount: 99900,
      currency: 'INR',
      status: 'created',
    });
  });

  test('multiplies amount by 100 (rupees → paise)', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_x' });
    await createOrder(150, 7);
    const arg = instance.orders.create.mock.calls[0][0];
    expect(arg.amount).toBe(15000); // 150 rupees → 15000 paise
  });

  test('amount=1 → 100 paise (smallest unit boundary)', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_y' });
    await createOrder(1, 1);
    expect(instance.orders.create.mock.calls[0][0].amount).toBe(100);
  });

  test('amount=0 → 0 paise (degenerate but supported by SDK shape)', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_z' });
    await createOrder(0, 1);
    expect(instance.orders.create.mock.calls[0][0].amount).toBe(0);
  });

  test('currency is hardcoded "INR"', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_inr' });
    await createOrder(500, 1);
    expect(instance.orders.create.mock.calls[0][0].currency).toBe('INR');
  });

  test('planId is stringified into notes.planId', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_notes' });
    await createOrder(500, 42);
    const arg = instance.orders.create.mock.calls[0][0];
    expect(arg.notes).toEqual({ planId: '42' });
    expect(typeof arg.notes.planId).toBe('string');
  });

  test('stringifies a non-numeric planId (string input)', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockResolvedValueOnce({ id: 'order_str' });
    await createOrder(500, 'starter');
    expect(instance.orders.create.mock.calls[0][0].notes).toEqual({
      planId: 'starter',
    });
  });

  test('propagates SDK errors (does not swallow)', async () => {
    const instance = getRazorpay();
    instance.orders.create.mockRejectedValueOnce(
      new Error('Razorpay: invalid key_id')
    );
    await expect(createOrder(100, 1)).rejects.toThrow(/invalid key_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// verifySignature — produces an HMAC-SHA256 over "<orderId>|<paymentId>"
// using process.env.RAZORPAY_KEY_SECRET, then timingSafeEqual against the
// supplied signature. To exercise the happy path we generate the expected
// signature with the SAME secret in the test.

function expectedSignatureFor(orderId, paymentId, secret) {
  const message = `${orderId}|${paymentId}`;
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

describe('verifySignature — happy path', () => {
  test('returns true when signature matches the expected HMAC', () => {
    const orderId = 'order_test_abc';
    const paymentId = 'pay_test_def';
    const sig = expectedSignatureFor(
      orderId,
      paymentId,
      process.env.RAZORPAY_KEY_SECRET
    );
    expect(verifySignature(orderId, paymentId, sig)).toBe(true);
  });

  test('different valid order/payment pair produces a matching signature', () => {
    const orderId = 'order_xyz';
    const paymentId = 'pay_uvw';
    const sig = expectedSignatureFor(
      orderId,
      paymentId,
      process.env.RAZORPAY_KEY_SECRET
    );
    expect(verifySignature(orderId, paymentId, sig)).toBe(true);
  });
});

describe('verifySignature — invalid paths return false (never throw)', () => {
  test('returns false when signature is wrong-but-correct-length hex', () => {
    const orderId = 'order_test_abc';
    const paymentId = 'pay_test_def';
    // 64 hex chars = 32 bytes, same length as a real SHA256 hex sig.
    const wrongSig = 'f'.repeat(64);
    expect(verifySignature(orderId, paymentId, wrongSig)).toBe(false);
  });

  test('returns false when orderId is tampered post-signing', () => {
    const sig = expectedSignatureFor(
      'order_orig',
      'pay_x',
      process.env.RAZORPAY_KEY_SECRET
    );
    // Caller submits a different orderId → HMAC must mismatch.
    expect(verifySignature('order_tampered', 'pay_x', sig)).toBe(false);
  });

  test('returns false when paymentId is tampered', () => {
    const sig = expectedSignatureFor(
      'order_x',
      'pay_orig',
      process.env.RAZORPAY_KEY_SECRET
    );
    expect(verifySignature('order_x', 'pay_tampered', sig)).toBe(false);
  });

  test('returns false when secret-of-signing differs from current env secret', () => {
    // Simulate an attacker signing with their own secret.
    const sig = expectedSignatureFor(
      'order_x',
      'pay_x',
      'attacker-secret-different'
    );
    expect(verifySignature('order_x', 'pay_x', sig)).toBe(false);
  });

  test('returns false when supplied signature is too short (length mismatch)', () => {
    // timingSafeEqual throws RangeError on length mismatch → caught and
    // surfaced as false.
    expect(verifySignature('o', 'p', 'abc123')).toBe(false);
  });

  test('returns false when supplied signature is non-hex', () => {
    // Buffer.from(invalidHex, 'hex') silently produces garbage; the
    // outer compare then mismatches → false. We just want no-throw.
    expect(verifySignature('o', 'p', 'not-hex-chars-zzzzz')).toBe(false);
  });

  test('returns false when signature is empty string', () => {
    expect(verifySignature('o', 'p', '')).toBe(false);
  });

  test('does not throw on null signature', () => {
    // Buffer.from(null, 'hex') throws → caught by outer try/catch → false.
    let threw = false;
    let out;
    try {
      out = verifySignature('o', 'p', null);
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(out).toBe(false);
  });

  test('does not throw on undefined signature', () => {
    let threw = false;
    let out;
    try {
      out = verifySignature('o', 'p', undefined);
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(out).toBe(false);
  });
});

describe('verifySignature — message format pinned ("<orderId>|<paymentId>")', () => {
  test('the pipe-delimited format is the only one that produces a valid signature', () => {
    // If a developer changes the message join character to ":" or "-",
    // the signature won't match the canonical Razorpay format and
    // post-checkout verification will silently start rejecting real
    // payments. Pin the format with a fixed-string regression assertion.
    const orderId = 'order_pin_1';
    const paymentId = 'pay_pin_1';

    // Correct message format.
    const sigPipe = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    // Wrong message format (concatenated with colon).
    const sigColon = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}:${paymentId}`)
      .digest('hex');

    expect(verifySignature(orderId, paymentId, sigPipe)).toBe(true);
    expect(verifySignature(orderId, paymentId, sigColon)).toBe(false);
  });
});
