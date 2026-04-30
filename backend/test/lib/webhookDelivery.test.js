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
});

beforeEach(() => {
  prisma.webhook.findMany.mockReset();
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
