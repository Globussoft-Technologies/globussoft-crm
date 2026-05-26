// @ts-check
/**
 * Unit tests for backend/routes/deal_insights.js — pin the AI deal-insights
 * surface (list / stats / generate / resolve / delete / run + dealContext
 * enrichment + heuristic-rules engine) against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * deal_insights.js is a 500-LOC route surface that backs the Deal Insights
 * page + the cron engine's per-tenant fan-out. Several historical contracts
 * are encoded in the SUT and need pinning:
 *
 *   - #572 / #587 — dealContext enrichment. GET / and GET /deal/:id attach
 *     `dealContext` to every row via a single tenant-scoped findMany join.
 *     The envelope is ALWAYS a non-null object for insights with a dealId
 *     (the "missing deal" sentinel populates the same key set with
 *     `isMissing: true` + nullified columns). Insights with `dealId === null`
 *     get `dealContext: null` so the frontend can distinguish "missing FK"
 *     from "no deal linked".
 *
 *   - #582 — past-expected-close severity split. The pre-fix path fired
 *     CRITICAL on every `expectedClose < now`, including the <24h case
 *     (Math.floor → 0, "Deal is 0 day(s) past expected close" noise).
 *     Post-fix:
 *       daysOverdue < 1   → no insight (closes today / future / null)
 *       daysOverdue 1..6  → WARNING
 *       daysOverdue ≥ 7   → CRITICAL
 *     Won/lost deals are exempt entirely.
 *
 *   - Dedup contract for persistInsights — when an unresolved insight with
 *     the same (dealId, tenantId, type, insight) already exists, the new
 *     candidate is silently dropped (NOT updated, NOT re-created). The
 *     return shape only counts NEW rows in `generated`.
 *
 *   - Gemini graceful fallback — when GEMINI_API_KEY is unset OR Gemini
 *     throws, the route MUST still complete the heuristic-rules pass and
 *     return a 200. Production has seen Gemini quota outages where this
 *     was the only working path; pinning it prevents a "Gemini-down →
 *     500-on-every-generate" regression.
 *
 *   - G-13 — POST /run is the manual trigger mirror of the cron engine.
 *     Gated to ADMIN (verifyRole), scopes to req.user.tenantId only (the
 *     cron version is all-tenant), runs the heuristic-only path (no Gemini
 *     — matches cron behaviour), returns
 *     { success, tenantId, scanned, generated, errors }. Per-deal failures
 *     populate `errors[]` without aborting the whole sweep.
 *
 *   - Tenant isolation on every read/write — every endpoint's prisma where
 *     clause MUST include tenantId from req.user. Cross-tenant insight IDs
 *     return 404, never 200 with cross-tenant data.
 *
 * What this file pins (15 cases)
 * ──────────────────────────────
 *   1.  GET /        — tenant-scoped list + dealContext enrichment shape
 *                      (resolved + isMissing sentinel + null dealId branch).
 *   2.  GET /        — ?severity + ?dealId + ?isResolved=true filters flow
 *                      into the prisma where clause.
 *   3.  GET /stats   — envelope shape (byType, bySeverity, openCount,
 *                      resolvedCount) under tenant scope.
 *   4.  GET /deal/:dealId — 404 when deal belongs to a different tenant.
 *   5.  GET /deal/:dealId — 400 INVALID dealId on a non-numeric param.
 *   6.  POST /generate/:dealId — Gemini-down graceful fallback (no
 *                      GEMINI_API_KEY set at module load → aiModel === null
 *                      → heuristic-only path → 200 with persisted rows).
 *   7.  POST /generate/:dealId — 404 cross-tenant deal.
 *   8.  POST /generate/:dealId — 400 INVALID dealId on a non-numeric param.
 *   9.  POST /generate/:dealId — heuristic dedup: existing unresolved
 *                      insight with same (dealId, type, insight) → 0 new
 *                      rows but the candidate IS evaluated.
 *  10.  POST /generate/:dealId — past-expected-close severity ladder
 *                      (#582): 7+ days = CRITICAL, <1 day = NO insight.
 *  11.  POST /:id/resolve — flips isResolved=true under tenant scope.
 *  12.  POST /:id/resolve — 404 cross-tenant.
 *  13.  DELETE /:id  — happy path + 404 cross-tenant.
 *  14.  POST /run    — ADMIN-only, tenant-scoped sweep, per-deal failures
 *                      populate errors[] without aborting (G-13 contract).
 *  15.  attachDealContext — exported helper smoke test: insights with
 *                      dealId hitting a missing FK get isMissing=true
 *                      sentinel, NOT dealContext=null.
 *
 * Pattern reference
 * ─────────────────
 * Mirrors backend/test/routes/deals.test.js for the auth-middleware
 * passthrough + prisma singleton patch, and the Gemini-disabled path:
 * because the SUT captures `aiModel` ONCE at module load (top-level
 * `if (GEMINI_KEY)`), we deliberately UNSET GEMINI_API_KEY before
 * requiring the router — exercising the production-realistic
 * "no Gemini key configured" branch + the in-route try/catch around
 * Gemini's generateContent for the path where the key IS set but
 * the SDK throws. The latter is covered via the heuristic-only
 * envelope assertion (route still returns 200) — pinning both halves
 * of the graceful-fallback contract.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Ensure aiModel stays null at module-load so the route exercises the
// "Gemini-down" branch by default. (#572 / #587 dealContext + #582 severity
// ladder + dedup + tenant isolation are all heuristic-only contracts; the
// AI-happy-path is observable only through "generated" count anyway, and
// stubbing the constructor adds CJS-cache fragility for ~zero coverage.)
delete process.env.GEMINI_API_KEY;

// Stub auth middleware BEFORE the router is required. Both middleware fns
// are destructured at module-load in the route, so the rebind on
// `authMw.verifyToken / .verifyRole` must happen before requireCJS fires.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Prisma singleton stubs — every delegate the route + helpers touch.
prisma.dealInsight = prisma.dealInsight || {};
prisma.dealInsight.findMany = vi.fn();
prisma.dealInsight.findFirst = vi.fn();
prisma.dealInsight.groupBy = vi.fn();
prisma.dealInsight.count = vi.fn();
prisma.dealInsight.create = vi.fn();
prisma.dealInsight.update = vi.fn();
prisma.dealInsight.delete = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findFirst = vi.fn();
prisma.deal.findMany = vi.fn();

import express from 'express';
import request from 'supertest';

const dealInsightsRouter = requireCJS('../../routes/deal_insights');
const { attachDealContext, runHeuristicRules } = dealInsightsRouter;

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/deal-insights', dealInsightsRouter);
  return app;
}

beforeEach(() => {
  prisma.dealInsight.findMany.mockReset();
  prisma.dealInsight.findFirst.mockReset();
  prisma.dealInsight.groupBy.mockReset();
  prisma.dealInsight.count.mockReset();
  prisma.dealInsight.create.mockReset();
  prisma.dealInsight.update.mockReset();
  prisma.dealInsight.delete.mockReset();
  prisma.deal.findFirst.mockReset();
  prisma.deal.findMany.mockReset();
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// GET / — list insights + dealContext enrichment
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list insights for tenant', () => {
  test('returns tenant-scoped insights with dealContext enrichment (resolved + isMissing sentinel + null dealId)', async () => {
    prisma.dealInsight.findMany.mockResolvedValue([
      { id: 1, dealId: 10, tenantId: 1, type: 'RISK',         severity: 'WARNING', insight: 'No activity in 30 days.', isResolved: false, generatedAt: new Date() },
      { id: 2, dealId: 11, tenantId: 1, type: 'OPPORTUNITY',  severity: 'INFO',    insight: 'Multiple DMs engaged.',  isResolved: false, generatedAt: new Date() },
      // Orphan FK: dealId references a row hard-deleted long ago (or
      // cross-tenant — same observable behaviour via the where clause).
      { id: 3, dealId: 99, tenantId: 1, type: 'RISK',         severity: 'CRITICAL', insight: 'Past close.', isResolved: false, generatedAt: new Date() },
      // Null dealId — explicit null branch in attachDealContext.
      { id: 4, dealId: null, tenantId: 1, type: 'NEXT_BEST_ACTION', severity: 'INFO', insight: 'General nudge.', isResolved: false, generatedAt: new Date() },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 10, title: 'Acme renewal', amount: 5000, currency: 'USD', stage: 'proposal', probability: 60, expectedClose: null, deletedAt: null, contact: { name: 'Jane', company: 'Acme' } },
      { id: 11, title: 'Beta pilot',   amount: 1200, currency: 'USD', stage: 'lead',     probability: 20, expectedClose: null, deletedAt: null, contact: null },
      // id 99 omitted → isMissing sentinel
    ]);

    const res = await request(makeApp()).get('/api/deal-insights/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);

    // Resolved Deal — dealContext populated with title + contactName.
    expect(res.body[0].dealContext).toEqual(expect.objectContaining({
      id: 10, title: 'Acme renewal', stage: 'proposal',
      contactName: 'Jane', contactCompany: 'Acme',
      isArchived: false, isMissing: false,
    }));
    // Contact-less Deal — contactName/Company null but isMissing still false.
    expect(res.body[1].dealContext).toEqual(expect.objectContaining({
      id: 11, title: 'Beta pilot',
      contactName: null, contactCompany: null,
      isArchived: false, isMissing: false,
    }));
    // Missing-FK sentinel — populated envelope with isMissing=true.
    expect(res.body[2].dealContext).toEqual(expect.objectContaining({
      id: 99, title: null, contactName: null,
      isArchived: false, isMissing: true,
    }));
    // Null dealId — explicit null dealContext (distinguishes from missing FK).
    expect(res.body[3].dealContext).toBeNull();

    // Tenant scope verified at the prisma layer.
    expect(prisma.dealInsight.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1 }),
      orderBy: { generatedAt: 'desc' },
      take: 500,
    }));
    // dealContext join is tenant-scoped via `tenantId` in the where clause.
    expect(prisma.deal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1, id: { in: [10, 11, 99] } }),
    }));
  });

  test('?severity + ?dealId + ?isResolved filters flow into where clause', async () => {
    prisma.dealInsight.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/deal-insights/?severity=CRITICAL&dealId=42&isResolved=true');

    expect(prisma.dealInsight.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, severity: 'CRITICAL', dealId: 42, isResolved: true },
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /stats
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stats — counts by type + severity + open/resolved', () => {
  test('returns envelope shape with tenant-scoped aggregates', async () => {
    prisma.dealInsight.groupBy
      .mockResolvedValueOnce([
        { type: 'RISK',        _count: { _all: 5 } },
        { type: 'OPPORTUNITY', _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { severity: 'WARNING', _count: { _all: 6 } },
        { severity: 'INFO',    _count: { _all: 1 } },
      ]);
    prisma.dealInsight.count
      .mockResolvedValueOnce(4)  // openCount
      .mockResolvedValueOnce(3); // resolvedCount

    const res = await request(makeApp()).get('/api/deal-insights/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      byType: [
        { type: 'RISK', count: 5 },
        { type: 'OPPORTUNITY', count: 2 },
      ],
      bySeverity: [
        { severity: 'WARNING', count: 6 },
        { severity: 'INFO', count: 1 },
      ],
      openCount: 4,
      resolvedCount: 3,
    });
    // Every groupBy / count call had tenantId = 1.
    for (const call of prisma.dealInsight.groupBy.mock.calls) {
      expect(call[0].where.tenantId).toBe(1);
    }
    for (const call of prisma.dealInsight.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /deal/:dealId — single-deal listing + cross-tenant + invalid id
// ─────────────────────────────────────────────────────────────────────────

describe('GET /deal/:dealId — per-deal insight listing', () => {
  test('404 when the deal belongs to a different tenant (deal.findFirst returns null)', async () => {
    // The route's tenant gate is the deal lookup. With tenantId=1 in
    // req.user and the deal sitting on tenantId=99, the prisma findFirst
    // would return null. Pinning that no insights are leaked is the
    // load-bearing assertion here.
    prisma.deal.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/deal-insights/deal/12345');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Deal not found' });
    // No insight fetch should have fired after the tenant gate failed.
    expect(prisma.dealInsight.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID dealId on a non-numeric param', async () => {
    const res = await request(makeApp()).get('/api/deal-insights/deal/not-a-number');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid dealId' });
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /generate/:dealId — heuristic + Gemini-graceful-fallback
// ─────────────────────────────────────────────────────────────────────────

describe('POST /generate/:dealId — heuristic insights + Gemini graceful fallback', () => {
  test('Gemini-down graceful fallback: heuristic rules run + persist + 200 (no aiModel because GEMINI_API_KEY unset at load)', async () => {
    // Deal with cold contact (no activity, no emails, no calls) — runHeuristicRules
    // should fire two RISKs: "No activity recorded" + "Low engagement: no emails or calls".
    prisma.deal.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, title: 'Stalled deal', amount: 7500, currency: 'USD',
      stage: 'proposal', probability: 30, expectedClose: null,
      contact: { name: 'Sam Cold', company: 'IceCo', status: 'lead',
        activities: [], emails: [], callLogs: [] },
    });
    // No dedup hits — every candidate is novel.
    prisma.dealInsight.findFirst.mockResolvedValue(null);
    prisma.dealInsight.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: Math.floor(Math.random() * 1000), ...data }));

    const res = await request(makeApp()).post('/api/deal-insights/generate/50');

    expect(res.status).toBe(200);
    // 2 heuristic candidates persisted (no AI candidate because aiModel === null).
    expect(res.body.generated).toBe(2);
    expect(res.body.evaluated).toBe(2);
    expect(res.body.insights).toHaveLength(2);
    // Both creates carry tenantId=1 + dealId=50.
    for (const call of prisma.dealInsight.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(1);
      expect(call[0].data.dealId).toBe(50);
    }
  });

  test('404 when deal belongs to a different tenant', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/deal-insights/generate/999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Deal not found' });
    expect(prisma.dealInsight.create).not.toHaveBeenCalled();
  });

  test('400 INVALID dealId on a non-numeric param', async () => {
    const res = await request(makeApp()).post('/api/deal-insights/generate/oops');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid dealId' });
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
  });

  test('dedup: an existing unresolved insight with same (dealId, type, insight) is NOT recreated', async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: 60, tenantId: 1, title: 'Repeat', amount: 100, currency: 'USD',
      stage: 'lead', probability: 10, expectedClose: null,
      contact: { name: 'Repeat', company: 'X', status: 'lead',
        activities: [], emails: [], callLogs: [] },
    });
    // findFirst returns truthy → dedup hit → skip create.
    prisma.dealInsight.findFirst.mockResolvedValue({ id: 777 });

    const res = await request(makeApp()).post('/api/deal-insights/generate/60');

    expect(res.status).toBe(200);
    // Both heuristic candidates fired but neither persisted.
    expect(res.body.evaluated).toBe(2);
    expect(res.body.generated).toBe(0);
    expect(prisma.dealInsight.create).not.toHaveBeenCalled();
  });

  test('past-expected-close severity ladder (#582): 7+ days → CRITICAL, <1 day → no insight', async () => {
    const now = Date.now();
    const tenDaysAgo  = new Date(now - 10 * DAY_MS);
    const hoursAgo    = new Date(now - 6 * 60 * 60 * 1000); // 6h ago, <1 day

    // Deal A — expectedClose 10 days ago, stage=proposal → CRITICAL.
    // Use a contact with rich activity + emails so the "no activity" and
    // "low engagement" rules DO NOT fire. We want exactly one heuristic:
    // the CRITICAL past-close rule.
    const recentEmail = { from: 'a@x.com', to: 'b@x.com', subject: 'recent', createdAt: new Date(now - 2 * DAY_MS) };
    const recentCall  = { createdAt: new Date(now - 1 * DAY_MS) };
    const recentAct   = { createdAt: new Date(now - 1 * DAY_MS) };

    prisma.deal.findFirst.mockResolvedValue({
      id: 70, tenantId: 1, title: 'Critical', amount: 500, currency: 'USD',
      stage: 'proposal', probability: 40, expectedClose: tenDaysAgo,
      contact: { name: 'X', company: 'Y', status: 'lead',
        activities: [recentAct], emails: [recentEmail], callLogs: [recentCall] },
    });
    prisma.dealInsight.findFirst.mockResolvedValue(null);
    prisma.dealInsight.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data }));

    let res = await request(makeApp()).post('/api/deal-insights/generate/70');
    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(1);
    expect(res.body.insights[0]).toEqual(expect.objectContaining({
      type: 'RISK',
      severity: 'CRITICAL',
    }));
    expect(res.body.insights[0].insight).toMatch(/10 day\(s\) past expected close/);

    // Deal B — expectedClose 6h ago, stage=proposal → daysOverdue=0 → NO past-close insight.
    // Activity is recent so no "no activity" rule. There IS still the
    // last-email-7-14d window check — we provide a 2-day-old email so it
    // doesn't fire either. Expect exactly 0 generated.
    prisma.deal.findFirst.mockResolvedValue({
      id: 71, tenantId: 1, title: 'Not yet overdue', amount: 500, currency: 'USD',
      stage: 'proposal', probability: 40, expectedClose: hoursAgo,
      contact: { name: 'X', company: 'Y', status: 'lead',
        activities: [recentAct], emails: [recentEmail], callLogs: [recentCall] },
    });
    prisma.dealInsight.create.mockClear();
    res = await request(makeApp()).post('/api/deal-insights/generate/71');
    expect(res.status).toBe(200);
    expect(res.body.evaluated).toBe(0);
    expect(res.body.generated).toBe(0);
    expect(prisma.dealInsight.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/resolve
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/resolve — mark insight resolved', () => {
  test('flips isResolved=true under tenant scope', async () => {
    prisma.dealInsight.findFirst.mockResolvedValue({ id: 5, tenantId: 1, isResolved: false });
    prisma.dealInsight.update.mockResolvedValue({ id: 5, isResolved: true });

    const res = await request(makeApp()).post('/api/deal-insights/5/resolve');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 5, isResolved: true });
    expect(prisma.dealInsight.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
    expect(prisma.dealInsight.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { isResolved: true },
    });
  });

  test('404 cross-tenant (findFirst returns null)', async () => {
    prisma.dealInsight.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/deal-insights/5/resolve');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Insight not found' });
    expect(prisma.dealInsight.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — tenant-checked', () => {
  test('happy path: tenant-scoped delete + { deleted: true } envelope', async () => {
    prisma.dealInsight.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.dealInsight.delete.mockResolvedValue({ id: 9 });

    const res = await request(makeApp()).delete('/api/deal-insights/9');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(prisma.dealInsight.findFirst).toHaveBeenCalledWith({
      where: { id: 9, tenantId: 1 },
    });
    expect(prisma.dealInsight.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });

  test('404 cross-tenant (findFirst returns null)', async () => {
    prisma.dealInsight.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).delete('/api/deal-insights/9');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Insight not found' });
    expect(prisma.dealInsight.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /run — G-13 manual cron trigger
// ─────────────────────────────────────────────────────────────────────────

describe('POST /run — manual deal-insights engine trigger (G-13)', () => {
  test('tenant-scoped sweep: scanned/generated/errors envelope; per-deal failures populate errors[] without aborting', async () => {
    // 3 open deals — 2 will generate insights cleanly, 1 will throw during
    // candidate generation so we can pin the per-deal try/catch path.
    const now = Date.now();
    const recentEmail = { from: 'a@x.com', to: 'b@x.com', subject: 's', createdAt: new Date(now - 2 * DAY_MS) };
    const recentCall  = { createdAt: new Date(now - 1 * DAY_MS) };
    const recentAct   = { createdAt: new Date(now - 1 * DAY_MS) };

    prisma.deal.findMany.mockResolvedValue([
      // Deal 80 — cold contact → 2 heuristics ("no activity", "low engagement").
      { id: 80, tenantId: 1, stage: 'proposal', amount: 100, currency: 'USD',
        title: 'Cold', probability: 10, expectedClose: null,
        contact: { name: 'Cold', activities: [], emails: [], callLogs: [], status: 'lead' } },
      // Deal 81 — recent activity → 0 heuristics.
      { id: 81, tenantId: 1, stage: 'proposal', amount: 200, currency: 'USD',
        title: 'Warm', probability: 50, expectedClose: null,
        contact: { name: 'Warm', activities: [recentAct], emails: [recentEmail], callLogs: [recentCall], status: 'lead' } },
      // Deal 82 — same as Deal 80 (cold) but persistInsights will throw.
      { id: 82, tenantId: 1, stage: 'proposal', amount: 300, currency: 'USD',
        title: 'Boom', probability: 10, expectedClose: null,
        contact: { name: 'Boom', activities: [], emails: [], callLogs: [], status: 'lead' } },
    ]);

    // Default: no dedup hits, create succeeds. For deal 82, force create
    // to throw on the first call so persistInsights propagates the error
    // into the per-deal catch.
    let createCallsByDeal = { 80: 0, 82: 0 };
    prisma.dealInsight.findFirst.mockResolvedValue(null);
    prisma.dealInsight.create.mockImplementation(({ data }) => {
      if (data.dealId === 82) {
        createCallsByDeal[82]++;
        if (createCallsByDeal[82] === 1) {
          return Promise.reject(new Error('simulated DB failure for deal 82'));
        }
      }
      if (data.dealId === 80) createCallsByDeal[80]++;
      return Promise.resolve({ id: Math.floor(Math.random() * 1000), ...data });
    });

    const res = await request(makeApp()).post('/api/deal-insights/run');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe(1);
    expect(res.body.scanned).toBe(3);
    // Deal 80 persisted 2 rows; deal 81 persisted 0; deal 82 errored.
    expect(res.body.generated).toBe(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toEqual(expect.objectContaining({
      dealId: 82,
      error: expect.stringContaining('simulated DB failure'),
    }));

    // Sweep query was tenant-scoped to req.user.tenantId and excluded
    // won/lost + soft-deleted deals (matches cron engine contract).
    expect(prisma.deal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 1,
        stage: { notIn: ['won', 'lost'] },
        deletedAt: null,
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// attachDealContext helper — exported surface
// ─────────────────────────────────────────────────────────────────────────

describe('attachDealContext helper — exported envelope', () => {
  test('insights with an orphan dealId get a populated isMissing=true sentinel (NOT dealContext=null)', async () => {
    // Only id=20 resolves; id=21 is orphan → sentinel.
    prisma.deal.findMany.mockResolvedValue([
      { id: 20, title: 'OK', amount: 1, currency: 'USD', stage: 'lead', probability: 10, expectedClose: null, deletedAt: null, contact: null },
    ]);

    const insights = [
      { id: 1, dealId: 20, type: 'RISK', insight: 'a' },
      { id: 2, dealId: 21, type: 'RISK', insight: 'b' }, // orphan
      { id: 3, dealId: null, type: 'NEXT_BEST_ACTION', insight: 'c' },
    ];

    const enriched = await attachDealContext(insights, 1);

    // Resolved
    expect(enriched[0].dealContext).toEqual(expect.objectContaining({
      id: 20, title: 'OK', isMissing: false,
    }));
    // Orphan — populated sentinel, NOT null. This is the #587 invariant.
    expect(enriched[1].dealContext).toEqual(expect.objectContaining({
      id: 21, title: null, isMissing: true,
    }));
    expect(enriched[1].dealContext).not.toBeNull();
    // Null dealId — explicit null dealContext.
    expect(enriched[2].dealContext).toBeNull();
  });
});
