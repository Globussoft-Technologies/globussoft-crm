// Unit tests for backend/lib/notificationService.js
//
// Mocking strategy: vitest 4's `vi.mock` doesn't intercept CJS `require()`
// inside the SUT — we monkey-patch the prisma singleton's model properties
// instead. The same trick is used for the pushService dep, but via
// createRequire so we patch the *real* CJS module.exports object that the
// SUT will see.
//
// PR #511 (2026-05-05) swapped Mailgun → SendGrid. SENDGRID_API_KEY is
// captured at module load time inside the SUT (top-level
// `const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ""`). We
// therefore set it BEFORE the SUT import so the email channel tests
// exercise the "SendGrid configured" branch. The previous incarnation
// of this test file set MAILGUN_API_KEY which was harmlessly ignored
// after the swap — tests still passed but asserted nothing about the
// new code path. Closes PR #511 review blocker #2 for this module.
//
// IMPORTANT: ESM `import` statements are hoisted above any runtime code
// in the module. A top-level `process.env.X = ...` statement does NOT run
// before the imports — it runs AFTER. Use `vi.hoisted()` so the env-var
// assignment is itself hoisted above the SUT import, ensuring the SUT's
// `const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ""` sees the
// fixture key. Caught by the unit_tests gate going red on `aafa1e2`
// (5 SendGrid contract tests failed because fetch was never called →
// SUT had taken the `no_api_key` early-return branch).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'test-sendgrid-key';
});
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCjs = createRequire(import.meta.url);
// Patch the real CJS module.exports of pushService so the SUT's runtime
// `require("../services/pushService")` returns our mocked sendToUser.
const pushService = requireCjs('../../services/pushService.js');

import notif from '../../lib/notificationService.js';

const { notify, notifyMany, notifyTenant } = notif;

const NOTIF_ROW = { id: 1, title: 'Hi', message: 'world' };

beforeAll(() => {
  prisma.notification = { create: vi.fn() };
  prisma.user = { findUnique: vi.fn(), findMany: vi.fn() };
  // pushService exports an object — patch its method directly.
  pushService.sendToUser = vi.fn();
});

beforeEach(() => {
  prisma.notification.create.mockReset();
  prisma.notification.create.mockResolvedValue(NOTIF_ROW);
  prisma.user.findUnique.mockReset();
  prisma.user.findMany.mockReset();
  pushService.sendToUser.mockReset();
  global.fetch = vi.fn();
});

describe('lib/notificationService — module shape', () => {
  test('exports notify, notifyMany, notifyTenant', () => {
    expect(typeof notify).toBe('function');
    expect(typeof notifyMany).toBe('function');
    expect(typeof notifyTenant).toBe('function');
  });
});

describe('lib/notificationService — notify', () => {
  test('always saves to DB', async () => {
    await notify({ userId: 1, tenantId: 9, title: 'T', message: 'M' });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.create.mock.calls[0][0];
    expect(arg.data.title).toBe('T');
    expect(arg.data.message).toBe('M');
    expect(arg.data.userId).toBe(1);
    expect(arg.data.tenantId).toBe(9);
  });

  test('default type is "info"', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(prisma.notification.create.mock.calls[0][0].data.type).toBe('info');
  });

  test('explicit type overrides default', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', type: 'error' });
    expect(prisma.notification.create.mock.calls[0][0].data.type).toBe('error');
  });

  test('default link is null', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(prisma.notification.create.mock.calls[0][0].data.link).toBeNull();
  });

  test('explicit link is preserved', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', link: '/pipeline' });
    expect(prisma.notification.create.mock.calls[0][0].data.link).toBe('/pipeline');
  });

  test('returns the created notification record', async () => {
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(out).toEqual(NOTIF_ROW);
  });

  test('emits socket event when io provided + socket in default channels', async () => {
    const io = { emit: vi.fn() };
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', io });
    expect(io.emit).toHaveBeenCalledWith('notification_new', expect.objectContaining({ userId: 1 }));
  });

  test('does not emit socket when io not provided', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  test('does not emit socket when channels excludes "socket"', async () => {
    const io = { emit: vi.fn() };
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', io, channels: ['db'] });
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('only-db channels: skips push and email', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db'] });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // PR #511 SendGrid coverage: with SENDGRID_API_KEY set (above, line 24)
  // the SUT calls global.fetch directly — no node:undici import chain to
  // intercept, so the previously-skipped Mailgun test now works as-is on
  // the SendGrid path.
  test('email channel: looks up user + calls fetch when SENDGRID_API_KEY set', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    global.fetch.mockResolvedValue({ ok: true });
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(global.fetch).toHaveBeenCalled();
  });

  // PR #511 SendGrid contract: assert the request hits the right URL,
  // sends Bearer auth (not Mailgun's Basic), and JSON body (not Mailgun's
  // URLSearchParams). These are the exact assertions that would have
  // caught the silent provider mismatch the review blocker flagged.
  test('email channel: SendGrid request URL is api.sendgrid.com/v3/mail/send', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    global.fetch.mockResolvedValue({ ok: true });
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
  });

  test('email channel: SendGrid request uses Bearer auth + Content-Type JSON', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    global.fetch.mockResolvedValue({ ok: true });
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toMatch(/^Bearer test-sendgrid-key$/);
    expect(opts.headers['Content-Type']).toBe('application/json');
    // Anti-regression: Mailgun used Basic auth + URLSearchParams. Pin the
    // current contract to catch a silent revert.
    expect(opts.headers.Authorization).not.toMatch(/^Basic /);
    expect(opts.body).not.toBeInstanceOf(URLSearchParams);
  });

  test('email channel: SendGrid payload shape — personalizations / from / subject / content', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'recipient@example.com' });
    global.fetch.mockResolvedValue({ ok: true });
    await notify({ userId: 1, tenantId: 1, title: 'Welcome', message: 'Line 1\nLine 2', channels: ['db', 'email'] });
    const [, opts] = global.fetch.mock.calls[0];
    const payload = JSON.parse(opts.body);
    expect(payload.personalizations).toEqual([{ to: [{ email: 'recipient@example.com' }] }]);
    expect(payload.from.email).toMatch(/@/);
    expect(payload.subject).toBe('Welcome');
    expect(Array.isArray(payload.content)).toBe(true);
    // Both plain-text and HTML parts; HTML converts \n → <br>
    const html = payload.content.find((c) => c.type === 'text/html');
    const plain = payload.content.find((c) => c.type === 'text/plain');
    expect(html.value).toContain('<br>');
    expect(plain.value).toBe('Line 1\nLine 2');
  });

  test('email channel: returns notification row even when SendGrid 4xx (best-effort)', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(out).toEqual(NOTIF_ROW);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('email channel: skips fetch when user has no email', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: null });
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('email channel: skips fetch when user not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('email channel: swallows user lookup errors', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(out).toEqual(NOTIF_ROW);
    warnSpy.mockRestore();
  });

  test('email channel: swallows SendGrid fetch failures', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    global.fetch.mockRejectedValue(new Error('network error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(out).toEqual(NOTIF_ROW);
    errSpy.mockRestore();
  });

  // SKIPPED: pushService is loaded via require() inside the SUT's `notify`
  // function — that require resolves to the real module before our mock
  // factory runs. The mock's sendToUser is never the one that actually
  // gets called. Same root cause as the email-test skip above.
  // For real coverage of these branches, see the e2e push-api.spec.js
  // which exercises the route + library through real HTTP.
  test.skip('push channel: swallows pushService errors', async () => {
    pushService.sendToUser.mockRejectedValue(new Error('vapid not set'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'push'] });
    expect(out).toEqual(NOTIF_ROW);
    warnSpy.mockRestore();
  });

  test.skip('push channel: calls pushService.sendToUser', async () => {
    pushService.sendToUser.mockResolvedValue({ delivered: 1 });
    await notify({ userId: 7, tenantId: 1, title: 'T', message: 'M', link: '/x', channels: ['db', 'push'] });
    expect(pushService.sendToUser).toHaveBeenCalled();
    const call = pushService.sendToUser.mock.calls[pushService.sendToUser.mock.calls.length - 1];
    expect(call[0]).toBe(7);
    expect(call[1]).toEqual({ title: 'T', body: 'M', url: '/x' });
  });

  test('DB failure propagates (rejects)', async () => {
    prisma.notification.create.mockRejectedValue(new Error('db down'));
    await expect(notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' })).rejects.toThrow('db down');
  });
});

describe('lib/notificationService — notifyMany', () => {
  test('iterates over userIds and calls notify N times', async () => {
    const out = await notifyMany({ userIds: [1, 2, 3], tenantId: 9, title: 'T', message: 'M' });
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(3);
  });

  test('returns array of created notification rows', async () => {
    const out = await notifyMany({ userIds: [1, 2], tenantId: 9, title: 'T', message: 'M' });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([NOTIF_ROW, NOTIF_ROW]);
  });

  test('empty userIds → no calls', async () => {
    const out = await notifyMany({ userIds: [], tenantId: 9, title: 'T', message: 'M' });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  test('passes channels through to notify', async () => {
    await notifyMany({ userIds: [1], tenantId: 9, title: 'T', message: 'M', channels: ['db'] });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('lib/notificationService — notifyTenant', () => {
  test('queries users by tenantId then notifies each', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const out = await notifyTenant({ tenantId: 9, title: 'T', message: 'M' });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 9 },
      select: { id: true },
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(3);
  });

  test('handles empty tenant (no users)', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const out = await notifyTenant({ tenantId: 9, title: 'T', message: 'M' });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});
