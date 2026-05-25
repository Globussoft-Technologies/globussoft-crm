// @ts-check
/**
 * Unit tests for backend/routes/funnel.js — pin the sales-funnel analytics
 * surface (per-stage metrics + conversion rate + source-conversion + by-rep
 * + velocity + monthly trend) that backs the Funnel dashboard page.
 *
 * Why this file exists
 * ────────────────────
 * funnel.js is a 319-LOC pure-aggregation route surface with no DB writes —
 * every endpoint reads (Deal, Contact, PipelineStage) under tenant scope and
 * computes derived metrics in-process. The historical contracts to pin:
 *
 *   - Canonical stage order — loadStageOrder() falls back to
 *     ["lead", "contacted", "proposal", "won"] when the tenant has zero
 *     pipelineStage rows. When the tenant HAS stages, the route appends
 *     "won" if absent so a deal at "won" always has a terminal bucket.
 *
 *   - "Ever entered" semantics on /stages and /trend — a deal currently at
 *     stage index N is counted as having entered every stage with
 *     index ≤ N. "lost" deals (no canonical position) are counted as having
 *     passed through every NON-terminal stage. This is the historical
 *     funnel-chart contract — without it, conversion rates flicker because
 *     a deal moving lead → proposal would phantom-leave the "lead" bucket.
 *
 *   - conversionToNext rounding — single decimal place (round to nearest
 *     0.1%) via Math.round(x * 1000) / 10. avgDays rounds to nearest 0.1 day
 *     via Math.round(x * 10) / 10. totalValue rounds to nearest cent via
 *     Math.round(x * 100) / 100. These pin the wire-format the frontend
 *     chart code consumes.
 *
 *   - Tenant scope on EVERY endpoint — prisma.deal.findMany / contact.findMany
 *     / pipelineStage.findMany ALL include where.tenantId = req.user.tenantId.
 *     Cross-tenant deals must never appear in the response — this is the
 *     canonical multi-tenant isolation invariant.
 *
 *   - Date-range filter on /stages /conversion-by-source /by-rep — when
 *     ?from + ?to are present, where.createdAt = { gte: from, lte: to }.
 *     Either bound alone is honored; neither bound omits the filter
 *     entirely (does NOT add an empty createdAt:{} clause).
 *
 *   - /trend ?months param clamping — Math.max(1, Math.min(36, ...)) — caller
 *     can't request 0 months (no buckets) or >36 months (DOS surface).
 *     Default is 6 when the param is missing or non-numeric.
 *
 *   - Velocity terminal-stage shortcut — for stage='won'/'lost' deals with an
 *     expectedClose timestamp, dayDiff uses (createdAt → expectedClose) as
 *     the duration. For open-stage deals, dayDiff uses (createdAt → now).
 *
 *   - by-rep ownership — owner.name preferred, then owner.email, fall back to
 *     "Unassigned" when ownerId is null. winRate = won / total to 1dp.
 *
 * What this file pins (15 cases across 6 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. /stages — per-stage current count + ever-entered + conversion rate
 *      + avgDays + totalValue, using a deal-list spanning all 4 canonical
 *      stages plus a lost deal.
 *   2. /stages — tenant isolation: cross-tenant deals are NOT returned (we
 *      assert the where clause passed to prisma.deal.findMany).
 *   3. /stages — date-range filter: ?from + ?to flow into where.createdAt
 *      with gte/lte.
 *   4. /stages — uses tenant pipelineStages when present (loadStageOrder
 *      reads from prisma.pipelineStage and orders by position).
 *   5. /stages — falls back to canonical 4-stage order when tenant has zero
 *      pipelineStage rows.
 *   6. /stages — conversionToNext is null for the LAST stage (no next bucket).
 *   7. /stages — pipelineId query param flows into where.pipelineId.
 *   8. /conversion-by-source — groups contacts by source, computes won/count,
 *      sorts by count desc. status="customer" counts as won.
 *   9. /conversion-by-source — contact with null source is bucketed under
 *      "Unknown".
 *  10. /by-rep — groups deals by ownerId, computes total/won/lost/open/
 *      revenue/winRate, sorts by revenue desc, falls back to "Unassigned"
 *      when ownerId is null.
 *  11. /velocity — averages dayDiff(createdAt, now-or-expectedClose) per
 *      stage; terminal-stage deals use expectedClose when set.
 *  12. /trend — monthly buckets for the default 6-month window; "ever
 *      entered" logic applies inside each month's row.
 *  13. /trend — months query param clamps to [1, 36] (4 sub-cases via .each).
 *  14. /trend — bucket count matches `months` exactly + has monotonic
 *      "YYYY-MM" keys ending at the current month.
 *  15. Tenant isolation on every endpoint — calls with a different tenantId
 *      pass that tenantId through to the prisma where clause.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/attribution.test.js — prisma singleton patch
 * BEFORE requiring the router, supertest with a fake auth middleware that
 * sets req.user. funnel.js has NO inline verifyRole / verifyToken (the
 * global auth guard at server.js:512 covers it), so role doesn't matter for
 * these tests; we use ADMIN for parity with the rest of the test surface.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton stubs (BEFORE require-time) ────────────────────────
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.pipelineStage = prisma.pipelineStage || {};
prisma.pipelineStage.findMany = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const funnelRouter = requireCJS('../../routes/funnel');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/funnel', funnelRouter);
  return app;
}

beforeEach(() => {
  prisma.deal.findMany.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.pipelineStage.findMany.mockReset();
  // Default: no tenant pipelineStages — loadStageOrder uses the canonical
  // ["lead","contacted","proposal","won"] order.
  prisma.pipelineStage.findMany.mockResolvedValue([]);
});

// Helper: a fixed "now" anchor to keep age-based assertions stable. Tests
// that need wall-clock determinism build deals dated relative to this.
const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// GET /stages — per-stage funnel breakdown
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stages — per-stage funnel breakdown', () => {
  test('returns current count + totalEntered + conversionToNext + avgDays + totalValue per canonical stage', async () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * DAY_MS);
    prisma.deal.findMany.mockResolvedValue([
      // 3 lead-stage deals at $1k each
      { id: 1, stage: 'lead',      amount: 1000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      { id: 2, stage: 'lead',      amount: 1000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      { id: 3, stage: 'lead',      amount: 1000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      // 2 contacted-stage deals at $2k each
      { id: 4, stage: 'contacted', amount: 2000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      { id: 5, stage: 'contacted', amount: 2000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      // 1 proposal-stage deal at $5k
      { id: 6, stage: 'proposal',  amount: 5000, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      // 1 won-stage deal at $10k with expectedClose 5 days after createdAt
      { id: 7, stage: 'won',       amount: 10000, createdAt: tenDaysAgo,
        expectedClose: new Date(tenDaysAgo.getTime() + 5 * DAY_MS), tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(4);

    const [lead, contacted, proposal, won] = res.body.stages;
    expect(lead).toEqual(expect.objectContaining({
      name: 'lead',
      current: 3,           // 3 deals currently AT lead
      totalEntered: 7,      // every deal passed through lead at some point
      totalValue: 3000,
    }));
    expect(contacted).toEqual(expect.objectContaining({
      name: 'contacted',
      current: 2,
      totalEntered: 4,      // 2 contacted + 1 proposal + 1 won
      totalValue: 4000,
    }));
    expect(proposal).toEqual(expect.objectContaining({
      name: 'proposal',
      current: 1,
      totalEntered: 2,      // 1 proposal + 1 won
      totalValue: 5000,
    }));
    expect(won).toEqual(expect.objectContaining({
      name: 'won',
      current: 1,
      totalEntered: 1,
      totalValue: 10000,
      conversionToNext: null, // no stage after won
    }));

    // conversionToNext at single-decimal precision
    // lead → contacted: 4/7 = 57.142857% → 57.1
    expect(lead.conversionToNext).toBe(57.1);
    // contacted → proposal: 2/4 = 50.0
    expect(contacted.conversionToNext).toBe(50);
    // proposal → won: 1/2 = 50.0
    expect(proposal.conversionToNext).toBe(50);

    // avgDays at single-decimal precision; lead deals are 10 days old (~10.0)
    expect(lead.avgDays).toBeGreaterThan(9.5);
    expect(lead.avgDays).toBeLessThan(10.5);
    // won deal's age is createdAt → expectedClose = 5 days exactly
    expect(won.avgDays).toBeCloseTo(5, 0);
  });

  test('tenant isolation: where clause passes req.user.tenantId through', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42 })).get('/api/funnel/stages');

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
    });
    expect(prisma.pipelineStage.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: { position: 'asc' },
    });
  });

  test('?from + ?to date-range flows into where.createdAt with gte/lte', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const from = '2026-01-01';
    const to = '2026-06-30';

    await request(makeApp()).get(`/api/funnel/stages?from=${from}&to=${to}`);

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        createdAt: { gte: new Date(from), lte: new Date(to) },
      },
    });
  });

  test('uses tenant pipelineStages when present (ordered by position)', async () => {
    prisma.pipelineStage.findMany.mockResolvedValue([
      { id: 1, name: 'Discovery',   position: 0, tenantId: 1 },
      { id: 2, name: 'Demo',        position: 1, tenantId: 1 },
      { id: 3, name: 'Negotiation', position: 2, tenantId: 1 },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'demo', amount: 100, createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    // 3 tenant stages + appended canonical "won" terminal bucket = 4
    expect(res.body.stages).toHaveLength(4);
    expect(res.body.stages.map((s) => s.name)).toEqual([
      'discovery', 'demo', 'negotiation', 'won',
    ]);
  });

  test('falls back to canonical 4-stage order when tenant has zero pipelineStages', async () => {
    prisma.pipelineStage.findMany.mockResolvedValue([]); // explicit empty
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    expect(res.body.stages.map((s) => s.name)).toEqual([
      'lead', 'contacted', 'proposal', 'won',
    ]);
  });

  test('?pipelineId flows into where.pipelineId as parsed int', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/stages?pipelineId=99');

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, pipelineId: 99 },
    });
  });

  test('"lost" deals are counted as having passed through every non-terminal stage', async () => {
    prisma.deal.findMany.mockResolvedValue([
      // One lost deal — bumps totalEntered on lead/contacted/proposal but NOT won
      { id: 1, stage: 'lost', amount: 5000, createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.stages.map((s) => [s.name, s]));
    expect(byName.lead.totalEntered).toBe(1);
    expect(byName.contacted.totalEntered).toBe(1);
    expect(byName.proposal.totalEntered).toBe(1);
    expect(byName.won.totalEntered).toBe(0);
    // Lost deal isn't "currently AT" any canonical stage (lost has no canonical idx)
    expect(byName.lead.current).toBe(0);
    expect(byName.contacted.current).toBe(0);
    expect(byName.proposal.current).toBe(0);
    expect(byName.won.current).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /conversion-by-source
// ─────────────────────────────────────────────────────────────────────────

describe('GET /conversion-by-source — group by lead source', () => {
  test('groups contacts by source, computes count + won + conversionRate, sorts by count desc', async () => {
    prisma.contact.findMany.mockResolvedValue([
      // Website: 4 contacts, 2 customers → 50.0%
      { id: 1, source: 'Website', status: 'lead' },
      { id: 2, source: 'Website', status: 'customer' },
      { id: 3, source: 'Website', status: 'lead' },
      { id: 4, source: 'Website', status: 'customer' },
      // Referral: 2 contacts, 1 customer → 50.0%
      { id: 5, source: 'Referral', status: 'customer' },
      { id: 6, source: 'Referral', status: 'prospect' },
      // Trade Show: 1 contact, 0 customer → 0.0%
      { id: 7, source: 'Trade Show', status: 'lead' },
    ]);

    const res = await request(makeApp()).get('/api/funnel/conversion-by-source');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { source: 'Website',    count: 4, won: 2, conversionRate: 50 },
      { source: 'Referral',   count: 2, won: 1, conversionRate: 50 },
      { source: 'Trade Show', count: 1, won: 0, conversionRate: 0 },
    ]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      select: { id: true, source: true, status: true },
    });
  });

  test('contacts with null source are bucketed under "Unknown"', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, source: null, status: 'customer' },
      { id: 2, source: '',   status: 'lead' },          // empty string also falsy → "Unknown"
      { id: 3, source: null, status: 'lead' },
    ]);

    const res = await request(makeApp()).get('/api/funnel/conversion-by-source');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({
      source: 'Unknown',
      count: 3,
      won: 1,
      conversionRate: 33.3,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /by-rep
// ─────────────────────────────────────────────────────────────────────────

describe('GET /by-rep — owner-keyed funnel slice', () => {
  test('groups deals by ownerId, computes total/won/lost/open/revenue/winRate, sorts by revenue desc, falls back to "Unassigned"', async () => {
    prisma.deal.findMany.mockResolvedValue([
      // Alice — 2 won at $10k each, 1 open lead
      { id: 1, stage: 'won',       amount: 10000, ownerId: 10,
        owner: { id: 10, name: 'Alice', email: 'a@example.com' }, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 2, stage: 'won',       amount: 10000, ownerId: 10,
        owner: { id: 10, name: 'Alice', email: 'a@example.com' }, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 3, stage: 'lead',      amount: 500,   ownerId: 10,
        owner: { id: 10, name: 'Alice', email: 'a@example.com' }, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      // Bob — 1 won at $5k, 1 lost
      { id: 4, stage: 'won',       amount: 5000,  ownerId: 11,
        owner: { id: 11, name: 'Bob',   email: 'b@example.com' }, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 5, stage: 'lost',      amount: 8000,  ownerId: 11,
        owner: { id: 11, name: 'Bob',   email: 'b@example.com' }, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      // Unassigned — ownerId null
      { id: 6, stage: 'proposal',  amount: 999,   ownerId: null,
        owner: null, createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/by-rep');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    // Sorted by revenue desc: Alice ($20k), Bob ($5k), Unassigned ($0)
    expect(res.body[0]).toEqual(expect.objectContaining({
      owner: 'Alice',
      total: 3, won: 2, lost: 0, open: 1,
      revenue: 20000,
      winRate: 66.7, // 2/3 = 66.666% → 66.7
    }));
    expect(res.body[1]).toEqual(expect.objectContaining({
      owner: 'Bob',
      total: 2, won: 1, lost: 1, open: 0,
      revenue: 5000,
      winRate: 50,
    }));
    expect(res.body[2]).toEqual(expect.objectContaining({
      owner: 'Unassigned',
      total: 1, won: 0, lost: 0, open: 1,
      revenue: 0,
      winRate: 0,
    }));

    // Per-stage breakdown attached for each rep
    expect(res.body[0].stages).toEqual(expect.objectContaining({
      lead: 1, won: 2,
    }));

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /velocity
// ─────────────────────────────────────────────────────────────────────────

describe('GET /velocity — avg days in stage', () => {
  test('uses createdAt → expectedClose for terminal stages, createdAt → now for open stages', async () => {
    const now = Date.now();
    const tenDaysAgo  = new Date(now - 10 * DAY_MS);
    const thirtyAgo   = new Date(now - 30 * DAY_MS);
    const closeIn5    = new Date(thirtyAgo.getTime() + 5 * DAY_MS); // 5-day win duration

    prisma.deal.findMany.mockResolvedValue([
      // Open lead: 10 days old
      { id: 1, stage: 'lead', amount: 0, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
      // Won deal: 5-day duration (createdAt → expectedClose)
      { id: 2, stage: 'won',  amount: 0, createdAt: thirtyAgo, expectedClose: closeIn5, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/velocity');

    expect(res.status).toBe(200);
    const byStage = Object.fromEntries(res.body.map((r) => [r.stage, r.avgDaysInStage]));
    // Lead: ~10 days (within rounding tolerance)
    expect(byStage.lead).toBeGreaterThan(9.5);
    expect(byStage.lead).toBeLessThan(10.5);
    // Won: exactly 5 days (terminal-stage shortcut)
    expect(byStage.won).toBeCloseTo(5, 0);
    // Empty stages stay at 0
    expect(byStage.contacted).toBe(0);
    expect(byStage.proposal).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /trend
// ─────────────────────────────────────────────────────────────────────────

describe('GET /trend — monthly funnel-entry counts', () => {
  test('returns `months` buckets with monotonic YYYY-MM keys ending at current month', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/funnel/trend?months=6');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    // Every row has a YYYY-MM `month` key + a count per canonical stage
    for (const row of res.body) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
      expect(row).toEqual(expect.objectContaining({
        lead: expect.any(Number),
        contacted: expect.any(Number),
        proposal: expect.any(Number),
        won: expect.any(Number),
      }));
    }
    // Last bucket = current month (UTC)
    const now = new Date();
    const expectedLast = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(res.body[res.body.length - 1].month).toBe(expectedLast);
  });

  // Source uses `parseInt(req.query.months, 10) || 6` then clamps to [1, 36].
  // Note: parseInt('0') is 0, which is FALSY, so `|| 6` kicks in BEFORE the
  // clamp — `?months=0` falls back to the default 6, not the clamp floor 1.
  // Negative ints (-5) parse as -5 (truthy), then clamp via Math.max(1, ...) → 1.
  test.each([
    ['-5',     1],   // negative → clamps to 1
    ['1',      1],   // exact min
    ['37',    36],   // above clamp → 36
    ['9999',  36],
    ['notnum', 6],   // NaN → falsy → default 6
    ['0',      6],   // 0 → falsy → default 6 (NOT clamped, see comment above)
  ])('?months=%s clamps to %d buckets', async (param, expected) => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get(`/api/funnel/trend?months=${param}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(expected);
  });

  test('"ever entered" applies within each month: a deal at proposal bumps lead+contacted+proposal counters', async () => {
    // Single proposal-stage deal created this month
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15));
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'proposal', amount: 0, createdAt: thisMonth, expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/trend?months=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(expect.objectContaining({
      lead: 1,
      contacted: 1,
      proposal: 1,
      won: 0,
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-cutting: tenant isolation on every endpoint
// ─────────────────────────────────────────────────────────────────────────

describe('Cross-cutting — every endpoint forwards req.user.tenantId to prisma', () => {
  test('every endpoint scopes its prisma read by tenantId', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.contact.findMany.mockResolvedValue([]);

    const tenantId = 1234;
    const app = makeApp({ tenantId });

    await request(app).get('/api/funnel/stages');
    await request(app).get('/api/funnel/conversion-by-source');
    await request(app).get('/api/funnel/by-rep');
    await request(app).get('/api/funnel/velocity');
    await request(app).get('/api/funnel/trend?months=3');

    // Every deal.findMany call had where.tenantId = 1234
    for (const call of prisma.deal.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // contact.findMany also tenant-scoped
    for (const call of prisma.contact.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
    // pipelineStage reads tenant-scoped
    for (const call of prisma.pipelineStage.findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(tenantId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EXTENDED COVERAGE — branches the original 15 cases missed.
// Targets c8 12.85% line baseline: partial date filters, unknown stages,
// missing-expectedClose terminal deals, deal-outside-trend-window branch,
// error envelopes on every endpoint, and tenant pipelineStages that
// already include "won" (no-append branch).
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stages — partial date filters + edge branches', () => {
  test('?from alone yields where.createdAt with gte only (no lte)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/stages?from=2026-01-01');

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, createdAt: { gte: new Date('2026-01-01') } },
    });
  });

  test('?to alone yields where.createdAt with lte only (no gte)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/stages?to=2026-06-30');

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, createdAt: { lte: new Date('2026-06-30') } },
    });
  });

  test('no ?from + no ?to → no createdAt clause at all (buildDateFilter returns undefined)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/stages');

    // No createdAt key in the where clause
    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
    });
  });

  test('deals with unknown stage names are ignored (idx === -1 continue branch)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'bogus-stage', amount: 999, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 2, stage: 'qualified',   amount: 999, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 3, stage: 'lead',        amount: 100, createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.stages.map((s) => [s.name, s]));
    // Only the 'lead' deal counts; bogus + qualified silently dropped
    expect(byName.lead.current).toBe(1);
    expect(byName.lead.totalEntered).toBe(1);
    expect(byName.lead.totalValue).toBe(100);
  });

  test('conversionToNext is null when current stage totalEntered === 0 (empty funnel division-by-zero guard)', async () => {
    // Only proposal-stage deals — lead + contacted have totalEntered === 0
    // Wait: ever-entered logic means a proposal deal bumps lead + contacted too.
    // To exercise totalEntered===0, use ONLY a lost deal scoped to never-non-terminal
    // OR: empty deal list — all buckets have totalEntered=0, so every conversionToNext=null.
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    // Every stage has totalEntered=0 → conversionToNext should be null for lead/contacted/proposal
    // and null for won (no next bucket).
    expect(res.body.stages.every((s) => s.conversionToNext === null)).toBe(true);
    expect(res.body.stages.every((s) => s.avgDays === 0)).toBe(true);
    expect(res.body.stages.every((s) => s.totalValue === 0)).toBe(true);
  });

  test('tenant pipelineStages already containing "won" do NOT get a second appended terminal bucket', async () => {
    prisma.pipelineStage.findMany.mockResolvedValue([
      { id: 1, name: 'Lead',     position: 0, tenantId: 1 },
      { id: 2, name: 'Proposal', position: 1, tenantId: 1 },
      { id: 3, name: 'Won',      position: 2, tenantId: 1 }, // already terminal
    ]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    // 3 tenant stages — no extra "won" appended (the existing one stays singular)
    expect(res.body.stages).toHaveLength(3);
    expect(res.body.stages.map((s) => s.name)).toEqual(['lead', 'proposal', 'won']);
    // No 'won' appears twice
    const wonCount = res.body.stages.filter((s) => s.name === 'won').length;
    expect(wonCount).toBe(1);
  });

  test('deals with amount=null treat as 0 in totalValue (Number(null) === 0)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'lead', amount: null, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 2, stage: 'lead', amount: undefined, createdAt: new Date(), expectedClose: null, tenantId: 1 },
      { id: 3, stage: 'lead', amount: 250, createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(200);
    const lead = res.body.stages.find((s) => s.name === 'lead');
    // Number(null) → 0, Number(undefined) → NaN → `|| 0` → 0; 250 stays
    expect(lead.totalValue).toBe(250);
    expect(lead.current).toBe(3);
  });

  test('500 error envelope when prisma.deal.findMany throws', async () => {
    prisma.deal.findMany.mockRejectedValue(new Error('db boom'));

    const res = await request(makeApp()).get('/api/funnel/stages');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'db boom' });
  });
});

describe('GET /conversion-by-source — extended branches', () => {
  test('?from + ?to date-range flows into where.createdAt', async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/conversion-by-source?from=2026-01-01&to=2026-12-31');

    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-12-31') },
      },
      select: { id: true, source: true, status: true },
    });
  });

  test('case-insensitive customer match: status="CUSTOMER" counts as won', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, source: 'Website', status: 'CUSTOMER' },
      { id: 2, source: 'Website', status: 'Customer' },
      { id: 3, source: 'Website', status: 'lead' },
    ]);

    const res = await request(makeApp()).get('/api/funnel/conversion-by-source');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      source: 'Website',
      count: 3,
      won: 2,
      conversionRate: 66.7,
    });
  });

  test('contacts with null status treat as non-customer (won=0)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, source: 'Email', status: null },
      { id: 2, source: 'Email', status: undefined },
    ]);

    const res = await request(makeApp()).get('/api/funnel/conversion-by-source');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      source: 'Email',
      count: 2,
      won: 0,
      conversionRate: 0,
    });
  });

  test('500 error envelope when prisma.contact.findMany throws', async () => {
    prisma.contact.findMany.mockRejectedValue(new Error('contact db boom'));

    const res = await request(makeApp()).get('/api/funnel/conversion-by-source');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'contact db boom' });
  });
});

describe('GET /by-rep — extended branches', () => {
  test('owner with email-only (name null) falls back to email as label', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'won', amount: 1000, ownerId: 20,
        owner: { id: 20, name: null, email: 'noname@example.com' },
        createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/by-rep');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      owner: 'noname@example.com',
      ownerId: 20,
      won: 1,
    }));
  });

  test('?from + ?to date-range flows into where.createdAt', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/funnel/by-rep?from=2026-01-01&to=2026-12-31');

    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-12-31') },
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
  });

  test('deal with unknown stage still counts toward total + open (else branch), no stages[] bump', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'bogus', amount: 500, ownerId: 30,
        owner: { id: 30, name: 'Carla', email: 'c@example.com' },
        createdAt: new Date(), expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/by-rep');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      owner: 'Carla',
      total: 1,
      won: 0, lost: 0,
      open: 1,        // bogus → not won, not lost → counted as open
      winRate: 0,
    }));
    // stages map has all canonical buckets at 0 (bogus didn't match stageIndex)
    expect(res.body[0].stages).toEqual({ lead: 0, contacted: 0, proposal: 0, won: 0 });
  });

  test('500 error envelope when prisma.deal.findMany throws', async () => {
    prisma.deal.findMany.mockRejectedValue(new Error('rep db boom'));

    const res = await request(makeApp()).get('/api/funnel/by-rep');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'rep db boom' });
  });
});

describe('GET /velocity — extended branches', () => {
  test('terminal-stage deal WITHOUT expectedClose falls through to now (no shortcut)', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    prisma.deal.findMany.mockResolvedValue([
      // Won but no expectedClose → uses now → ~10 days
      { id: 1, stage: 'won', amount: 0, createdAt: tenDaysAgo, expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/velocity');

    expect(res.status).toBe(200);
    const byStage = Object.fromEntries(res.body.map((r) => [r.stage, r.avgDaysInStage]));
    // Won without expectedClose → createdAt → now ≈ 10 days
    expect(byStage.won).toBeGreaterThan(9.5);
    expect(byStage.won).toBeLessThan(10.5);
  });

  test('deal with unknown stage is ignored (buckets.has(stage) === false continue branch)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'bogus', amount: 0, createdAt: new Date(Date.now() - 50 * DAY_MS),
        expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/velocity');

    expect(res.status).toBe(200);
    // Every canonical bucket stays at 0
    for (const row of res.body) {
      expect(row.avgDaysInStage).toBe(0);
    }
  });

  test('empty deals list returns 0 for every stage (no division-by-zero)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/funnel/velocity');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    for (const row of res.body) {
      expect(row.avgDaysInStage).toBe(0);
    }
  });

  test('500 error envelope when prisma.deal.findMany throws', async () => {
    prisma.deal.findMany.mockRejectedValue(new Error('velocity db boom'));

    const res = await request(makeApp()).get('/api/funnel/velocity');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'velocity db boom' });
  });
});

describe('GET /trend — extended branches', () => {
  test('"lost" deal in current month bumps every NON-terminal stage (won stays 0)', async () => {
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 10));
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'lost', amount: 0, createdAt: thisMonth, expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/trend?months=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(expect.objectContaining({
      lead: 1,
      contacted: 1,
      proposal: 1,
      won: 0,        // terminal → lost deals don't bump 'won'
    }));
  });

  test('deal at "won" stage bumps every stage including won', async () => {
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 10));
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, stage: 'won', amount: 0, createdAt: thisMonth, expectedClose: null, tenantId: 1 },
    ]);

    const res = await request(makeApp()).get('/api/funnel/trend?months=1');

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      lead: 1,
      contacted: 1,
      proposal: 1,
      won: 1,
    }));
  });

  test('500 error envelope when prisma.deal.findMany throws', async () => {
    prisma.deal.findMany.mockRejectedValue(new Error('trend db boom'));

    const res = await request(makeApp()).get('/api/funnel/trend?months=6');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'trend db boom' });
  });
});
