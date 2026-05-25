// @ts-check
/**
 * Unit tests for backend/routes/support.js — pins the customer-support /
 * ticket CRUD contract for the tenant-scoped helpdesk surface.
 *
 * Why this file exists (regression class)
 * ───────────────────────────────────────
 *   The route is 154 LOC and previously had ZERO direct vitest coverage at
 *   the ROUTE level. The companion `e2e/tests/support-api.spec.js` Playwright
 *   spec exercises happy paths against a live backend but nothing pinned the
 *   route's tenant-scope guards, the GET /stats aggregation shape, the
 *   firstResponseAt-on-Open-transition logic, or the assignment endpoint's
 *   null-coercion. Any drift in those (status-shape rename, terminal-status
 *   list edit, response-envelope reshape) would silently bypass the e2e spec
 *   because the spec asserts on the happy-path shapes only.
 *
 * Auth model
 * ──────────
 *   verifyToken-gated; tenantId pulled from req.user.tenantId. We exercise
 *   BOTH the real verifyToken (so the 401 gate is end-to-end via HS256 JWT
 *   signed with the dev-fallback secret) AND a fake-auth middleware shortcut
 *   for the per-test cases — the auth-gate test mounts the router directly
 *   so verifyToken actually runs.
 *
 * What this file pins (10 cases)
 * ──────────────────────────────
 *   GET / (smoke list):
 *    1. happy-path → 200 + tickets array; where filter scoped to tenantId.
 *
 *   POST / (create):
 *    2. happy-path → 201 + ticket; data.tenantId injected; SLA lookup runs
 *       (auto-apply SLA on matching priority).
 *    3. create + matching SLA policy → ticket.update called with
 *       slaResponseDue + slaResolveDue computed from policy minutes.
 *
 *   GET /:id (read-by-id):
 *    4. cross-tenant (id exists for tenant 7, requester is tenant 9) → 404
 *       `{ error: 'Ticket not found' }`. The route's findFirst pins
 *       tenantId in the where clause so this exercises the isolation guard.
 *
 *   PUT /:id (update):
 *    5. cross-tenant existing=null → 404.
 *    6. Open → In Progress transition stamps firstResponseAt.
 *    7. Open → Resolved does NOT stamp firstResponseAt (terminal status)
 *       but DOES stamp resolvedAt.
 *
 *   PUT /:id/assign:
 *    8. happy-path with assigneeId=null → coerces to null (unassign flow).
 *
 *   DELETE /:id:
 *    9. happy-path → 200 `{ success: true }` + prisma.ticket.delete called.
 *
 *   Auth gate (REAL verifyToken):
 *   10. GET / with no Authorization header → 401 + WWW-Authenticate: Bearer.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/voyagr.test.js + backend/test/routes/admin.test.js
 *   — patch the prisma singleton with vi.fn() shapes BEFORE the router is
 *   required so the route's top-level `require('../lib/prisma')` resolves to
 *   the stub. Two app builders:
 *     - makeApp({ tenantId, userId, role }) — fake-auth middleware that
 *       pre-populates req.user, skipping verifyToken.
 *     - makeRealAuthApp() — leaves verifyToken intact so the 401 gate test
 *       exercises the real middleware end-to-end.
 *   The eventBus.emitEvent / req.io.emit side-effects are wrapped in try/catch
 *   by the route so they don't need stubbing; the prisma.slaPolicy.findFirst
 *   default of null skips the SLA branch except where explicitly mocked.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

// ── Prisma singleton patching — BEFORE the router is required ──────────
prisma.ticket = prisma.ticket || {};
prisma.ticket.findMany = vi.fn();
prisma.ticket.findFirst = vi.fn();
prisma.ticket.count = vi.fn();
prisma.ticket.groupBy = vi.fn();
prisma.ticket.create = vi.fn();
prisma.ticket.update = vi.fn();
prisma.ticket.delete = vi.fn();
prisma.slaPolicy = prisma.slaPolicy || {};
prisma.slaPolicy.findFirst = vi.fn();
// verifyToken consults RevokedToken when a `jti` claim is present; our
// signed tokens omit `jti` so the lookup never fires, but stub for safety
// in case the auth middleware adds a default jti in the future.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// ── eventBus.emitEvent mock — BEFORE the router is required ───────────
//
// The route fires `require('../lib/eventBus').emitEvent('ticket.created', ...)`
// inside a synchronous try/catch on POST /. The emitEvent call returns a
// Promise that synchronously starts `prisma.automationRule.findMany()` —
// the sync try/catch does NOT trap the resulting async rejection. Under
// the CI unit-tests gate there's no DATABASE_URL, so the prisma call
// rejects asynchronously with PrismaClientInitializationError, which
// surfaces as an unhandled rejection and exits the vitest process with
// a non-zero status even though every test passed (the canonical #937
// pattern from CLAUDE.md cron-learnings). Stub the emit to a no-op
// resolved promise so the route's side-effect is inert under unit tests.
const eb = requireCJS('../../lib/eventBus');
eb.emitEvent = vi.fn().mockResolvedValue(undefined);

// ── Auth middleware swap — BEFORE the router is required ───────────────
//
// The router does `const { verifyToken } = require('../middleware/auth')`
// at module-load and captures whatever `verifyToken` points at THE MOMENT
// the route is required. To exercise the route logic without forging
// JWTs on every test we replace verifyToken on the exports object with a
// shim driven by a mutable shared `authState` object — flip `authState.mode`
// to `'real'` for the auth-gate test so verifyToken's real implementation
// runs end-to-end.
const authMw = requireCJS('../../middleware/auth');
const realVerifyToken = authMw.verifyToken;
const authState = {
  mode: 'fake',                          // 'fake' | 'real'
  user: { userId: 4, tenantId: 7, role: 'USER' },
};
authMw.verifyToken = (req, res, next) => {
  if (authState.mode === 'real') {
    return realVerifyToken(req, res, next);
  }
  req.user = { ...authState.user };
  next();
};

import express from 'express';
import request from 'supertest';

const supportRouter = requireCJS('../../routes/support');
const { JWT_SECRET } = requireCJS('../../config/secrets');

/**
 * Fake-auth app: the verifyToken shim short-circuits and assigns req.user
 * from authState. Use for the route-logic cases where the auth middleware
 * isn't under test.
 */
function makeApp({ tenantId = 7, userId = 4, role = 'USER' } = {}) {
  authState.mode = 'fake';
  authState.user = { userId, tenantId, role };
  const app = express();
  app.use(express.json());
  app.use('/api/support', supportRouter);
  return app;
}

/**
 * Real-auth app: flips the shim to delegate to the actual verifyToken so
 * the 401 / valid-JWT cases exercise the real middleware end-to-end.
 */
function makeRealAuthApp() {
  authState.mode = 'real';
  const app = express();
  app.use(express.json());
  app.use('/api/support', supportRouter);
  return app;
}

beforeEach(() => {
  prisma.ticket.findMany.mockReset().mockResolvedValue([]);
  prisma.ticket.findFirst.mockReset();
  prisma.ticket.count.mockReset().mockResolvedValue(0);
  prisma.ticket.groupBy.mockReset().mockResolvedValue([]);
  prisma.ticket.create.mockReset();
  prisma.ticket.update.mockReset();
  prisma.ticket.delete.mockReset();
  prisma.slaPolicy.findFirst.mockReset().mockResolvedValue(null);
});

// ── GET / — smoke list ────────────────────────────────────────────────

describe('GET /api/support', () => {
  test('happy-path → 200 + tickets array; where filter scoped to tenantId', async () => {
    const tickets = [
      { id: 1, subject: 'Login broken', status: 'Open', priority: 'High', tenantId: 7 },
      { id: 2, subject: 'Reports slow', status: 'Pending', priority: 'Low', tenantId: 7 },
    ];
    prisma.ticket.findMany.mockResolvedValueOnce(tickets);

    const res = await request(makeApp({ tenantId: 7 })).get('/api/support');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tickets);

    // Critically: where clause was tenant-scoped.
    const findManyArgs = prisma.ticket.findMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ tenantId: 7 });
    expect(findManyArgs.orderBy).toEqual({ createdAt: 'desc' });
  });
});

// ── POST / — create ───────────────────────────────────────────────────

describe('POST /api/support', () => {
  test('happy-path → 201 + ticket; data.tenantId injected from req.user', async () => {
    const created = {
      id: 42,
      subject: 'Payment failed',
      priority: 'High',
      status: 'Open',
      tenantId: 7,
      createdAt: new Date('2026-05-25T10:00:00Z'),
    };
    prisma.ticket.create.mockResolvedValueOnce(created);
    prisma.slaPolicy.findFirst.mockResolvedValueOnce(null); // no SLA → skip update

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/support')
      .send({ subject: 'Payment failed', priority: 'High', status: 'Open' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    expect(res.body.subject).toBe('Payment failed');

    // Tenant injected on create.
    const createArgs = prisma.ticket.create.mock.calls[0][0].data;
    expect(createArgs.tenantId).toBe(7);
    expect(createArgs.subject).toBe('Payment failed');

    // SLA lookup ran but produced no policy → no update call.
    expect(prisma.slaPolicy.findFirst).toHaveBeenCalledOnce();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  test('create + matching SLA policy → update fires with slaResponseDue + slaResolveDue', async () => {
    const baseTime = new Date('2026-05-25T10:00:00Z');
    const created = {
      id: 43,
      subject: 'Critical bug',
      priority: 'Critical',
      status: 'Open',
      tenantId: 7,
      createdAt: baseTime,
    };
    prisma.ticket.create.mockResolvedValueOnce(created);
    prisma.slaPolicy.findFirst.mockResolvedValueOnce({
      id: 1,
      tenantId: 7,
      priority: 'Critical',
      responseMinutes: 15,
      resolveMinutes: 240,
      isActive: true,
    });
    prisma.ticket.update.mockResolvedValueOnce({ ...created });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/support')
      .send({ subject: 'Critical bug', priority: 'Critical', status: 'Open' });

    expect(res.status).toBe(201);
    expect(prisma.ticket.update).toHaveBeenCalledOnce();

    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 43 });
    // Response-due = createdAt + 15 min; Resolve-due = createdAt + 240 min.
    const expectedResponseDue = new Date(baseTime.getTime() + 15 * 60_000);
    const expectedResolveDue = new Date(baseTime.getTime() + 240 * 60_000);
    expect(updateArgs.data.slaResponseDue.getTime()).toBe(expectedResponseDue.getTime());
    expect(updateArgs.data.slaResolveDue.getTime()).toBe(expectedResolveDue.getTime());
  });
});

// ── GET /:id — read by id, tenant isolation ───────────────────────────

describe('GET /api/support/:id', () => {
  test('cross-tenant (record belongs to other tenant) → 404 Ticket not found', async () => {
    // findFirst is scoped by { id, tenantId } so a record belonging to
    // tenant 7 returns null when queried by tenant 9 — exactly the
    // isolation contract this test pins.
    prisma.ticket.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp({ tenantId: 9 })).get('/api/support/42');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Ticket not found' });

    // findFirst was called with tenant 9 — proves the tenant guard fires.
    const findArgs = prisma.ticket.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(9);
    expect(findArgs.where.id).toBe(42);
  });
});

// ── PUT /:id — update ─────────────────────────────────────────────────

describe('PUT /api/support/:id', () => {
  test('cross-tenant existing=null → 404 Ticket not found', async () => {
    prisma.ticket.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp({ tenantId: 9 }))
      .put('/api/support/42')
      .send({ status: 'Resolved' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Ticket not found' });

    // Update was NEVER called — the tenant guard short-circuited before
    // any write would happen.
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  test('Open → In Progress transition stamps firstResponseAt', async () => {
    const existing = {
      id: 50,
      tenantId: 7,
      status: 'Open',
      firstResponseAt: null,
      resolvedAt: null,
    };
    prisma.ticket.findFirst.mockResolvedValueOnce(existing);
    prisma.ticket.update.mockResolvedValueOnce({ ...existing, status: 'In Progress' });

    const res = await request(makeApp({ tenantId: 7 }))
      .put('/api/support/50')
      .send({ status: 'In Progress' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 50 });
    expect(updateArgs.data.status).toBe('In Progress');
    expect(updateArgs.data.firstResponseAt).toBeInstanceOf(Date);
    // resolvedAt NOT stamped on a non-resolved status.
    expect(updateArgs.data.resolvedAt).toBeUndefined();
  });

  test('Open → Resolved stamps resolvedAt but NOT firstResponseAt (terminal status)', async () => {
    const existing = {
      id: 51,
      tenantId: 7,
      status: 'Open',
      firstResponseAt: null,
      resolvedAt: null,
    };
    prisma.ticket.findFirst.mockResolvedValueOnce(existing);
    prisma.ticket.update.mockResolvedValueOnce({ ...existing, status: 'Resolved' });

    const res = await request(makeApp({ tenantId: 7 }))
      .put('/api/support/51')
      .send({ status: 'Resolved' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Resolved');
    // resolvedAt stamped on first Resolved transition.
    expect(updateArgs.data.resolvedAt).toBeInstanceOf(Date);
    // firstResponseAt explicitly NOT stamped — terminal statuses don't
    // count as "first response" per the route's JSDoc.
    expect(updateArgs.data.firstResponseAt).toBeUndefined();
  });
});

// ── PUT /:id/assign — assignment ──────────────────────────────────────

describe('PUT /api/support/:id/assign', () => {
  test('assigneeId=null in body → coerces to null (unassign flow)', async () => {
    const existing = { id: 60, tenantId: 7, assigneeId: 99 };
    prisma.ticket.findFirst.mockResolvedValueOnce(existing);
    prisma.ticket.update.mockResolvedValueOnce({ ...existing, assigneeId: null });

    const res = await request(makeApp({ tenantId: 7 }))
      .put('/api/support/60/assign')
      .send({ assigneeId: null });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 60 });
    expect(updateArgs.data.assigneeId).toBeNull();
  });
});

// ── DELETE /:id — delete ──────────────────────────────────────────────

describe('DELETE /api/support/:id', () => {
  test('happy-path → 200 { success:true } + prisma.ticket.delete called', async () => {
    prisma.ticket.findFirst.mockResolvedValueOnce({ id: 70, tenantId: 7 });
    prisma.ticket.delete.mockResolvedValueOnce({ id: 70 });

    const res = await request(makeApp({ tenantId: 7 })).delete('/api/support/70');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // findFirst tenant-scoped before delete (isolation guard).
    const findArgs = prisma.ticket.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 70, tenantId: 7 });
    expect(prisma.ticket.delete).toHaveBeenCalledOnce();
    expect(prisma.ticket.delete.mock.calls[0][0].where).toEqual({ id: 70 });
  });
});

// ── Auth gate — REAL verifyToken ──────────────────────────────────────

describe('Auth gate (real verifyToken)', () => {
  test('GET / with no Authorization header → 401 + WWW-Authenticate: Bearer', async () => {
    const res = await request(makeRealAuthApp()).get('/api/support');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body.error).toBe('Authentication required');
    // Route handler never reached → no prisma calls.
    expect(prisma.ticket.findMany).not.toHaveBeenCalled();
  });

  test('GET / with valid HS256 JWT → 200 (sanity check the auth-bypass path works end-to-end)', async () => {
    const token = jwt.sign(
      { userId: 4, tenantId: 7, role: 'USER' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    prisma.ticket.findMany.mockResolvedValueOnce([]);

    const res = await request(makeRealAuthApp())
      .get('/api/support')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // findMany ran with the tenant from the signed JWT (7).
    const findArgs = prisma.ticket.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 7 });
  });
});
