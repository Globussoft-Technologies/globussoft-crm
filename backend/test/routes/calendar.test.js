// @ts-check
/**
 * Route-level tests for backend/routes/calendar.js — the 46-LOC read-only
 * calendar surface mounted at /api/calendar.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /api/calendar/events        — per-user + per-tenant scoping;
 *                                        orderBy startTime asc; default take=50;
 *                                        ?limit= override; parseInt(NaN)||50
 *                                        fallback for non-numeric limit.
 *   2. GET /api/calendar/integrations  — per-user scoping ONLY (NO tenantId
 *                                        in the where clause — see "BUG-WATCH"
 *                                        below); enforced `select` projection
 *                                        of { id, provider, syncEnabled,
 *                                        lastSyncAt, calendarId }.
 *   3. GET /api/calendar/upcoming      — per-user + per-tenant scoping;
 *                                        startTime gte now (±2s tolerance);
 *                                        orderBy startTime asc; take=10.
 *   4. All three endpoints behind verifyToken — missing Authorization → 401.
 *   5. All three endpoints catch prisma errors → 500 with their respective
 *      `{ error: '...' }` envelope strings (fetch calendar events / fetch
 *      calendar integrations / fetch upcoming events).
 *
 * Why this file is distinct from the sibling calendar tests
 * ─────────────────────────────────────────────────────────
 * backend/routes/calendar.js (this file's target) is the basic read surface:
 * /events, /integrations, /upcoming. The sibling test files cover DIFFERENT
 * route files:
 *   - backend/test/routes/calendar-events.test.js  covers calendar_events.js
 *     (PUT/DELETE /:id, mounted at /api/calendar-events)
 *   - backend/test/routes/calendar-google.test.js  covers calendar_google.js
 *     (OAuth + Google-specific flows, mounted at /api/calendar/google)
 *   - backend/test/routes/calendar-outlook.test.js covers calendar_outlook.js
 *     (OAuth + Outlook-specific flows, mounted at /api/calendar/outlook)
 *
 * Before this file there was NO route-level test for calendar.js itself.
 *
 * BUG-WATCH — GET /integrations missing tenantId (issue #975)
 * ────────────────────────────────────────────────────────────
 * The /integrations handler scopes findMany by `{ userId }` only, while the
 * other two handlers also scope by `tenantId`. With the current schema
 * (User.tenantId is an Int FK and a user belongs to exactly one tenant at a
 * time) the userId filter is functionally sufficient: a row's userId
 * implies its tenant. This is a defense-in-depth gap rather than a live
 * cross-tenant data-leak — filed as issue #975 so a future UserTenant join
 * table doesn't silently regress to a real leak. The current behaviour is
 * pinned by the `tenantId NOT in where` assertion so any tighter scoping
 * shows up as a green-→-red signal at the same time the gap is closed.
 *
 * Pattern
 * ───────
 * Mirrors backend/test/routes/audit-chain.test.js — prisma-singleton-patch
 * BEFORE requiring the router, bare-express mount, supertest, real HS256
 * JWTs signed against config/secrets.js's dev-fallback secret. We do NOT
 * mock middleware/auth — the actual verifyToken runs unmodified so the 401
 * path is real.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router — calendar.js
// destructures `prisma.calendarEvent` / `prisma.calendarIntegration` at
// call-time, so as long as the singleton has both properties set with
// vi.fn() findMany methods before each request, the route sees the mocks.
prisma.calendarEvent = {
  findMany: vi.fn(),
};
prisma.calendarIntegration = {
  findMany: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const calendarRouter = requireCJS('../../routes/calendar');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  return app;
}

function tokenFor({ userId = 42, tenantId = 1, role = 'USER' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `user${userId}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // verifyToken consults prisma.revokedToken when a token carries `jti`.
  // Our test tokens do NOT set jti, so this branch is never hit — but a
  // stale singleton from a sibling test could throw here. Stub defensively.
  prisma.revokedToken = prisma.revokedToken || {};
  prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
});

beforeEach(() => {
  prisma.calendarEvent.findMany.mockReset();
  prisma.calendarEvent.findMany.mockResolvedValue([]);
  prisma.calendarIntegration.findMany.mockReset();
  prisma.calendarIntegration.findMany.mockResolvedValue([]);
});

describe('GET /api/calendar/events', () => {
  test('authed → 200 + array; where scoped to { userId, tenantId }', async () => {
    const rows = [
      { id: 1, userId: 42, tenantId: 7, title: 'Demo', startTime: new Date('2026-06-01T10:00:00Z') },
    ];
    prisma.calendarEvent.findMany.mockResolvedValueOnce(rows);

    const res = await request(makeApp())
      .get('/api/calendar/events')
      .set('Authorization', `Bearer ${tokenFor({ userId: 42, tenantId: 7 })}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 42, tenantId: 7 });
  });

  test('default take=50 when no ?limit= query param supplied', async () => {
    await request(makeApp())
      .get('/api/calendar/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  test('?limit=10 → take=10 (parseInt respected)', async () => {
    await request(makeApp())
      .get('/api/calendar/events?limit=10')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  test('orderBy { startTime: asc }', async () => {
    await request(makeApp())
      .get('/api/calendar/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ startTime: 'asc' });
  });

  test('?limit=abc (non-numeric) → falls back to take=50 (NaN || 50)', async () => {
    // parseInt('abc') === NaN, `NaN || 50` === 50.
    await request(makeApp())
      .get('/api/calendar/events?limit=abc')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  test('missing Authorization → 401', async () => {
    const res = await request(makeApp()).get('/api/calendar/events');
    expect(res.status).toBe(401);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  test('prisma rejects → 500 with { error: "Failed to fetch calendar events" }', async () => {
    prisma.calendarEvent.findMany.mockRejectedValueOnce(new Error('boom'));

    const res = await request(makeApp())
      .get('/api/calendar/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch calendar events' });
  });
});

describe('GET /api/calendar/integrations', () => {
  test('authed → 200 + array; where scoped to { userId } ONLY (no tenantId)', async () => {
    // Pins the CURRENT shape — tenantId is NOT in the where clause. See the
    // file header's "BUG-WATCH" section. With today's User.tenantId-as-Int
    // schema the userId filter is functionally sufficient (a user belongs
    // to exactly one tenant), so this is a defense-in-depth gap rather
    // than a live data-leak. Tracker issue filed; see the skipped test
    // below for the tightened-shape assertion that goes green once the
    // source closes the gap.
    const rows = [
      { id: 1, provider: 'google', syncEnabled: true, lastSyncAt: null, calendarId: 'primary' },
    ];
    prisma.calendarIntegration.findMany.mockResolvedValueOnce(rows);

    const res = await request(makeApp())
      .get('/api/calendar/integrations')
      .set('Authorization', `Bearer ${tokenFor({ userId: 42, tenantId: 7 })}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const call = prisma.calendarIntegration.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 42 });
    // Explicit pin: tenantId is NOT in the current where clause.
    expect(call.where.tenantId).toBeUndefined();
  });

  test('select projection enforced: { id, provider, syncEnabled, lastSyncAt, calendarId }', async () => {
    await request(makeApp())
      .get('/api/calendar/integrations')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarIntegration.findMany.mock.calls[0][0];
    expect(call.select).toEqual({
      id: true,
      provider: true,
      syncEnabled: true,
      lastSyncAt: true,
      calendarId: true,
    });
  });

  // TODO(#975): When /integrations grows a tenantId filter alongside
  // userId (defense in depth — guards against a future UserTenant join
  // table making the userId-implies-tenantId invariant false), un-skip
  // this test. It will go from .skip to green at the same commit that
  // adds the tenantId filter to routes/calendar.js:23. At that point also
  // tighten the current-shape test above's `expect(call.where).toEqual({
  // userId: 42 })` to `{ userId: 42, tenantId: 7 }`.
  test.skip('FUTURE: where should scope by both { userId, tenantId } (defense in depth)', async () => {
    await request(makeApp())
      .get('/api/calendar/integrations')
      .set('Authorization', `Bearer ${tokenFor({ userId: 42, tenantId: 7 })}`);

    const call = prisma.calendarIntegration.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 42, tenantId: 7 });
  });

  test('missing Authorization → 401', async () => {
    const res = await request(makeApp()).get('/api/calendar/integrations');
    expect(res.status).toBe(401);
    expect(prisma.calendarIntegration.findMany).not.toHaveBeenCalled();
  });

  test('prisma rejects → 500 with { error: "Failed to fetch calendar integrations" }', async () => {
    prisma.calendarIntegration.findMany.mockRejectedValueOnce(new Error('boom'));

    const res = await request(makeApp())
      .get('/api/calendar/integrations')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch calendar integrations' });
  });
});

describe('GET /api/calendar/upcoming', () => {
  test('authed → 200 + array; where { userId, tenantId, startTime: { gte: <now ±2s> } }', async () => {
    const rows = [
      { id: 1, userId: 42, tenantId: 7, title: 'Future', startTime: new Date(Date.now() + 60_000) },
    ];
    prisma.calendarEvent.findMany.mockResolvedValueOnce(rows);

    const before = Date.now();
    const res = await request(makeApp())
      .get('/api/calendar/upcoming')
      .set('Authorization', `Bearer ${tokenFor({ userId: 42, tenantId: 7 })}`);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.where.userId).toBe(42);
    expect(call.where.tenantId).toBe(7);
    expect(call.where.startTime).toBeDefined();
    expect(call.where.startTime.gte).toBeInstanceOf(Date);

    // The handler captures `new Date()` at request time. Assert it sits
    // within [before-2s, after+2s] — generous tolerance absorbs CI clock
    // skew and supertest serialization overhead.
    const gteMs = call.where.startTime.gte.getTime();
    expect(gteMs).toBeGreaterThanOrEqual(before - 2000);
    expect(gteMs).toBeLessThanOrEqual(after + 2000);
  });

  test('take=10 enforced (hardcoded cap, no ?limit override)', async () => {
    await request(makeApp())
      .get('/api/calendar/upcoming?limit=999')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  test('orderBy { startTime: asc }', async () => {
    await request(makeApp())
      .get('/api/calendar/upcoming')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const call = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ startTime: 'asc' });
  });

  test('missing Authorization → 401', async () => {
    const res = await request(makeApp()).get('/api/calendar/upcoming');
    expect(res.status).toBe(401);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  test('prisma rejects → 500 with { error: "Failed to fetch upcoming events" }', async () => {
    prisma.calendarEvent.findMany.mockRejectedValueOnce(new Error('boom'));

    const res = await request(makeApp())
      .get('/api/calendar/upcoming')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch upcoming events' });
  });
});
