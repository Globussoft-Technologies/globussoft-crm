// @ts-check
/**
 * Unit tests for backend/routes/calendar_google.js — pins the Google
 * Calendar OAuth + sync route contract.
 *
 * Why this file exists
 * ────────────────────
 * routes/calendar_google.js wires OAuth (connect / callback) and event
 * sync (POST /sync, GET /events, POST /events, DELETE /disconnect)
 * against the Google Calendar API via the `googleapis` SDK. The
 * contract that matters for downstream consumers (Settings →
 * CalendarSync UI, automation workflows that read CalendarEvent rows)
 * is:
 *
 *   1. GET /connect requires GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
 *      to be set on the server. Missing → 500 with a deterministic
 *      "credentials not configured" envelope.
 *   2. GET /connect returns { authUrl } — the OAuth2 client's
 *      generateAuthUrl output. The state param round-trips
 *      { userId, tenantId, t } so the callback can match the user.
 *   3. GET /callback redirects to FRONTEND_URL/calendar-sync on
 *      every terminal branch (no JSON envelopes — OAuth callbacks
 *      need browser redirects):
 *        - missing code/state → ?error=missing_code_or_state
 *        - invalid/undecodable state → ?error=invalid_state
 *        - token exchange failure → ?error=token_exchange_failed
 *        - Google sent ?error=… → relayed through to the frontend
 *        - happy path → ?connected=google via HTML script redirect
 *   4. GET /callback upserts a CalendarIntegration row keyed on
 *      (userId, provider='google') with tokens + syncEnabled=true.
 *   5. POST /sync 404s when no integration row exists (user hasn't
 *      connected yet — friendly error, not 500).
 *   6. POST /sync pulls events from Google → upserts CalendarEvent
 *      rows keyed on (tenantId, provider, externalId). Returns
 *      { success: true, synced: <count> } and stamps
 *      CalendarIntegration.lastSyncAt.
 *   7. POST /sync skips events missing start or end (defensive — the
 *      Google API occasionally returns malformed entries during
 *      partial deletions).
 *   8. POST /sync paginates via nextPageToken — multi-page responses
 *      are concatenated into one synced count.
 *   9. GET /events 404s when no integration row exists.
 *  10. GET /events scopes findMany by (userId, tenantId, provider).
 *  11. POST /events validates: title + startTime + endTime required
 *      (400), valid Date parsing (400), start must be in future (400),
 *      end must be after start (400). Conflicting event in same
 *      window → 409.
 *  12. POST /events creates via Google API then upserts CalendarEvent
 *      row scoped to (tenantId, provider, externalId). Attendees
 *      string-or-object shape both accepted. Returns 201.
 *  13. DELETE /disconnect removes the integration row. Idempotent —
 *      P2025 (row-not-found) returns success rather than 500.
 *
 * Pattern
 * ───────
 *   Mirror of backend/test/routes/accounting.test.js + admin.test.js:
 *
 *   - Auth middleware bypass: monkey-patch `authMw.verifyToken` at
 *     module-load so destructured references in the router capture
 *     the pass-through.
 *
 *   - Prisma singleton patching: replace the lazy $extends-proxy
 *     delegates for calendarIntegration + calendarEvent with bare
 *     vi.fn() surfaces. The router only touches these two delegates.
 *
 *   - googleapis SDK mocking: the route does
 *       const { google } = require('googleapis');
 *     at module-load. Since `google.auth.OAuth2` and `google.calendar`
 *     are writable, we monkey-patch them on the live `google` object
 *     BEFORE the router is required. Same approach the route uses
 *     itself (calls `google.auth.OAuth2` / `google.calendar` lazily
 *     inside handlers), so the patched versions take effect on every
 *     request.
 *
 * What this file does NOT cover (intentional):
 *   - No real Google API HTTP — every SDK method is stubbed.
 *   - No token-refresh tokens-event flow (the `client.on('tokens',…)`
 *     is exercised implicitly when `setCredentials` is called; pinning
 *     it would require a deeper SDK fake than the per-handler shape
 *     this file pins).
 *   - No multi-tenant cross-isolation probe (tenant scoping is pinned
 *     in the e2e api spec; the unit test pins per-handler argument
 *     shape only).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth middleware bypass ─────────────────────────────────────────
// Pass-through verifyToken so we exercise the route logic without
// minting JWTs. Same pattern as accounting.test.js + admin.test.js.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ─── googleapis monkey-patch ────────────────────────────────────────
// The route does `const { google } = require('googleapis')` at module
// load. The `google` object's `auth.OAuth2` and `calendar` exports are
// writable function properties, so we replace them here BEFORE the
// router is required. The route then captures whatever they point at.
const googleapis = requireCJS('googleapis');

// Per-test mock handles — reset in beforeEach.
const oauth2State = {
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  on: vi.fn(),
};
const calendarState = {
  events: {
    list: vi.fn(),
    insert: vi.fn(),
  },
};

// Replace google.auth.OAuth2 with a constructor that returns our mock
// each call (so `new google.auth.OAuth2(...)` resolves to oauth2State).
googleapis.google.auth.OAuth2 = function FakeOAuth2() {
  return {
    generateAuthUrl: (...args) => oauth2State.generateAuthUrl(...args),
    getToken: (...args) => oauth2State.getToken(...args),
    setCredentials: (...args) => oauth2State.setCredentials(...args),
    on: (...args) => oauth2State.on(...args),
  };
};

// Replace google.calendar to return our stub each call.
googleapis.google.calendar = function fakeCalendar() {
  return {
    events: {
      list: (...args) => calendarState.events.list(...args),
      insert: (...args) => calendarState.events.insert(...args),
    },
  };
};

// ─── Prisma singleton patching ──────────────────────────────────────
// Replace the lazy $extends-proxy delegates with bare vi.fn() surfaces.
// The route only touches calendarIntegration + calendarEvent.
prisma.calendarIntegration = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.calendarEvent = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
};

// Pin env vars so /connect doesn't 500 in tests that exercise the
// happy path. Tests that need to flip these clear/restore them locally.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/google/callback';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

import express from 'express';
import request from 'supertest';
const calendarGoogleRouter = requireCJS('../../routes/calendar_google');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/calendar/google', calendarGoogleRouter);
  return app;
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

beforeEach(() => {
  // Reset oauth + calendar mocks.
  oauth2State.generateAuthUrl.mockReset();
  oauth2State.getToken.mockReset();
  oauth2State.setCredentials.mockReset();
  oauth2State.on.mockReset();
  calendarState.events.list.mockReset();
  calendarState.events.insert.mockReset();

  // Reset prisma mocks.
  prisma.calendarIntegration.findUnique.mockReset();
  prisma.calendarIntegration.upsert.mockReset();
  prisma.calendarIntegration.update.mockReset();
  prisma.calendarIntegration.delete.mockReset();
  prisma.calendarEvent.findFirst.mockReset();
  prisma.calendarEvent.findMany.mockReset();
  prisma.calendarEvent.upsert.mockReset();

  // Sensible defaults — happy-path resolves.
  oauth2State.generateAuthUrl.mockReturnValue(
    'https://accounts.google.com/o/oauth2/v2/auth?stub=1'
  );
  oauth2State.getToken.mockResolvedValue({
    tokens: {
      access_token: 'at-stub',
      refresh_token: 'rt-stub',
      expiry_date: Date.now() + 3600_000,
    },
  });
  prisma.calendarIntegration.upsert.mockResolvedValue({
    id: 1,
    userId: 7,
    provider: 'google',
    tenantId: 1,
  });
  prisma.calendarIntegration.update.mockResolvedValue({ id: 1 });
  prisma.calendarIntegration.delete.mockResolvedValue({ id: 1 });
  prisma.calendarEvent.findFirst.mockResolvedValue(null);
  prisma.calendarEvent.findMany.mockResolvedValue([]);
  prisma.calendarEvent.upsert.mockImplementation(({ create }) =>
    Promise.resolve({ id: 555, ...create })
  );

  // Pin env vars (some tests delete them and restore in afterAll, but
  // restoring here keeps each test independent).
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.FRONTEND_URL = 'http://localhost:5173';
});

// ─── GET /connect — OAuth URL generation ───────────────────────────

describe('GET /api/calendar/google/connect', () => {
  test('returns an authUrl when client credentials are configured', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/calendar/google/connect');
    expect(res.status).toBe(200);
    expect(res.body.authUrl).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?stub=1'
    );
    expect(oauth2State.generateAuthUrl).toHaveBeenCalledTimes(1);
    // Validate the state param round-trips the user + tenant.
    const args = oauth2State.generateAuthUrl.mock.calls[0][0];
    expect(args.access_type).toBe('offline');
    expect(args.prompt).toBe('consent');
    expect(Array.isArray(args.scope)).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(args.state, 'base64url').toString('utf8')
    );
    expect(decoded.userId).toBe(7);
    expect(decoded.tenantId).toBe(1);
    expect(typeof decoded.t).toBe('number');
  });

  test('500s when GOOGLE_CLIENT_ID/SECRET missing on the server', async () => {
    // The route captures GOOGLE_CLIENT_ID into a module-load-time const
    // (line 12), so testing the missing-creds 500 branch requires a
    // fresh require with the env cleared. We do this with the CJS
    // require cache: drop the route from cache, clear the env, re-
    // require, mount on a one-shot app. The router we cached at the
    // top of this file remains unaffected for every other test.
    const origId = process.env.GOOGLE_CLIENT_ID;
    const origSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      const routePath = requireCJS.resolve('../../routes/calendar_google');
      delete requireCJS.cache[routePath];
      const freshRouter = requireCJS('../../routes/calendar_google');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = { userId: 7, tenantId: 1 };
        next();
      });
      app.use('/api/calendar/google', freshRouter);
      const res = await request(app).get('/api/calendar/google/connect');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/credentials not configured/i);
      expect(oauth2State.generateAuthUrl).not.toHaveBeenCalled();
    } finally {
      process.env.GOOGLE_CLIENT_ID = origId;
      process.env.GOOGLE_CLIENT_SECRET = origSecret;
      // Restore the warm-cached router for any subsequent test in this file.
      const routePath = requireCJS.resolve('../../routes/calendar_google');
      delete requireCJS.cache[routePath];
      requireCJS('../../routes/calendar_google');
    }
  });
});

// ─── GET /callback — OAuth redirect endpoint ──────────────────────

describe('GET /api/calendar/google/callback', () => {
  test('redirects with error=missing_code_or_state when no code or state', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/calendar/google/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=missing_code_or_state/);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
  });

  test('relays ?error=… from Google to the frontend', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/google/callback?error=access_denied'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/calendar-sync\?error=access_denied/);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
  });

  test('redirects with error=invalid_state when state cannot be decoded', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/calendar/google/callback?code=abc&state=NOT-VALID-BASE64-JSON'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=invalid_state/);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
  });

  test('happy path — upserts integration + emits HTML redirect to /calendar-sync?connected=google', async () => {
    const state = encodeState({ userId: 7, tenantId: 1, t: Date.now() });
    const app = makeApp();
    const res = await request(app).get(
      `/api/calendar/google/callback?code=auth-code-xyz&state=${state}`
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.location.href');
    expect(res.text).toContain('connected=google');
    expect(oauth2State.getToken).toHaveBeenCalledWith('auth-code-xyz');
    expect(prisma.calendarIntegration.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.calendarIntegration.upsert.mock.calls[0][0];
    expect(upsertArgs.where.userId_provider).toEqual({
      userId: 7,
      provider: 'google',
    });
    expect(upsertArgs.create.accessToken).toBe('at-stub');
    expect(upsertArgs.create.refreshToken).toBe('rt-stub');
    expect(upsertArgs.create.syncEnabled).toBe(true);
    expect(upsertArgs.create.calendarId).toBe('primary');
    expect(upsertArgs.create.tenantId).toBe(1);
  });

  test('token exchange failure redirects with error=token_exchange_failed', async () => {
    oauth2State.getToken.mockRejectedValueOnce(new Error('bad code'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = encodeState({ userId: 7, tenantId: 1, t: Date.now() });
    const app = makeApp();
    const res = await request(app).get(
      `/api/calendar/google/callback?code=auth-code-xyz&state=${state}`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=token_exchange_failed/);
    expect(prisma.calendarIntegration.upsert).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  test('callback omits refreshToken from update when Google did not return one (preserves prior)', async () => {
    // Google's contract: refresh_token only returned on FIRST consent.
    // If a re-consent omits it, the route must keep the existing
    // refresh token in place — pinned by the spread `...(refresh_token ? ... : {})`.
    oauth2State.getToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'at-refresh',
        // refresh_token deliberately absent
        expiry_date: Date.now() + 3600_000,
      },
    });
    const state = encodeState({ userId: 7, tenantId: 1, t: Date.now() });
    const app = makeApp();
    const res = await request(app).get(
      `/api/calendar/google/callback?code=auth-code-xyz&state=${state}`
    );
    expect(res.status).toBe(200);
    const upsertArgs = prisma.calendarIntegration.upsert.mock.calls[0][0];
    // create branch always sets refreshToken (to null if missing)
    expect(upsertArgs.create.refreshToken).toBeNull();
    // update branch must NOT contain a refreshToken key at all
    expect('refreshToken' in upsertArgs.update).toBe(false);
    expect(upsertArgs.update.accessToken).toBe('at-refresh');
  });
});

// ─── POST /sync — pull events from Google → DB ────────────────────

describe('POST /api/calendar/google/sync', () => {
  test('404s when no integration row exists (user not connected)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).post('/api/calendar/google/sync');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
    expect(calendarState.events.list).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  test('happy path — pulls events from Google, upserts each, stamps lastSyncAt', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at-stub',
      refreshToken: 'rt-stub',
      expiresAt: new Date(Date.now() + 3600_000),
      calendarId: 'primary',
    });
    calendarState.events.list.mockResolvedValue({
      data: {
        items: [
          {
            id: 'ev-1',
            summary: 'Patient consult',
            description: 'Initial review',
            start: { dateTime: '2026-06-01T10:00:00Z' },
            end: { dateTime: '2026-06-01T10:30:00Z' },
            location: 'Clinic A',
            attendees: [{ email: 'patient@example.com' }],
            hangoutLink: 'https://meet.google.com/abc-defg-hij',
          },
          {
            id: 'ev-2',
            summary: 'Team sync',
            start: { dateTime: '2026-06-02T14:00:00Z' },
            end: { dateTime: '2026-06-02T15:00:00Z' },
          },
        ],
        nextPageToken: undefined,
      },
    });
    const app = makeApp();
    const res = await request(app).post('/api/calendar/google/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: 2 });
    expect(prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);

    // First event: meeting URL comes from hangoutLink.
    const ev1 = prisma.calendarEvent.upsert.mock.calls[0][0];
    expect(ev1.where.tenantId_provider_externalId).toEqual({
      tenantId: 1,
      provider: 'google',
      externalId: 'ev-1',
    });
    expect(ev1.create.title).toBe('Patient consult');
    expect(ev1.create.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(ev1.create.attendees).toBe(
      JSON.stringify([{ email: 'patient@example.com' }])
    );

    // lastSyncAt stamped at the end.
    expect(prisma.calendarIntegration.update).toHaveBeenCalledTimes(1);
    const lastSync = prisma.calendarIntegration.update.mock.calls[0][0];
    expect(lastSync.where.userId_provider).toEqual({
      userId: 7,
      provider: 'google',
    });
    expect(lastSync.data.lastSyncAt).toBeInstanceOf(Date);
  });

  test('skips events with missing start or end (defensive)', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at',
      calendarId: 'primary',
    });
    calendarState.events.list.mockResolvedValue({
      data: {
        items: [
          { id: 'ev-good', summary: 'OK', start: { dateTime: '2026-06-01T10:00:00Z' }, end: { dateTime: '2026-06-01T10:30:00Z' } },
          { id: 'ev-no-end', summary: 'Bad', start: { dateTime: '2026-06-01T10:00:00Z' } }, // no end
          { id: 'ev-no-start', summary: 'Bad', end: { dateTime: '2026-06-01T10:30:00Z' } }, // no start
          { summary: 'No-id' }, // no id at all
        ],
      },
    });
    const app = makeApp();
    const res = await request(app).post('/api/calendar/google/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: 1 });
    expect(prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
  });

  test('paginates via nextPageToken — multi-page totals concatenate', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at',
      calendarId: 'primary',
    });
    let callCount = 0;
    calendarState.events.list.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          data: {
            items: [
              { id: 'p1-a', summary: 'p1a', start: { dateTime: '2026-06-01T10:00:00Z' }, end: { dateTime: '2026-06-01T10:30:00Z' } },
              { id: 'p1-b', summary: 'p1b', start: { dateTime: '2026-06-01T11:00:00Z' }, end: { dateTime: '2026-06-01T11:30:00Z' } },
            ],
            nextPageToken: 'token-page-2',
          },
        });
      }
      return Promise.resolve({
        data: {
          items: [
            { id: 'p2-a', summary: 'p2a', start: { dateTime: '2026-06-02T10:00:00Z' }, end: { dateTime: '2026-06-02T10:30:00Z' } },
          ],
          nextPageToken: undefined,
        },
      });
    });
    const app = makeApp();
    const res = await request(app).post('/api/calendar/google/sync');
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(3);
    expect(callCount).toBe(2);
    // Second call passed the nextPageToken.
    expect(calendarState.events.list.mock.calls[1][0].pageToken).toBe(
      'token-page-2'
    );
  });
});

// ─── GET /events — list synced events ─────────────────────────────

describe('GET /api/calendar/google/events', () => {
  test('404s when no integration row exists', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/calendar/google/events');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  test('returns events scoped to (userId, tenantId, provider) ordered by startTime asc', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
    });
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 1, title: 'A', startTime: new Date('2026-06-01T10:00:00Z') },
      { id: 2, title: 'B', startTime: new Date('2026-06-02T10:00:00Z') },
    ]);
    const app = makeApp({ tenantId: 42, userId: 99 });
    const res = await request(app).get('/api/calendar/google/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    const args = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: 99,
      tenantId: 42,
      provider: 'google',
    });
    expect(args.orderBy).toEqual({ startTime: 'asc' });
  });
});

// ─── POST /events — create event in Google + DB ───────────────────

describe('POST /api/calendar/google/events', () => {
  function futureIso(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  test('400 when title/startTime/endTime missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/google/events')
      .send({ title: 'Only title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(calendarState.events.insert).not.toHaveBeenCalled();
  });

  test('400 when startTime in the past', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/google/events')
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
      .post('/api/calendar/google/events')
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
      .post('/api/calendar/google/events')
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
      .post('/api/calendar/google/events')
      .send({
        title: 'Clash',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/conflict/i);
    expect(calendarState.events.insert).not.toHaveBeenCalled();
  });

  test('happy path — creates Google event + upserts CalendarEvent row, returns 201', async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      tenantId: 1,
      accessToken: 'at',
      calendarId: 'primary',
    });
    calendarState.events.insert.mockResolvedValue({
      data: {
        id: 'gcal-new-id',
        summary: 'New consult',
        hangoutLink: 'https://meet.google.com/xyz',
      },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/calendar/google/events')
      .send({
        title: 'New consult',
        startTime: futureIso(3600_000),
        endTime: futureIso(7200_000),
        attendees: ['a@example.com', { email: 'b@example.com' }],
        location: 'Room 3',
      });
    expect(res.status).toBe(201);
    expect(calendarState.events.insert).toHaveBeenCalledTimes(1);
    const insertArgs = calendarState.events.insert.mock.calls[0][0];
    expect(insertArgs.calendarId).toBe('primary');
    expect(insertArgs.requestBody.summary).toBe('New consult');
    expect(insertArgs.requestBody.location).toBe('Room 3');
    expect(insertArgs.requestBody.attendees).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);

    expect(prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prisma.calendarEvent.upsert.mock.calls[0][0];
    expect(upsertArgs.where.tenantId_provider_externalId).toEqual({
      tenantId: 1,
      provider: 'google',
      externalId: 'gcal-new-id',
    });
    expect(upsertArgs.create.meetingUrl).toBe('https://meet.google.com/xyz');
  });
});

// ─── DELETE /disconnect ───────────────────────────────────────────

describe('DELETE /api/calendar/google/disconnect', () => {
  test('happy path — deletes integration row and returns { success: true }', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/google/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.calendarIntegration.delete).toHaveBeenCalledTimes(1);
    const args = prisma.calendarIntegration.delete.mock.calls[0][0];
    expect(args.where.userId_provider).toEqual({
      userId: 7,
      provider: 'google',
    });
  });

  test('idempotent — P2025 (row-not-found) is swallowed and still returns success', async () => {
    const err = new Error('Record to delete does not exist');
    /** @type {any} */ (err).code = 'P2025';
    prisma.calendarIntegration.delete.mockRejectedValueOnce(err);
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/google/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('non-P2025 prisma error → 500 envelope', async () => {
    prisma.calendarIntegration.delete.mockRejectedValueOnce(
      new Error('db connection lost')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/google/disconnect');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disconnect/i);
    consoleSpy.mockRestore();
  });
});
