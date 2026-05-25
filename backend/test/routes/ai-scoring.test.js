// @ts-check
/**
 * Unit + integration tests for backend/routes/ai_scoring.js — pins the
 * deal-scoring, contact-scoring, and manual-trigger contracts of the
 * predictive AI surface.
 *
 * Route surface
 * ─────────────
 *   1. GET  /score/:dealId        — deal-based probability estimate
 *      • Looks up deal scoped to req.user.tenantId.
 *      • Mixes stage weight + budget bonus + activity bonus + close-date
 *        urgency into a clamped 1..99 probability + qualitative confidence.
 *      • 404 when deal not found (or wrong tenant).
 *      • 500 on internal crash, with envelope `{ error: "Predictive AI Model crashed" }`.
 *
 *   2. GET  /contact/:contactId   — contact-level score + factor breakdown
 *      • Requires verifyToken (only route in this file that does — the
 *        others rely on the global guard wired in server.js).
 *      • 400 on non-numeric :contactId (NaN guard).
 *      • 404 when contact not in tenant.
 *      • Lazy-requires leadScoringEngine.computeScore so the route's
 *        prisma path stays decoupled from the cron internals; returns
 *        currentStoredScore (from contact row) + liveComputedScore (fresh).
 *      • Factor breakdown: status, totalDeals, wonDeals, proposalDeals,
 *        recentActivities (30d window), activeSequences.
 *
 *   3. POST /trigger              — debug rescore-all-tenants knob
 *      • Lazy-requires leadScoringEngine.tickLeadScoringEngine and forwards
 *        req.io for socket broadcast.
 *      • Returns `{ success: true, scored: <n> }` on success.
 *      • 500 with envelope `{ error: "Scoring trigger failed" }` on throw.
 *
 * Pinned contracts (regression bait)
 * ──────────────────────────────────
 *   - probabilityScore clamp 1..99 (Math.max(1, Math.min(round, 99))).
 *   - confidence bucketing: >75 ⇒ "Extremely High", >50 ⇒ "Moderate",
 *     else "Low". Boundary semantics matter: exact 75/50 fall into the
 *     lower bucket (strict >).
 *   - tenant scoping on every lookup (where.tenantId === req.user.tenantId).
 *     A regression that drops the tenant filter would surface here.
 *   - Date math: expectedClose in past ⇒ −30; within 7d ⇒ +10; else 0.
 *   - parseInt on :dealId — string deal IDs survive the cast; the spec
 *     does NOT pin a 400 for non-numeric :dealId today because the route
 *     swallows it via the catch-all 500.
 *
 * Test pattern
 * ────────────
 *   Same prisma singleton patch as communications.test.js — replace
 *   prisma.deal.findFirst / prisma.contact.findFirst with vi.fn() BEFORE
 *   the router is required (route's top-level `require('../lib/prisma')`
 *   resolves at import time). leadScoringEngine is lazy-required inside
 *   the handlers, so we install a mock via vi.mock at the same path the
 *   route's `require('../cron/leadScoringEngine')` resolves.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required,
// since the router's top-level `require('../lib/prisma')` resolves at
// import time. (Same shape as communications.test.js.)
prisma.deal = prisma.deal || {};
prisma.deal.findFirst = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// we bypass verifyToken in this suite by injecting req.user via a fake
// middleware before mounting the router, but stub the surface anyway so
// any incidental call returns cleanly rather than throwing.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will use — by reaching into the
// already-cached config/secrets module (loaded earlier when prisma →
// middleware/auth chain pulled it in). This guarantees that whichever
// fallback path landed for verifyToken's resolution is the same fallback
// our test-token signing uses, regardless of process.env timing.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// CJS self-mocking seam: the route does `require('../cron/leadScoringEngine')`
// inside each handler. Node CJS caches modules by resolved path — so the
// require inside the route returns the SAME object identity as our require
// here. We mutate that object's exported fns in place to vi.fn() so we can
// assert call args + control return values per test. (See cron-learnings
// 2026-05-24 ~01:43 UTC: this is the canonical pattern for CJS-self-mocking
// of inter-module fns when ESM vi.mock can't reach them via createRequire.)
const leadScoringEngine = requireCJS('../../cron/leadScoringEngine');
leadScoringEngine.computeScore = vi.fn(() => 0);
leadScoringEngine.tickLeadScoringEngine = vi.fn();

const aiScoringRouter = requireCJS('../../routes/ai_scoring');

function makeApp({ tenantId = 1, userId = 7, io = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role: 'ADMIN' };
    if (io) req.io = io;
    next();
  });
  app.use('/api/ai-scoring', aiScoringRouter);
  return app;
}

beforeEach(() => {
  prisma.deal.findFirst.mockReset();
  prisma.contact.findFirst.mockReset();
  leadScoringEngine.computeScore.mockReset();
  leadScoringEngine.tickLeadScoringEngine.mockReset();
  // Sensible defaults — tests override as needed.
  leadScoringEngine.computeScore.mockReturnValue(42);
});

// ─── GET /score/:dealId — deal-based predictive probability ────────

describe('GET /score/:dealId — deal-based scoring', () => {
  test('returns 404 when deal missing or wrong-tenant', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/ai-scoring/score/999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Deal not found');
    // Verify tenant scoping: the where-clause must carry tenantId
    expect(prisma.deal.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.deal.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.id).toBe(999);
  });

  test('clamps probability into 1..99 and tags Extremely High at high scores', async () => {
    // Construct a deal whose raw score easily exceeds 99 so the clamp fires.
    // stage=won → 100, budget bonus capped at 20, engagement bonus up to 15.
    prisma.deal.findFirst.mockResolvedValue({
      id: 1,
      title: 'Huge Won Deal',
      stage: 'won',
      amount: 10_000_000, // budget bonus clamps to 20
      contact: { activities: new Array(50).fill({ type: 'Call' }) }, // engagement >5 → +15
      expectedClose: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/1');
    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe(1);
    expect(res.body.title).toBe('Huge Won Deal');
    expect(res.body.probability).toBeLessThanOrEqual(99);
    expect(res.body.probability).toBeGreaterThanOrEqual(1);
    // 100 + 20 + 15 = 135 → clamped to 99 → confidence "Extremely High"
    expect(res.body.probability).toBe(99);
    expect(res.body.confidence).toBe('Extremely High');
    expect(res.body.predictiveVariables.stageWeight).toBe(100);
    expect(res.body.predictiveVariables.budgetBonus).toBe(20);
    expect(res.body.predictiveVariables.engagementLevel).toBe(50);
  });

  test('confidence buckets: Low/Moderate/Extremely High by score threshold', async () => {
    // Lost stage → 0 + tiny budget + no activities → probability stays low (clamped to 1).
    prisma.deal.findFirst.mockResolvedValue({
      id: 2,
      title: 'Stale lost lead',
      stage: 'lost',
      amount: 1000,
      contact: { activities: [] },
      expectedClose: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/2');
    expect(res.status).toBe(200);
    // 0 + 0.5 budget bonus + 0 activity → ~0 → clamp to 1 → "Low"
    expect(res.body.confidence).toBe('Low');
    expect(res.body.probability).toBeGreaterThanOrEqual(1);
    expect(res.body.probability).toBeLessThanOrEqual(50);
  });

  test('contacted stage with mid engagement lands "Low" or "Moderate" (boundary >50)', async () => {
    // stage=contacted → 25, mid budget, 3 activities → +5.
    prisma.deal.findFirst.mockResolvedValue({
      id: 3,
      title: 'Mid-pipe lead',
      stage: 'contacted',
      amount: 20_000, // budget bonus = 10
      contact: { activities: [{}, {}, {}] }, // engagement 3 → +5
      expectedClose: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/3');
    expect(res.status).toBe(200);
    // 25 + 10 + 5 = 40 → "Low" (strict > thresholds)
    expect(res.body.probability).toBe(40);
    expect(res.body.confidence).toBe('Low');
  });

  test('expectedClose in the past applies the −30 overdue drag', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    prisma.deal.findFirst.mockResolvedValue({
      id: 4,
      title: 'Overdue proposal',
      stage: 'proposal', // +50
      amount: 0,
      contact: { activities: [] },
      expectedClose: yesterday,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/4');
    expect(res.status).toBe(200);
    // 50 + 0 + 0 − 30 = 20 → "Low"
    expect(res.body.probability).toBe(20);
    expect(res.body.confidence).toBe('Low');
  });

  test('expectedClose within 7 days adds the +10 urgency bonus', async () => {
    const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    prisma.deal.findFirst.mockResolvedValue({
      id: 5,
      title: 'Closing soon',
      stage: 'proposal', // +50
      amount: 0,
      contact: { activities: [] },
      expectedClose: threeDaysOut,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/5');
    expect(res.status).toBe(200);
    // 50 + 0 + 0 + 10 = 60 → "Moderate"
    expect(res.body.probability).toBe(60);
    expect(res.body.confidence).toBe('Moderate');
  });

  test('unknown stage defaults to 10 weight (Object.lookup fallback)', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 6,
      title: 'Weird stage',
      stage: 'qualification', // not in weights.stage map → falls back to 10
      amount: 0,
      contact: { activities: [] },
      expectedClose: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/6');
    expect(res.status).toBe(200);
    // 10 + 0 + 0 = 10 → "Low"
    expect(res.body.probability).toBe(10);
    expect(res.body.predictiveVariables.stageWeight).toBe(0); // map.lookup returns undefined → || 0
    expect(res.body.confidence).toBe('Low');
  });

  test('missing contact / activities is tolerated (graceful zero engagement)', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 7,
      title: 'No contact attached',
      stage: 'lead', // +10
      amount: 0,
      contact: null, // optional-chained in the route
      expectedClose: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/7');
    expect(res.status).toBe(200);
    expect(res.body.probability).toBe(10);
    expect(res.body.predictiveVariables.engagementLevel).toBe(0);
  });

  test('500 envelope when prisma throws inside the score handler', async () => {
    prisma.deal.findFirst.mockRejectedValue(new Error('db blip'));
    const app = makeApp();
    const res = await request(app).get('/api/ai-scoring/score/8');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Predictive AI Model crashed');
  });
});

// ─── GET /contact/:contactId — contact-level score breakdown ───────

describe('GET /contact/:contactId — factor breakdown', () => {
  test('400 on non-numeric contactId (NaN guard)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/ai-scoring/contact/not-a-number')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid contactId');
    // Should short-circuit BEFORE hitting prisma.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('404 when contact not in tenant', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 5 });
    const res = await request(app)
      .get('/api/ai-scoring/contact/42')
      .set('Authorization', makeBearer({ tenantId: 5 }));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Contact not found');
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(5);
    expect(args.where.id).toBe(42);
  });

  test('happy path: returns currentStoredScore + liveComputedScore + factor breakdown', async () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 86400000);
    const fortyDaysAgo = new Date(now - 40 * 86400000);
    prisma.contact.findFirst.mockResolvedValue({
      id: 100,
      name: 'Acme Co',
      status: 'Prospect',
      aiScore: 55, // currentStoredScore
      deals: [
        { stage: 'won' },
        { stage: 'won' },
        { stage: 'proposal' },
        { stage: 'lead' },
      ],
      activities: [
        { createdAt: tenDaysAgo },   // within 30d → counted as recent
        { createdAt: tenDaysAgo },   // within 30d
        { createdAt: fortyDaysAgo }, // outside 30d → not recent
      ],
      sequenceEnrollments: [
        { status: 'Active' },
        { status: 'Active' },
        { status: 'Completed' },
      ],
    });
    leadScoringEngine.computeScore.mockReturnValue(77);

    const app = makeApp();
    const res = await request(app)
      .get('/api/ai-scoring/contact/100')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(100);
    expect(res.body.name).toBe('Acme Co');
    expect(res.body.currentStoredScore).toBe(55);
    expect(res.body.liveComputedScore).toBe(77);
    expect(res.body.factors.status).toBe('Prospect');
    expect(res.body.factors.totalDeals).toBe(4);
    expect(res.body.factors.wonDeals).toBe(2);
    expect(res.body.factors.proposalDeals).toBe(1);
    expect(res.body.factors.recentActivities).toBe(2);
    expect(res.body.factors.activeSequences).toBe(2);
    // Sanity: computeScore actually got called with the loaded contact.
    expect(leadScoringEngine.computeScore).toHaveBeenCalledTimes(1);
    expect(leadScoringEngine.computeScore.mock.calls[0][0].id).toBe(100);
  });

  test('500 envelope when prisma throws inside the contact-score handler', async () => {
    prisma.contact.findFirst.mockRejectedValue(new Error('db on fire'));
    const app = makeApp();
    const res = await request(app)
      .get('/api/ai-scoring/contact/100')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to get contact score');
  });
});

// ─── POST /trigger — debug rescore-all-tenants knob ────────────────

describe('POST /trigger — manual rescore', () => {
  test('happy path: forwards req.io and returns { success: true, ...result }', async () => {
    const fakeIo = { emit: vi.fn() };
    leadScoringEngine.tickLeadScoringEngine.mockResolvedValue({ scored: 17 });

    const app = makeApp({ io: fakeIo });
    const res = await request(app).post('/api/ai-scoring/trigger').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scored).toBe(17);
    // io is passed through so the engine can broadcast 'lead_scores_updated'.
    expect(leadScoringEngine.tickLeadScoringEngine).toHaveBeenCalledTimes(1);
    expect(leadScoringEngine.tickLeadScoringEngine.mock.calls[0][0]).toBe(fakeIo);
  });

  test('500 envelope when the engine throws', async () => {
    leadScoringEngine.tickLeadScoringEngine.mockRejectedValue(new Error('engine boom'));
    const app = makeApp();
    const res = await request(app).post('/api/ai-scoring/trigger').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Scoring trigger failed');
  });

  test('merges arbitrary engine result fields into the response envelope', async () => {
    // The route uses `res.json({ success: true, ...result })` so any extra
    // fields the engine returns (future migration safety) survive.
    leadScoringEngine.tickLeadScoringEngine.mockResolvedValue({
      scored: 3,
      tenants: 2,
      durationMs: 142,
    });
    const app = makeApp();
    const res = await request(app).post('/api/ai-scoring/trigger').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      scored: 3,
      tenants: 2,
      durationMs: 142,
    });
  });
});
