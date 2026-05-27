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

const { notify, notifyMany, notifyTenant, resolve } = notif;

const NOTIF_ROW = { id: 1, title: 'Hi', message: 'world' };

beforeAll(() => {
  prisma.notification = { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() };
  prisma.user = { findUnique: vi.fn(), findMany: vi.fn() };
  // PR #710 / #702 — notify() now reads NotificationPreference before
  // routing. Default to "no custom prefs row" so the helper falls back
  // to DEFAULT_PREFERENCES (every category + every channel enabled).
  prisma.notificationPreference = { findUnique: vi.fn() };
  // pushService exports an object — patch its method directly.
  pushService.sendToUser = vi.fn();
});

beforeEach(() => {
  prisma.notification.create.mockReset();
  prisma.notification.create.mockResolvedValue(NOTIF_ROW);
  prisma.notification.findFirst.mockReset();
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.update.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notificationPreference.findUnique.mockReset();
  // PR #710 (#702) — DEFAULT_PREFERENCES has `channels.email = false` and
  // `channels.push = false` (sensible opt-in defaults). Most of the legacy
  // tests in this file pre-date that and assert the SendGrid + push paths
  // ALWAYS run when the caller specifies channels=['email'] etc. To preserve
  // the test intent (route-mechanics validation, not opt-in policy), the
  // default mock here returns a "user opted in to everything" preference row.
  // The category gate is also fully open. Individual tests that DO want to
  // exercise the opt-in policy (e.g. "category disabled" / "channel disabled"
  // / "quiet hours") can override with mockResolvedValueOnce.
  prisma.notificationPreference.findUnique.mockResolvedValue({
    userId: 1,
    tenantId: 1,
    categoryToggles: {
      info: true, success: true, warning: true, error: true,
      system: true, deal: true, task: true, ticket: true, lead: true,
      approval: true, leave: true, expense: true,
    },
    channels: { db: true, socket: true, push: true, email: true },
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: null,
  });
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
    // PR #669 changed notificationService.js:120 to `io.to(userId).emit(...)`
    // for per-user socket routing. Mock both methods on a single object —
    // `.to(room).emit(...)` is the standard socket.io API for room-scoped
    // emit. The chain returns `this` so the same mock catches `.emit`.
    const ioEmit = vi.fn();
    const ioTo = vi.fn(() => ({ emit: ioEmit }));
    const io = { to: ioTo, emit: vi.fn() };
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', io });
    expect(ioTo).toHaveBeenCalledWith('user:1');
    expect(ioEmit).toHaveBeenCalledWith('notification_new', expect.objectContaining({ userId: 1 }));
  });

  test('does not emit socket when io not provided', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  test('does not emit socket when channels excludes "socket"', async () => {
    const ioEmit = vi.fn();
    const ioTo = vi.fn(() => ({ emit: ioEmit }));
    const io = { to: ioTo, emit: vi.fn() };
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', io, channels: ['db'] });
    expect(ioTo).not.toHaveBeenCalled();
    expect(ioEmit).not.toHaveBeenCalled();
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

  // CJS-singleton-patch REVIVAL (2026-05-26): the SUT's runtime
  // `require("../services/pushService")` resolves to the SAME CJS module
  // exports object that the test patched via createRequire at the top of
  // this file. Same singleton-patch trick the prisma mocks already use.
  // Originally skipped because the older mock factory pattern didn't
  // intercept the require; the `pushService.sendToUser = vi.fn()` patch
  // directly on the exports object DOES.
  test('push channel: swallows pushService errors', async () => {
    pushService.sendToUser.mockRejectedValue(new Error('vapid not set'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'push'] });
    expect(out).toEqual(NOTIF_ROW);
    expect(pushService.sendToUser).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('push channel: calls pushService.sendToUser with title/body/url', async () => {
    pushService.sendToUser.mockResolvedValue({ sent: 1, failed: 0 });
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

// ---------------------------------------------------------------------------
// EXTENDED COVERAGE (2026-05-26) — preference gates, dedup, priority, default
// preference fallback, resolve(), notifyMany partial-failure semantics, push
// channel revival via CJS-singleton-patch (skips above un-skipped). Pins
// branches that previously only had implicit coverage through integration
// specs (push-api, notifications-api). Reduces the time-to-detect for a
// preference-routing regression from "next e2e-full" to "next per-push gate".
// ---------------------------------------------------------------------------

describe('lib/notificationService — notify: preference gates', () => {
  test('category disabled → returns null + no DB write', async () => {
    prisma.notificationPreference.findUnique.mockResolvedValueOnce({
      userId: 1, tenantId: 1,
      categoryToggles: { info: false, deal: true, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
      channels: { db: true, socket: true, push: true, email: true },
      quietHoursStart: null, quietHoursEnd: null, timezone: null,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', type: 'info' });
    expect(out).toBeNull();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('category preference uses explicit category over type', async () => {
    // Pin: when `category` is provided, gate uses category, NOT type.
    prisma.notificationPreference.findUnique.mockResolvedValueOnce({
      userId: 1, tenantId: 1,
      categoryToggles: { info: true, deal: false, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
      channels: { db: true, socket: true, push: true, email: true },
      quietHoursStart: null, quietHoursEnd: null, timezone: null,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', type: 'info', category: 'deal' });
    expect(out).toBeNull(); // 'deal' is disabled even though 'info' (the type) is enabled
    logSpy.mockRestore();
  });

  test('channel disabled in prefs filters that channel out', async () => {
    // User opted out of email; even though caller requests email, fetch must NOT fire.
    prisma.notificationPreference.findUnique.mockResolvedValueOnce({
      userId: 1, tenantId: 1,
      categoryToggles: { info: true, deal: true, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
      channels: { db: true, socket: true, push: true, email: false },
      quietHoursStart: null, quietHoursEnd: null, timezone: null,
    });
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', channels: ['db', 'email'] });
    expect(prisma.notification.create).toHaveBeenCalled(); // DB still works
    expect(global.fetch).not.toHaveBeenCalled(); // email filtered out
    logSpy.mockRestore();
  });

  test('no prefs row + DEFAULT_PREFERENCES applied (email is opt-in, defaults to disabled)', async () => {
    // SUT line 26-27: DEFAULT_PREFERENCES.channels.email = false, push = false.
    // When prisma returns null (no row), the helper falls back to defaults and
    // caller's `channels: ['db','email']` gets email filtered out.
    prisma.notificationPreference.findUnique.mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', type: 'deal', channels: ['db', 'email'] });
    expect(prisma.notification.create).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('prefs query failure falls back to DEFAULT_PREFERENCES (no throw)', async () => {
    // .catch(() => null) at line 144 — DB error during prefs lookup must NOT
    // bring down the whole notification. Falls back to defaults.
    prisma.notificationPreference.findUnique.mockRejectedValueOnce(new Error('prefs query timeout'));
    const out = await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', type: 'deal' });
    expect(out).toEqual(NOTIF_ROW);
    expect(prisma.notification.create).toHaveBeenCalled();
  });
});

describe('lib/notificationService — notify: deduplication', () => {
  test('returns null when dup found within window (entityId + entityType)', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce({ id: 42, type: 'lead' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await notify({
      userId: 1, tenantId: 1, title: 'T', message: 'M',
      type: 'lead', entityType: 'lead', entityId: 99,
    });
    expect(out).toBeNull();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.notification.findFirst).toHaveBeenCalled();
    const arg = prisma.notification.findFirst.mock.calls[0][0];
    expect(arg.where.userId).toBe(1);
    expect(arg.where.tenantId).toBe(1);
    expect(arg.where.entityId).toBe(99);
    expect(arg.where.entityType).toBe('lead');
    logSpy.mockRestore();
  });

  test('no dup found → proceeds to create', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    const out = await notify({
      userId: 1, tenantId: 1, title: 'T', message: 'M',
      type: 'lead', entityType: 'lead', entityId: 99,
    });
    expect(out).toEqual(NOTIF_ROW);
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  test('skips dedup query when entityId or entityType missing', async () => {
    // entityId without entityType → no findFirst call (both required at line 178).
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', entityId: 99 });
    expect(prisma.notification.findFirst).not.toHaveBeenCalled();
  });

  test('dedup window default is 24h (windowStart ≈ now - 24h)', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    const before = Date.now();
    await notify({
      userId: 1, tenantId: 1, title: 'T', message: 'M',
      type: 'lead', entityType: 'lead', entityId: 99,
    });
    const arg = prisma.notification.findFirst.mock.calls[0][0];
    const windowStart = arg.where.createdAt.gte;
    const expectedMin = before - 24 * 60 * 60 * 1000 - 100;
    const expectedMax = Date.now() - 24 * 60 * 60 * 1000 + 100;
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(windowStart.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  test('custom dedupWindowHours threads through', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    const before = Date.now();
    await notify({
      userId: 1, tenantId: 1, title: 'T', message: 'M',
      type: 'lead', entityType: 'lead', entityId: 99, dedupWindowHours: 1,
    });
    const arg = prisma.notification.findFirst.mock.calls[0][0];
    const windowStart = arg.where.createdAt.gte;
    // ~1 hour ago, not 24
    const oneHourAgo = before - 60 * 60 * 1000;
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(oneHourAgo - 100);
    expect(windowStart.getTime()).toBeLessThanOrEqual(Date.now() - 60 * 60 * 1000 + 100);
  });
});

describe('lib/notificationService — notify: priority + entity fields', () => {
  test('default priority is "normal"', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    expect(prisma.notification.create.mock.calls[0][0].data.priority).toBe('normal');
  });

  test('explicit priority overrides default', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M', priority: 'critical' });
    expect(prisma.notification.create.mock.calls[0][0].data.priority).toBe('critical');
  });

  test('entityType + entityId persisted to row when no dup', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce(null);
    await notify({
      userId: 1, tenantId: 1, title: 'T', message: 'M',
      entityType: 'ticket', entityId: 7,
    });
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.entityType).toBe('ticket');
    expect(data.entityId).toBe(7);
  });

  test('entityType/entityId default to null when not provided', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.entityType).toBeNull();
    expect(data.entityId).toBeNull();
  });

  test('isRead defaults to false on create', async () => {
    await notify({ userId: 1, tenantId: 1, title: 'T', message: 'M' });
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.isRead).toBe(false);
  });
});

describe('lib/notificationService — notifyMany: extended', () => {
  test('partial failure: middle userId rejects → Promise rejects (for-of awaits sequentially)', async () => {
    // The SUT uses `for...of` + `await notify(...)`. A rejected notify() will
    // propagate as a rejection of notifyMany. Pin this contract: callers must
    // assume "all-or-nothing within the iteration"; users after the failing
    // one are NOT notified.
    prisma.notification.create
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce({ id: 3 });
    await expect(
      notifyMany({ userIds: [1, 2, 3], tenantId: 9, title: 'T', message: 'M' })
    ).rejects.toThrow('db hiccup');
    // Third user must NOT have been called (loop bailed at user 2's reject).
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  test('return ordering matches input userIds order', async () => {
    prisma.notification.create
      .mockResolvedValueOnce({ id: 10 })
      .mockResolvedValueOnce({ id: 20 })
      .mockResolvedValueOnce({ id: 30 });
    const out = await notifyMany({ userIds: [10, 20, 30], tenantId: 9, title: 'T', message: 'M' });
    expect(out.map((r) => r.id)).toEqual([10, 20, 30]);
  });

  test('threads link parameter into every per-user notify', async () => {
    await notifyMany({ userIds: [1, 2], tenantId: 9, title: 'T', message: 'M', link: '/deals/5' });
    const calls = prisma.notification.create.mock.calls;
    expect(calls[0][0].data.link).toBe('/deals/5');
    expect(calls[1][0].data.link).toBe('/deals/5');
  });

  test('threads type parameter into every per-user notify', async () => {
    await notifyMany({ userIds: [1, 2], tenantId: 9, title: 'T', message: 'M', type: 'warning' });
    const calls = prisma.notification.create.mock.calls;
    expect(calls[0][0].data.type).toBe('warning');
    expect(calls[1][0].data.type).toBe('warning');
  });

  test('returns null in array for users where prefs blocked the notification', async () => {
    // First user has category disabled, second is unblocked.
    prisma.notificationPreference.findUnique
      .mockResolvedValueOnce({
        userId: 1, tenantId: 9,
        categoryToggles: { info: false, deal: true, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
        channels: { db: true, socket: true, push: true, email: true },
        quietHoursStart: null, quietHoursEnd: null, timezone: null,
      })
      .mockResolvedValueOnce({
        userId: 2, tenantId: 9,
        categoryToggles: { info: true, deal: true, task: true, ticket: true, lead: true, approval: true, leave: true, expense: true },
        channels: { db: true, socket: true, push: true, email: true },
        quietHoursStart: null, quietHoursEnd: null, timezone: null,
      });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await notifyMany({ userIds: [1, 2], tenantId: 9, title: 'T', message: 'M', type: 'info' });
    expect(out).toHaveLength(2);
    expect(out[0]).toBeNull();
    expect(out[1]).toEqual(NOTIF_ROW);
    logSpy.mockRestore();
  });
});

describe('lib/notificationService — resolve', () => {
  test('marks notification as read + sets readAt', async () => {
    const updated = { id: 5, isRead: true, readAt: new Date() };
    prisma.notification.update.mockResolvedValueOnce(updated);
    const out = await resolve(5, 9);
    expect(prisma.notification.update).toHaveBeenCalled();
    const arg = prisma.notification.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 5, tenantId: 9 });
    expect(arg.data.isRead).toBe(true);
    expect(arg.data.readAt).toBeInstanceOf(Date);
    expect(out).toEqual(updated);
  });

  test('returns null + swallows update errors', async () => {
    prisma.notification.update.mockRejectedValueOnce(new Error('record not found'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await resolve(999, 9);
    expect(out).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('scopes update by tenantId (cross-tenant guard)', async () => {
    prisma.notification.update.mockResolvedValueOnce({ id: 5 });
    await resolve(5, 42);
    const arg = prisma.notification.update.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
  });
});
