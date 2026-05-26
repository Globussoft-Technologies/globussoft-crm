// @ts-check
/**
 * Unit tests for backend/routes/live_chat.js — pin the contract of the
 * live-chat session/message surface (visitor public endpoints + agent
 * authenticated endpoints).
 *
 * Why this file exists
 * ────────────────────
 * routes/live_chat.js (331 LOC) had ZERO vitest coverage prior to this
 * file. It owns 9 endpoints split into two surfaces:
 *   • PUBLIC visitor endpoints under /api/live-chat/visitor/* — the embed
 *     widget on tenant marketing sites posts here. The /visitor/start
 *     handler is one of the explicit examples in the standing rule about
 *     siteTenantId (#646) — `req.body.tenantId` is silently stripped by
 *     stripDangerous, so the visitor MUST send siteTenantId or the row
 *     would silently land in tenant 1.
 *   • AGENT endpoints — list / get / assign / send / close, all scoped to
 *     req.user.tenantId via findFirst guards.
 *
 * Silent contract drift on any of these would either (a) red the
 * live-chat e2e flow against demo, OR (b) let the embed widget create
 * cross-tenant sessions, OR (c) let an authenticated agent view another
 * tenant's chat history. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. POST /visitor/start                  — public, requires siteTenantId
 *   2. POST /visitor/:sessionId/message     — public, visitor reply
 *   3. GET  /visitor/:sessionId/messages    — public, visitor polling
 *   4. POST /visitor/:sessionId/rate        — public, close+rate
 *   5. GET  /                               — agent list active sessions
 *   6. GET  /stats                          — open/assigned/closedToday
 *   7. GET  /:id                            — single session + messages
 *   8. POST /:id/assign                     — claim session
 *   9. POST /:id/messages                   — agent reply
 *  10. POST /:id/close                      — close (optional rating)
 *
 * Cases (16 total)
 * ────────────────
 *   visitor/start: 400 missing visitorId; 400 missing siteTenantId (the
 *     #646 strip case — req.body.tenantId is NOT enough); 200 happy with
 *     session+system-message create (3)
 *   visitor/message: 400 empty body; 404 unknown session; 400 when session
 *     is CLOSED; 200 happy + body trimmed (4)
 *   visitor/messages: 404 unknown session; 200 returns {session, messages}
 *     ordered asc (2)
 *   visitor/rate: 200 clamps rating to [1,5] + sets CLOSED status (1)
 *   GET /: tenant-scoped list with NOT-CLOSED filter + lastMessage preview (1)
 *   GET /stats: 6-field envelope shape from 3 parallel counts (1)
 *   GET /:id: 404 cross-tenant (findFirst returns null) (1)
 *   POST /:id/assign: 200 default assignTo = req.user.userId + ASSIGNED status (1)
 *   POST /:id/messages: 400 empty body; 200 agent message creation (2)
 *   POST /:id/close: 200 closes with rating clamp (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — prisma singleton monkey-patch
 * BEFORE requiring the router, eventBus stubbed, fake-auth middleware in
 * makeApp populates req.user.{userId, tenantId, role}. The visitor
 * endpoints don't read req.user so role/userId are irrelevant there.
 *
 * The route emits Socket.io events via req.io.to(...).emit(...). We
 * install a tiny fake-io stub on every request so the route's
 * `if (req.io)` branch is exercised without needing a real Socket.io
 * instance.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.liveChatSession = prisma.liveChatSession || {};
prisma.liveChatSession.findUnique = vi.fn();
prisma.liveChatSession.findFirst = vi.fn();
prisma.liveChatSession.findMany = vi.fn();
prisma.liveChatSession.create = vi.fn();
prisma.liveChatSession.update = vi.fn();
prisma.liveChatSession.count = vi.fn();
prisma.liveChatMessage = prisma.liveChatMessage || {};
prisma.liveChatMessage.findFirst = vi.fn();
prisma.liveChatMessage.findMany = vi.fn();
prisma.liveChatMessage.create = vi.fn();

// eventBus / auditLog defensive stubs — not directly called by this route
// but kept consistent with sla.test.js's environment shape so the boot
// path doesn't blow up under a future eventBus refactor.
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const liveChatRouter = requireCJS('../../routes/live_chat');

/**
 * Build an express app with a fake-auth middleware populating req.user
 * (the global verifyToken guard is bypassed here — visitor endpoints
 * don't read req.user; agent endpoints do). Also installs a tiny fake
 * req.io stub so the `if (req.io)` branches in the route are exercised
 * without needing a real Socket.io server.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  // Fake req.io — captures every .to().emit() call into emitCalls so
  // assertions can verify the route fires the expected room/event pair.
  const emitCalls = [];
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    req.io = {
      to(room) {
        return {
          emit(event, payload) {
            emitCalls.push({ room, event, payload });
          },
        };
      },
    };
    next();
  });
  app.use('/api/live-chat', liveChatRouter);
  app.locals.emitCalls = emitCalls;
  return app;
}

beforeEach(() => {
  prisma.liveChatSession.findUnique.mockReset();
  prisma.liveChatSession.findFirst.mockReset();
  prisma.liveChatSession.findMany.mockReset();
  prisma.liveChatSession.create.mockReset();
  prisma.liveChatSession.update.mockReset();
  prisma.liveChatSession.count.mockReset();
  prisma.liveChatMessage.findFirst.mockReset();
  prisma.liveChatMessage.findMany.mockReset();
  prisma.liveChatMessage.create.mockReset();

  // Sensible defaults — individual tests override.
  prisma.liveChatSession.findUnique.mockResolvedValue(null);
  prisma.liveChatSession.findFirst.mockResolvedValue(null);
  prisma.liveChatSession.findMany.mockResolvedValue([]);
  prisma.liveChatSession.create.mockResolvedValue({ id: 1, tenantId: 1 });
  prisma.liveChatSession.update.mockResolvedValue({ id: 1 });
  prisma.liveChatSession.count.mockResolvedValue(0);
  prisma.liveChatMessage.findFirst.mockResolvedValue(null);
  prisma.liveChatMessage.findMany.mockResolvedValue([]);
  prisma.liveChatMessage.create.mockResolvedValue({ id: 1 });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /visitor/start — public, embed-widget session opener
// ─────────────────────────────────────────────────────────────────────────

describe('POST /visitor/start — visitor opens a chat session', () => {
  test('400 when visitorId is missing', async () => {
    const res = await request(makeApp())
      .post('/api/live-chat/visitor/start')
      .send({ siteTenantId: 1, visitorName: 'Alice' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visitorId/i);
    expect(prisma.liveChatSession.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_INPUT when siteTenantId is missing (#646 strip case — tenantId is silently deleted by stripDangerous)', async () => {
    const res = await request(makeApp())
      .post('/api/live-chat/visitor/start')
      // NOTE: We intentionally send `tenantId` here too — in real traffic
      // it would be stripped by stripDangerous middleware. The route MUST
      // require siteTenantId rather than falling back to a default.
      .send({ visitorId: 'visitor-abc', tenantId: 5, visitorName: 'Alice' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toMatch(/siteTenantId/i);
    expect(prisma.liveChatSession.create).not.toHaveBeenCalled();
  });

  test('200 creates session + emits system message + notifies tenant room', async () => {
    prisma.liveChatSession.create.mockResolvedValue({
      id: 42,
      visitorId: 'v-1',
      visitorName: 'Alice',
      visitorEmail: 'alice@example.com',
      status: 'OPEN',
      tenantId: 7,
    });
    prisma.liveChatMessage.create.mockResolvedValue({ id: 100 });

    const app = makeApp({ tenantId: 999 }); // visitor endpoint ignores req.user.tenantId
    const res = await request(app)
      .post('/api/live-chat/visitor/start')
      .send({
        visitorId: 'v-1',
        siteTenantId: 7,
        visitorName: 'Alice',
        visitorEmail: 'alice@example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(42);
    expect(res.body.session.tenantId).toBe(7);

    // Session created with siteTenantId — NOT req.user.tenantId.
    expect(prisma.liveChatSession.create).toHaveBeenCalledWith({
      data: {
        visitorId: 'v-1',
        visitorName: 'Alice',
        visitorEmail: 'alice@example.com',
        status: 'OPEN',
        tenantId: 7,
      },
    });

    // System message announcing the visitor.
    expect(prisma.liveChatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 42,
        sender: 'system',
        tenantId: 7,
      }),
    });

    // Socket.io emitted to tenant-7 room with chat_new_session event.
    const emits = app.locals.emitCalls;
    expect(emits).toContainEqual(
      expect.objectContaining({ room: 'tenant-7', event: 'chat_new_session' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /visitor/:sessionId/message — public, visitor sends a reply
// ─────────────────────────────────────────────────────────────────────────

describe('POST /visitor/:sessionId/message — visitor sends a message', () => {
  test('400 when body is empty / whitespace-only', async () => {
    const res = await request(makeApp())
      .post('/api/live-chat/visitor/1/message')
      .send({ body: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body is required/i);
    expect(prisma.liveChatMessage.create).not.toHaveBeenCalled();
  });

  test('404 when session not found', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/live-chat/visitor/9999/message')
      .send({ body: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/session not found/i);
    expect(prisma.liveChatMessage.create).not.toHaveBeenCalled();
  });

  test('400 when session is already CLOSED', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue({
      id: 50, tenantId: 1, status: 'CLOSED',
    });

    const res = await request(makeApp())
      .post('/api/live-chat/visitor/50/message')
      .send({ body: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session is closed/i);
    expect(prisma.liveChatMessage.create).not.toHaveBeenCalled();
  });

  test('200 creates visitor message (body trimmed, sender=visitor) + emits to both rooms', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue({
      id: 50, tenantId: 7, status: 'OPEN',
    });
    prisma.liveChatMessage.create.mockResolvedValue({
      id: 200,
      sessionId: 50,
      sender: 'visitor',
      body: 'hello',
      tenantId: 7,
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/live-chat/visitor/50/message')
      .send({ body: '  hello  ' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message.id).toBe(200);
    // Body trimmed before write.
    expect(prisma.liveChatMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 50,
        sender: 'visitor',
        body: 'hello',
        tenantId: 7,
      },
    });
    // Emits to BOTH the tenant room AND the chat-specific room.
    const rooms = app.locals.emitCalls.map((c) => c.room);
    expect(rooms).toContain('tenant-7');
    expect(rooms).toContain('chat-50');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /visitor/:sessionId/messages — public, visitor polls
// ─────────────────────────────────────────────────────────────────────────

describe('GET /visitor/:sessionId/messages — visitor polls for messages', () => {
  test('404 when session not found', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/live-chat/visitor/9999/messages');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/session not found/i);
  });

  test('200 returns { session, messages } with messages ordered createdAt asc', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue({
      id: 50, tenantId: 7, status: 'OPEN',
    });
    prisma.liveChatMessage.findMany.mockResolvedValue([
      { id: 1, sessionId: 50, sender: 'system', body: 'start' },
      { id: 2, sessionId: 50, sender: 'visitor', body: 'hi' },
    ]);

    const res = await request(makeApp()).get('/api/live-chat/visitor/50/messages');

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(50);
    expect(res.body.messages).toHaveLength(2);
    expect(prisma.liveChatMessage.findMany).toHaveBeenCalledWith({
      where: { sessionId: 50 },
      orderBy: { createdAt: 'asc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /visitor/:sessionId/rate — visitor rates + closes
// ─────────────────────────────────────────────────────────────────────────

describe('POST /visitor/:sessionId/rate — visitor rates and closes session', () => {
  test('200 clamps rating to [1,5] + sets CLOSED status + closedAt', async () => {
    prisma.liveChatSession.findUnique.mockResolvedValue({
      id: 50, tenantId: 7, status: 'OPEN',
    });
    prisma.liveChatSession.update.mockResolvedValue({
      id: 50, status: 'CLOSED', rating: 5, closedAt: new Date(),
    });

    const res = await request(makeApp())
      .post('/api/live-chat/visitor/50/rate')
      .send({ rating: 99 /* will be clamped to 5 */ });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.status).toBe('CLOSED');

    const updateArg = prisma.liveChatSession.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.status).toBe('CLOSED');
    expect(updateArg.data.rating).toBe(5);
    expect(updateArg.data.closedAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — agent list active sessions
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list active sessions (tenant-scoped, agent-authenticated)', () => {
  test('200 tenant-scoped findMany with NOT-CLOSED filter + lastMessage preview attached', async () => {
    prisma.liveChatSession.findMany.mockResolvedValue([
      { id: 1, tenantId: 42, status: 'OPEN', visitorId: 'v-a' },
      { id: 2, tenantId: 42, status: 'ASSIGNED', visitorId: 'v-b' },
    ]);
    prisma.liveChatMessage.findFirst
      .mockResolvedValueOnce({ id: 100, sessionId: 1, body: 'hi from A' })
      .mockResolvedValueOnce({ id: 200, sessionId: 2, body: 'hi from B' });

    const res = await request(makeApp({ tenantId: 42 })).get('/api/live-chat/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].lastMessage.body).toBe('hi from A');
    expect(res.body[1].lastMessage.body).toBe('hi from B');

    // Tenant scope + status NOT-CLOSED + startedAt desc ordering.
    expect(prisma.liveChatSession.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, status: { not: 'CLOSED' } },
      orderBy: { startedAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /stats — KPI summary envelope
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stats — KPI summary', () => {
  test('200 returns { open, assigned, closedToday } from 3 tenant-scoped count calls', async () => {
    prisma.liveChatSession.count
      .mockResolvedValueOnce(3) // open
      .mockResolvedValueOnce(2) // assigned
      .mockResolvedValueOnce(7); // closedToday

    const res = await request(makeApp({ tenantId: 42 })).get('/api/live-chat/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: 3, assigned: 2, closedToday: 7 });

    // Each count call tenant-scoped + status-filtered.
    const calls = prisma.liveChatSession.count.mock.calls;
    expect(calls[0][0]).toEqual({ where: { tenantId: 42, status: 'OPEN' } });
    expect(calls[1][0]).toEqual({ where: { tenantId: 42, status: 'ASSIGNED' } });
    // closedToday includes closedAt: { gte: startOfDay } — assert shape not value.
    expect(calls[2][0].where).toMatchObject({ tenantId: 42, status: 'CLOSED' });
    expect(calls[2][0].where.closedAt.gte).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — single session (tenant isolation via findFirst)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — single session', () => {
  test('404 when session belongs to a different tenant (findFirst returns null)', async () => {
    prisma.liveChatSession.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/live-chat/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/session not found/i);
    // Tenant scope must be applied at the findFirst level.
    expect(prisma.liveChatSession.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/assign — claim session
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/assign — assign session to current user by default', () => {
  test('200 defaults assignTo to req.user.userId + sets status=ASSIGNED + writes system message', async () => {
    prisma.liveChatSession.findFirst.mockResolvedValue({
      id: 50, tenantId: 7, status: 'OPEN',
    });
    prisma.liveChatSession.update.mockResolvedValue({
      id: 50, agentId: 11, status: 'ASSIGNED',
    });

    const res = await request(makeApp({ tenantId: 7, userId: 11 }))
      .post('/api/live-chat/50/assign')
      .send({}); // no agentId → defaults to req.user.userId

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.agentId).toBe(11);

    expect(prisma.liveChatSession.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { agentId: 11, status: 'ASSIGNED' },
    });
    // System message recording the assignment.
    expect(prisma.liveChatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 50,
        sender: 'system',
        agentId: 11,
        tenantId: 7,
      }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/messages — agent sends a message
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/messages — agent sends a message', () => {
  test('400 when body is empty', async () => {
    const res = await request(makeApp())
      .post('/api/live-chat/50/messages')
      .send({ body: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body is required/i);
    expect(prisma.liveChatMessage.create).not.toHaveBeenCalled();
  });

  test('200 creates agent message with sender=agent + agentId from JWT + tenant-scoped session lookup', async () => {
    prisma.liveChatSession.findFirst.mockResolvedValue({
      id: 50, tenantId: 7, status: 'ASSIGNED',
    });
    prisma.liveChatMessage.create.mockResolvedValue({
      id: 300,
      sessionId: 50,
      sender: 'agent',
      agentId: 11,
      body: 'hello visitor',
      tenantId: 7,
    });

    const res = await request(makeApp({ tenantId: 7, userId: 11 }))
      .post('/api/live-chat/50/messages')
      .send({ body: '  hello visitor  ' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message.id).toBe(300);

    // Tenant-scoped session lookup before write.
    expect(prisma.liveChatSession.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 7 },
    });
    // Body trimmed, sender=agent, agentId from JWT.
    expect(prisma.liveChatMessage.create).toHaveBeenCalledWith({
      data: {
        sessionId: 50,
        sender: 'agent',
        agentId: 11,
        body: 'hello visitor',
        tenantId: 7,
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/close — close session with optional rating
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/close — close session', () => {
  test('200 closes session + clamps rating to [1,5] + writes system message + tenant-scoped lookup', async () => {
    prisma.liveChatSession.findFirst.mockResolvedValue({
      id: 50, tenantId: 7, status: 'ASSIGNED',
    });
    prisma.liveChatSession.update.mockResolvedValue({
      id: 50, status: 'CLOSED', rating: 5, closedAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 7, userId: 11 }))
      .post('/api/live-chat/50/close')
      .send({ rating: 100 /* will be clamped to 5 */ });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.status).toBe('CLOSED');

    // Tenant-scoped lookup.
    expect(prisma.liveChatSession.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 7 },
    });
    const updateArg = prisma.liveChatSession.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.status).toBe('CLOSED');
    expect(updateArg.data.rating).toBe(5);
    expect(updateArg.data.closedAt).toBeInstanceOf(Date);

    // System message recorded.
    expect(prisma.liveChatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 50,
        sender: 'system',
        agentId: 11,
        tenantId: 7,
      }),
    });
  });
});
