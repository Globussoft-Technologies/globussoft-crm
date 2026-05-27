// @ts-check
/**
 * Unit tests for backend/controllers/calendarEventController.js — pins the
 * shape of the two exported handlers (`updateCalendarEvent` +
 * `deleteCalendarEvent`).
 *
 * Why this file exists
 * ────────────────────
 * Per c8 coverage the controller is the top-1 under-covered file in the
 * codebase at 7.05% lines — completely untested. The handlers wrap external
 * calendar sync (Google + Microsoft Graph) around a Prisma update / delete of
 * the local `CalendarEvent` mirror row; both have non-trivial validation,
 * tenant-isolation, and external-provider fan-out that need pinning so
 * subsequent refactors (date-validation tweaks, provider additions,
 * attendees-shape changes) surface as test failures rather than silent
 * production regressions.
 *
 * Contract pinned by this file
 * ────────────────────────────
 * updateCalendarEvent (PUT /:id):
 *   1. Missing `id` path param → 400 `{ error: "Event ID is required" }`.
 *   2. Bad date format (`startTime` or `endTime` unparseable) → 400.
 *   3. `endTime <= startTime` → 400.
 *   4. `startTime` in the past → 400.
 *   5. Event not found in DB → 404.
 *   6. Event found but `userId` or `tenantId` mismatches req.user → 403
 *      (tenant isolation).
 *   7. Provider `google` happy path: oauth client built via cached
 *      CalendarIntegration, calendar.events.update called with the merged
 *      summary/description/location, then local DB row updated and returned.
 *   8. Provider `microsoft` happy path: integration fetched + token-refresh
 *      short-circuits when expiresAt is in the future, Graph PATCH fired
 *      with UTC start/end + attendees normalised to `emailAddress` shape,
 *      local DB row updated and returned.
 *   9. Provider `microsoft` with no integration row → 404.
 *  10. Provider `microsoft` when Graph PATCH returns non-2xx → 502.
 *  11. Provider `null` / non-cloud (purely-local event) → no external call,
 *      DB update still happens.
 *
 * deleteCalendarEvent (DELETE /:id):
 *  12. Missing `id` → 400.
 *  13. Event not found → 404.
 *  14. Cross-user / cross-tenant → 403.
 *  15. Provider `google` happy path: external delete attempted; if it
 *      throws the DB row is STILL deleted (best-effort external cleanup).
 *  16. Provider `microsoft` happy path: Graph DELETE fired then DB row
 *      removed; non-2xx upstream does NOT prevent DB delete.
 *  17. Provider `null` → DB-only delete, no external call.
 *
 * Pattern
 * ───────
 * Mirrors test/routes/calendar-google.test.js + test/routes/calendar-outlook.test.js
 * because the SUT shares the same external-provider surfaces:
 *
 *   - googleapis is a singleton in node's require cache. Vitest's inline list
 *     does NOT cover backend/controllers/, so vi.mock('googleapis') would not
 *     intercept the SUT's CJS require. Instead we replace
 *     `googleapis.google.calendar` with a fake constructor BEFORE requiring
 *     the SUT — the SUT then picks up the patched function.
 *
 *   - Prisma singleton patching: mutate prisma.calendarEvent +
 *     prisma.calendarIntegration onto bare vi.fn() surfaces. This bypasses
 *     vi.mock entirely (which can't see the SUT's require) and works because
 *     prisma is itself a require-cache singleton.
 *
 *   - Global fetch stub: SUT uses Node 18's global `fetch` for Microsoft
 *     Graph + token refresh. Replace global.fetch with vi.fn() per test;
 *     restore in afterAll so the rest of the suite isn't affected.
 *
 *   - The handlers accept (req, res) directly so we invoke them with fake
 *     req / res objects instead of mounting through supertest — fewer
 *     moving parts, same coverage.
 *
 * What this file does NOT cover (intentional):
 *   - No real Google or Graph HTTP — every external call is stubbed.
 *   - Token-refresh branch (`refreshOutlookTokenIfNeeded` with expired
 *     expiresAt) is exercised indirectly via the future-dated default;
 *     dedicated refresh-flow tests live in calendar-outlook.test.js.
 *   - The helper functions (`buildGoogleOAuthClient`,
 *     `getAuthorizedGoogleClient`, `refreshOutlookTokenIfNeeded`) aren't
 *     exported so we exercise them through the public handlers.
 */

import { describe, test, beforeEach, afterAll, vi, expect } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── googleapis live patching ───────────────────────────────────────
// The SUT lazily calls `google.calendar({ version: 'v3', auth: client })`
// and uses `.events.update` / `.events.delete`. We replace the calendar
// factory with one that returns our stub per call.
const googleapis = requireCJS('googleapis');

const oauth2State = {
  setCredentials: vi.fn(),
  on: vi.fn(),
};
const calendarState = {
  events: {
    update: vi.fn(),
    delete: vi.fn(),
  },
};

const origOAuth2 = googleapis.google.auth.OAuth2;
const origCalendar = googleapis.google.calendar;

googleapis.google.auth.OAuth2 = function FakeOAuth2() {
  return {
    setCredentials: (...args) => oauth2State.setCredentials(...args),
    on: (...args) => oauth2State.on(...args),
  };
};

googleapis.google.calendar = function fakeCalendar() {
  return {
    events: {
      update: (...args) => calendarState.events.update(...args),
      delete: (...args) => calendarState.events.delete(...args),
    },
  };
};

// ─── Prisma singleton patching ──────────────────────────────────────
prisma.calendarEvent = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.calendarIntegration = {
  findUnique: vi.fn(),
  update: vi.fn(),
};

// Pin env vars so the controller's google OAuth construction has something
// to feed into the OAuth2 constructor (the values themselves don't matter
// because the constructor is faked above; but reading process.env.X when
// undefined is fine — only listed here so a future code-path that gates
// on env presence still works the same way locally + in CI).
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/google/callback';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'test-ms-client-id';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 'test-ms-client-secret';
process.env.MS_REDIRECT_URI =
  process.env.MS_REDIRECT_URI || 'http://localhost:5000/api/calendar/outlook/callback';

const controller = requireCJS('../../controllers/calendarEventController');

const prevFetch = global.fetch;

/**
 * Builds a mock express `req` with the shape the handlers consume.
 */
function makeReq({
  params = {},
  body = {},
  user = { userId: 7, tenantId: 1 },
} = {}) {
  return { params, body, user };
}

/**
 * Builds a mock express `res` that captures status() + json() calls.
 * Both are chainable (Express's real Response API).
 */
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/**
 * Minimal fetch-Response-like shape consumed by the SUT.
 */
function mockFetchResponse({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// Use a deterministic future date for all happy-path scenarios so the
// "past start time" validation never trips in tests that don't intend
// to probe it. Year 2099 is well beyond the controller's lifetime.
const FUTURE_START_ISO = '2099-06-01T10:00:00.000Z';
const FUTURE_END_ISO = '2099-06-01T11:00:00.000Z';

beforeEach(() => {
  oauth2State.setCredentials.mockReset();
  oauth2State.on.mockReset();
  calendarState.events.update.mockReset();
  calendarState.events.delete.mockReset();

  prisma.calendarEvent.findUnique.mockReset();
  prisma.calendarEvent.update.mockReset();
  prisma.calendarEvent.delete.mockReset();
  prisma.calendarIntegration.findUnique.mockReset();
  prisma.calendarIntegration.update.mockReset();

  // Sensible defaults: integration exists, externals succeed.
  prisma.calendarIntegration.findUnique.mockResolvedValue({
    id: 1,
    userId: 7,
    provider: 'google',
    tenantId: 1,
    accessToken: 'at-stub',
    refreshToken: 'rt-stub',
    expiresAt: new Date('2099-12-31T00:00:00Z'),
    calendarId: 'primary',
  });
  calendarState.events.update.mockResolvedValue({ data: { id: 'ext-evt-1' } });
  calendarState.events.delete.mockResolvedValue({});

  global.fetch = vi.fn();
});

afterAll(() => {
  global.fetch = prevFetch;
  googleapis.google.auth.OAuth2 = origOAuth2;
  googleapis.google.calendar = origCalendar;
});

// ─── updateCalendarEvent — validation gates ─────────────────────────

describe('updateCalendarEvent — validation', () => {
  test('400 when path param `id` is missing', async () => {
    const req = makeReq({ params: {} });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Event ID is required' });
    expect(prisma.calendarEvent.findUnique).not.toHaveBeenCalled();
  });

  test('400 when startTime is an unparseable date string', async () => {
    const req = makeReq({
      params: { id: '42' },
      body: { startTime: 'not-a-date', endTime: FUTURE_END_ISO },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid startTime or endTime format/i);
    expect(prisma.calendarEvent.findUnique).not.toHaveBeenCalled();
  });

  test('400 when endTime <= startTime', async () => {
    const req = makeReq({
      params: { id: '42' },
      body: {
        startTime: '2099-06-01T11:00:00.000Z',
        endTime: '2099-06-01T10:00:00.000Z', // before start
      },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/End time must be after start time/i);
  });

  test('400 when startTime is in the past', async () => {
    const req = makeReq({
      params: { id: '42' },
      body: {
        startTime: '2000-01-01T10:00:00.000Z',
        endTime: '2000-01-01T11:00:00.000Z',
      },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/past/i);
  });
});

// ─── updateCalendarEvent — auth / not-found gates ───────────────────

describe('updateCalendarEvent — lookup + authorization', () => {
  test('404 when the event does not exist in the database', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce(null);
    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Event not found/i);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  test('403 when event belongs to a different user (tenant isolation, same tenant)', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 999, // not the requester's userId
      tenantId: 1,
      provider: null,
      title: 'Other user event',
      externalId: null,
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
      user: { userId: 7, tenantId: 1 },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Unauthorized/i);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  test('403 when event belongs to a different tenant (cross-tenant)', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 99, // different tenant
      provider: null,
      title: 'Cross-tenant event',
      externalId: null,
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
      user: { userId: 7, tenantId: 1 },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Unauthorized/i);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });
});

// ─── updateCalendarEvent — provider happy paths ─────────────────────

describe('updateCalendarEvent — provider fan-out', () => {
  test('local-only event (provider=null) skips external sync, updates DB row', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: null,
      externalId: null,
      title: 'Local event',
      description: 'orig',
      location: 'orig loc',
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    prisma.calendarEvent.update.mockResolvedValueOnce({
      id: 42,
      title: 'Renamed',
    });

    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 42, title: 'Renamed' });
    // No google / fetch calls when provider is null.
    expect(calendarState.events.update).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // DB update was called with the new title only.
    expect(prisma.calendarEvent.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.calendarEvent.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 42 });
    expect(updateArgs.data.title).toBe('Renamed');
  });

  test('Google-provider event syncs through calendar.events.update + updates DB row', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'google',
      externalId: 'ext-google-1',
      title: 'Orig',
      description: 'Orig desc',
      location: 'Orig loc',
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    prisma.calendarEvent.update.mockResolvedValueOnce({ id: 42, title: 'Renamed' });

    const req = makeReq({
      params: { id: '42' },
      body: {
        title: 'Renamed',
        attendees: ['a@example.com', { email: 'b@example.com', name: 'B' }],
      },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);

    expect(res.statusCode).toBe(200);
    expect(calendarState.events.update).toHaveBeenCalledTimes(1);
    const gcalArgs = calendarState.events.update.mock.calls[0][0];
    expect(gcalArgs.calendarId).toBe('primary');
    expect(gcalArgs.eventId).toBe('ext-google-1');
    expect(gcalArgs.requestBody.summary).toBe('Renamed');
    // Attendees normalised: strings → { email }; object preserved.
    expect(gcalArgs.requestBody.attendees).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com', name: 'B' },
    ]);
    expect(prisma.calendarEvent.update).toHaveBeenCalledTimes(1);
  });

  test('Microsoft-provider event PATCHes Graph + updates DB row with UTC timeZone', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ext-ms-1',
      title: 'Orig',
      description: 'Orig desc',
      location: 'Orig loc',
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    prisma.calendarIntegration.findUnique.mockResolvedValueOnce({
      id: 9,
      userId: 7,
      provider: 'microsoft',
      tenantId: 1,
      accessToken: 'ms-at',
      refreshToken: 'ms-rt',
      expiresAt: new Date('2099-12-31T00:00:00Z'),
    });
    global.fetch.mockResolvedValueOnce(mockFetchResponse({ ok: true, body: {} }));
    prisma.calendarEvent.update.mockResolvedValueOnce({ id: 42, title: 'Renamed' });

    const req = makeReq({
      params: { id: '42' },
      body: {
        title: 'Renamed',
        startTime: '2099-07-01T14:00:00.000Z',
        endTime: '2099-07-01T15:00:00.000Z',
        attendees: ['c@example.com', { email: 'd@example.com', name: 'D' }],
      },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [graphUrl, graphInit] = global.fetch.mock.calls[0];
    expect(graphUrl).toBe(
      'https://graph.microsoft.com/v1.0/me/calendar/events/ext-ms-1'
    );
    expect(graphInit.method).toBe('PATCH');
    expect(graphInit.headers.Authorization).toBe('Bearer ms-at');
    const graphBody = JSON.parse(graphInit.body);
    expect(graphBody.subject).toBe('Renamed');
    expect(graphBody.start.timeZone).toBe('UTC');
    expect(graphBody.end.timeZone).toBe('UTC');
    // Attendees normalised to Graph's emailAddress shape.
    expect(graphBody.attendees).toEqual([
      {
        emailAddress: { address: 'c@example.com', name: 'c@example.com' },
        type: 'required',
      },
      {
        emailAddress: { address: 'd@example.com', name: 'D' },
        type: 'required',
      },
    ]);
  });

  test('Microsoft-provider event 404s when integration row is missing', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ext-ms-1',
      title: 'Orig',
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    prisma.calendarIntegration.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Outlook calendar not connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });

  test('Microsoft-provider 502s when Graph PATCH returns non-2xx', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ext-ms-1',
      title: 'Orig',
      startTime: new Date(FUTURE_START_ISO),
      endTime: new Date(FUTURE_END_ISO),
    });
    prisma.calendarIntegration.findUnique.mockResolvedValueOnce({
      id: 9,
      userId: 7,
      provider: 'microsoft',
      tenantId: 1,
      accessToken: 'ms-at',
      refreshToken: 'ms-rt',
      expiresAt: new Date('2099-12-31T00:00:00Z'),
    });
    global.fetch.mockResolvedValueOnce(
      mockFetchResponse({ ok: false, status: 500, body: 'Graph exploded' })
    );

    const req = makeReq({
      params: { id: '42' },
      body: { title: 'Renamed' },
    });
    const res = makeRes();
    await controller.updateCalendarEvent(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/Graph update failed/i);
    expect(prisma.calendarEvent.update).not.toHaveBeenCalled();
  });
});

// ─── deleteCalendarEvent ────────────────────────────────────────────

describe('deleteCalendarEvent', () => {
  test('400 when path param `id` is missing', async () => {
    const req = makeReq({ params: {} });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Event ID is required' });
    expect(prisma.calendarEvent.delete).not.toHaveBeenCalled();
  });

  test('404 when event does not exist', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce(null);
    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Event not found/i);
    expect(prisma.calendarEvent.delete).not.toHaveBeenCalled();
  });

  test('403 when event belongs to a different tenant', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 99, // different tenant
      provider: null,
      externalId: null,
    });
    const req = makeReq({
      params: { id: '42' },
      user: { userId: 7, tenantId: 1 },
    });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Unauthorized/i);
    expect(prisma.calendarEvent.delete).not.toHaveBeenCalled();
  });

  test('local-only event (provider=null) deletes DB row without external calls', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: null,
      externalId: null,
    });
    prisma.calendarEvent.delete.mockResolvedValueOnce({ id: 42 });
    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Event deleted successfully' });
    expect(calendarState.events.delete).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  test('Google-provider event deletes external + DB row in lockstep', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'google',
      externalId: 'ext-google-1',
    });
    prisma.calendarEvent.delete.mockResolvedValueOnce({ id: 42 });
    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    expect(res.statusCode).toBe(200);
    expect(calendarState.events.delete).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ext-google-1',
    });
    expect(prisma.calendarEvent.delete).toHaveBeenCalledTimes(1);
  });

  test('Google-provider event STILL deletes DB row when external delete throws (best-effort)', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'google',
      externalId: 'ext-google-1',
    });
    calendarState.events.delete.mockRejectedValueOnce(new Error('Google 404'));
    prisma.calendarEvent.delete.mockResolvedValueOnce({ id: 42 });
    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);
    // DB delete still succeeded → 200 envelope, external failure swallowed.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Event deleted successfully' });
    expect(prisma.calendarEvent.delete).toHaveBeenCalledTimes(1);
  });

  test('Microsoft-provider event hits Graph DELETE then removes DB row', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ext-ms-1',
    });
    prisma.calendarIntegration.findUnique.mockResolvedValueOnce({
      id: 9,
      userId: 7,
      provider: 'microsoft',
      tenantId: 1,
      accessToken: 'ms-at',
      refreshToken: 'ms-rt',
      expiresAt: new Date('2099-12-31T00:00:00Z'),
    });
    global.fetch.mockResolvedValueOnce(mockFetchResponse({ ok: true }));
    prisma.calendarEvent.delete.mockResolvedValueOnce({ id: 42 });

    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [graphUrl, graphInit] = global.fetch.mock.calls[0];
    expect(graphUrl).toBe(
      'https://graph.microsoft.com/v1.0/me/calendar/events/ext-ms-1'
    );
    expect(graphInit.method).toBe('DELETE');
    expect(graphInit.headers.Authorization).toBe('Bearer ms-at');
    expect(prisma.calendarEvent.delete).toHaveBeenCalledTimes(1);
  });

  test('Microsoft-provider event STILL deletes DB row when Graph returns non-2xx (best-effort)', async () => {
    prisma.calendarEvent.findUnique.mockResolvedValueOnce({
      id: 42,
      userId: 7,
      tenantId: 1,
      provider: 'microsoft',
      externalId: 'ext-ms-1',
    });
    prisma.calendarIntegration.findUnique.mockResolvedValueOnce({
      id: 9,
      userId: 7,
      provider: 'microsoft',
      tenantId: 1,
      accessToken: 'ms-at',
      refreshToken: 'ms-rt',
      expiresAt: new Date('2099-12-31T00:00:00Z'),
    });
    global.fetch.mockResolvedValueOnce(
      mockFetchResponse({ ok: false, status: 500, body: 'Graph exploded' })
    );
    prisma.calendarEvent.delete.mockResolvedValueOnce({ id: 42 });

    const req = makeReq({ params: { id: '42' } });
    const res = makeRes();
    await controller.deleteCalendarEvent(req, res);

    // DB delete still succeeded; Graph failure logged-not-raised.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Event deleted successfully' });
    expect(prisma.calendarEvent.delete).toHaveBeenCalledTimes(1);
  });
});
