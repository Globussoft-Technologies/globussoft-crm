// @ts-check
/**
 * Unit tests for backend/routes/win_loss.js — pin the contract of the
 * win/loss reasons CRUD + closed-deal analysis aggregation surface that
 * powers the Sales WinLoss dashboard + per-deal lost-reason tagging.
 *
 * Why this file exists
 * ────────────────────
 * win_loss.js was a top-10 under-covered file in the codebase per c8
 * measurement (13.59% lines) — zero vitest coverage, only thin gate
 * coverage. The route owns three contracts that frontends + agents rely
 * on simultaneously:
 *   (1) `WinLossReason` CRUD is tenant-scoped — cross-tenant id lookups
 *       must 404 (covered by tenant-scoped `findFirst` before delete);
 *   (2) `/analysis` aggregates won/lost deals into win-rate + per-reason
 *       counts; the math (winRate rounding, avg-deal-size, byReason
 *       grouping with `lostReason` free-text fallback) is the load-bearing
 *       UI contract;
 *   (3) `PUT /deals/:dealId/reason` resolves `winLossReasonId` strictly
 *       within the deal's tenant — a forged id from another tenant must
 *       400, never silently land on the deal row.
 * Pin the wire shape now so future refactors can't silently flip any of
 * these contracts.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET /reasons                    — list reasons, tenant-scoped
 *   2. POST /reasons                   — create reason (won|lost, validated)
 *   3. DELETE /reasons/:id             — delete reason, tenant-scoped 404
 *   4. GET /analysis?from=&to=         — aggregated win/loss analysis
 *   5. PUT /deals/:dealId/reason       — set lostReason / winLossReasonId
 *
 * Cases (16 total)
 * ────────────────
 *   GET /reasons (2): 200 returns tenant-scoped list ordered by (type asc,
 *     count desc); 500 on prisma error.
 *   POST /reasons (4): 400 missing type; 400 missing reason; 400 invalid
 *     type (not 'won'|'lost'); 201 happy path returns created row with
 *     tenantId from JWT (never body).
 *   DELETE /reasons/:id (2): 404 when id belongs to another tenant
 *     (tenant-scoped findFirst returns null); 204 No Content on happy
 *     delete (per #550 cross-route shape sweep).
 *   GET /analysis (4): 200 with all-zero envelope when no closed deals;
 *     200 with computed winRate + avg-deal-size when mixed won/lost;
 *     200 groups byReason with free-text lostReason fallback when no
 *     winLossReasonId set; 200 honors from/to date range filter.
 *   PUT /deals/:dealId/reason (4): 404 when deal id belongs to another
 *     tenant; 400 when winLossReasonId points at another tenant's reason
 *     (the cross-tenant assignment guard); 400 when body has no fields
 *     to update; 200 happy path sets lostReason + increments reason
 *     count tally.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/subscriptions.test.js — prisma singleton
 * monkey-patch BEFORE requiring the router (vi.mock doesn't reliably
 * intercept CJS require in this repo's vitest config). eventBus is
 * patched at module-singleton level (CJS self-mocking seam) so any
 * downstream emit doesn't try to hit a real DB. A real-signed JWT proves
 * the verifyToken integration end-to-end (the route's req.user.tenantId
 * contract is what gets pinned, not a fake-auth shortcut).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.winLossReason = prisma.winLossReason || {};
prisma.winLossReason.findMany = vi.fn();
prisma.winLossReason.findFirst = vi.fn();
prisma.winLossReason.create = vi.fn();
prisma.winLossReason.delete = vi.fn();
prisma.winLossReason.update = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.findFirst = vi.fn();
prisma.deal.update = vi.fn();
// eventBus's best-effort emit walks automationRule.findMany — stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── eventBus stubs (best-effort writeAudit / route-side emit) ──────────
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { JWT_SECRET } = requireCJS('../../config/secrets');
const winLossRouter = requireCJS('../../routes/win_loss');

function signToken({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/win-loss', winLossRouter);
  return app;
}

function authedGet(app, path, opts) {
  return request(app).get(path).set('Authorization', `Bearer ${signToken(opts)}`);
}
function authedPost(app, path, body, opts) {
  return request(app).post(path).set('Authorization', `Bearer ${signToken(opts)}`).send(body);
}
function authedPut(app, path, body, opts) {
  return request(app).put(path).set('Authorization', `Bearer ${signToken(opts)}`).send(body || {});
}
function authedDelete(app, path, opts) {
  return request(app).delete(path).set('Authorization', `Bearer ${signToken(opts)}`);
}

beforeEach(() => {
  prisma.winLossReason.findMany.mockReset();
  prisma.winLossReason.findFirst.mockReset();
  prisma.winLossReason.create.mockReset();
  prisma.winLossReason.delete.mockReset();
  prisma.winLossReason.update.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.deal.findFirst.mockReset();
  prisma.deal.update.mockReset();

  prisma.winLossReason.findMany.mockResolvedValue([]);
  prisma.winLossReason.findFirst.mockResolvedValue(null);
  prisma.winLossReason.create.mockResolvedValue({});
  prisma.winLossReason.delete.mockResolvedValue({});
  prisma.winLossReason.update.mockResolvedValue({});
  prisma.deal.findMany.mockResolvedValue([]);
  prisma.deal.findFirst.mockResolvedValue(null);
  prisma.deal.update.mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────
// GET /reasons — list, tenant-scoped
// ─────────────────────────────────────────────────────────────────────────

describe('GET /reasons — tenant-scoped list ordered by (type asc, count desc)', () => {
  test('200 returns rows scoped to req.user.tenantId with the documented orderBy', async () => {
    prisma.winLossReason.findMany.mockResolvedValue([
      { id: 1, type: 'lost', reason: 'Price', count: 12, tenantId: 1 },
      { id: 2, type: 'won', reason: 'Feature fit', count: 7, tenantId: 1 },
    ]);

    const res = await authedGet(makeApp(), '/api/win-loss/reasons');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.winLossReason.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ type: 'asc' }, { count: 'desc' }],
    });
  });

  test('500 with stable error envelope when prisma throws', async () => {
    prisma.winLossReason.findMany.mockRejectedValue(new Error('db down'));

    const res = await authedGet(makeApp(), '/api/win-loss/reasons');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to list reasons/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /reasons — create with validation
// ─────────────────────────────────────────────────────────────────────────

describe('POST /reasons — create with type/reason validation', () => {
  test('400 when type missing', async () => {
    const res = await authedPost(makeApp(), '/api/win-loss/reasons', { reason: 'Price' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type and reason required/i);
    expect(prisma.winLossReason.create).not.toHaveBeenCalled();
  });

  test('400 when reason missing', async () => {
    const res = await authedPost(makeApp(), '/api/win-loss/reasons', { type: 'won' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type and reason required/i);
    expect(prisma.winLossReason.create).not.toHaveBeenCalled();
  });

  test('400 when type is not "won" or "lost"', async () => {
    const res = await authedPost(makeApp(), '/api/win-loss/reasons', {
      type: 'drawn',
      reason: 'Not a real outcome',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type must be "won" or "lost"/i);
    expect(prisma.winLossReason.create).not.toHaveBeenCalled();
  });

  test('201 happy path persists tenantId from JWT (never body)', async () => {
    prisma.winLossReason.create.mockResolvedValue({
      id: 99,
      type: 'lost',
      reason: 'Budget',
      count: 0,
      tenantId: 1,
    });

    const res = await authedPost(
      makeApp(),
      '/api/win-loss/reasons',
      // Body attempts a tenant override — must be ignored by the route.
      { type: 'lost', reason: 'Budget', tenantId: 999 },
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 99, type: 'lost', reason: 'Budget', count: 0 });
    expect(prisma.winLossReason.create).toHaveBeenCalledWith({
      data: { type: 'lost', reason: 'Budget', count: 0, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /reasons/:id — tenant-scoped 404 + 204 on success
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /reasons/:id — tenant-scoped 404 + 204 on success', () => {
  test('404 when id belongs to another tenant (findFirst scoped by tenantId returns null)', async () => {
    prisma.winLossReason.findFirst.mockResolvedValue(null);

    const res = await authedDelete(makeApp(), '/api/win-loss/reasons/555');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/reason not found/i);
    expect(prisma.winLossReason.findFirst).toHaveBeenCalledWith({
      where: { id: 555, tenantId: 1 },
    });
    expect(prisma.winLossReason.delete).not.toHaveBeenCalled();
  });

  test('204 No Content on happy delete (per #550 DELETE-shape sweep)', async () => {
    prisma.winLossReason.findFirst.mockResolvedValue({
      id: 42,
      type: 'lost',
      reason: 'Price',
      count: 3,
      tenantId: 1,
    });
    prisma.winLossReason.delete.mockResolvedValue({ id: 42 });

    const res = await authedDelete(makeApp(), '/api/win-loss/reasons/42');

    expect(res.status).toBe(204);
    // 204 carries no body
    expect(res.text).toBe('');
    expect(prisma.winLossReason.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /analysis — aggregated win/loss math
// ─────────────────────────────────────────────────────────────────────────

describe('GET /analysis — aggregated win/loss math', () => {
  test('200 with all-zero envelope when no closed deals exist', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await authedGet(makeApp(), '/api/win-loss/analysis');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      wonCount: 0,
      lostCount: 0,
      winRate: 0,
      byReason: [],
      avgDealSize: { won: 0, lost: 0 },
      closedDeals: [],
    });
    // No range filter when from/to omitted.
    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, stage: { in: ['won', 'lost'] } },
      }),
    );
  });

  test('200 with computed winRate + avg-deal-size when mixed won/lost', async () => {
    // 3 won (10k, 20k, 30k = 60k → avg 20k) + 1 lost (5k → avg 5k)
    // winRate = 3/(3+1) = 75.0
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'A', amount: 10000, stage: 'won', lostReason: null, winLossReasonId: null, createdAt: new Date('2026-05-01'), ownerId: 7 },
      { id: 2, title: 'B', amount: 20000, stage: 'won', lostReason: null, winLossReasonId: null, createdAt: new Date('2026-05-02'), ownerId: 7 },
      { id: 3, title: 'C', amount: 30000, stage: 'won', lostReason: null, winLossReasonId: null, createdAt: new Date('2026-05-03'), ownerId: 7 },
      { id: 4, title: 'D', amount: 5000, stage: 'lost', lostReason: 'Price', winLossReasonId: null, createdAt: new Date('2026-05-04'), ownerId: 7 },
    ]);

    const res = await authedGet(makeApp(), '/api/win-loss/analysis');

    expect(res.status).toBe(200);
    expect(res.body.wonCount).toBe(3);
    expect(res.body.lostCount).toBe(1);
    expect(res.body.winRate).toBe(75);
    expect(res.body.avgDealSize).toEqual({ won: 20000, lost: 5000 });
    expect(res.body.closedDeals).toHaveLength(4);
  });

  test('200 groups byReason with free-text lostReason fallback when winLossReasonId is null', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'A', amount: 1000, stage: 'lost', lostReason: 'Price', winLossReasonId: null, createdAt: new Date('2026-05-01'), ownerId: 7 },
      { id: 2, title: 'B', amount: 1000, stage: 'lost', lostReason: 'Price', winLossReasonId: null, createdAt: new Date('2026-05-02'), ownerId: 7 },
      { id: 3, title: 'C', amount: 1000, stage: 'lost', lostReason: 'Timing', winLossReasonId: null, createdAt: new Date('2026-05-03'), ownerId: 7 },
    ]);

    const res = await authedGet(makeApp(), '/api/win-loss/analysis');

    expect(res.status).toBe(200);
    // sorted by count desc → Price (2) before Timing (1)
    expect(res.body.byReason).toEqual([
      { reason: 'Price', type: 'lost', count: 2 },
      { reason: 'Timing', type: 'lost', count: 1 },
    ]);
  });

  test('200 honors from/to date range filter (UTC end-of-day inclusive on to)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await authedGet(
      makeApp(),
      '/api/win-loss/analysis?from=2026-05-01&to=2026-05-31',
    );

    expect(res.status).toBe(200);
    const callArg = prisma.deal.findMany.mock.calls[0][0];
    expect(callArg.where).toMatchObject({
      tenantId: 1,
      stage: { in: ['won', 'lost'] },
    });
    expect(callArg.where.createdAt.gte).toBeInstanceOf(Date);
    expect(callArg.where.createdAt.lte).toBeInstanceOf(Date);
    // to-end is rolled forward to 23:59:59.999 UTC for inclusive range.
    expect(callArg.where.createdAt.lte.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /deals/:dealId/reason — set lostReason / winLossReasonId
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /deals/:dealId/reason — set lostReason / winLossReasonId', () => {
  test('404 when the deal id belongs to another tenant', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);

    const res = await authedPut(makeApp(), '/api/win-loss/deals/777/reason', {
      lostReason: 'Price',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/deal not found/i);
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  test('400 when winLossReasonId points at another tenant\'s reason (cross-tenant assignment guard)', async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    // findFirst for the reason is tenant-scoped — returns null when the
    // id belongs to another tenant.
    prisma.winLossReason.findFirst.mockResolvedValue(null);

    const res = await authedPut(makeApp(), '/api/win-loss/deals/50/reason', {
      winLossReasonId: 999,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid winLossReasonId/i);
    expect(prisma.winLossReason.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 1 },
    });
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  test('400 when body has no recognized fields to update', async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });

    const res = await authedPut(makeApp(), '/api/win-loss/deals/50/reason', {
      // none of {lostReason, winLossReasonId} provided
      unrelatedField: 'ignored',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields to update/i);
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  test('200 happy path: sets winLossReasonId + increments reason count tally', async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.winLossReason.findFirst.mockResolvedValue({
      id: 11,
      type: 'lost',
      reason: 'Price',
      count: 4,
      tenantId: 1,
    });
    prisma.deal.update.mockResolvedValue({
      id: 50,
      lostReason: null,
      winLossReasonId: 11,
    });

    const res = await authedPut(makeApp(), '/api/win-loss/deals/50/reason', {
      winLossReasonId: 11,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 50, winLossReasonId: 11 });
    expect(prisma.deal.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { winLossReasonId: 11 },
    });
    // Count tally on WinLossReason incremented for quick analytics.
    expect(prisma.winLossReason.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { count: { increment: 1 } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-cutting — verifyToken enforced on every endpoint
// ─────────────────────────────────────────────────────────────────────────

describe('Auth gate — verifyToken enforced on every endpoint', () => {
  test('GET /reasons without Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/win-loss/reasons');
    expect(res.status).toBe(401);
  });
});
