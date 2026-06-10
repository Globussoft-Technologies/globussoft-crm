// Unit tests for backend/lib/webhookDelivery.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import wh from '../../lib/webhookDelivery.js';

const { deliverWebhooks, deliverSingle } = wh;

beforeAll(() => {
  prisma.webhook = { findMany: vi.fn() };
  // deliverWebhooks now resolves entitlement + per-tenant secret via
  // lib/webhookEntitlement.js (same prisma singleton). Stub those surfaces so
  // the delivery-path tests below see an ENTITLED tenant with NO per-tenant
  // credential (→ env/null secret) unless a test overrides them.
  prisma.subscription = { findFirst: vi.fn() };
  prisma.user = { findFirst: vi.fn() };
  prisma.webhookCredential = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.webhook.findMany.mockReset();
  // Default: entitled via an active paid subscription, no per-tenant credential.
  prisma.subscription.findFirst.mockReset().mockResolvedValue({ id: 1 });
  prisma.user.findFirst.mockReset().mockResolvedValue(null);
  prisma.webhookCredential.findFirst.mockReset().mockResolvedValue(null);
  global.fetch = vi.fn();
});

describe('lib/webhookDelivery — module shape', () => {
  test('exports deliverWebhooks and deliverSingle', () => {
    expect(typeof deliverWebhooks).toBe('function');
    expect(typeof deliverSingle).toBe('function');
  });
});

describe('lib/webhookDelivery — deliverWebhooks', () => {
  test('queries webhooks with exact + wildcard event match', async () => {
    prisma.webhook.findMany.mockResolvedValue([]);
    await deliverWebhooks('deal.won', { id: 1 }, 9);
    expect(prisma.webhook.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.webhook.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(9);
    expect(arg.where.isActive).toBe(true);
    expect(arg.where.event.in).toEqual(['deal.won', 'deal.*']);
  });

  test('iterates all matching webhooks and calls fetch for each', async () => {
    prisma.webhook.findMany.mockResolvedValue([
      { id: 1, targetUrl: 'https://a.example/wh' },
      { id: 2, targetUrl: 'https://b.example/wh' },
    ]);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverWebhooks('deal.won', { id: 5 }, 9);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('swallows DB errors when querying webhooks', async () => {
    prisma.webhook.findMany.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deliverWebhooks('deal.won', {}, 9)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('handles event without dot (single segment)', async () => {
    prisma.webhook.findMany.mockResolvedValue([]);
    await deliverWebhooks('ping', {}, 1);
    const arg = prisma.webhook.findMany.mock.calls[0][0];
    // event.split('.')[0] + '.*' = 'ping' + '.*' = 'ping.*'
    expect(arg.where.event.in).toEqual(['ping', 'ping.*']);
  });

  test('handles empty webhook result without error', async () => {
    prisma.webhook.findMany.mockResolvedValue([]);
    await deliverWebhooks('deal.won', {}, 1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('lib/webhookDelivery — deliverSingle', () => {
  test('skips delivery when url is empty/null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliverSingle(null, 'event', {}, 1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('skips delivery when url is empty string', async () => {
    await deliverSingle('', 'event', {}, 1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POSTs JSON with proper headers', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'deal.won', { dealId: 5 }, 9);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.com/wh');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-CRM-Event']).toBe('deal.won');
    expect(opts.headers['X-CRM-Tenant']).toBe('9');
  });

  test('body includes event, timestamp, data', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'deal.won', { dealId: 5 }, 9);
    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('deal.won');
    expect(body.data).toEqual({ dealId: 5 });
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  test('uses AbortSignal.timeout(10000)', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'event', {}, 1);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.signal).toBeDefined();
  });

  test('logs status on success', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliverSingle('https://x.com/wh', 'event', {}, 1);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('logs but does not throw on non-2xx responses', async () => {
    // Implementation just logs the status — does not retry, does not throw.
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(deliverSingle('https://x.com/wh', 'event', {}, 1)).resolves.toBeUndefined();
    logSpy.mockRestore();
  });

  test('catches network errors gracefully', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deliverSingle('https://x.com/wh', 'event', {}, 1)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('catches AbortError (timeout) gracefully', async () => {
    const err = new Error('timed out');
    err.name = 'AbortError';
    global.fetch.mockRejectedValue(err);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deliverSingle('https://x.com/wh', 'event', {}, 1)).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  test('coerces numeric tenantId to string in header', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'event', {}, 42);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-CRM-Tenant']).toBe('42');
    expect(typeof opts.headers['X-CRM-Tenant']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Boundary / shape coverage (tick #N — extends the 15 cases above with edge
// cases on event-string segmentation, payload-serialization failure modes,
// fan-out arg correctness, timestamp freshness, and concurrency).
// ---------------------------------------------------------------------------
describe('lib/webhookDelivery — boundary / shape', () => {
  test('multi-segment event uses ONLY first segment for wildcard', async () => {
    // event.split('.')[0] = 'deal' → wildcard = 'deal.*' (NOT 'deal.won.*')
    prisma.webhook.findMany.mockResolvedValue([]);
    await deliverWebhooks('deal.won.followup', { id: 1 }, 7);
    const arg = prisma.webhook.findMany.mock.calls[0][0];
    expect(arg.where.event.in).toEqual(['deal.won.followup', 'deal.*']);
  });

  test('empty event string is handled defensively (no throw)', async () => {
    // ''.split('.')[0] = '' → wildcard = '.*'
    prisma.webhook.findMany.mockResolvedValue([]);
    await expect(deliverWebhooks('', { id: 1 }, 7)).resolves.toBeUndefined();
    const arg = prisma.webhook.findMany.mock.calls[0][0];
    expect(arg.where.event.in).toEqual(['', '.*']);
  });

  test('body.timestamp is a recent ISO (within last second)', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const before = Date.now();
    await deliverSingle('https://x.com/wh', 'event', {}, 1);
    const after = Date.now();
    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    const ts = Date.parse(body.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  test('circular-reference payload: JSON.stringify throws → caught, no fetch, no re-throw', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const circular = { name: 'loop' };
    circular.self = circular;
    await expect(
      deliverSingle('https://x.com/wh', 'event', circular, 1)
    ).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('undefined tenantId becomes literal "undefined" in header (defensive String coercion)', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'event', {}, undefined);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-CRM-Tenant']).toBe('undefined');
  });

  test('opts.signal is an actual AbortSignal instance (Node 18+ AbortSignal.timeout)', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await deliverSingle('https://x.com/wh', 'event', {}, 1);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('concurrent deliverWebhooks calls via Promise.all → both resolve, fetch-call sum is correct', async () => {
    // First call: 2 webhooks → 2 fetches. Second call: 1 webhook → 1 fetch. Total: 3.
    prisma.webhook.findMany
      .mockResolvedValueOnce([
        { id: 1, targetUrl: 'https://a.example/wh' },
        { id: 2, targetUrl: 'https://b.example/wh' },
      ])
      .mockResolvedValueOnce([{ id: 3, targetUrl: 'https://c.example/wh' }]);
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    await Promise.all([
      deliverWebhooks('deal.won', { id: 1 }, 9),
      deliverWebhooks('contact.created', { id: 2 }, 9),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Subscription gating + per-tenant secret resolution (multi-tenant webhook
// signing). deliverWebhooks now: (1) skips ALL delivery when the tenant is not
// entitled (no active sub AND no active trial), and (2) signs with the tenant's
// own WebhookCredential secret when present.
// ---------------------------------------------------------------------------
describe('lib/webhookDelivery — subscription gating', () => {
  test('skips all deliveries when the tenant is NOT entitled', async () => {
    prisma.webhook.findMany.mockResolvedValue([
      { id: 1, targetUrl: 'https://a.example/wh' },
      { id: 2, targetUrl: 'https://b.example/wh' },
    ]);
    // Not entitled: no active subscription AND no active trial.
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await deliverWebhooks('deal.won', { id: 5 }, 9);

    expect(global.fetch).not.toHaveBeenCalled(); // gate stopped delivery
    logSpy.mockRestore();
  });

  test('delivers when entitled via an active TRIAL (no paid subscription)', async () => {
    prisma.webhook.findMany.mockResolvedValue([{ id: 1, targetUrl: 'https://a.example/wh' }]);
    prisma.subscription.findFirst.mockResolvedValue(null); // no paid sub
    prisma.user.findFirst.mockResolvedValue({ id: 7 }); // active trial user
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await deliverWebhooks('deal.won', { id: 5 }, 9);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('entitlement check runs only when ≥1 webhook matches (no DB cost for empty results)', async () => {
    prisma.webhook.findMany.mockResolvedValue([]);
    await deliverWebhooks('deal.won', { id: 5 }, 9);
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.webhookCredential.findFirst).not.toHaveBeenCalled();
  });
});

describe('lib/webhookDelivery — per-tenant secret signing', () => {
  const crypto = require('node:crypto');

  test("signs with the tenant's WebhookCredential secret (not the global env secret)", async () => {
    const tenantSecret = 'tenant-specific-secret-abc';
    process.env.WEBHOOK_HMAC_SECRET = 'GLOBAL-should-not-be-used';
    prisma.webhook.findMany.mockResolvedValue([{ id: 1, targetUrl: 'https://a.example/wh' }]);
    prisma.subscription.findFirst.mockResolvedValue({ id: 1 }); // entitled
    prisma.webhookCredential.findFirst.mockResolvedValue({ secret: tenantSecret });
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await deliverWebhooks('deal.won', { dealId: 5 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    const sig = opts.headers['X-Globussoft-Signature'];
    const m = sig.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(m).toBeTruthy();
    const expected = crypto.createHmac('sha256', tenantSecret).update(`${m[1]}.${opts.body}`).digest('hex');
    expect(m[2]).toBe(expected); // signed with the TENANT secret
    delete process.env.WEBHOOK_HMAC_SECRET;
  });

  test('falls back to the global env secret when the tenant has no credential', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'global-fallback-secret';
    prisma.webhook.findMany.mockResolvedValue([{ id: 1, targetUrl: 'https://a.example/wh' }]);
    prisma.subscription.findFirst.mockResolvedValue({ id: 1 });
    prisma.webhookCredential.findFirst.mockResolvedValue(null); // no per-tenant credential
    global.fetch.mockResolvedValue({ ok: true, status: 200 });

    await deliverWebhooks('deal.won', { dealId: 5 }, 9);

    const [, opts] = global.fetch.mock.calls[0];
    const m = opts.headers['X-Globussoft-Signature'].match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    const expected = crypto.createHmac('sha256', 'global-fallback-secret').update(`${m[1]}.${opts.body}`).digest('hex');
    expect(m[2]).toBe(expected);
    delete process.env.WEBHOOK_HMAC_SECRET;
  });
});
