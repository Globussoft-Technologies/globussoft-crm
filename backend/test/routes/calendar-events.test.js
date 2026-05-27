// @ts-check
/**
 * Unit tests for backend/routes/calendar_events.js — pins the tiny 12-LOC
 * router that mounts the calendar-event update + delete handlers behind
 * verifyToken.
 *
 * Why this file exists
 * ────────────────────
 * routes/calendar_events.js is a 12-line router: it does nothing but mount
 * two controller methods (updateCalendarEvent, deleteCalendarEvent from
 * controllers/calendarEventController.js) behind verifyToken on PUT /:id
 * and DELETE /:id. The controller is independently covered in
 * test/controllers/calendarEventController.test.js. What is NOT covered
 * elsewhere is:
 *
 *   - the verifyToken gate is actually in front of BOTH endpoints
 *   - the controller methods are wired to the correct HTTP verbs
 *   - the :id path param is forwarded through to the controller
 *
 * Those are exactly the surface this file pins. The handlers themselves
 * are stubbed to bare vi.fn() responders so we measure the routing wire
 * and not the controller logic (already covered).
 *
 * Pattern
 * ───────
 *   - Replace the controller exports with vi.fn() responders BEFORE the
 *     router is required. The router's `require('../controllers/...')`
 *     is destructured at module-load time, so we monkey-patch the
 *     controller module on the require-cache singleton, drop the route
 *     from cache, then re-require the router so it picks up the stubbed
 *     handlers.
 *
 *   - Mint a real HS256 JWT with the dev-fallback secret resolved by
 *     backend/config/secrets.js (same secret the SUT's verifyToken uses
 *     when JWT_SECRET is unset, which is the case under this vitest run).
 *
 *   - Defensive #937 eventBus mock: replace emitEvent on the eventBus
 *     singleton BEFORE the router require so any future change that
 *     emits a workflow/audit event from the routing layer doesn't
 *     accidentally fire a real workflow tick during the test.
 *
 *   - The auth middleware optionally consults prisma.revokedToken for
 *     tokens that carry a `jti` claim. We don't set `jti`, so that
 *     branch is never reached — no prisma mock needed in this file.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Defensive #937 eventBus mock ─────────────────────────────────
// Patch eventBus.emitEvent BEFORE the router is required, so any future
// emit on this route's surface (auditing, workflow trigger) is a no-op.
const eb = requireCJS('../../lib/eventBus');
eb.emitEvent = vi.fn().mockResolvedValue(undefined);

// ─── Controller stub — patch BEFORE router require ────────────────
// The router does
//   const { updateCalendarEvent, deleteCalendarEvent } = require(...controller);
// at module-load. We replace the exports on the controller's require-
// cache singleton, then drop and re-require the route so its destructure
// picks up our vi.fn() responders.
const controllerModule = requireCJS('../../controllers/calendarEventController');

const updateStub = vi.fn((req, res) =>
  res.status(200).json({ ok: true, op: 'update', id: req.params.id, userId: req.user.userId })
);
const deleteStub = vi.fn((req, res) =>
  res.status(200).json({ ok: true, op: 'delete', id: req.params.id, userId: req.user.userId })
);

controllerModule.updateCalendarEvent = updateStub;
controllerModule.deleteCalendarEvent = deleteStub;

// Drop the route from cache so its destructuring picks up the stubs.
const routePath = requireCJS.resolve('../../routes/calendar_events');
delete requireCJS.cache[routePath];
const calendarEventsRouter = requireCJS('../../routes/calendar_events');

// ─── JWT minting ─────────────────────────────────────────────────────
// secrets.js resolves to the dev fallback when JWT_SECRET is unset, which
// is the case under vitest. Sign with the same fallback so verifyToken
// accepts the token.
const { JWT_SECRET } = requireCJS('../../config/secrets');

function mintToken({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar/events', calendarEventsRouter);
  return app;
}

beforeEach(() => {
  updateStub.mockClear();
  deleteStub.mockClear();
  eb.emitEvent.mockClear();
});

// ─── Router smoke ─────────────────────────────────────────────────────

describe('routes/calendar_events — router exports', () => {
  test('exports an express Router instance', () => {
    // express.Router() returns a function with the standard router signature.
    expect(typeof calendarEventsRouter).toBe('function');
    expect(typeof calendarEventsRouter.use).toBe('function');
    expect(typeof calendarEventsRouter.stack).not.toBe('undefined');
  });

  test('mounts without throwing on a fresh app', () => {
    expect(() => makeApp()).not.toThrow();
  });
});

// ─── Auth gate ────────────────────────────────────────────────────────

describe('PUT/DELETE /:id — verifyToken gate', () => {
  test('PUT /:id without Authorization header → 401 + WWW-Authenticate: Bearer', async () => {
    const app = makeApp();
    const res = await request(app).put('/api/calendar/events/42').send({ title: 'x' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body.error).toMatch(/authentication required/i);
    expect(updateStub).not.toHaveBeenCalled();
  });

  test('DELETE /:id without Authorization header → 401 + WWW-Authenticate: Bearer', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/calendar/events/42');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body.error).toMatch(/authentication required/i);
    expect(deleteStub).not.toHaveBeenCalled();
  });

  test('PUT /:id with garbage Bearer token → 401 (invalid signature)', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/calendar/events/42')
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .send({ title: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
    expect(updateStub).not.toHaveBeenCalled();
  });
});

// ─── Wiring: verb + path param forwarded to controller ───────────────

describe('PUT/DELETE /:id — controller wiring', () => {
  test('PUT /:id with valid JWT forwards :id to updateCalendarEvent', async () => {
    const app = makeApp();
    const token = mintToken({ userId: 7, tenantId: 1 });
    const res = await request(app)
      .put('/api/calendar/events/42')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'new title' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, op: 'update', id: '42', userId: 7 });
    expect(updateStub).toHaveBeenCalledTimes(1);
    expect(deleteStub).not.toHaveBeenCalled();
    // Verify req.user was populated by verifyToken upstream.
    const reqArg = updateStub.mock.calls[0][0];
    expect(reqArg.user.userId).toBe(7);
    expect(reqArg.user.tenantId).toBe(1);
    expect(reqArg.params.id).toBe('42');
  });

  test('DELETE /:id with valid JWT forwards :id to deleteCalendarEvent', async () => {
    const app = makeApp();
    const token = mintToken({ userId: 9, tenantId: 2 });
    const res = await request(app)
      .delete('/api/calendar/events/99')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, op: 'delete', id: '99', userId: 9 });
    expect(deleteStub).toHaveBeenCalledTimes(1);
    expect(updateStub).not.toHaveBeenCalled();
    // Verify req.user was populated by verifyToken upstream.
    const reqArg = deleteStub.mock.calls[0][0];
    expect(reqArg.user.userId).toBe(9);
    expect(reqArg.user.tenantId).toBe(2);
    expect(reqArg.params.id).toBe('99');
  });

  test('GET /:id 404s — only PUT + DELETE are mounted', async () => {
    const app = makeApp();
    const token = mintToken();
    const res = await request(app)
      .get('/api/calendar/events/42')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(updateStub).not.toHaveBeenCalled();
    expect(deleteStub).not.toHaveBeenCalled();
  });

  test('POST /:id 404s — only PUT + DELETE are mounted', async () => {
    const app = makeApp();
    const token = mintToken();
    const res = await request(app)
      .post('/api/calendar/events/42')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(updateStub).not.toHaveBeenCalled();
    expect(deleteStub).not.toHaveBeenCalled();
  });
});
