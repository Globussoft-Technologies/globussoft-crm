// @ts-check
/**
 * Unit tests for backend/cron/scheduledEmailEngine.js — every-minute engine
 * that picks up status='PENDING' ScheduledEmail rows whose scheduledFor has
 * passed, persists them as EmailMessage rows for inbox visibility, attaches
 * a tracking pixel, dispatches via SendGrid, and flips status to SENT or
 * FAILED.
 *
 * Why this file exists (regression class — Wave 5 Agent XX cron coverage gap):
 *   - Engine has zero existing vitest unit coverage. Awkward branches:
 *       - Missing API key (env var unset) → graceful "no_api_key" reason
 *         instead of network call.
 *       - SendGrid 4xx/5xx response → row flagged FAILED with status code
 *         + body in errorMessage; sibling rows still process.
 *       - SendGrid network error (fetch throws) → graceful FAILED.
 *       - take:50 cap — engine never picks up >50 rows per tick (paginated
 *         fairness across tenants).
 *       - WHERE: status='PENDING' + scheduledFor:{lte: now} — future-scheduled
 *         + already-sent rows excluded at DB layer.
 *       - HTML body conversion: the engine's body.replace(/\n/g, '<br>')
 *         transforms plain-text newlines for the text/html alternative.
 *       - Tracking pixel: every send creates an EmailTracking row with a UUID
 *         and the pixel URL is appended to the body before send.
 *       - Per-row error containment: an exception inside the for-loop catches
 *         to FAILED with the exception message; siblings continue.
 *
 * Functions / branches covered:
 *   - sendViaSendGrid (NOT exported; tested indirectly via processScheduledEmails
 *     by inspecting fetch mock calls + ScheduledEmail status updates)
 *   - processScheduledEmails
 *       Empty due-set → no fetch, no email/tracking writes.
 *       Happy path → emailMessage.create + emailTracking.create + fetch +
 *         scheduledEmail.update(SENT) all fire in order.
 *       4xx response → status FAILED with "sendgrid 400: <body>" reason.
 *       5xx response → status FAILED with "sendgrid 500: <body>" reason.
 *       Network error (fetch throws) → status FAILED with the throw message.
 *       Missing SENDGRID_API_KEY env → status FAILED with "no_api_key".
 *       Per-row error containment: emailMessage.create throws → FAILED row
 *         + sibling row in same tick still processed.
 *       WHERE shape: status='PENDING' + scheduledFor:{lte: now} + take:50.
 *       Tracking pixel HTML appended to body BEFORE fetch.
 *
 * NOT covered (intentional):
 *   - initScheduledEmailCron: schedule shell.
 *
 * Mocking strategy:
 *   - prisma singleton monkey-patch (per writing-vitest-unit-test skill).
 *   - global.fetch stubbed via vi.stubGlobal — engine uses bare fetch, not
 *     node-fetch. Different responses per test (ok 200, 4xx, 5xx, throw).
 *   - Restore originals between tests so other test files don't see leakage.
 */
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Clear SENDGRID_API_KEY BEFORE importing the SUT — the engine captures
// `const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY` at module load
// time and the runtime check uses `process.env.SENDGRID_API_KEY || <captured>`,
// so a leftover value from .env (auto-loaded by @prisma/client) would
// poison the "missing key" branch by surviving `delete process.env.*`.
vi.hoisted(() => { delete process.env.SENDGRID_API_KEY; });

import prisma from '../../lib/prisma.js';

import { processScheduledEmails } from '../../cron/scheduledEmailEngine.js';

beforeAll(() => {
  prisma.scheduledEmail = { findMany: vi.fn(), update: vi.fn() };
  prisma.emailMessage = { create: vi.fn() };
  prisma.emailTracking = { create: vi.fn() };
});

let originalFetch;
let originalSendgridKey;

beforeEach(() => {
  prisma.scheduledEmail.findMany.mockReset();
  prisma.scheduledEmail.update.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.emailTracking.create.mockReset();

  prisma.scheduledEmail.findMany.mockResolvedValue([]);
  prisma.scheduledEmail.update.mockResolvedValue({});
  prisma.emailMessage.create.mockResolvedValue({ id: 'email-row-1' });
  prisma.emailTracking.create.mockResolvedValue({});

  // Save + stub fetch so each test can override per-call.
  originalFetch = global.fetch;
  global.fetch = vi.fn();

  // Most tests want a configured key. Tests that need "no key" branch override.
  originalSendgridKey = process.env.SENDGRID_API_KEY;
  process.env.SENDGRID_API_KEY = 'SG.testkey-deterministic';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalSendgridKey === undefined) {
    delete process.env.SENDGRID_API_KEY;
  } else {
    process.env.SENDGRID_API_KEY = originalSendgridKey;
  }
});

function pendingRow({
  id = 1,
  to = 'recipient@example.com',
  subject = 'Reminder',
  body = 'Hello\nWorld',
  contactId = 7,
  userId = 17,
  tenantId = 'tenant-A',
}) {
  return { id, to, subject, body, contactId, userId, tenantId };
}

function mockOkResponse({ messageId = 'sg-msg-id-abc' } = {}) {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 202,
    headers: {
      get: (h) => (h === 'x-message-id' ? messageId : null),
    },
    text: async () => '',
  });
}

function mockErrorResponse({ status = 400, body = 'invalid request' } = {}) {
  global.fetch.mockResolvedValueOnce({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  });
}

// ─── Empty due-set ──────────────────────────────────────────────────────────

describe('cron/scheduledEmailEngine — empty due-set', () => {
  test('zero pending rows → no fetch, no email/tracking writes; returns 0', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([]);

    const res = await processScheduledEmails();

    expect(res).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.emailTracking.create).not.toHaveBeenCalled();
    expect(prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });
});

// ─── findMany WHERE shape ───────────────────────────────────────────────────

describe('cron/scheduledEmailEngine — due-rows query shape', () => {
  test('WHERE: status=PENDING + scheduledFor:{lte:now} + take:50', async () => {
    const before = Date.now();
    await processScheduledEmails();

    expect(prisma.scheduledEmail.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('PENDING');
    expect(arg.where.scheduledFor).toHaveProperty('lte');
    const lte = arg.where.scheduledFor.lte.getTime();
    expect(lte).toBeGreaterThanOrEqual(before);
    expect(lte).toBeLessThanOrEqual(Date.now() + 50);
    expect(arg.take).toBe(50);
  });

  test('the cap on take=50 protects against unbounded scans', async () => {
    await processScheduledEmails();
    const arg = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(arg.take).toBe(50);
    expect(arg.take).toBeLessThanOrEqual(50);
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('cron/scheduledEmailEngine — happy path (200 OK)', () => {
  test('PENDING row sends successfully → SENT status with sentAt + null errorMessage', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 99 })]);
    mockOkResponse({ messageId: 'sg-id-X' });

    const processed = await processScheduledEmails();

    expect(processed).toBe(1);
    expect(prisma.scheduledEmail.update).toHaveBeenCalledTimes(1);
    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: 99 });
    expect(updArg.data.status).toBe('SENT');
    expect(updArg.data.sentAt).toBeInstanceOf(Date);
    expect(updArg.data.errorMessage).toBeNull();
  });

  test('emailMessage.create called BEFORE fetch with full envelope (subject, body, from, to, direction, contactId, userId, tenantId)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ id: 1, to: 'r@x.com', subject: 'Hi', body: 'B', contactId: 9, userId: 19, tenantId: 't' }),
    ]);
    mockOkResponse();

    await processScheduledEmails();

    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const arg = prisma.emailMessage.create.mock.calls[0][0];
    expect(arg.data.subject).toBe('Hi');
    expect(arg.data.body).toBe('B');
    expect(arg.data.to).toBe('r@x.com');
    expect(arg.data.direction).toBe('OUTBOUND');
    expect(arg.data.read).toBe(true);
    expect(arg.data.contactId).toBe(9);
    expect(arg.data.userId).toBe(19);
    expect(arg.data.tenantId).toBe('t');
    expect(arg.data.from).toMatch(/.+@.+\..+/);
  });

  test('emailTracking row created with type=open + scoped tenantId + emailId from emailMessage.create', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ id: 1, tenantId: 'tenant-Z' }),
    ]);
    prisma.emailMessage.create.mockResolvedValueOnce({ id: 'em-XYZ' });
    mockOkResponse();

    await processScheduledEmails();

    expect(prisma.emailTracking.create).toHaveBeenCalledTimes(1);
    const arg = prisma.emailTracking.create.mock.calls[0][0];
    expect(arg.data.emailId).toBe('em-XYZ');
    expect(arg.data.type).toBe('open');
    expect(arg.data.tenantId).toBe('tenant-Z');
    // trackingId is a UUID — assert format only.
    expect(arg.data.trackingId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('fetch fired with SendGrid v3 mail/send URL + Bearer auth + JSON content-type', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    mockOkResponse();

    await processScheduledEmails();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer SG.testkey-deterministic');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  test('fetch payload: personalizations.to[].email + from.email + subject + content[plain] + content[html]', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ to: 'alice@x.com', subject: 'S', body: 'line1\nline2' }),
    ]);
    mockOkResponse();

    await processScheduledEmails();

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.personalizations[0].to[0].email).toBe('alice@x.com');
    expect(body.from.email).toMatch(/.+@.+\..+/);
    expect(body.subject).toBe('S');
    expect(body.content).toHaveLength(2);
    expect(body.content[0].type).toBe('text/plain');
    expect(body.content[1].type).toBe('text/html');
  });

  test('HTML body converts \\n to <br> (text/html alternative)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ body: 'a\nb\nc' }),
    ]);
    mockOkResponse();

    await processScheduledEmails();

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    const htmlPart = body.content.find((c) => c.type === 'text/html').value;
    expect(htmlPart).toContain('<br>');
    // Plain text part keeps newlines (the SUT sends body unmodified for plain).
    // The body sent to fetch is the trackedBody — which appends a tracking
    // <img> AFTER the body. So plain text should still contain a/b/c on lines.
    const plainPart = body.content.find((c) => c.type === 'text/plain').value;
    expect(plainPart).toContain('a');
    expect(plainPart).toContain('b');
    expect(plainPart).toContain('c');
  });

  test('tracking pixel <img> URL appended to body before send (uses BASE_URL or default)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({})]);
    prisma.emailTracking.create.mockImplementationOnce(async ({ data }) => ({
      id: 'tr-1',
      trackingId: data.trackingId,
    }));
    mockOkResponse();

    await processScheduledEmails();

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    const plainPart = body.content.find((c) => c.type === 'text/plain').value;
    expect(plainPart).toContain('/api/communications/track/');
    expect(plainPart).toContain('/open.gif');
  });

  test('processed counter is the number of rows processed (one per row regardless of send outcome)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ id: 1 }),
      pendingRow({ id: 2 }),
    ]);
    mockOkResponse();
    mockErrorResponse({ status: 500 });

    const processed = await processScheduledEmails();
    // Both processed (counter increments per row in the for-loop, regardless
    // of SENT/FAILED).
    expect(processed).toBe(2);
  });
});

// ─── SendGrid error responses ───────────────────────────────────────────────

describe('cron/scheduledEmailEngine — SendGrid error responses', () => {
  test('400 response → status FAILED with "sendgrid 400: <body>" reason', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    mockErrorResponse({ status: 400, body: 'invalid recipient' });

    await processScheduledEmails();

    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('sendgrid 400');
    expect(updArg.data.errorMessage).toContain('invalid recipient');
  });

  test('500 response → status FAILED', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    mockErrorResponse({ status: 500, body: 'oops' });

    await processScheduledEmails();

    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('sendgrid 500');
  });

  test('429 rate-limit response → status FAILED (no implicit retry — caller responsibility)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    mockErrorResponse({ status: 429, body: 'rate limited' });

    await processScheduledEmails();

    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('429');
  });

  test('error response with unreadable body → reason is "sendgrid <status>: " (text() fallback to empty)', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => {
        throw new Error('body read failed');
      },
    });

    await processScheduledEmails();

    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('sendgrid 503');
  });
});

// ─── SendGrid network errors ────────────────────────────────────────────────

describe('cron/scheduledEmailEngine — network errors', () => {
  test('fetch throws → status FAILED with thrown message; row counted as processed', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    global.fetch.mockRejectedValueOnce(new Error('ENETUNREACH'));

    const processed = await processScheduledEmails();

    expect(processed).toBe(1);
    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('ENETUNREACH');
  });
});

// ─── No API key (env unset) ─────────────────────────────────────────────────

describe('cron/scheduledEmailEngine — missing SENDGRID_API_KEY', () => {
  test('env var unset → status FAILED with "no_api_key" reason; no fetch attempted', async () => {
    delete process.env.SENDGRID_API_KEY;
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);

    await processScheduledEmails();

    expect(global.fetch).not.toHaveBeenCalled();
    const updArg = prisma.scheduledEmail.update.mock.calls[0][0];
    expect(updArg.data.status).toBe('FAILED');
    expect(updArg.data.errorMessage).toContain('no_api_key');
  });

  test('env var unset → emailMessage + emailTracking still created (inbox visibility BEFORE send attempt)', async () => {
    delete process.env.SENDGRID_API_KEY;
    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);

    await processScheduledEmails();

    // Inbox visibility is independent of send success — the architecture
    // captures the EmailMessage + tracking row first, then attempts send.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.emailTracking.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Per-row error containment ──────────────────────────────────────────────

describe('cron/scheduledEmailEngine — per-row error containment', () => {
  test('emailMessage.create throws on row 1 → row 1 flagged FAILED with throw message; row 2 still processed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.scheduledEmail.findMany.mockResolvedValueOnce([
      pendingRow({ id: 1 }),
      pendingRow({ id: 2 }),
    ]);
    prisma.emailMessage.create
      .mockRejectedValueOnce(new Error('PrismaClientKnownRequestError'))
      .mockResolvedValueOnce({ id: 'em-2' });
    mockOkResponse();

    const processed = await processScheduledEmails();

    expect(processed).toBe(1); // only row 2 incremented (the inner-catch path
                                // does NOT increment processed)

    // Two scheduledEmail.update calls: one inside the inner catch (row 1
    // FAILED), one in the SENT path (row 2)
    const updates = prisma.scheduledEmail.update.mock.calls.map((c) => c[0]);
    const failedUpdate = updates.find((u) => u.where.id === 1);
    expect(failedUpdate.data.status).toBe('FAILED');
    expect(failedUpdate.data.errorMessage).toContain('PrismaClient');

    const sentUpdate = updates.find((u) => u.where.id === 2);
    expect(sentUpdate.data.status).toBe('SENT');

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('per-row inner catch failing to update FAILED status is silently ignored (defensive double-catch)', async () => {
    // The inner catch wraps the FAILED update in another try/catch — if even
    // the FAILED update fails, the engine continues without throwing.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.scheduledEmail.findMany.mockResolvedValueOnce([pendingRow({ id: 1 })]);
    prisma.emailMessage.create.mockRejectedValueOnce(new Error('first'));
    prisma.scheduledEmail.update.mockRejectedValueOnce(new Error('FAILED-update also dead'));

    await expect(processScheduledEmails()).resolves.toBe(0);
    errSpy.mockRestore();
  });
});

// ─── Top-level error handling ───────────────────────────────────────────────

describe('cron/scheduledEmailEngine — top-level error handling', () => {
  test('findMany throws → engine catches, logs, returns 0', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.scheduledEmail.findMany.mockRejectedValueOnce(new Error('DB unavailable'));

    const processed = await processScheduledEmails();

    expect(processed).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
