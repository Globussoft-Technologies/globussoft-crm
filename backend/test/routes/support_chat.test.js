// @ts-check
/**
 * /api/support-chat — Wellness Admin Support Chatbot route contract.
 *
 * Pins backend/routes/support_chat.js over the services/supportChatbot
 * orchestrator:
 *
 *   POST /message
 *     - 401 without a token
 *     - 403 WELLNESS_TENANT_REQUIRED on a non-wellness tenant
 *     - 400 MISSING_MESSAGE on an empty body
 *     - happy path: BYOK config → tool loop (search_help_docs round then a
 *       prose round) → { reply, links, toolsUsed } + 2 LlmCallLog rows with
 *       task='support-chat'; KB article deep links are suppressed until the
 *       /portal/kb/:slug page is wired. Upstream fetch carries the BYOK key,
 *       never the internal one
 *     - 503 AI_PROVIDER_NOT_CONFIGURED in production without BYOK
 *   GET /analytics
 *     - ADMIN → rollup over LlmCallLog task='support-chat' rows
 *     - USER  → 403 RBAC_DENIED
 *
 * Pattern mirrors test/routes/tenant_settings.test.js: prisma singleton
 * patched BEFORE requiring the router; real JWTs signed with the same dev
 * fallback secret; verifyToken + verifyRole stay live. The LLM HTTP layer
 * is stubbed via vi.stubGlobal('fetch', ...) — the adapters resolve fetch
 * lazily at call time.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Patch prisma BEFORE requiring the router ─────────────────────────
prisma.tenantSetting = { findUnique: vi.fn() };
prisma.kbArticle = { findMany: vi.fn() };
prisma.llmCallLog = { create: vi.fn(), findMany: vi.fn() };
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const supportChatRouter = requireCJS('../../routes/support_chat');

const BYOK_KEY = 'sk-byok-test-key-000111222';
const BYOK_BLOB = JSON.stringify({
  provider: 'gemini',
  apiKey: BYOK_KEY,
  model: 'gemini-2.5-flash-lite',
  baseUrl: 'https://generativelanguage.googleapis.com',
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/support-chat', supportChatRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1, vertical = 'wellness' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, vertical, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function geminiResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const TOOL_CALL_BODY = {
  candidates: [
    {
      content: {
        parts: [
          { functionCall: { name: 'search_help_docs', args: { query: 'reschedule appointment' } } },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
};

const PROSE_BODY = {
  candidates: [
    {
      content: {
        parts: [{ text: 'Open Appointments, select the booking and choose Reschedule. See "Managing Appointments".' }],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12, totalTokenCount: 32 },
};

let fetchMock;

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue({ value: BYOK_BLOB });
  prisma.kbArticle.findMany.mockReset().mockResolvedValue([
    {
      id: 11,
      title: 'Managing Appointments',
      slug: 'managing-appointments',
      content: 'To reschedule an appointment, open it from the Appointments page and pick a new slot.',
    },
  ]);
  prisma.llmCallLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.llmCallLog.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });

  // Default: tool-call round, then prose round.
  fetchMock = vi
    .fn()
    .mockResolvedValueOnce(geminiResponse(TOOL_CALL_BODY))
    .mockResolvedValueOnce(geminiResponse(PROSE_BODY));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/support-chat/message', () => {
  test('401 without a token', async () => {
    const res = await request(makeApp()).post('/api/support-chat/message').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  test('403 WELLNESS_TENANT_REQUIRED on a non-wellness tenant', async () => {
    const res = await request(makeApp())
      .post('/api/support-chat/message')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { vertical: 'generic' })}`)
      .send({ message: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_TENANT_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('400 MISSING_MESSAGE on an empty message', async () => {
    const res = await request(makeApp())
      .post('/api/support-chat/message')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_MESSAGE');
  });

  test('happy path: tool loop → reply + cost logs', async () => {
    const res = await request(makeApp())
      .post('/api/support-chat/message')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        message: 'How do I reschedule an appointment?',
        history: [],
        pageContext: { path: '/wellness/appointments', pageName: 'Appointments' },
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/Reschedule/);
    expect(res.body.toolsUsed).toContain('search_help_docs');
    // KB-article deep links are intentionally suppressed until the /portal/kb/:slug
    // reader page exists in the SPA; only get_page_info routes become buttons.
    expect(res.body.links).toEqual([]);

    // Two LLM rounds → two calls, both against the BYOK endpoint + key.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    expect(init.headers.Authorization).toBe(`Bearer ${BYOK_KEY}`);
    expect(init.headers['x-goog-api-key']).toBe(BYOK_KEY);

    // The KB search ran tenant-scoped + published-only.
    expect(prisma.kbArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, isPublished: true }),
      }),
    );

    // Cost tracking: one LlmCallLog per LLM round, task='support-chat'.
    expect(prisma.llmCallLog.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.llmCallLog.create.mock.calls) {
      expect(call[0].data).toEqual(
        expect.objectContaining({
          tenantId: 1,
          task: 'support-chat',
          userId: 7,
          status: 'success',
        }),
      );
    }
    expect(prisma.llmCallLog.create.mock.calls[0][0].data.totalTokens).toBe(15);
    expect(prisma.llmCallLog.create.mock.calls[1][0].data.totalTokens).toBe(32);
  });

  test('503 AI_PROVIDER_NOT_CONFIGURED in production without BYOK', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(makeApp())
      .post('/api/support-chat/message')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ message: 'hello' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(res.body.error).toMatch(/Settings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('upstream provider failure → 502 AI_PROVIDER_ERROR + failed log row', async () => {
    fetchMock.mockReset().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    });
    const res = await request(makeApp())
      .post('/api/support-chat/message')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ message: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_PROVIDER_ERROR');
    expect(prisma.llmCallLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ task: 'support-chat', status: 'failed' }),
      }),
    );
  });
});

describe('GET /api/support-chat/analytics', () => {
  test('ADMIN gets the rollup over task=support-chat rows', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costEstimate: 0.0001,
        status: 'success',
        createdAt: new Date('2026-07-20T10:00:00Z'),
      },
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
        costEstimate: 0.0002,
        status: 'failed',
        createdAt: new Date('2026-07-20T09:00:00Z'),
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
        costEstimate: 0.0003,
        status: 'success',
        createdAt: new Date('2026-07-19T09:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/support-chat/analytics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.llmCallLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, task: 'support-chat' },
      }),
    );
    expect(res.body.totalCalls).toBe(3);
    expect(res.body.failedCalls).toBe(1);
    expect(res.body.totalTokens).toBe(55);
    expect(res.body.promptTokens).toBe(35);
    expect(res.body.totalCostUsd).toBeCloseTo(0.0006, 6);
    const gemini = res.body.byProvider.find((p) => p.provider === 'gemini');
    expect(gemini).toEqual(expect.objectContaining({ calls: 2, totalTokens: 45 }));
    const openai = res.body.byProvider.find((p) => p.provider === 'openai');
    expect(openai).toEqual(expect.objectContaining({ calls: 1, totalTokens: 10 }));
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/support-chat/analytics')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});
