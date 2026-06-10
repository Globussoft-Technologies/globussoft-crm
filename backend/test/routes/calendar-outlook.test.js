// @ts-check
/**
 * Unit tests for backend/routes/calendar_outlook.js — pins the Microsoft
 * Outlook / Graph Calendar OAuth + sync route contract.
 *
 * Why this file exists
 * ────────────────────
 * routes/calendar_outlook.js is the Outlook sister of routes/calendar_google.js.
 * It wires OAuth (connect / callback) and event sync (POST /sync, GET /events,
 * POST /events, DELETE /disconnect) against the Microsoft Graph API via raw
 * `fetch(...)` calls — there's no Microsoft Graph SDK in use; the route hits
 *   https://login.microsoftonline.com/common/oauth2/v2.0/{token,authorize}
 *   https://graph.microsoft.com/v1.0/me/calendar/events
 * directly. The contract that downstream consumers (Settings → CalendarSync
 * UI, workflow automations that read CalendarEvent rows) need pinned:
 *
 *   1. GET /connect requires MS_CLIENT_ID + MS_REDIRECT_URI to be set on
 *      the server. Missing → 500 with deterministic
 *      "Microsoft OAuth env vars not configured" envelope.
 *   2. GET /connect returns { authUrl } pointing at the Microsoft authorize
 *      endpoint with response_type=code, the configured redirect_uri, the
 *      Calendars.ReadWrite scope, and state=<userId> for round-tripping.
 *   3. GET /callback is PUBLIC (no verifyToken — OAuth providers redirect
 *      the BROWSER here, no JWT available). Missing code/state → 400 plain
 *      text. Non-numeric state → 400 plain text.
 *   4. GET /callback exchanges code → tokens via fetch to MS token endpoint.
 *      Failure (non-2xx) → 500 plain text with the upstream error.
 *   5. GET /callback happy path upserts a CalendarIntegration row keyed on
 *      (userId, provider='microsoft') with tokens + syncEnabled=true +
 *      calendarId='primary'. Emits HTML script redirect to
 *      /calendar-sync?connected=outlook (preserves the SPA browser session).
 *   6. POST /sync 404s when no integration row exists (friendly error,
 *      not 500). Caller must hit /connect first.
 *   7. POST /sync pulls events from Graph → upserts CalendarEvent rows
 *      keyed on (tenantId, provider, externalId). Returns { synced }
 *      and stamps CalendarIntegration.lastSyncAt.
 *   8. POST /sync 502s when the upstream Graph request fails (token expired
 *      after refresh attempt, rate limited, etc.) — surfaces upstream error.
 *   9. GET /events 404s when no integration row exists.
 *  10. GET /events scopes findMany by (userId, tenantId, provider='microsoft')
 *      ordered by startTime asc.
 *  11. POST /events validates: title + startTime + endTime required (400),
 *      unparseable dates (400), start must be in future (400), end must be
 *      after start (400). Conflicting event in same window → 409.
 *  12. POST /events creates via Graph then upserts CalendarEvent row scoped
 *      to (tenantId, provider, externalId). Attendees string-or-object shape
 *      both accepted (both get normalised to Graph's emailAddress shape).
 *      Returns 201.
 *  13. DELETE /disconnect removes the integration row via deleteMany
 *      (idempotent by Prisma semantics — deleteMany on no-match returns
 *      { count: 0 } rather than throwing). Returns { disconnected: true }.
 *
 * Pattern
 * ───────
 *   Mirrors backend/test/routes/calendar-google.test.js (commit 3ff87b92)
 *   as the sister surface. Key divergences from the Google template:
 *
 *   - No SDK to monkey-patch — the route uses raw `fetch(...)`. We stub
 *     `global.fetch` per-test via vi.fn() and queue per-call responses
 *     with mockResolvedValueOnce so token-exchange / Graph-list /
 *     Graph-create can return distinct shapes from a single endpoint.
 *
 *   - Auth middleware bypass: monkey-patch `authMw.verifyToken` at
 *     module-load so destructured references in the router capture
 *     the pass-through. Identical to Google template.
 *
 *   - Prisma singleton patching: replace the lazy $extends-proxy
 *     delegates for calendarIntegration + calendarEvent + user with
 *     bare vi.fn() surfaces. The route also calls prisma.user.findUnique
 *     during /callback to resolve tenantId from userId — needs stubbing
 *     so the upsert sees a sane tenantId default.
 *
 * What this file does NOT cover (intentional):
 *   - No real Microsoft Graph HTTP — every fetch call is stubbed.
 *   - No token-refresh trigger via expired expiresAt (refreshTokenIfNeeded
 *     short-circuits when expiresAt > now; pinning the refresh branch would
 *     require a second fetch queue + integration row with expired token —
 *     out of scope for the per-handler contract this file pins).
 *   - No multi-tenant cross-isolation probe (tenant scoping is pinned
 *     in the e2e api spec; the unit test pins per-handler argument
 *     shape only).
 */
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth middleware bypass ─────────────────────────────────────────
// Pass-through verifyToken so we exercise the route logic without
// minting JWTs. Same pattern as accounting.test.js + calendar-google.test.js.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ─── Prisma singleton patching ──────────────────────────────────────
// Replace the lazy $extends-proxy delegates with bare vi.fn() surfaces.
// The Outlook route touches calendarIntegration + calendarEvent + user
// (the latter only inside /callback to resolve tenantId from userId).
prisma.calendarIntegration = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.calendarEvent = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.user = {
  findUnique: vi.fn(),
};

// Pin env vars so /connect doesn't 500 in tests that exercise the
// happy path. Force-override (not `||`) — Prisma's client constructor
// auto-loads backend/.env on import (the `import prisma` above), which
// would inject the real MS_CLIENT_ID and break the `client_id=test-ms-client-id`
// assertion. The route reads these into module-level consts at require time,
// so the override MUST happen BEFORE the requireCJS() call below.
process.env.MS_CLIENT_ID = 'test-ms-client-id';
process.env.MS_CLIENT_SECRET = 'test-ms-client-secret';
process.env.MS_REDIRECT_URI = 'http://localhost:5000/api/calendar/outlook/callback';
process.env.FRONTEND_URL = 'http://localhost:5173';

import express from 'express';
import request from 'supertest';
const calendarOutlookRouter = requireCJS('../../routes/calendar_outlook');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/calendar/outlook', calendarOutlookRouter);
  return app;
}

/**
 * Builds a minimal fetch-Response-like object with the shape the route
 * actually consumes (`ok`, `status`, `text()`, `json()`).
 */
function mockResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

const prevFetch = global.fetch;

beforeEach(() => {
  // Reset prisma mocks.
  prisma.calendarIntegration.findUnique.mockReset();
  prisma.calendarIntegration.upsert.mockReset();
  prisma.calendarIntegration.update.mockReset();
  prisma.calendarIntegration.deleteMany.mockReset();
  prisma.calendarEvent.findFirst.mockReset();
  prisma.calendarEvent.findMany.mockReset();
  prisma.calendarEvent.upsert.mockReset();
  prisma.user.findUnique.mockReset();

  // Sensible defaults — happy-path resolves.
  prisma.calendarIntegration.upsert.mockResolvedValue({
    id: 1,
    userId: 7,
    provider: 'microsoft',
    tenantId: 1,
  });
  prisma.calendarIntegration.update.mockResolvedValue({ id: 1 });
  prisma.calendarIntegration.deleteMany.mockResolvedValue({ count: 1 });
  prisma.calendarEvent.findFirst.mockResolvedValue(null);
  prisma.calendarEvent.findMany.mockResolvedValue([]);
  prisma.calendarEvent.upsert.mockImplementation(({ create }) =>
    Promise.resolve({ id: 555, ...create })
  );
  prisma.user.findUnique.mockResolvedValue({ id: 7, tenantId: 1 });

  // Pin env vars (some tests delete them and restore in afterAll, but
  // restoring here keeps each test independent).
  process.env.MS_CLIENT_ID = 'test-ms-client-id';
  process.env.MS_CLIENT_SECRET = 'test-ms-client-secret';
  process.env.MS_REDIRECT_URI = 'http://localhost:5000/api/calendar/outlook/callback';
  process.env.FRONTEND_URL = 'http://localhost:5173';

  // Fresh fetch stub per test.
  global.fetch = vi.fn();
});

afterAll(() => {
  global.fetch = prevFetch;
});

// ─── GET /connect — OAuth URL generation ───────────────────────────

describe('GET /api/calendar/outlook/connect', () => {
  test('returns an authUrl when MS env vars are configured', async () => {
    const app = makeApp({ userId: 42, tenantId: 9 });
    const res = await request(app).get('/api/calendar/outlook/connect');
    expect(res.status).toBe(200);
    expect(typeof res.body.authUrl).toBe('string');
    // Pin the shape — must point at the MS authorize endpoint with the
    // configured client_id, redirect_uri, scope, and state=userId.
    expect(res.body.authUrl).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/
    );
    expect(res.body.authUrl).toContain('client_id=test-ms-client-id');
    expect(res.body.authUrl).toContain('response_type=code');
    // scope encoded with %20 (encodeURIComponent default), NOT '+'.
    expect(res.body.authUrl).toContain(
      'scope=offline_access%20Calendars.ReadWrite%20User.Read'
    );
    expect(res.body.authUrl).toContain('state=42');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('500s when MS_CLIENT_ID is missing on the server', async () => {
    // The route reads MS_CLIENT_ID at module-load (line 10) into a const,
    // BUT the /connect handler also re-reads it via the captured const each
    // call. We need a fresh require with the env cleared to flip the gate.
    const origId = process.env.MS_CLIENT_ID;
    const origRedirect = process.env.MS_REDIRECT_URI;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_REDIRECT_URI;
    try {
      const routePath = requireCJS.resolve('../../routes/calendar_outlook');
      delete requireCJS.cache[routePath];
      const freshRouter = requireCJS('../../routes/calendar_outlook');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = { userId: 7, tenantId: 1 };
        next();
      });
      app.use('/api/calendar/outlook', freshRouter);
      const res = await request(app).get('/api/calendar/outlook/connect');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Microsoft OAuth env vars not configured/i);
    } finally {
      process.env.MS_CLIENT_ID = origId;
      process.env.MS_REDIRECT_URI = origRedirect;
      // Restore the warm-cached router for every subsequent test.
      const routePath = requireCJS.resolve('../../routes/calendar_outlook');
      delete requireCJS.cache[routePath];
      requireCJS('../../routes/calendar_outlook');
    }
  });
});

// ─── GET /callback — OAuth redirect endpoint ──────────────────────

describe('GET /api/calendar/outlook/callback', () => {
  test('400 plain text when no code or state', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/calendar/outlook/callback');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Missing code or state/i);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
  });

  test('400 plain text when state is not a numeric userId', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/outlook/callback?code=abc&state=NOT-NUMERIC'
    );
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid state/i);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
  });

  test('happy path — upserts integration + emits HTML redirect to /calendar-sync?connected=outlook', async () => {
    // Token exchange returns the canonical MS token shape.
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        body: {
          access_token: 'ms-at-stub',
          refresh_token: 'ms-rt-stub',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'Calendars.ReadWrite offline_access',
        },
      })
    );
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/outlook/callback?code=auth-code-xyz&state=7'
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.location.href');
    expect(res.text).toContain('connected=outlook');

    // Token endpoint was called with form-encoded body containing the code.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenOpts] = global.fetch.mock.calls[0];
    expect(tokenUrl).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    );
    expect(tokenOpts.method).toBe('POST');
    expect(tokenOpts.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(tokenOpts.body).toContain('code=auth-code-xyz');
    expect(tokenOpts.body).toContain('grant_type=authorization_code');

    // Integration upserted under provider='microsoft' keyed by userId.
    expect(prisma.calendarIntegration.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.calendarIntegration.upsert.mock.calls[0][0];
    expect(upsertArgs.where.userId_provider).toEqual({
      userId: 7,
      provider: 'microsoft',
    });
    expect(upsertArgs.create.accessToken).toBe('ms-at-stub');
    expect(upsertArgs.create.refreshToken).toBe('ms-rt-stub');
    expect(upsertArgs.create.syncEnabled).toBe(true);
    expect(upsertArgs.create.calendarId).toBe('primary');
    expect(upsertArgs.update.accessToken).toBe('ms-at-stub');
    expect(upsertArgs.update.syncEnabled).toBe(true);

    // tenantId resolves from the user lookup (we stubbed user.findUnique
    // to return { tenantId: 1 }).
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(upsertArgs.create.tenantId).toBe(1);
  });

  test('falls back to tenantId=1 when the user lookup returns null', async () => {
    // Pin the defensive `|| 1` branch on line 122 — if the user row vanishes
    // mid-callback the integration still saves rather than 500ing.
    prisma.user.findUnique.mockResolvedValue(null);
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        body: {
          access_token: 'ms-at-2',
          refresh_token: 'ms-rt-2',
          expires_in: 3600,
        },
      })
    );
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/outlook/callback?code=cd&state=7'
    );
    expect(res.status).toBe(200);
    const upsertArgs = prisma.calendarIntegration.upsert.mock.calls[0][0];
    expect(upsertArgs.create.tenantId).toBe(1);
  });

  test('token exchange failure → 500 with the upstream error body', async () => {
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        body: 'invalid_grant: code expired',
      })
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/outlook/callback?code=expired&state=7'
    );
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/Token exchange failed/i);
    expect(res.text).toMatch(/invalid_grant/);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─── POST /sync — pull events from Graph → DB ────────────────────

describe('POST /api/calendar/outlook/sync', () => {
  test('404s when no integration row exists (user not connected)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/calendar/outlook/sync');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('happy path — pulls events from Graph, upserts each, stamps lastSyncAt', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'ms-at',
      refreshToken: 'ms-rt',
      // not yet expired — refreshTokenIfNeeded short-circuits
      expiresAt: new Date(Date.now() + 3600_000),
      calendarId: 'primary',
    });
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        body: {
          value: [
            {
              id: 'ms-ev-1',
              subject: 'Patient consult',
              bodyPreview: 'Initial review',
              start: { dateTime: '2026-06-01T10:00:00.0000000' },
              end: { dateTime: '2026-06-01T10:30:00.0000000' },
              location: { displayName: 'Clinic A' },
              attendees: [
                {
                  emailAddress: { address: 'patient@example.com', name: 'Patient One' },
                  status: { response: 'accepted' },
                },
              ],
              onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
            },
            {
              id: 'ms-ev-2',
              subject: 'Team sync',
              start: { dateTime: '2026-06-02T14:00:00.0000000' },
              end: { dateTime: '2026-06-02T15:00:00.0000000' },
            },
          ],
        },
      })
    );
    const app = makeApp();
    const res = await request(app).post('/api/calendar/outlook/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 2 });
    expect(prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);

    // Pin Graph fetch URL — must point at /me/calendar/events with the
    // 90-day window filter + $top=250 + $orderby=start/dateTime.
    // The route uses raw template-string concatenation (not URLSearchParams),
    // so '$' and '/' are NOT URL-encoded — both appear literally in the URL.
    const [graphUrl, graphOpts] = global.fetch.mock.calls[0];
    expect(graphUrl).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendar\/events\?/
    );
    expect(graphUrl).toContain('$top=250');
    expect(graphUrl).toContain('$orderby=start/dateTime');
    expect(graphUrl).toContain('$filter=start/dateTime ge ');
    expect(graphOpts.headers.Authorization).toBe('Bearer ms-at');
    expect(graphOpts.headers.Prefer).toBe('outlook.timezone="UTC"');

    // First event: meeting URL comes from onlineMeeting.joinUrl, attendees
    // are stringified as { email, name, status } trios.
    const ev1 = prisma.calendarEvent.upsert.mock.calls[0][0];
    expect(ev1.where.tenantId_provider_externalId).toEqual({
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ms-ev-1',
    });
    expect(ev1.create.title).toBe('Patient consult');
    expect(ev1.create.meetingUrl).toBe(
      'https://teams.microsoft.com/l/meetup-join/abc'
    );
    expect(ev1.create.location).toBe('Clinic A');
    expect(ev1.create.attendees).toBe(
      JSON.stringify([
        { email: 'patient@example.com', name: 'Patient One', status: 'accepted' },
      ])
    );

    // lastSyncAt stamped at the end.
    expect(prisma.calendarIntegration.update).toHaveBeenCalledTimes(1);
    const lastSync = prisma.calendarIntegration.update.mock.calls[0][0];
    expect(lastSync.where.id).toBe(1);
    expect(lastSync.data.lastSyncAt).toBeInstanceOf(Date);
  });

  test('events with empty subject default the title to "(No title)"', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        body: {
          value: [
            {
              id: 'ms-untitled',
              // subject deliberately absent
              start: { dateTime: '2026-06-01T10:00:00.0000000' },
              end: { dateTime: '2026-06-01T10:30:00.0000000' },
            },
          ],
        },
      })
    );
    const app = makeApp();
    const res = await request(app).post('/api/calendar/outlook/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 1 });
    const ev = prisma.calendarEvent.upsert.mock.calls[0][0];
    expect(ev.create.title).toBe('(No title)');
  });

  test('502 when Graph returns non-2xx', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: 'rate limited',
      })
    );
    const app = makeApp();
    const res = await request(app).post('/api/calendar/outlook/sync');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Graph fetch failed/);
    expect(res.body.error).toMatch(/rate limited/);
    expect(prisma.calendarEvent.upsert).not.toHaveBeenCalled();
  });
});

// ─── GET /events — list synced events ─────────────────────────────

describe('GET /api/calendar/outlook/events', () => {
  test('404s when no integration row exists', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/calendar/outlook/events');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  test('returns events scoped to (userId, tenantId, provider="microsoft") ordered by startTime asc', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 99,
      tenantId: 42,
    });
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 1, title: 'A', startTime: new Date('2026-06-01T10:00:00Z') },
      { id: 2, title: 'B', startTime: new Date('2026-06-02T10:00:00Z') },
    ]);
    const app = makeApp({ tenantId: 42, userId: 99 });
    const res = await request(app).get('/api/calendar/outlook/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    const args = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: 99,
      tenantId: 42,
      provider: 'microsoft',
    });
    expect(args.orderBy).toEqual({ startTime: 'asc' });
  });
});

// ─── POST /events — create event in Graph + DB ────────────────────

describe('POST /api/calendar/outlook/events', () => {
  function futureIso(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  test('400 when title/startTime/endTime missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({ title: 'Only title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('400 when startTime in the past', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'Past',
        startTime: new Date(Date.now() - 86_400_000).toISOString(),
        endTime: new Date(Date.now() - 80_000_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/i);
  });

  test('400 when endTime ≤ startTime', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'Backwards',
        startTime: futureIso(3600_000),
        endTime: futureIso(1800_000),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end time/i);
  });

  test('400 on unparseable startTime/endTime', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'BadDate',
        startTime: 'not-a-date',
        endTime: 'also-not-a-date',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('409 when conflicting event exists in the same window', async () => {
    prisma.calendarEvent.findFirst.mockResolvedValueOnce({
      id: 42,
      title: 'Pre-existing',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'Clash',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/conflict/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('404 when integration row is missing (after passing validation)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'New event',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('happy path — creates Graph event + upserts CalendarEvent row, returns 201', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'ms-at',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 201,
        body: {
          id: 'graph-new-id',
          subject: 'New consult',
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' },
          start: { dateTime: '2026-06-01T10:00:00.0000000' },
          end: { dateTime: '2026-06-01T11:00:00.0000000' },
        },
      })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'New consult',
        description: 'Initial visit',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
        attendees: ['a@example.com', { email: 'b@example.com', name: 'Bob' }],
      });
    expect(res.status).toBe(201);

    // Graph POST was called once with the canonical Outlook event shape.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [graphUrl, graphOpts] = global.fetch.mock.calls[0];
    expect(graphUrl).toBe(
      'https://graph.microsoft.com/v1.0/me/calendar/events'
    );
    expect(graphOpts.method).toBe('POST');
    expect(graphOpts.headers.Authorization).toBe('Bearer ms-at');
    expect(graphOpts.headers['Content-Type']).toBe('application/json');
    const graphBody = JSON.parse(graphOpts.body);
    expect(graphBody.subject).toBe('New consult');
    expect(graphBody.body).toEqual({
      contentType: 'HTML',
      content: 'Initial visit',
    });
    expect(graphBody.start.timeZone).toBe('UTC');
    expect(graphBody.end.timeZone).toBe('UTC');
    // Attendees: string form → { emailAddress: { address, name }, type: 'required' }.
    // The route's normalisation treats both forms uniformly; string attendees
    // populate BOTH address and name with the string value.
    expect(graphBody.attendees).toHaveLength(2);
    expect(graphBody.attendees[0]).toEqual({
      emailAddress: { address: 'a@example.com', name: 'a@example.com' },
      type: 'required',
    });
    expect(graphBody.attendees[1]).toEqual({
      emailAddress: { address: 'b@example.com', name: 'Bob' },
      type: 'required',
    });

    // CalendarEvent upserted under (tenantId, provider, externalId).
    expect(prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.calendarEvent.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId_provider_externalId).toEqual({
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'graph-new-id',
    });
    expect(upsertArgs.create.meetingUrl).toBe(
      'https://teams.microsoft.com/l/meetup-join/xyz'
    );
    expect(upsertArgs.create.userId).toBe(7);
    expect(upsertArgs.create.provider).toBe('microsoft');
  });

  test('createMeet:true requests a Teams online meeting (isOnlineMeeting + teamsForBusiness)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1, userId: 7, tenantId: 1, accessToken: 'ms-at', expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(mockResponse({
      ok: true, status: 201,
      body: { id: 'graph-meet-id', subject: 'Consult', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/new' } },
    }));
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({ title: 'Consult', startTime: futureIso(3600_000), endTime: futureIso(7200_000), createMeet: true });
    expect(res.status).toBe(201);
    const graphBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(graphBody.isOnlineMeeting).toBe(true);
    expect(graphBody.onlineMeetingProvider).toBe('teamsForBusiness');
    expect(prisma.calendarEvent.upsert.mock.calls[0][0].create.meetingUrl).toBe(
      'https://teams.microsoft.com/l/meetup-join/new'
    );
  });

  test('backward-compat: without createMeet, no online meeting is requested', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1, userId: 7, tenantId: 1, accessToken: 'ms-at', expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 201, body: { id: 'g2', subject: 'Plain' } }));
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({ title: 'Plain', startTime: futureIso(3600_000), endTime: futureIso(7200_000) });
    expect(res.status).toBe(201);
    const graphBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect('isOnlineMeeting' in graphBody).toBe(false);
  });

  test('502 when Graph create returns non-2xx', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'ms-at',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 403,
        body: 'insufficient privileges',
      })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/outlook/events')
      .send({
        title: 'No perms',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
      });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Graph create failed/);
    expect(res.body.error).toMatch(/insufficient privileges/);
    expect(prisma.calendarEvent.upsert).not.toHaveBeenCalled();
  });
});

// ─── GET /slots — free/busy slot-picker (via getSchedule) ─────────

describe('GET /api/calendar/outlook/slots', () => {
  test('400 when date is missing/malformed', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/calendar/outlook/slots');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date is required/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('404 when Outlook not connected', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/calendar/outlook/slots?date=2999-01-15');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
  });

  test('returns slots that exclude busy windows (via Graph getSchedule)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1, userId: 7, tenantId: 1, accessToken: 'ms-at', expiresAt: new Date(Date.now() + 3600_000),
    });
    // 1st fetch = /me (mailbox), 2nd fetch = getSchedule. 09:00–10:00 UTC busy.
    global.fetch
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { mail: 'advisor@contoso.com' } }))
      .mockResolvedValueOnce(mockResponse({
        ok: true, status: 200,
        body: { value: [{ scheduleItems: [{ start: { dateTime: '2999-01-15T09:00:00' }, end: { dateTime: '2999-01-15T10:00:00' } }] }] },
      }));
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/outlook/slots?date=2999-01-15&durationMins=60&startHour=9&endHour=18&tzOffsetMins=0'
    );
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2999-01-15');
    // 9 one-hour slots 09–18; the 09:00 slot is busy → 8 free.
    expect(res.body.slots.length).toBe(8);
    expect(res.body.slots.map((s) => s.start)).not.toContain('2999-01-15T09:00:00.000Z');
    // getSchedule was queried for the resolved mailbox.
    const schedBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(schedBody.schedules).toEqual(['advisor@contoso.com']);
  });
});

// ─── DELETE /disconnect ───────────────────────────────────────────

describe('DELETE /api/calendar/outlook/disconnect', () => {
  test('happy path — deletes integration rows and returns { disconnected: true }', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/outlook/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
    expect(prisma.calendarIntegration.deleteMany).toHaveBeenCalledTimes(1);
    const args = prisma.calendarIntegration.deleteMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 7, provider: 'microsoft' });
  });

  test('idempotent — deleteMany returning { count: 0 } still returns { disconnected: true }', async () => {
    // deleteMany on no-match resolves cleanly with count=0 (unlike .delete
    // which throws P2025) — the route doesn't need to swallow anything.
    prisma.calendarIntegration.deleteMany.mockResolvedValueOnce({ count: 0 });
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/outlook/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
  });

  test('500 envelope when prisma throws an unexpected error', async () => {
    prisma.calendarIntegration.deleteMany.mockRejectedValueOnce(
      new Error('db connection lost')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/outlook/disconnect');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db connection lost/);
    consoleSpy.mockRestore();
  });
});
