// Unit tests for the Task 10 HMAC signing addition to lib/webhookDelivery.js
//
// The module reads WEBHOOK_HMAC_SECRET at load time; we use the CJS
// cache-bust pattern (same as callifiedClient.test.js) to load fresh copies
// with a controlled env value. Each describe group calls loadDelivery() to
// get the exact module variant it needs.
//
// What this file pins (7 cases):
//   1. No X-Globussoft-Signature when WEBHOOK_HMAC_SECRET absent
//   2. No X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is '' (empty)
//   3. Header IS present when WEBHOOK_HMAC_SECRET is set
//   4. Signature format matches Stripe-style: t=<unix10digits>,v1=<sha256_hex64>
//   5. Signature verifies: HMAC-SHA256(secret, "<t>.<body>") == v1 hex
//   6. X-CRM-Event + X-CRM-Tenant headers are still present alongside signature
//   7. body.timestamp and t= in signature are derived from the SAME epoch second

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

beforeEach(() => {
  prisma.webhook = prisma.webhook || {};
  prisma.webhook.findMany = vi.fn().mockResolvedValue([]);
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  // Bust cache + restore env so tests don't pollute each other
  delete requireCJS.cache[requireCJS.resolve('../../lib/webhookDelivery.js')];
  delete process.env.WEBHOOK_HMAC_SECRET;
  vi.restoreAllMocks();
});

/**
 * Load a fresh copy of webhookDelivery with the given HMAC secret.
 * Passing `undefined` (or omitting) removes the env var (no signing).
 */
function loadDelivery(secret) {
  if (secret !== undefined && secret !== '') {
    process.env.WEBHOOK_HMAC_SECRET = secret;
  } else {
    delete process.env.WEBHOOK_HMAC_SECRET;
  }
  delete requireCJS.cache[requireCJS.resolve('../../lib/webhookDelivery.js')];
  return requireCJS('../../lib/webhookDelivery.js');
}

// ── No HMAC secret ─────────────────────────────────────────────────────────

describe('webhookDelivery — HMAC signing absent', () => {
  test('no X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is not set', async () => {
    const { deliverSingle } = loadDelivery(undefined);

    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeUndefined();
  });

  test('no X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is empty string', async () => {
    // An empty string is treated as "not configured" — no signature.
    const { deliverSingle } = loadDelivery('');

    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeUndefined();
  });
});

// ── HMAC secret set ────────────────────────────────────────────────────────

describe('webhookDelivery — HMAC signing present', () => {
  test('X-Globussoft-Signature header is added when WEBHOOK_HMAC_SECRET is set', async () => {
    const { deliverSingle } = loadDelivery('my-test-secret');

    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeDefined();
  });

  test('signature matches Stripe-style format: t=<10-digit-unix>,v1=<64-hex-chars>', async () => {
    const { deliverSingle } = loadDelivery('stripe-style-secret');

    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    const sig = opts.headers['X-Globussoft-Signature'];
    // t is a Unix epoch second (10 digits for years 2001-2286)
    expect(sig).toMatch(/^t=\d{10},v1=[a-f0-9]{64}$/);
  });

  test('HMAC-SHA256 verifies: HMAC(secret, "<t>.<body>") == v1 hex (GP-side algorithm)', async () => {
    const secret = 'verifiable-secret-xyz';
    const { deliverSingle } = loadDelivery(secret);

    const callTs = Math.floor(Date.now() / 1000);
    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 99 }, 5);

    const [, opts] = global.fetch.mock.calls[0];
    const sig = opts.headers['X-Globussoft-Signature'];
    const tMatch = sig.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(tMatch).toBeTruthy();

    const tSec = parseInt(tMatch[1], 10);
    const v1Hex = tMatch[2];
    const bodyStr = opts.body; // exact bytes sent over the wire

    // Timestamp must be current (within ±5 s of the test start)
    expect(Math.abs(tSec - callTs)).toBeLessThan(5);

    // Independently compute the expected HMAC (mirrors GP-side webhook_auth.py)
    const expectedHex = createHmac('sha256', secret)
      .update(`${tSec}.${bodyStr}`)
      .digest('hex');
    expect(v1Hex).toBe(expectedHex);
  });

  test('X-CRM-Event + X-CRM-Tenant headers still present alongside X-Globussoft-Signature', async () => {
    const { deliverSingle } = loadDelivery('any-secret');

    await deliverSingle('https://receiver.test/wh', 'contact.updated', { id: 7 }, 13);

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-CRM-Event']).toBe('contact.updated');
    expect(opts.headers['X-CRM-Tenant']).toBe('13');
    expect(opts.headers['X-Globussoft-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  test('body.timestamp is derived from the SAME epoch second as t= in signature', async () => {
    // This is the consistency contract: GP can reconstruct the signed string
    // as "<t>.<body>" without re-serialising or re-timestamping the payload.
    const { deliverSingle } = loadDelivery('consistency-secret');

    await deliverSingle('https://receiver.test/wh', 'deal.won', { dealId: 42 }, 7);

    const [, opts] = global.fetch.mock.calls[0];
    const sig = opts.headers['X-Globussoft-Signature'];
    const tSec = parseInt(sig.match(/^t=(\d+)/)[1], 10);
    const body = JSON.parse(opts.body);
    const bodyTsUnix = Math.floor(new Date(body.timestamp).getTime() / 1000);
    expect(bodyTsUnix).toBe(tSec);
  });
});
