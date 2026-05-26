// @ts-check
/**
 * Unit tests for backend/routes/canned_responses.js — pins the contract
 * for the support-team canned-response CRUD endpoints.
 *
 * Route surface pinned
 * ────────────────────
 *   - GET    /api/canned-responses               list per-tenant (optional ?category= filter)
 *   - POST   /api/canned-responses               create (400 when name/content missing)
 *   - PUT    /api/canned-responses/:id           update (404 cross-tenant; 400 invalid id)
 *   - DELETE /api/canned-responses/:id           delete → 204 (#550); 404 cross-tenant; 400 invalid id
 *
 * What this file pins
 * ───────────────────
 *   1. List scopes findMany by req.user.tenantId and applies the
 *      ordering contract ([{category:'asc'},{name:'asc'}]).
 *   2. List with ?category= adds the category clause to the where shape.
 *   3. POST requires both name AND content — 400 otherwise; nothing is
 *      written to Prisma when validation fails.
 *   4. POST coerces fields to String and defaults category to 'General'
 *      when omitted; tenantId is sourced from req.user (NOT body).
 *   5. PUT findFirst is tenant-scoped — cross-tenant id returns 404 and
 *      update is never called.
 *   6. PUT only writes the fields present in the body — undefined keys
 *      stay untouched (partial update contract).
 *   7. PUT/DELETE with a non-numeric :id returns 400 'Invalid id'.
 *   8. DELETE returns 204 No Content on success (per the #550 sweep) and
 *      404 when the row is not in the caller tenant.
 *   9. Tenant default — when req.user is absent the route falls back to
 *      tenantId=1 (the production global auth-guard normally populates
 *      req.user; this pins the in-route fallback).
 *
 * Test pattern
 * ────────────
 *   Prisma singleton-monkey-patch BEFORE requiring the router — same
 *   shape as backend/test/routes/currencies.test.js and consent-templates.test.js.
 *   Adds a defensive #937 eventBus mock even though the SUT doesn't
 *   import eventBus, so a future cross-cutting wiring change (e.g. a
 *   workflow trigger on canned-response create) can't silently break
 *   this suite when its events try to reach the real bus.
 *
 *   Auth model: routes/canned_responses.js is mounted under
 *   server.js's global auth guard (which decodes the JWT and sets
 *   req.user). The router itself has NO verifyToken / verifyRole calls
 *   — it simply reads req.user?.tenantId with a `|| 1` fallback. So the
 *   "auth gate" test here mirrors that behaviour: when no req.user is
 *   set (no global guard), the route defaults to tenantId=1. The 401
 *   path lives at the global-guard layer, not in this router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ─── Prisma singleton monkey-patch — MUST happen before the require ──
prisma.cannedResponse = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// #937 defensive eventBus mock — applied BEFORE the router require so
// any future cross-cutting wiring change that decides to fire an event
// from a canned-response handler can't silently land a real bus emit
// in this suite.
const eb = requireCJS('../../lib/eventBus');
eb.emitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const cannedResponsesRouter = requireCJS('../../routes/canned_responses');

/**
 * Mount the router with an optional user-injecting middleware so the
 * handlers see req.user.tenantId. Pass `{ user: null }` to simulate the
 * unauthenticated case where the global guard hasn't populated req.user
 * — the router's `|| 1` fallback then takes over.
 */
function makeApp({ user = { userId: 7, tenantId: 1, role: 'USER' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/canned-responses', cannedResponsesRouter);
  return app;
}

beforeEach(() => {
  prisma.cannedResponse.findMany.mockReset();
  prisma.cannedResponse.findFirst.mockReset();
  prisma.cannedResponse.create.mockReset();
  prisma.cannedResponse.update.mockReset();
  prisma.cannedResponse.delete.mockReset();
});

// ─── GET /api/canned-responses ───────────────────────────────────────

describe('GET /api/canned-responses', () => {
  test('lists rows scoped to req.user.tenantId, ordered (category asc, name asc)', async () => {
    const rows = [
      { id: 1, tenantId: 7, name: 'Acknowledge', content: 'Got it.', category: 'General' },
      { id: 2, tenantId: 7, name: 'Refund Policy', content: 'Per policy …', category: 'Billing' },
    ];
    prisma.cannedResponse.findMany.mockResolvedValue(rows);

    const res = await request(makeApp({ user: { userId: 1, tenantId: 7, role: 'USER' } })).get(
      '/api/canned-responses',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 7 });
    expect(args.orderBy).toEqual([{ category: 'asc' }, { name: 'asc' }]);
  });

  test('?category= filter narrows the where clause', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/canned-responses?category=Billing');

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 1, category: 'Billing' });
  });

  test('falls back to tenantId=1 when no req.user is present (no global guard)', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp({ user: null })).get('/api/canned-responses');

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 1 });
  });

  test('500 envelope when Prisma throws', async () => {
    prisma.cannedResponse.findMany.mockRejectedValue(new Error('boom'));

    const res = await request(makeApp()).get('/api/canned-responses');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch/i);
  });
});

// ─── GET /api/canned-responses?fields=summary — #920 slice 21 ────────

describe('GET /api/canned-responses?fields=summary', () => {
  test('?fields=summary attaches a slim select dropping content + tenantId + createdAt + updatedAt', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp({ user: { userId: 1, tenantId: 7, role: 'USER' } })).get(
      '/api/canned-responses?fields=summary',
    );

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      category: true,
    });
    // Heavy / metadata columns MUST NOT be in the slim select.
    expect(args.select.content).toBeUndefined();
    expect(args.select.tenantId).toBeUndefined();
    expect(args.select.createdAt).toBeUndefined();
    expect(args.select.updatedAt).toBeUndefined();
  });

  test('no ?fields param → full-row shape (NO select attached, back-compat)', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/canned-responses');

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    // Back-compat: the legacy callers (SLA.jsx fetches /api/canned-responses
    // with no query string) keep getting the full row including content.
    expect(args.select).toBeUndefined();
  });

  test('?fields=full (non-exact match) → full-row shape (only EXACT "summary" opts in)', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/canned-responses?fields=full');

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
  });

  test('?fields=SUMMARY (wrong case) → full-row shape (case-sensitive opt-in)', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/canned-responses?fields=SUMMARY');

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
  });

  test('?fields=summary + ?category= combine — both tenant + category in where AND select attached', async () => {
    prisma.cannedResponse.findMany.mockResolvedValue([]);

    await request(makeApp({ user: { userId: 1, tenantId: 4, role: 'USER' } })).get(
      '/api/canned-responses?fields=summary&category=Billing',
    );

    const args = prisma.cannedResponse.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 4, category: 'Billing' });
    expect(args.orderBy).toEqual([{ category: 'asc' }, { name: 'asc' }]);
    expect(args.select).toEqual({
      id: true,
      name: true,
      category: true,
    });
  });

  test('?fields=summary returns rows verbatim (route does not post-process Prisma output)', async () => {
    const slim = [
      { id: 1, name: 'Acknowledge', category: 'General' },
      { id: 2, name: 'Refund Policy', category: 'Billing' },
    ];
    prisma.cannedResponse.findMany.mockResolvedValue(slim);

    const res = await request(makeApp()).get('/api/canned-responses?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(slim);
    // Confirm the route did not re-attach content / tenantId fields server-side.
    expect(res.body[0]).not.toHaveProperty('content');
    expect(res.body[0]).not.toHaveProperty('tenantId');
  });
});

// ─── POST /api/canned-responses ──────────────────────────────────────

describe('POST /api/canned-responses', () => {
  test('happy path: coerces to String, defaults category=General, scopes tenant from req.user', async () => {
    prisma.cannedResponse.create.mockImplementation(async ({ data }) => ({ id: 42, ...data }));

    const res = await request(makeApp({ user: { userId: 9, tenantId: 5, role: 'USER' } }))
      .post('/api/canned-responses')
      .send({ name: 'Welcome', content: 'Hello and welcome!' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Welcome');
    expect(res.body.content).toBe('Hello and welcome!');
    expect(res.body.category).toBe('General'); // defaulted
    expect(res.body.tenantId).toBe(5); // from req.user, NOT body
    const data = prisma.cannedResponse.create.mock.calls[0][0].data;
    expect(typeof data.name).toBe('string');
    expect(typeof data.content).toBe('string');
  });

  test('respects an explicit category when supplied', async () => {
    prisma.cannedResponse.create.mockImplementation(async ({ data }) => ({ id: 43, ...data }));

    const res = await request(makeApp())
      .post('/api/canned-responses')
      .send({ name: 'Refund Step-by-Step', content: 'See the refund policy …', category: 'Billing' });

    expect(res.status).toBe(201);
    expect(res.body.category).toBe('Billing');
  });

  test('400 when name is missing — no row is created', async () => {
    const res = await request(makeApp())
      .post('/api/canned-responses')
      .send({ content: 'Body only' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and content are required/i);
    expect(prisma.cannedResponse.create).not.toHaveBeenCalled();
  });

  test('400 when content is missing — no row is created', async () => {
    const res = await request(makeApp())
      .post('/api/canned-responses')
      .send({ name: 'Just a name' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and content are required/i);
    expect(prisma.cannedResponse.create).not.toHaveBeenCalled();
  });

  test('tenantId from body is ignored — req.user wins', async () => {
    prisma.cannedResponse.create.mockImplementation(async ({ data }) => ({ id: 99, ...data }));

    // The global stripDangerous middleware would strip body.tenantId in
    // production. Here we mount the router in isolation; the route's own
    // code already pins tenantId from req.user — that's what we pin.
    await request(makeApp({ user: { userId: 1, tenantId: 3, role: 'USER' } }))
      .post('/api/canned-responses')
      .send({ name: 'X', content: 'Y', tenantId: 999 });

    const createArgs = prisma.cannedResponse.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(3);
  });
});

// ─── PUT /api/canned-responses/:id ───────────────────────────────────

describe('PUT /api/canned-responses/:id', () => {
  test('400 INVALID_ID when :id is not numeric', async () => {
    const res = await request(makeApp())
      .put('/api/canned-responses/not-a-number')
      .send({ name: 'New' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.cannedResponse.findFirst).not.toHaveBeenCalled();
    expect(prisma.cannedResponse.update).not.toHaveBeenCalled();
  });

  test('404 when the row is not in the caller tenant (cross-tenant guard)', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ user: { userId: 1, tenantId: 7, role: 'USER' } }))
      .put('/api/canned-responses/123')
      .send({ name: 'Patch' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // findFirst MUST scope by tenant — otherwise a different tenant's
    // id could be edited.
    const findArgs = prisma.cannedResponse.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 123, tenantId: 7 });
    expect(prisma.cannedResponse.update).not.toHaveBeenCalled();
  });

  test('partial update writes only the fields present in the body', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'Old name',
      content: 'Old content',
      category: 'General',
    });
    prisma.cannedResponse.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      tenantId: 1,
      name: 'Old name',
      content: 'Old content',
      category: 'General',
      ...data,
    }));

    const res = await request(makeApp())
      .put('/api/canned-responses/5')
      .send({ content: 'Refreshed wording' });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Refreshed wording');
    const updateArgs = prisma.cannedResponse.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 5 });
    // Only `content` was supplied; name + category must NOT be in data.
    expect(updateArgs.data).toEqual({ content: 'Refreshed wording' });
    expect(updateArgs.data.name).toBeUndefined();
    expect(updateArgs.data.category).toBeUndefined();
  });

  test('500 envelope when Prisma update throws', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.cannedResponse.update.mockRejectedValue(new Error('db down'));

    const res = await request(makeApp())
      .put('/api/canned-responses/5')
      .send({ name: 'X' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to update/i);
  });
});

// ─── DELETE /api/canned-responses/:id ────────────────────────────────

describe('DELETE /api/canned-responses/:id', () => {
  test('204 No Content on successful delete (per the #550 sweep)', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue({ id: 5, tenantId: 1, name: 'Greet' });
    prisma.cannedResponse.delete.mockResolvedValue({ id: 5 });

    const res = await request(makeApp()).delete('/api/canned-responses/5');

    // #550: DELETE → 204 No Content with empty body.
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.cannedResponse.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  test('400 INVALID_ID when :id is not numeric — no DB call', async () => {
    const res = await request(makeApp()).delete('/api/canned-responses/not-a-number');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.cannedResponse.findFirst).not.toHaveBeenCalled();
    expect(prisma.cannedResponse.delete).not.toHaveBeenCalled();
  });

  test('404 when the row is not in the caller tenant (cross-tenant guard)', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ user: { userId: 1, tenantId: 9, role: 'USER' } })).delete(
      '/api/canned-responses/123',
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    const findArgs = prisma.cannedResponse.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 123, tenantId: 9 });
    expect(prisma.cannedResponse.delete).not.toHaveBeenCalled();
  });

  test('500 envelope when Prisma delete throws', async () => {
    prisma.cannedResponse.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.cannedResponse.delete.mockRejectedValue(new Error('FK constraint'));

    const res = await request(makeApp()).delete('/api/canned-responses/5');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to delete/i);
  });
});

// ─── eventBus defensive mock — #937 ───────────────────────────────────

describe('eventBus defensive mock — #937', () => {
  test('emitEvent is a vi.fn() so any future cross-cutting wiring lands inert', () => {
    expect(eb.emitEvent).toBeDefined();
    // Calling it must not throw and must return a resolved promise.
    return expect(eb.emitEvent('canned_response.created', { id: 1 })).resolves.toBeUndefined();
  });
});
