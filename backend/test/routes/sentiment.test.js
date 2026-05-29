// @ts-check
/**
 * Unit tests for backend/routes/sentiment.js — pin the contract of the
 * Sentiment Analysis read + recalculate surface (companion to the existing
 * cron-engine test at backend/test/cron/sentimentEngine.test.js).
 *
 * Why this file exists
 * ────────────────────
 * routes/sentiment.js (214 LOC) had ZERO route-level vitest coverage. The
 * only sentiment test was for the cron engine itself (analyzeMessage and
 * tickSentimentEngine). The route exposes five endpoints that the support
 * dashboard, the agent-triage queue, and the marketing-attribution KPI
 * tile all read from. Silent contract drift on the response envelope
 * (e.g. flipping `counts` → `byCategory`, dropping the `trend` field, or
 * losing tenant scoping on /negative-recent) would silently red the
 * downstream UI tiles without any deploy-gate signal.
 *
 * Endpoints under test
 * ────────────────────
 *   1. POST /analyze                    — stateless ad-hoc analysis
 *   2. POST /analyze-message/:emailId   — analyze + persist a stored email
 *   3. POST /analyze-batch              — batch analyze + persist
 *   4. GET  /stats                      — counts + avgScore + 30-day trend
 *   5. GET  /negative-recent            — most-recent negative emails
 *
 * Cases (15 total)
 * ────────────────
 *   /analyze: 400 when text missing; 400 when text non-string; 200 happy (3)
 *   /analyze-message: 400 invalid id; 404 cross-tenant; 200 persists +
 *     returns id/sentiment/score (3)
 *   /analyze-batch: 400 when emailIds missing/empty; 200 tenant-scoped
 *     findMany; 200 envelope shape includes requested/processed/results;
 *     200 ids hard-cap at 200 (4)
 *   /stats: 200 envelope { counts, total, avgScore, trend } with
 *     tenant-scoped groupBy + 30-day window (1)
 *   /negative-recent: 200 default limit=20; clamps limit>100 to 100;
 *     200 tenant-scoped + sentiment='negative' + includes contact (3)
 *   bonus: /analyze 500 when engine throws (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — fake-auth middleware to
 * populate req.user, prisma singleton monkey-patch BEFORE requiring the
 * router, and sentimentEngine.analyzeMessage swapped on module-exports so
 * the destructured route binding captures the mock.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── auth middleware monkey-patch (CJS self-mocking seam) ───────────────
// routes/sentiment.js does
//   const { verifyToken } = require("../middleware/auth");
// at module-load. We patch the module's verifyToken export to a passthrough
// BEFORE the router is required so the destructured reference picks it up.
// Same pattern as backend/test/routes/accounting.test.js.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.findFirst = vi.fn();
prisma.emailMessage.findMany = vi.fn();
prisma.emailMessage.update = vi.fn();
prisma.emailMessage.groupBy = vi.fn();
// eventBus's best-effort emit walks automationRule.findMany — stub.
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── sentimentEngine singleton patching (CJS self-mocking seam) ─────────
// routes/sentiment.js does
//   const { analyzeMessage } = require("../cron/sentimentEngine");
// at module-load, so we must patch the module-exports' analyzeMessage
// property BEFORE the router is required.
const sentimentEngine = requireCJS('../../cron/sentimentEngine');
sentimentEngine.analyzeMessage = vi.fn();

// ── eventBus stubs (best-effort emit) ──────────────────────────────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const sentimentRouter = requireCJS('../../routes/sentiment');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Sentiment routes don't gate on a specific role
 * (only the global verifyToken in server.js), but we still surface role
 * for future-proofing.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'USER' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/sentiment', sentimentRouter);
  return app;
}

beforeEach(() => {
  prisma.emailMessage.findFirst.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.update.mockReset();
  prisma.emailMessage.groupBy.mockReset();
  sentimentEngine.analyzeMessage.mockReset();

  // Sensible defaults — individual tests override.
  prisma.emailMessage.findFirst.mockResolvedValue(null);
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.update.mockResolvedValue({ id: 1 });
  prisma.emailMessage.groupBy.mockResolvedValue([]);
  sentimentEngine.analyzeMessage.mockResolvedValue({
    sentiment: 'neutral',
    sentimentScore: 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /analyze — stateless ad-hoc analysis
// ─────────────────────────────────────────────────────────────────────────

describe('POST /analyze — stateless analysis', () => {
  test('400 when text missing', async () => {
    const res = await request(makeApp())
      .post('/api/sentiment/analyze')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
    expect(sentimentEngine.analyzeMessage).not.toHaveBeenCalled();
  });

  test('400 when text is non-string (number)', async () => {
    const res = await request(makeApp())
      .post('/api/sentiment/analyze')
      .send({ text: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
    expect(sentimentEngine.analyzeMessage).not.toHaveBeenCalled();
  });

  test('200 returns { sentiment, sentimentScore } from engine', async () => {
    sentimentEngine.analyzeMessage.mockResolvedValue({
      sentiment: 'positive',
      sentimentScore: 0.85,
    });

    const res = await request(makeApp())
      .post('/api/sentiment/analyze')
      .send({ text: 'I love the product!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sentiment: 'positive', sentimentScore: 0.85 });
    expect(sentimentEngine.analyzeMessage).toHaveBeenCalledWith('I love the product!');
  });

  test('500 when engine throws', async () => {
    sentimentEngine.analyzeMessage.mockRejectedValue(new Error('gemini boom'));

    const res = await request(makeApp())
      .post('/api/sentiment/analyze')
      .send({ text: 'whatever' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/analyze/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /analyze-message/:emailId — analyze + persist a stored email
// ─────────────────────────────────────────────────────────────────────────

describe('POST /analyze-message/:emailId — analyze stored email', () => {
  test('400 when emailId is not a number', async () => {
    const res = await request(makeApp())
      .post('/api/sentiment/analyze-message/not-an-int')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid emailid/i);
    expect(prisma.emailMessage.findFirst).not.toHaveBeenCalled();
  });

  test('404 when email belongs to a different tenant (findFirst returns null)', async () => {
    prisma.emailMessage.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sentiment/analyze-message/777')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/email not found/i);
    expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });

  test('200 analyzes message body, persists result, returns { id, sentiment, sentimentScore }', async () => {
    prisma.emailMessage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, body: 'Order delayed again.',
    });
    sentimentEngine.analyzeMessage.mockResolvedValue({
      sentiment: 'negative', sentimentScore: -0.6,
    });
    prisma.emailMessage.update.mockResolvedValue({
      id: 50, sentiment: 'negative', sentimentScore: -0.6,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sentiment/analyze-message/50')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 50, sentiment: 'negative', sentimentScore: -0.6 });
    expect(sentimentEngine.analyzeMessage).toHaveBeenCalledWith('Order delayed again.');
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { sentiment: 'negative', sentimentScore: -0.6 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /analyze-batch — batch analyze + persist
// ─────────────────────────────────────────────────────────────────────────

describe('POST /analyze-batch — batch analyze', () => {
  test('400 when emailIds missing', async () => {
    const res = await request(makeApp())
      .post('/api/sentiment/analyze-batch')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/emailids/i);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });

  test('400 when emailIds is an empty array', async () => {
    const res = await request(makeApp())
      .post('/api/sentiment/analyze-batch')
      .send({ emailIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/emailids/i);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });

  test('200 tenant-scoped findMany + per-message update + envelope { requested, processed, results, errors }', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { id: 10, body: 'great!' },
      { id: 11, body: 'meh' },
    ]);
    sentimentEngine.analyzeMessage
      .mockResolvedValueOnce({ sentiment: 'positive', sentimentScore: 0.8 })
      .mockResolvedValueOnce({ sentiment: 'neutral', sentimentScore: 0 });
    prisma.emailMessage.update.mockResolvedValue({ id: 1 });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/sentiment/analyze-batch')
      .send({ emailIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.processed).toBe(2);
    expect(res.body.results).toEqual([
      { id: 10, sentiment: 'positive', sentimentScore: 0.8 },
      { id: 11, sentiment: 'neutral', sentimentScore: 0 },
    ]);
    expect(res.body.errors).toEqual([]);
    // Tenant scoping on findMany.
    expect(prisma.emailMessage.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 11] }, tenantId: 42 },
    });
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(2);
  });

  test('200 caps requested ids at 200 (hard limit, no runaway)', async () => {
    // 300 distinct ids — route should truncate to 200 before issuing findMany.
    const tooMany = Array.from({ length: 300 }, (_, i) => i + 1);
    prisma.emailMessage.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sentiment/analyze-batch')
      .send({ emailIds: tooMany });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(200);
    const findArg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(findArg.where.id.in.length).toBe(200);
    expect(findArg.where.tenantId).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /stats — counts + avgScore + 30-day trend
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stats — sentiment KPI summary', () => {
  test('200 envelope { counts, total, avgScore, trend } with tenant-scoped groupBy + 30-day window', async () => {
    prisma.emailMessage.groupBy.mockResolvedValue([
      { sentiment: 'positive', _count: { _all: 10 }, _avg: { sentimentScore: 0.6 } },
      { sentiment: 'neutral',  _count: { _all: 5 },  _avg: { sentimentScore: 0 } },
      { sentiment: 'negative', _count: { _all: 3 },  _avg: { sentimentScore: -0.5 } },
    ]);
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    prisma.emailMessage.findMany.mockResolvedValue([
      { sentiment: 'positive', sentimentScore: 0.7, createdAt: today },
      { sentiment: 'negative', sentimentScore: -0.5, createdAt: today },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/sentiment/stats');

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ positive: 10, neutral: 5, negative: 3 });
    expect(res.body.total).toBe(18);
    // weightedScoreSum = 0.6*10 + 0*5 + -0.5*3 = 4.5; totalScored=18; avg=0.25
    expect(res.body.avgScore).toBeCloseTo(0.25, 2);
    expect(Array.isArray(res.body.trend)).toBe(true);
    expect(res.body.trend.length).toBe(1);
    expect(res.body.trend[0]).toMatchObject({
      date: todayKey,
      positive: 1,
      negative: 1,
      neutral: 0,
    });
    // Tenant scoping on groupBy + sentiment != null guard.
    expect(prisma.emailMessage.groupBy).toHaveBeenCalledWith({
      by: ['sentiment'],
      where: { tenantId: 1, sentiment: { not: null } },
      _count: { _all: true },
      _avg: { sentimentScore: true },
    });
    // 30-day window on the trend findMany.
    const findArg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(1);
    expect(findArg.where.sentiment).toEqual({ not: null });
    expect(findArg.where.createdAt.gte).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /negative-recent — needs-attention alert list
// ─────────────────────────────────────────────────────────────────────────

describe('GET /negative-recent — recent negative emails', () => {
  test('200 default limit=20, tenant-scoped + sentiment=negative + includes contact', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { id: 1, body: 'angry', sentiment: 'negative', sentimentScore: -0.8, contact: { id: 5, name: 'Acme' } },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/sentiment/negative-recent');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.messages).toHaveLength(1);
    const arg = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 1, sentiment: 'negative' });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(20);
    expect(arg.include).toEqual({
      contact: { select: { id: true, name: true, email: true, company: true } },
    });
  });

  test('200 honors ?limit=5 (below default)', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/sentiment/negative-recent?limit=5');

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.findMany.mock.calls[0][0].take).toBe(5);
  });

  test('200 clamps ?limit=999 to 100 (hard cap)', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/sentiment/negative-recent?limit=999');

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.findMany.mock.calls[0][0].take).toBe(100);
  });
});
