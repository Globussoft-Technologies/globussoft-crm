// @ts-check
/**
 * Unit + integration tests for backend/routes/chatbots.js — pins the chatbot
 * CRUD + activate/deactivate + conversation list + public chat-engine surface
 * that powers the Marketing → Chatbots admin page and the public widget at
 * /api/chatbots/chat/:botId.
 *
 * Why this file exists
 * ────────────────────
 *   routes/chatbots.js is a 405-LOC two-tier module:
 *     1. ADMIN-ONLY CRUD — POST / PUT / DELETE / activate / deactivate are
 *        gated by `[verifyToken, verifyRole(['ADMIN'])]` (the #527 / CRIT-02
 *        hardening). GET stays open to all authed users because USERs may
 *        still need to see the bot list.
 *     2. PUBLIC chat — POST /chat/:botId is the actual visitor-facing
 *        endpoint. It runs a small flow-engine state machine over `bot.flow`
 *        (a JSON column with `{nodes, edges}`), advancing per visitor message
 *        and persisting a ChatbotConversation row. Inactive bots return 403
 *        UNLESS the `previewTenantId` body field matches the bot's tenantId
 *        (#646 — body-field name had to dodge stripDangerous's tenantId strip;
 *        the working preview override is `previewTenantId`).
 *
 * Tenant-isolation angle
 * ──────────────────────
 *   Every authenticated read AND every mutation scopes by `tenantId` =
 *   `req.user.tenantId`. The list, get, update, delete, activate, deactivate,
 *   and conversations endpoints all pin a tenant filter on the existence
 *   check — a future "let me drop the tenant filter for simplicity" refactor
 *   reds the test instead of silently leaking cross-tenant data. The public
 *   /chat/:botId endpoint is exempt from auth (real visitors hit it without
 *   a token), so it uses `bot.tenantId` as the persistence scope instead of
 *   `req.user.tenantId`.
 *
 * What this file pins
 * ───────────────────
 *   CRUD
 *   1. GET / returns the tenant's bots with conversationCount + parsed flow.
 *   2. POST / requires name → 400 otherwise.
 *   3. POST / persists flow as a JSON string + isActive=false by default.
 *   4. GET /:id 404s when the bot is in another tenant (tenant filter pinned).
 *   5. PUT /:id 404s when the bot is in another tenant.
 *   6. PUT /:id partial-updates (name / flow / isActive) without clobbering.
 *   7. DELETE /:id 404s when the bot is in another tenant.
 *   8. DELETE /:id cascades — deletes ChatbotConversation rows first.
 *   9. POST /:id/activate flips isActive=true (404 on cross-tenant).
 *  10. POST /:id/deactivate flips isActive=false (404 on cross-tenant).
 *  11. GET /:id/conversations 404s when the bot is in another tenant.
 *  12. GET /:id/conversations returns convos with parsed `messages` (top 100).
 *
 *   PUBLIC CHAT ENGINE
 *  13. POST /chat/:botId requires visitorId → 400 otherwise.
 *  14. POST /chat/:botId 404s when the bot doesn't exist.
 *  15. POST /chat/:botId on an inactive bot returns 403 unless
 *      previewTenantId matches bot.tenantId.
 *  16. POST /chat/:botId on an inactive bot with matching previewTenantId
 *      allows test-mode preview (200) — pins the #646 contract.
 *  17. POST /chat/:botId first-touch (no message, no convo) starts the flow
 *      and emits the start node's content as the bot reply.
 *  18. POST /chat/:botId on a flow-less bot returns a graceful
 *      "no flow configured" response (does NOT 500).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/social.test.js + admin.test.js — prisma
 *   singleton monkey-patch BEFORE the router is required, monkey-patch
 *   `verifyToken` to a pass-through so the verifyRole(['ADMIN']) admin-gate
 *   stays REAL (we want to exercise the role-denial path), then mount the
 *   router into a bare express app with a fake req.user injector and drive
 *   it via supertest. No real DB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — pass through verifyToken so we exercise the
// route + verifyRole flow without minting JWTs. verifyRole stays REAL so
// the role-gate assertions are end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — must happen BEFORE the router is required,
// since the router's top-level `require('../lib/prisma')` resolves at
// import time and captures whatever shape these models point at then.
prisma.chatbot = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.chatbotConversation = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  groupBy: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.webVisitor = prisma.webVisitor || {};
prisma.webVisitor.findUnique = vi.fn();
prisma.webVisitor.update = vi.fn();

import express from 'express';
import request from 'supertest';

const chatbotsRouter = requireCJS('../../routes/chatbots');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/chatbots', chatbotsRouter);
  return app;
}

beforeEach(() => {
  prisma.chatbot.findMany.mockReset();
  prisma.chatbot.findFirst.mockReset();
  prisma.chatbot.findUnique.mockReset();
  prisma.chatbot.create.mockReset();
  prisma.chatbot.update.mockReset();
  prisma.chatbot.delete.mockReset();

  prisma.chatbotConversation.findMany.mockReset();
  prisma.chatbotConversation.findFirst.mockReset();
  prisma.chatbotConversation.create.mockReset();
  prisma.chatbotConversation.update.mockReset();
  prisma.chatbotConversation.deleteMany.mockReset();
  prisma.chatbotConversation.groupBy.mockReset();

  prisma.contact.findFirst.mockReset();
  prisma.webVisitor.findUnique.mockReset();
  prisma.webVisitor.update.mockReset();

  // Sensible defaults
  prisma.chatbot.findMany.mockResolvedValue([]);
  prisma.chatbotConversation.findMany.mockResolvedValue([]);
  prisma.chatbotConversation.groupBy.mockResolvedValue([]);
});

// ─── GET / — list bots ──────────────────────────────────────────────

describe('GET /api/chatbots', () => {
  test('scopes findMany by tenantId and decorates with conversationCount + parsed flow', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, name: 'Bot A', flow: JSON.stringify({ nodes: [{ id: 'n1', type: 'message' }], edges: [] }), isActive: true, tenantId: 42 },
      { id: 2, name: 'Bot B', flow: null, isActive: false, tenantId: 42 },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([
      { chatbotId: 1, _count: { _all: 5 } },
    ]);

    const res = await request(app).get('/api/chatbots');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    // Tenant filter pinned on the findMany.
    const args = prisma.chatbot.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);

    // groupBy is scoped by both tenantId AND chatbotId IN [list]
    const groupByArgs = prisma.chatbotConversation.groupBy.mock.calls[0][0];
    expect(groupByArgs.where.tenantId).toBe(42);
    expect(groupByArgs.where.chatbotId).toEqual({ in: [1, 2] });

    // conversationCount populated from groupBy
    expect(res.body[0].conversationCount).toBe(5);
    expect(res.body[1].conversationCount).toBe(0);

    // flow parsed back to an object (NOT a string)
    expect(res.body[0].flow).toEqual({ nodes: [{ id: 'n1', type: 'message' }], edges: [] });
    expect(res.body[1].flow).toEqual({ nodes: [], edges: [] });
  });

  test('500 envelope when prisma throws', async () => {
    const app = makeApp();
    prisma.chatbot.findMany.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/chatbots');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'List failed' });
  });
});

// ─── GET /?fields=summary — slim-shape opt-in (#920 slice 19) ───────

describe('GET /api/chatbots?fields=summary', () => {
  test('uses a slim Prisma select that drops the heavy flow column', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, name: 'Bot A', isActive: true, tenantId: 42, createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await request(app).get('/api/chatbots?fields=summary');

    expect(res.status).toBe(200);
    // findMany invoked with a `select` payload (slim-shape branch taken).
    const args = prisma.chatbot.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      isActive: true,
      tenantId: true,
      createdAt: true,
      updatedAt: true,
    });
    // flow must NOT appear in the select — it's the heavy column we drop.
    expect(args.select.flow).toBeUndefined();
    // Tenant filter pinned even in the slim branch.
    expect(args.where.tenantId).toBe(42);
    // orderBy still preserved.
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
  });

  test('returns rows verbatim — no conversationCount decoration in slim mode', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 7, name: 'Bot X', isActive: true, tenantId: 1, createdAt: new Date(), updatedAt: new Date() },
      { id: 8, name: 'Bot Y', isActive: false, tenantId: 1, createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await request(app).get('/api/chatbots?fields=summary');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    // Slim shape — no conversationCount, no parsed flow.
    expect(res.body[0].conversationCount).toBeUndefined();
    expect(res.body[0].flow).toBeUndefined();
    expect(res.body[1].conversationCount).toBeUndefined();
    expect(res.body[1].flow).toBeUndefined();
    // Core identity + status fields preserved.
    expect(res.body[0].id).toBe(7);
    expect(res.body[0].name).toBe('Bot X');
    expect(res.body[0].isActive).toBe(true);
  });

  test('slim branch skips the conversation groupBy query entirely', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, name: 'Bot A', isActive: true, tenantId: 1, createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await request(app).get('/api/chatbots?fields=summary');

    expect(res.status).toBe(200);
    // The per-row groupBy is the second-most-expensive part of the list
    // handler — slim mode must avoid it.
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });

  test('absent ?fields preserves the full-row shape (back-compat)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, name: 'Bot A', flow: JSON.stringify({ nodes: [], edges: [] }), isActive: true, tenantId: 1 },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([
      { chatbotId: 1, _count: { _all: 3 } },
    ]);

    const res = await request(app).get('/api/chatbots'); // no ?fields

    expect(res.status).toBe(200);
    // findMany invoked WITHOUT a `select` payload — full-row shape preserved.
    const args = prisma.chatbot.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    // groupBy still fires in the full-row branch.
    expect(prisma.chatbotConversation.groupBy).toHaveBeenCalledTimes(1);
    // Response decorated with conversationCount + parsed flow as before.
    expect(res.body[0].conversationCount).toBe(3);
    expect(res.body[0].flow).toEqual({ nodes: [], edges: [] });
  });

  test('unknown ?fields value falls back to full-row shape (additive contract)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, name: 'Bot A', flow: JSON.stringify({ nodes: [], edges: [] }), isActive: true, tenantId: 1 },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([]);

    const res = await request(app).get('/api/chatbots?fields=bogus');

    expect(res.status).toBe(200);
    // Bogus value treated as "no opt-in" — no `select`, full-row branch.
    const args = prisma.chatbot.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    // Full-row response shape — flow parsed back to an object + decorated.
    expect(res.body[0].flow).toEqual({ nodes: [], edges: [] });
    expect(res.body[0].conversationCount).toBe(0);
  });

  test('empty result set in slim mode returns [] (no groupBy call)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/chatbots?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });
});

// ─── POST / — create bot ────────────────────────────────────────────

describe('POST /api/chatbots', () => {
  test('400 when name is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/chatbots').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
    expect(prisma.chatbot.create).not.toHaveBeenCalled();
  });

  test('persists flow as JSON string + isActive=false + tenantId from req.user', async () => {
    const app = makeApp({ tenantId: 11 });
    prisma.chatbot.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 101, ...data })
    );

    const res = await request(app)
      .post('/api/chatbots')
      .send({
        name: 'Lead Bot',
        flow: { nodes: [{ id: 'start', type: 'message', content: 'hi' }], edges: [] },
      });

    expect(res.status).toBe(200);
    expect(prisma.chatbot.create).toHaveBeenCalledTimes(1);
    const data = prisma.chatbot.create.mock.calls[0][0].data;
    expect(data.name).toBe('Lead Bot');
    expect(data.tenantId).toBe(11);
    expect(data.isActive).toBe(false); // always created inactive
    // flow stored as JSON string, not object
    expect(typeof data.flow).toBe('string');
    expect(JSON.parse(data.flow)).toEqual({
      nodes: [{ id: 'start', type: 'message', content: 'hi' }],
      edges: [],
    });

    // Response decodes flow back into an object
    expect(res.body.flow).toEqual({
      nodes: [{ id: 'start', type: 'message', content: 'hi' }],
      edges: [],
    });
  });

  test('non-ADMIN role → 403 RBAC_DENIED (verifyRole gate)', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/chatbots')
      .send({ name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.chatbot.create).not.toHaveBeenCalled();
  });

  test('MANAGER role is also denied (only ADMIN passes verifyRole)', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .post('/api/chatbots')
      .send({ name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.chatbot.create).not.toHaveBeenCalled();
  });
});

// ─── GET /:id — get one bot ─────────────────────────────────────────

describe('GET /api/chatbots/:id', () => {
  test('404 when the bot is in another tenant (tenant filter pinned)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue(null); // cross-tenant lookup fails

    const res = await request(app).get('/api/chatbots/77');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.chatbot.findFirst.mock.calls[0][0].where).toEqual({ id: 77, tenantId: 1 });
  });

  test('returns the bot with parsed flow on tenant-owned read', async () => {
    const app = makeApp({ tenantId: 3 });
    prisma.chatbot.findFirst.mockResolvedValue({
      id: 7,
      name: 'My Bot',
      flow: JSON.stringify({ nodes: [{ id: 'a' }], edges: [] }),
      isActive: true,
      tenantId: 3,
    });

    const res = await request(app).get('/api/chatbots/7');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.flow).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });
});

// ─── PUT /:id — update bot ──────────────────────────────────────────

describe('PUT /api/chatbots/:id', () => {
  test('404 when the bot is in another tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue(null);

    const res = await request(app).put('/api/chatbots/55').send({ name: 'changed' });

    expect(res.status).toBe(404);
    expect(prisma.chatbot.update).not.toHaveBeenCalled();
    // Tenant filter pinned on the existence check
    expect(prisma.chatbot.findFirst.mock.calls[0][0].where).toEqual({ id: 55, tenantId: 1 });
  });

  test('partial update — only supplied fields land in update.data', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, name: 'old', flow: '{}', isActive: false, tenantId: 1 });
    prisma.chatbot.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data, flow: data.flow || '{}' })
    );

    const res = await request(app)
      .put('/api/chatbots/9')
      .send({ isActive: true }); // only isActive supplied

    expect(res.status).toBe(200);
    expect(prisma.chatbot.update).toHaveBeenCalledTimes(1);
    const data = prisma.chatbot.update.mock.calls[0][0].data;
    expect(data).toEqual({ isActive: true }); // name + flow NOT in data
    expect(data.name).toBeUndefined();
    expect(data.flow).toBeUndefined();
  });

  test('flow update stringifies JSON before persist', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, name: 'old', flow: '{}', isActive: false, tenantId: 1 });
    prisma.chatbot.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, name: 'old', isActive: false, ...data })
    );

    const newFlow = { nodes: [{ id: 'start', type: 'message', content: 'hello' }], edges: [] };
    const res = await request(app)
      .put('/api/chatbots/9')
      .send({ flow: newFlow });

    expect(res.status).toBe(200);
    const data = prisma.chatbot.update.mock.calls[0][0].data;
    expect(typeof data.flow).toBe('string');
    expect(JSON.parse(data.flow)).toEqual(newFlow);
    // Response decodes flow back
    expect(res.body.flow).toEqual(newFlow);
  });

  test('non-ADMIN role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .put('/api/chatbots/9')
      .send({ name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.chatbot.findFirst).not.toHaveBeenCalled();
    expect(prisma.chatbot.update).not.toHaveBeenCalled();
  });
});

// ─── DELETE /:id — cascade delete ───────────────────────────────────

describe('DELETE /api/chatbots/:id', () => {
  test('404 when the bot is in another tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue(null);

    const res = await request(app).delete('/api/chatbots/55');

    expect(res.status).toBe(404);
    expect(prisma.chatbotConversation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.chatbot.delete).not.toHaveBeenCalled();
  });

  test('cascades — deletes ChatbotConversation rows first, then the bot', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.chatbotConversation.deleteMany.mockResolvedValue({ count: 3 });
    prisma.chatbot.delete.mockResolvedValue({ id: 9 });

    const res = await request(app).delete('/api/chatbots/9');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Both prisma calls happened
    expect(prisma.chatbotConversation.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatbot.delete).toHaveBeenCalledTimes(1);

    // ChatbotConversation.deleteMany scoped by both chatbotId AND tenantId
    expect(prisma.chatbotConversation.deleteMany.mock.calls[0][0].where).toEqual({
      chatbotId: 9,
      tenantId: 1,
    });
    // Final chatbot delete by id
    expect(prisma.chatbot.delete.mock.calls[0][0].where).toEqual({ id: 9 });
  });

  test('non-ADMIN role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' })).delete('/api/chatbots/9');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.chatbot.delete).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/activate + /:id/deactivate ──────────────────────────

describe('POST /api/chatbots/:id/activate', () => {
  test('404 when the bot is in another tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/chatbots/55/activate');

    expect(res.status).toBe(404);
    expect(prisma.chatbot.update).not.toHaveBeenCalled();
  });

  test('flips isActive=true on a tenant-owned bot', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, isActive: false, tenantId: 1, flow: '{}' });
    prisma.chatbot.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data, flow: '{}' })
    );

    const res = await request(app).post('/api/chatbots/9/activate');

    expect(res.status).toBe(200);
    expect(prisma.chatbot.update.mock.calls[0][0]).toEqual({
      where: { id: 9 },
      data: { isActive: true },
    });
  });

  test('non-ADMIN role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' })).post('/api/chatbots/9/activate');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

describe('POST /api/chatbots/:id/deactivate', () => {
  test('flips isActive=false on a tenant-owned bot', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, isActive: true, tenantId: 1, flow: '{}' });
    prisma.chatbot.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data, flow: '{}' })
    );

    const res = await request(app).post('/api/chatbots/9/deactivate');

    expect(res.status).toBe(200);
    expect(prisma.chatbot.update.mock.calls[0][0]).toEqual({
      where: { id: 9 },
      data: { isActive: false },
    });
  });
});

// ─── GET /:id/conversations ────────────────────────────────────────

describe('GET /api/chatbots/:id/conversations', () => {
  test('404 when the bot is in another tenant (tenant filter pinned on parent bot)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/chatbots/77/conversations');

    expect(res.status).toBe(404);
    expect(prisma.chatbotConversation.findMany).not.toHaveBeenCalled();
  });

  test('returns convos with parsed messages and pins take=100 + tenant scope', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.chatbot.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.chatbotConversation.findMany.mockResolvedValue([
      {
        id: 1,
        chatbotId: 9,
        tenantId: 1,
        messages: JSON.stringify([{ from: 'user', text: 'hi' }, { from: 'bot', text: 'hello' }]),
        status: 'ACTIVE',
      },
    ]);

    const res = await request(app).get('/api/chatbots/9/conversations');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].messages).toEqual([
      { from: 'user', text: 'hi' },
      { from: 'bot', text: 'hello' },
    ]);
    // findMany scoped by chatbotId + tenantId + capped at 100
    const args = prisma.chatbotConversation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ chatbotId: 9, tenantId: 1 });
    expect(args.take).toBe(100);
  });
});

// ─── POST /chat/:botId — PUBLIC chat-engine endpoint ───────────────

describe('POST /api/chatbots/chat/:botId — public visitor surface', () => {
  test('400 when visitorId is missing', async () => {
    // Public route — no auth needed, but our test app still mounts a fake
    // req.user injector. That doesn't affect the route's body validation.
    const app = makeApp();
    const res = await request(app)
      .post('/api/chatbots/chat/9')
      .send({ message: 'hi' }); // no visitorId

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visitorId required/i);
    expect(prisma.chatbot.findUnique).not.toHaveBeenCalled();
  });

  test('404 when the bot does not exist', async () => {
    const app = makeApp();
    prisma.chatbot.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/chatbots/chat/999')
      .send({ visitorId: 'visitor-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Bot not found/i);
  });

  test('inactive bot WITHOUT matching previewTenantId → 403', async () => {
    const app = makeApp();
    prisma.chatbot.findUnique.mockResolvedValue({
      id: 9,
      tenantId: 1,
      isActive: false,
      flow: JSON.stringify({ nodes: [], edges: [] }),
    });

    const res = await request(app)
      .post('/api/chatbots/chat/9')
      .send({ visitorId: 'visitor-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not active/i);
    expect(prisma.chatbotConversation.create).not.toHaveBeenCalled();
  });

  test('inactive bot WITH matching previewTenantId → 200 (preview mode, #646 contract)', async () => {
    const app = makeApp();
    prisma.chatbot.findUnique.mockResolvedValue({
      id: 9,
      tenantId: 1,
      isActive: false, // inactive
      flow: JSON.stringify({
        nodes: [{ id: 'start', type: 'message', content: 'Welcome!' }],
        edges: [],
      }),
    });
    prisma.chatbotConversation.findFirst.mockResolvedValue(null); // no existing convo
    prisma.chatbotConversation.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 555, ...data })
    );

    const res = await request(app)
      .post('/api/chatbots/chat/9')
      .send({ visitorId: 'preview-visitor', previewTenantId: 1 }); // matches bot.tenantId

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Welcome!');
    expect(res.body.conversationId).toBe(555);
    // Convo persisted with bot.tenantId (NOT req.user.tenantId — public surface)
    const data = prisma.chatbotConversation.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(1);
    expect(data.chatbotId).toBe(9);
    expect(data.visitorId).toBe('preview-visitor');
  });

  test('first-touch on an active bot starts the flow with the start-node content', async () => {
    const app = makeApp();
    prisma.chatbot.findUnique.mockResolvedValue({
      id: 9,
      tenantId: 1,
      isActive: true,
      flow: JSON.stringify({
        nodes: [
          { id: 'n1', type: 'message', content: 'Hi there!' },
          { id: 'n2', type: 'end' },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      }),
    });
    prisma.chatbotConversation.findFirst.mockResolvedValue(null);
    prisma.chatbotConversation.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data })
    );

    const res = await request(app)
      .post('/api/chatbots/chat/9')
      .send({ visitorId: 'v-1' }); // no message — first touch

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Hi there!');
    // The flow reaches `end` so the engine reports completed=true.
    expect(res.body.completed).toBe(true);
    expect(res.body.requiresInput).toBe(false);
    expect(res.body.conversationId).toBe(1);

    // Convo status pinned: COMPLETED when engine ends, ACTIVE otherwise.
    const createArgs = prisma.chatbotConversation.create.mock.calls[0][0].data;
    expect(createArgs.status).toBe('COMPLETED');
  });

  test('flow-less bot returns graceful "no flow configured" envelope (no 500)', async () => {
    const app = makeApp();
    prisma.chatbot.findUnique.mockResolvedValue({
      id: 9,
      tenantId: 1,
      isActive: true,
      flow: null, // null flow → parsed as { nodes: [], edges: [] } → no start node
    });
    prisma.chatbotConversation.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/chatbots/chat/9')
      .send({ visitorId: 'v-1' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/no flow configured/i);
    expect(res.body.completed).toBe(true);
    expect(res.body.requiresInput).toBe(false);
    // No convo persisted for the flow-less short-circuit
    expect(prisma.chatbotConversation.create).not.toHaveBeenCalled();
    expect(prisma.chatbotConversation.update).not.toHaveBeenCalled();
  });
});
