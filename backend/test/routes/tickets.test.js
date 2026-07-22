// @ts-check
/**
 * Unit tests for backend/routes/tickets.js — pins the Ticket CRUD surface
 * that backs the Tickets page (mirror of routes/support.js, but simpler —
 * no contact-linkage, no comments thread, no first-response counter
 * separation by channel).
 *
 * Why this file exists
 * ────────────────────
 * tickets.js is a 182-LOC route surface holding several encoded contracts:
 *   - tenant isolation — every read / write filters on req.user.tenantId;
 *     cross-tenant id lookups return 404, never the foreign row.
 *   - VALID_STATUSES = ["Open", "Pending", "Resolved", "Closed"] — status
 *     mutations outside this set are rejected 400. VALID_PRIORITIES =
 *     ["Low", "Medium", "High", "Urgent"] enforced on both POST + PUT.
 *   - first-response stamping — PUT that transitions Open → (In Progress |
 *     Pending | Replied) stamps firstResponseAt. Terminal transitions
 *     (Resolved/Closed/Cancelled) do NOT count as a first response. Case-
 *     insensitive match. Idempotent: once stamped, never re-stamped.
 *   - resolvedAt stamping — PUT that transitions to "Resolved" (any prior
 *     status) stamps resolvedAt. Idempotent: once stamped, never re-stamped.
 *   - subject validation — POST rejects missing / empty / whitespace-only
 *     subject with 400.
 *   - SLA auto-apply — POST creates ticket, then if SlaPolicy matches the
 *     ticket's priority + isActive, a SECOND prisma.ticket.update fires
 *     stamping slaResponseDue + slaResolveDue. Wrapped in try/catch so an
 *     SLA failure does NOT break the POST response.
 *   - event emission — POST emits 'ticket.created' via lib/eventBus. Wrapped
 *     in try/catch so an event-bus failure does NOT break the POST response.
 *   - DELETE returns 204 No Content (#550 cross-route shape sweep).
 *
 * What this file pins (15 cases across 6 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — list tenant-scoped tickets ordered by createdAt desc,
 *      assignee relation included.
 *   2. GET /:id — happy single-ticket fetch, tenant-scoped via findFirst.
 *   3. GET /:id — cross-tenant id returns 404 (findFirst returns null).
 *   4. POST / — create happy path: returns 201, status auto-set to "Open",
 *      priority defaults to "Low", subject trimmed, eventBus emitted.
 *   5. POST / — rejects missing subject with 400.
 *   6. POST / — rejects whitespace-only subject with 400.
 *   7. POST / — rejects invalid priority with 400.
 *   8. POST / — auto-applies SLA when SlaPolicy matches priority + isActive,
 *      stamping slaResponseDue + slaResolveDue via a follow-up update.
 *   9. POST / — SLA failure does NOT break the response (try/catch wraps
 *      the SLA branch).
 *  10. PUT /:id — happy update of status to "Pending"; firstResponseAt
 *      stamped (Open → Pending counts as a first response).
 *  11. PUT /:id — transition to "Resolved" stamps resolvedAt, NOT
 *      firstResponseAt (terminal status is not a first response).
 *  12. PUT /:id — idempotent firstResponseAt + resolvedAt: existing stamps
 *      are not overwritten by subsequent updates.
 *  13. PUT /:id — rejects invalid status with 400.
 *  14. PUT /:id — cross-tenant id returns 404 (findFirst returns null).
 *  15. DELETE /:id — happy delete returns 204 No Content (#550).
 *  16. DELETE /:id — cross-tenant id returns 404.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/pipelines.test.js — prisma singleton patch +
 * real JWT bearer signed with config/secrets.JWT_SECRET so the real
 * verifyToken middleware passes. routes/tickets.js does NOT mount
 * verifyToken inline (it relies on the global guard in server.js), so the
 * test app wires it manually via `app.use('/api/tickets', verifyToken, ...)`.
 * CJS self-mocking seam on lib/eventBus replaces emitEvent with vi.fn().
 * See cron-learnings 2026-05-24 ~01:43 UTC for the canonical pattern.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.ticket = {
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.slaPolicy = prisma.slaPolicy || {};
prisma.slaPolicy.findFirst = vi.fn();

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will use — by reaching into the
// already-cached config/secrets module. This guarantees the test-token
// signing path matches verifyToken's resolution regardless of env timing.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// CJS self-mocking seam on lib/eventBus.emitEvent — the route does
// `require('../lib/eventBus').emitEvent(...)` inline in POST. Node CJS
// caches modules by resolved path, so the require inside the route returns
// the SAME object identity as our require here. We mutate the export in
// place with vi.fn() to assert emission shape without firing the real
// SendGrid / workflow-evaluator side effects.
const eventBusModule = requireCJS('../../lib/eventBus');
const emitEventMock = vi.fn().mockResolvedValue(undefined);
eventBusModule.emitEvent = emitEventMock;

// The route lives in routes/tickets.js but verifyToken is mounted globally
// in server.js — so the test app MUST wire it inline to exercise the same
// req.user-shaped path the production handler relies on.
const { verifyToken } = requireCJS('../../middleware/auth');
const ticketsRouter = requireCJS('../../routes/tickets');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tickets', verifyToken, ticketsRouter);
  return app;
}

beforeEach(() => {
  prisma.ticket.findMany.mockReset();
  prisma.ticket.count.mockReset();
  prisma.ticket.findFirst.mockReset();
  prisma.ticket.create.mockReset();
  prisma.ticket.update.mockReset();
  prisma.ticket.delete.mockReset();
  prisma.slaPolicy.findFirst.mockReset();
  emitEventMock.mockReset();
  emitEventMock.mockResolvedValue(undefined);
});

// ── GET / — list tenant-scoped tickets ──────────────────────────────────

describe('GET / — list tickets', () => {
  test('returns tenant-scoped tickets ordered by createdAt desc with assignee included', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 11, subject: 'Login broken', status: 'Open', priority: 'High',
        tenantId: 1, createdAt: new Date('2026-05-20'),
        assignee: { id: 7, name: 'Owner', email: 'o@example.com' },
      },
      {
        id: 12, subject: 'Slow page', status: 'Pending', priority: 'Medium',
        tenantId: 1, createdAt: new Date('2026-05-19'),
        assignee: null,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 11, subject: 'Login broken' }));
    expect(res.body[0].assignee).toEqual(expect.objectContaining({ id: 7, name: 'Owner' }));

    // Tenant-scoped + correct shape
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('GET / — paginated list', () => {
  test('returns a paginated envelope with counts and skip/take args', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 11, subject: 'Login broken', status: 'Open', priority: 'High',
        tenantId: 1, createdAt: new Date('2026-05-20'),
        assignee: { id: 7, name: 'Owner', email: 'o@example.com' },
      },
      {
        id: 12, subject: 'Slow page', status: 'Pending', priority: 'Medium',
        tenantId: 1, createdAt: new Date('2026-05-19'),
        assignee: null,
      },
    ]);
    prisma.ticket.count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);

    const res = await request(makeApp())
      .get('/api/tickets?page=2&limit=2')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      tickets: expect.any(Array),
      total: 12,
      page: 2,
      limit: 2,
      totalPages: 6,
      openCount: 7,
      urgentCount: 2,
    }));
    expect(res.body.tickets).toHaveLength(2);

    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: 2,
      take: 2,
    });
    expect(prisma.ticket.count).toHaveBeenNthCalledWith(1, { where: { tenantId: 1 } });
    expect(prisma.ticket.count).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: 1,
        status: { notIn: ['Resolved', 'Closed'] },
      },
    });
    expect(prisma.ticket.count).toHaveBeenNthCalledWith(3, {
      where: {
        tenantId: 1,
        priority: 'Urgent',
        status: { not: 'Closed' },
      },
    });
  });
});

// ── GET /:id — single ticket fetch ──────────────────────────────────────

describe('GET /:id — single ticket', () => {
  test('returns the ticket when found in current tenant', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 50, subject: 'Need help', status: 'Open', priority: 'Low', tenantId: 1,
      assignee: { id: 7, name: 'Owner', email: 'o@example.com' },
    });

    const res = await request(makeApp())
      .get('/api/tickets/50')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(50);
    // Tenant-scoped via findFirst (not findUnique by id) — this is the
    // canonical pattern that blocks cross-tenant id-guess attacks.
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
      include: { assignee: { select: { id: true, name: true, email: true } } },
    });
  });

  test('cross-tenant id returns 404 without leaking the foreign row', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/tickets/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Ticket not found/);
  });
});

// ── POST / — create ticket ──────────────────────────────────────────────

describe('POST / — create ticket', () => {
  test('creates a ticket with subject trimmed, status=Open, default priority=Low, emits ticket.created', async () => {
    prisma.ticket.create.mockResolvedValue({
      id: 100, subject: 'Cannot login', description: null,
      status: 'Open', priority: 'Low', tenantId: 1, createdAt: new Date(),
      assignee: null,
    });
    prisma.slaPolicy.findFirst.mockResolvedValue(null); // no SLA configured

    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({ subject: '  Cannot login  ' }); // padding to verify trim

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 100,
      subject: 'Cannot login',
      status: 'Open',
      priority: 'Low',
    }));

    // create payload was trimmed + tenant-stamped + defaults applied
    expect(prisma.ticket.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subject: 'Cannot login',
        description: null,
        priority: 'Low',
        status: 'Open',
        tenantId: 1,
      }),
      include: { assignee: { select: { id: true, name: true, email: true } } },
    });

    // No SLA → no follow-up ticket.update
    expect(prisma.ticket.update).not.toHaveBeenCalled();

    // ticket.created emitted with the correct envelope shape
    expect(emitEventMock).toHaveBeenCalledTimes(1);
    expect(emitEventMock).toHaveBeenCalledWith(
      'ticket.created',
      expect.objectContaining({
        ticketId: 100,
        subject: 'Cannot login',
        priority: 'Low',
        status: 'Open',
        userId: 7,
      }),
      1,
      undefined, // req.io is undefined in the test app (no socket.io wired)
    );
  });

  test('rejects missing subject with 400 — no create / no emit', async () => {
    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({}); // no subject at all

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Subject is required/);
    expect(prisma.ticket.create).not.toHaveBeenCalled();
    expect(emitEventMock).not.toHaveBeenCalled();
  });

  test('rejects whitespace-only subject with 400', async () => {
    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({ subject: '    ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Subject is required/);
    expect(prisma.ticket.create).not.toHaveBeenCalled();
  });

  test('rejects invalid priority with 400 listing the allowed values', async () => {
    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({ subject: 'Bug', priority: 'CRITICAL' }); // not in VALID_PRIORITIES

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid priority/);
    expect(res.body.error).toMatch(/Low/);
    expect(res.body.error).toMatch(/Urgent/);
    expect(prisma.ticket.create).not.toHaveBeenCalled();
  });

  test('auto-applies SLA when an active SlaPolicy matches the ticket priority', async () => {
    const created = {
      id: 200, subject: 'High prio bug', priority: 'High', status: 'Open',
      tenantId: 1, createdAt: new Date('2026-05-25T10:00:00Z'),
      description: null, assignee: null,
    };
    prisma.ticket.create.mockResolvedValue(created);
    prisma.slaPolicy.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, priority: 'High', isActive: true,
      responseMinutes: 60,     // 1h
      resolveMinutes: 240,     // 4h
    });
    prisma.ticket.update.mockResolvedValue({ ...created });

    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({ subject: 'High prio bug', priority: 'High' });

    expect(res.status).toBe(201);
    // SLA policy lookup was tenant + priority + isActive scoped
    expect(prisma.slaPolicy.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1, priority: 'High', isActive: true },
    });
    // Follow-up ticket.update stamped both due dates
    expect(prisma.ticket.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 200 });
    expect(updateArgs.data.slaResponseDue).toBeInstanceOf(Date);
    expect(updateArgs.data.slaResolveDue).toBeInstanceOf(Date);
    // resolveDue is later than responseDue
    expect(updateArgs.data.slaResolveDue.getTime()).toBeGreaterThan(
      updateArgs.data.slaResponseDue.getTime(),
    );
  });

  test('SLA failure does NOT break the response — try/catch wraps the SLA branch', async () => {
    prisma.ticket.create.mockResolvedValue({
      id: 201, subject: 'Bug', priority: 'High', status: 'Open',
      tenantId: 1, createdAt: new Date(), description: null, assignee: null,
    });
    // Simulate the SLA policy lookup blowing up
    prisma.slaPolicy.findFirst.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(makeApp())
      .post('/api/tickets')
      .set('Authorization', makeBearer())
      .send({ subject: 'Bug', priority: 'High' });

    // POST still succeeds — the SLA branch is non-critical
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(201);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });
});

// ── PUT /:id — update ticket ────────────────────────────────────────────

describe('PUT /:id — update ticket', () => {
  test('Open → Pending stamps firstResponseAt (responsive transition)', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 300, subject: 'X', status: 'Open', priority: 'Low',
      tenantId: 1, firstResponseAt: null, resolvedAt: null,
    });
    prisma.ticket.update.mockResolvedValue({
      id: 300, subject: 'X', status: 'Pending', priority: 'Low',
      tenantId: 1, firstResponseAt: new Date(), resolvedAt: null,
      assignee: null,
    });

    const res = await request(makeApp())
      .put('/api/tickets/300')
      .set('Authorization', makeBearer())
      .send({ status: 'Pending' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Pending');
    expect(updateArgs.data.firstResponseAt).toBeInstanceOf(Date);
    // NOT a terminal transition — resolvedAt must NOT be stamped
    expect(updateArgs.data.resolvedAt).toBeUndefined();
  });

  test('transition to Resolved stamps resolvedAt but NOT firstResponseAt (terminal is not a response)', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 301, subject: 'X', status: 'Open', priority: 'Low',
      tenantId: 1, firstResponseAt: null, resolvedAt: null,
    });
    prisma.ticket.update.mockResolvedValue({
      id: 301, subject: 'X', status: 'Resolved', priority: 'Low',
      tenantId: 1, firstResponseAt: null, resolvedAt: new Date(),
      assignee: null,
    });

    const res = await request(makeApp())
      .put('/api/tickets/301')
      .set('Authorization', makeBearer())
      .send({ status: 'Resolved' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Resolved');
    expect(updateArgs.data.resolvedAt).toBeInstanceOf(Date);
    // Terminal status — firstResponseAt must NOT be stamped (not a response)
    expect(updateArgs.data.firstResponseAt).toBeUndefined();
  });

  test('firstResponseAt + resolvedAt are idempotent — pre-existing stamps never overwritten', async () => {
    const existingFirstResponse = new Date('2026-05-20T10:00:00Z');
    const existingResolvedAt = new Date('2026-05-22T15:00:00Z');
    prisma.ticket.findFirst.mockResolvedValue({
      id: 302, subject: 'X', status: 'Resolved', priority: 'Low',
      tenantId: 1,
      firstResponseAt: existingFirstResponse,
      resolvedAt: existingResolvedAt,
    });
    prisma.ticket.update.mockResolvedValue({
      id: 302, subject: 'X', status: 'Closed', priority: 'Low',
      tenantId: 1,
      firstResponseAt: existingFirstResponse,
      resolvedAt: existingResolvedAt,
      assignee: null,
    });

    const res = await request(makeApp())
      .put('/api/tickets/302')
      .set('Authorization', makeBearer())
      .send({ status: 'Closed' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.ticket.update.mock.calls[0][0];
    // Neither stamp re-applied
    expect(updateArgs.data.firstResponseAt).toBeUndefined();
    expect(updateArgs.data.resolvedAt).toBeUndefined();
  });

  test('rejects invalid status with 400 — no update fired', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 303, subject: 'X', status: 'Open', priority: 'Low', tenantId: 1,
      firstResponseAt: null, resolvedAt: null,
    });

    const res = await request(makeApp())
      .put('/api/tickets/303')
      .set('Authorization', makeBearer())
      .send({ status: 'Bogus' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid status/);
    expect(res.body.error).toMatch(/Open/);
    expect(res.body.error).toMatch(/Closed/);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  test('cross-tenant id returns 404 — tenant isolation via findFirst', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/tickets/9999')
      .set('Authorization', makeBearer())
      .send({ status: 'Pending' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Ticket not found/);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id — delete ticket ─────────────────────────────────────────

describe('DELETE /:id — delete ticket', () => {
  test('returns 204 No Content on a successful delete (#550)', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 400, subject: 'Old ticket', status: 'Closed', tenantId: 1,
    });
    prisma.ticket.delete.mockResolvedValue({ id: 400 });

    const res = await request(makeApp())
      .delete('/api/tickets/400')
      .set('Authorization', makeBearer());

    // #550 cross-route sweep — DELETE → 204 No Content, NOT 200 + body
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 400 } });
  });

  test('cross-tenant id returns 404 — tenant isolation', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/tickets/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Ticket not found/);
    expect(prisma.ticket.delete).not.toHaveBeenCalled();
  });
});

// ── GET /api/tickets?fields=summary — slim-shape opt-in (#920 slice 3) ──────
//
// Mirrors slice 1 contacts (f7790241) + slice 2 deals (6786c2da). When the
// caller passes ?fields=summary, the route swaps the nested-include shape for
// a slim Prisma `select` over a fixed allowlist of columns. Existing callers
// (no ?fields, or any other value) keep the full shape unchanged.
//
// Pinned contract:
//   - Opt-in is EXACT-match on the literal string "summary" — other values
//     (empty, "anything", "SUMMARY" uppercased, "full") fall through to the
//     full-shape branch.
//   - The slim allowlist is {id, subject, status, priority, assigneeId,
//     tenantId, createdAt} — drops description, slaResponseDue, slaResolveDue,
//     firstResponseAt, resolvedAt, breached, breachedAt, updatedAt, and the
//     entire `assignee` nested object.
//   - Prisma is called with `select` (not `include`) on the slim branch so
//     the unselected columns never come back from the DB.
//   - Tenant scope is preserved on BOTH branches (where.tenantId).
describe('GET / ?fields=summary — slim-shape opt-in (#920 slice 3)', () => {
  test('?fields=summary → response rows expose ONLY the slim allowlist; no heavy/nested fields', async () => {
    // The route requests `select`, so the mocked findMany returns only the
    // slim columns — heavy columns + assignee are absent on the wire.
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 11, subject: 'Login broken', status: 'Open', priority: 'High',
        assigneeId: 7, tenantId: 1, createdAt: new Date('2026-05-20'),
      },
      {
        id: 12, subject: 'Slow page', status: 'Pending', priority: 'Medium',
        assigneeId: null, tenantId: 1, createdAt: new Date('2026-05-19'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets?fields=summary')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    // Each row exposes EXACTLY the slim allowlist (no description, no SLA
    // dates, no firstResponseAt, no breached*, no updatedAt, no assignee).
    const SLIM_KEYS = ['id', 'subject', 'status', 'priority', 'assigneeId', 'tenantId', 'createdAt'];
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual([...SLIM_KEYS].sort());
      expect(row).not.toHaveProperty('description');
      expect(row).not.toHaveProperty('slaResponseDue');
      expect(row).not.toHaveProperty('slaResolveDue');
      expect(row).not.toHaveProperty('firstResponseAt');
      expect(row).not.toHaveProperty('resolvedAt');
      expect(row).not.toHaveProperty('breached');
      expect(row).not.toHaveProperty('breachedAt');
      expect(row).not.toHaveProperty('updatedAt');
      expect(row).not.toHaveProperty('assignee');
    }
  });

  test('?fields=summary → prisma.ticket.findMany called with `select` (slim) NOT `include` (nested)', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/tickets?fields=summary')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.ticket.findMany.mock.calls[0][0];

    // Slim branch — select shape pinned to the exact allowlist
    expect(args.select).toEqual({
      id: true,
      subject: true,
      status: true,
      priority: true,
      assigneeId: true,
      tenantId: true,
      createdAt: true,
    });
    // include MUST NOT also be set (Prisma rejects `select` + `include` together)
    expect(args.include).toBeUndefined();
    // Tenant scope preserved on the slim branch
    expect(args.where).toEqual({ tenantId: 1 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields= (empty) → falls through to FULL shape with nested assignee include', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 21, subject: 'Bug', status: 'Open', priority: 'Low', tenantId: 1,
        createdAt: new Date(), description: 'desc here', firstResponseAt: null,
        assignee: { id: 7, name: 'Owner', email: 'o@example.com' },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets?fields=')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body[0]).toHaveProperty('description', 'desc here');
    expect(res.body[0].assignee).toEqual(expect.objectContaining({ id: 7, name: 'Owner' }));

    const args = prisma.ticket.findMany.mock.calls[0][0];
    // Full branch — include set, select unset
    expect(args.include).toEqual({
      assignee: { select: { id: true, name: true, email: true } },
    });
    expect(args.select).toBeUndefined();
  });

  test('?fields=anything-else → falls through to FULL shape (opt-in only on EXACT "summary")', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 22, subject: 'Bug', status: 'Open', priority: 'Low', tenantId: 1,
        createdAt: new Date(), description: 'still here', assignee: null,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets?fields=SUMMARY') // uppercased — must NOT trigger slim
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // Full shape preserved — description present
    expect(res.body[0]).toHaveProperty('description', 'still here');

    const args = prisma.ticket.findMany.mock.calls[0][0];
    expect(args.include).toEqual({
      assignee: { select: { id: true, name: true, email: true } },
    });
    expect(args.select).toBeUndefined();
  });

  test('?fields=summary → tenant-isolation preserved (no foreign-tenant leak)', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);

    // Caller is tenantId=2 — slim branch must still scope where.tenantId
    const res = await request(makeApp())
      .get('/api/tickets?fields=summary')
      .set('Authorization', makeBearer({ userId: 9, tenantId: 2, role: 'USER' }));

    expect(res.status).toBe(200);
    const args = prisma.ticket.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 2 });
    // Confirm slim-select still active (proves the branch is taken before
    // the where clause is built — not bypassed by tenant change)
    expect(args.select).toBeDefined();
    expect(args.select.subject).toBe(true);
    expect(args.include).toBeUndefined();
  });

  test('?fields=summary preserves orderBy + tenant where alongside slim select', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      { id: 31, subject: 'A', status: 'Open', priority: 'High', assigneeId: 7, tenantId: 1, createdAt: new Date('2026-05-25') },
      { id: 30, subject: 'B', status: 'Open', priority: 'High', assigneeId: 7, tenantId: 1, createdAt: new Date('2026-05-24') },
    ]);

    const res = await request(makeApp())
      .get('/api/tickets?fields=summary')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    const args = prisma.ticket.findMany.mock.calls[0][0];
    // Pagination shape unchanged (tickets has no take/skip today — pin that
    // slim opt-in didn't accidentally inject new pagination semantics).
    expect(args.take).toBeUndefined();
    expect(args.skip).toBeUndefined();
    // orderBy + where survive the slim branch
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.where).toEqual({ tenantId: 1 });
  });
});
