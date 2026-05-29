// @ts-check
/**
 * Marketing/Support polish — pin GET /api/chatbots/stats contract.
 *
 * Issue context
 * ─────────────
 *   chatbots.js was a 405-LOC chatbot/intent-flow management route with
 *   NO tenant-wide aggregate endpoint. The Marketing → Chatbots dashboard
 *   needs a single KPI roundtrip ({totalBots, activeBots, inactiveBots,
 *   byBotStatus, totalConversations, byConversationStatus, lastCreatedAt})
 *   instead of N+1 queries (list + count(isActive=true) + groupBy(status)).
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from (independent validation).
 *   - 400 INVALID_DATE on bad ?to (independent validation).
 *   - Empty-tenant happy path: zeroed envelope + byBotStatus={active:0,
 *     inactive:0} + byConversationStatus={ACTIVE:0,COMPLETED:0,ABANDONED:0}
 *     + lastCreatedAt=null. Conversation groupBy NOT called when bots=[].
 *   - Happy path: 5 bots (3 active, 2 inactive) + groupBy returns conversation
 *     status spread → byBotStatus + byConversationStatus + totalConversations
 *     correct.
 *   - lastCreatedAt picks the maximum Chatbot.createdAt as ISO string.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId.
 *   - ?from/?to narrows the window via createdAt clauses on the prisma query.
 *   - Conversation groupBy is scoped to the WINDOW-matching bot ids (not
 *     the tenant's entire bot population) so date filters propagate.
 *   - NO audit row written (read-only meta surface).
 *   - byBotStatus and byConversationStatus envelopes are present even when
 *     specific buckets are zero (stable shape for frontend KPI tiles).
 *
 * Schema reality (verified against prisma/schema.prisma → models
 * Chatbot + ChatbotConversation lines 2119+2130):
 *   - Chatbot has NO channel column. The prompt's "byChannel" envelope
 *     is intentionally omitted; bot status (isActive) is the only
 *     available dimension. ChatbotConversation.status fills the second
 *     dimension via byConversationStatus.
 *
 * Pattern reference: backend/test/routes/sequences-stats.test.js — patches
 * the prisma singleton with vi.fn() BEFORE requiring the router, drives
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.chatbot = prisma.chatbot || {};
prisma.chatbot.findMany = vi.fn();
prisma.chatbotConversation = prisma.chatbotConversation || {};
prisma.chatbotConversation.groupBy = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const chatbotsRouter = requireCJS('../../routes/chatbots');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chatbots', chatbotsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.chatbot.findMany.mockReset();
  prisma.chatbotConversation.groupBy.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/chatbots/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/chatbots/stats');
    expect(res.status).toBe(401);
    expect(prisma.chatbot.findMany).not.toHaveBeenCalled();
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.chatbot.findMany).not.toHaveBeenCalled();
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats?to=also-bad')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.chatbot.findMany).not.toHaveBeenCalled();
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });

  test('empty-tenant happy path: zeroed envelope + stable bucket shape + lastCreatedAt=null', async () => {
    prisma.chatbot.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalBots: 0,
      activeBots: 0,
      inactiveBots: 0,
      byBotStatus: { active: 0, inactive: 0 },
      totalConversations: 0,
      byConversationStatus: { ACTIVE: 0, COMPLETED: 0, ABANDONED: 0 },
      lastCreatedAt: null,
    });
    // Conversation groupBy is skipped when there are zero bots to scope to.
    expect(prisma.chatbotConversation.groupBy).not.toHaveBeenCalled();
  });

  test('happy path: 5 bots (3 active, 2 inactive) + conversations spread across statuses', async () => {
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, isActive: true,  createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true,  createdAt: new Date('2026-05-02T10:00:00Z') },
      { id: 3, isActive: true,  createdAt: new Date('2026-05-03T10:00:00Z') },
      { id: 4, isActive: false, createdAt: new Date('2026-05-04T10:00:00Z') },
      { id: 5, isActive: false, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([
      { status: 'ACTIVE',    _count: { _all: 7 } },
      { status: 'COMPLETED', _count: { _all: 4 } },
      { status: 'ABANDONED', _count: { _all: 2 } },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalBots).toBe(5);
    expect(res.body.activeBots).toBe(3);
    expect(res.body.inactiveBots).toBe(2);
    expect(res.body.byBotStatus).toEqual({ active: 3, inactive: 2 });
    expect(res.body.totalConversations).toBe(13);
    expect(res.body.byConversationStatus).toEqual({
      ACTIVE: 7,
      COMPLETED: 4,
      ABANDONED: 2,
    });
  });

  test('lastCreatedAt picks the maximum Chatbot.createdAt as ISO string', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, isActive: true,  createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true,  createdAt: newest }, // newest
      { id: 3, isActive: false, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.chatbot.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const botWhere = prisma.chatbot.findMany.mock.calls[0][0].where;
    expect(botWhere.tenantId).toBe(42);
  });

  test('?from/?to narrows the window via createdAt clauses on the prisma query', async () => {
    prisma.chatbot.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/chatbots/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const botWhere = prisma.chatbot.findMany.mock.calls[0][0].where;
    expect(botWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(botWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('conversation groupBy is scoped to the window-matching bot ids (not all tenant bots)', async () => {
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 11, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 22, isActive: true, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 5 } },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 9 })}`);

    expect(res.status).toBe(200);
    const groupArgs = prisma.chatbotConversation.groupBy.mock.calls[0][0];
    expect(groupArgs.where.tenantId).toBe(9);
    expect(groupArgs.where.chatbotId).toEqual({ in: [11, 22] });
    expect(groupArgs.by).toEqual(['status']);
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.chatbotConversation.groupBy.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('byConversationStatus envelope stays stable when some buckets are absent from groupBy result', async () => {
    prisma.chatbot.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    // groupBy only returns ACTIVE rows — COMPLETED + ABANDONED stay at 0.
    prisma.chatbotConversation.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 3 } },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byConversationStatus).toEqual({
      ACTIVE: 3,
      COMPLETED: 0,
      ABANDONED: 0,
    });
    expect(res.body.totalConversations).toBe(3);
  });

  test('USER role can also call /stats (mirrors GET / list auth — not admin-only)', async () => {
    prisma.chatbot.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/chatbots/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalBots).toBe(0);
  });
});
