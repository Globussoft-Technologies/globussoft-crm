// Unit tests for the [GP-CRM integration] HMAC signing added to
// lib/webhookDelivery.js (Task 10).
//
// deliverSingle reads process.env.WEBHOOK_HMAC_SECRET at CALL time, so each
// test just sets/clears the env var before invoking — no module cache-busting
// needed. We monkey-patch the prisma singleton + global.fetch the same way
// webhookDelivery.test.js does (vi.mock doesn't intercept CJS require here).
//
// What this pins:
//   1. No X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is unset
//   2. No X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is '' (empty)
//   3. Header IS present when WEBHOOK_HMAC_SECRET is set
//   4. Signature format is Stripe-style: t=<unix10digits>,v1=<sha256_hex64>
//   5. Signature verifies: HMAC-SHA256(secret, "<t>.<body>") == v1 (GP-side algo)
//   6. X-CRM-Event + X-CRM-Tenant headers are still present alongside the sig
//   7. body.timestamp and t= in the signature share the SAME epoch second
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import wh from '../../lib/webhookDelivery.js';

const { deliverSingle } = wh;

beforeEach(() => {
  prisma.webhook = prisma.webhook || {};
  prisma.webhook.findMany = vi.fn().mockResolvedValue([]);
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  delete process.env.WEBHOOK_HMAC_SECRET;
});

afterEach(() => {
  delete process.env.WEBHOOK_HMAC_SECRET;
  vi.restoreAllMocks();
});

// ── No HMAC secret ──────────────────────────────────────────────────

describe('webhookDelivery — HMAC signing absent', () => {
  test('no X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is not set', async () => {
    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeUndefined();
  });

  test('no X-Globussoft-Signature when WEBHOOK_HMAC_SECRET is empty string', async () => {
    process.env.WEBHOOK_HMAC_SECRET = '';
    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeUndefined();
  });
});

// ── HMAC secret set ─────────────────────────────────────────────────

describe('webhookDelivery — HMAC signing present', () => {
  test('X-Globussoft-Signature header is added when WEBHOOK_HMAC_SECRET is set', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'my-test-secret';
    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toBeDefined();
  });

  test('signature matches Stripe-style format: t=<10-digit-unix>,v1=<64-hex-chars>', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'stripe-style-secret';
    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 1 }, 9);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Globussoft-Signature']).toMatch(/^t=\d{10},v1=[a-f0-9]{64}$/);
  });

  test('HMAC-SHA256 verifies: HMAC(secret, "<t>.<body>") == v1 hex (GP-side algorithm)', async () => {
    const secret = 'verifiable-secret-xyz';
    process.env.WEBHOOK_HMAC_SECRET = secret;
    const callTs = Math.floor(Date.now() / 1000);

    await deliverSingle('https://receiver.test/wh', 'lead.new', { id: 99 }, 5);

    const [, opts] = global.fetch.mock.calls[0];
    const sig = opts.headers['X-Globussoft-Signature'];
    const m = sig.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(m).toBeTruthy();

    const tSec = parseInt(m[1], 10);
    const v1Hex = m[2];
    const bodyStr = opts.body; // exact bytes on the wire

    // Timestamp must be current (within ±5s of test start).
    expect(Math.abs(tSec - callTs)).toBeLessThan(5);

    // Independently recompute the expected HMAC (mirrors GP webhook_auth.py).
    const expectedHex = createHmac('sha256', secret).update(`${tSec}.${bodyStr}`).digest('hex');
    expect(v1Hex).toBe(expectedHex);
  });

  test('X-CRM-Event + X-CRM-Tenant headers still present alongside X-Globussoft-Signature', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'any-secret';
    await deliverSingle('https://receiver.test/wh', 'contact.updated', { id: 7 }, 13);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-CRM-Event']).toBe('contact.updated');
    expect(opts.headers['X-CRM-Tenant']).toBe('13');
    expect(opts.headers['X-Globussoft-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  test('body.timestamp is derived from the SAME epoch second as t= in the signature', async () => {
    // Consistency contract: a receiver reconstructs "<t>.<body>" without
    // re-serialising or re-timestamping the payload.
    process.env.WEBHOOK_HMAC_SECRET = 'consistency-secret';
    await deliverSingle('https://receiver.test/wh', 'deal.won', { dealId: 42 }, 7);
    const [, opts] = global.fetch.mock.calls[0];
    const tSec = parseInt(opts.headers['X-Globussoft-Signature'].match(/^t=(\d+)/)[1], 10);
    const body = JSON.parse(opts.body);
    const bodyTsUnix = Math.floor(new Date(body.timestamp).getTime() / 1000);
    expect(bodyTsUnix).toBe(tSec);
  });
});
