// @ts-check
/**
 * Unit tests for backend/routes/deal_insights.js — runHeuristicRules() and
 * attachDealContext() (called by the cron at backend/cron/dealInsightsEngine.js).
 *
 * Why this file exists (regression class — issues #572 + #582):
 *   - The deal-insights heuristic-rule engine had ZERO unit-level tests.
 *     The G-13 e2e spec (deal-insights-engine-api.spec.js) covers the full
 *     /run + /generate routes through HTTP, but pinning the date-math
 *     branch boundaries (daysOverdue 0 / 1 / 6 / 7) and the null-expectedClose
 *     guard against regression is awkward through e2e — every assertion
 *     pays a Prisma round-trip + dedup check.
 *
 *   - Issue #582: pre-fix the rule fired CRITICAL on ANY (now − expectedClose) > 0,
 *     including the < 24h case where Math.floor → 0 ("Deal is 0 day(s) past
 *     expected close"). 22 of 498 demo CRITICAL alerts were 0-day noise. Fix
 *     splits severity by daysOverdue threshold:
 *       0 (today/null/future) → no insight
 *       1-6 → WARNING
 *       >=7 → CRITICAL
 *
 *   - Issue #572: pre-fix GET /api/deal-insights returned bare DealInsight
 *     rows; the frontend's parallel /api/deals?limit=100 missed deals outside
 *     the newest-100 window → "Deal details unavailable" placeholder for ~80%
 *     of insights. Fix adds attachDealContext() that does a single
 *     `findMany({ where: { id: { in: dealIds }, tenantId } })` and hangs the
 *     result on each row as `dealContext`. Soft-deleted deals come through
 *     with `isArchived: true` so the UI labels them rather than hiding.
 *
 * Functions covered:
 *   - runHeuristicRules(deal):
 *       * RISK / no-activity branch (lastTouch missing)
 *       * RISK / no-activity branch (lastTouch > 30d)
 *       * RISK / past-expected-close branch — date-math threshold
 *           (the heart of #582 — exhaustive boundary testing)
 *       * RISK / low-engagement branch (no emails AND no calls)
 *       * OPPORTUNITY / multi-DM branch (>3 distinct email participants)
 *       * NEXT_BEST_ACTION / follow-up window (7-14 days since last email)
 *
 *   - attachDealContext(insights, tenantId):
 *       * empty / null insights → returns input unchanged
 *       * insights with hard-deleted deals (no row) → dealContext = null
 *       * active deals → dealContext fully populated incl. contactName
 *       * soft-deleted deals → dealContext.isArchived = true
 *       * tenant scope → join's where-clause includes tenantId
 *       * shape contract — all expected keys, no leak of unrelated columns
 *
 * Mocking strategy:
 *   The runHeuristicRules function is a pure function over the deal object.
 *   No prisma calls inside it — we just hand-build deal fixtures and assert.
 *   For attachDealContext we mock the prisma singleton (deal.findMany).
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// Mocking pattern (mirrors backend/test/cron/recurringInvoiceEngine.test.js):
//   - Import the prisma singleton directly. Monkey-patch model accessors with
//     vi.fn() before the SUT's call sites fire. The vitest.config.js inlines
//     backend/lib/, backend/middleware/, backend/services/, backend/utils/ —
//     and per the 940b4f0 wave, we extended that to backend/routes/ via the
//     server.deps.inline regex. So when the SUT (`routes/deal_insights.js`)
//     does `require('../lib/prisma')`, it hits the SAME singleton we just
//     patched here.
//
// runHeuristicRules() is pure — no prisma calls — but importing the SUT still
// triggers express.Router() + Gemini.init at module-load time. Those are
// harmless in unit-test scope.

beforeAll(() => {
  prisma.deal = {
    findMany: vi.fn(),
  };
});

const { runHeuristicRules, attachDealContext, buildMissingDealContext } = require('../../routes/deal_insights');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a deal fixture with overridable fields. */
function makeDeal(overrides = {}) {
  return {
    id: 1,
    title: 'Test Deal',
    amount: 10000,
    currency: 'USD',
    stage: 'proposal',
    probability: 50,
    expectedClose: null,
    contact: { activities: [], emails: [], callLogs: [] },
    ...overrides,
  };
}

/** Date N days ago from now. */
function daysAgo(n) {
  return new Date(Date.now() - n * MS_PER_DAY);
}

/** Date N days from now in the future. */
function daysFromNow(n) {
  return new Date(Date.now() + n * MS_PER_DAY);
}

// ─── runHeuristicRules — past-expected-close branch (#582 core fix) ─────────

describe('routes/deal_insights — runHeuristicRules — #582 expectedClose threshold', () => {
  test('expectedClose null → NO past-expected-close insight emitted', async () => {
    const deal = makeDeal({ expectedClose: null });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(0);
  });

  test('expectedClose === today (diff 0d) → NO past-expected-close insight (was CRITICAL noise pre-#582)', async () => {
    const deal = makeDeal({ expectedClose: new Date() });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(
      overdue,
      'pre-fix this fired CRITICAL "0 day(s) past" — must now be silent'
    ).toHaveLength(0);
  });

  test('expectedClose 14 days in future → NO past-expected-close insight', async () => {
    const deal = makeDeal({ expectedClose: daysFromNow(14) });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(0);
  });

  test('expectedClose 1 day past → WARNING (lower bound of WARNING band)', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(1.1) }); // 1.1d so floor → 1
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].severity).toBe('WARNING');
    expect(overdue[0].type).toBe('RISK');
    expect(overdue[0].insight).toMatch(/1 day\(s\)/);
  });

  test('expectedClose 6 days past → WARNING (upper bound of WARNING band)', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(6.1) });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].severity).toBe('WARNING');
    expect(overdue[0].insight).toMatch(/6 day\(s\)/);
  });

  test('expectedClose 7 days past → CRITICAL (lower bound of CRITICAL band)', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(7.1) });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].severity).toBe('CRITICAL');
    expect(overdue[0].insight).toMatch(/7 day\(s\)/);
  });

  test('expectedClose 30 days past → CRITICAL', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(30.1) });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].severity).toBe('CRITICAL');
    expect(overdue[0].insight).toMatch(/30 day\(s\)/);
  });

  test('won deal with expectedClose 30 days past → NO past-expected-close insight (excluded by stage filter)', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(30), stage: 'won' });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(0);
  });

  test('lost deal with expectedClose 30 days past → NO past-expected-close insight', async () => {
    const deal = makeDeal({ expectedClose: daysAgo(30), stage: 'lost' });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(0);
  });

  test('invalid expectedClose value → NO past-expected-close insight (Number.isFinite guard)', async () => {
    const deal = makeDeal({ expectedClose: 'not-a-real-date' });
    const out = await runHeuristicRules(deal);
    const overdue = out.filter(i => /past expected close/i.test(i.insight));
    expect(overdue).toHaveLength(0);
  });
});

// ─── runHeuristicRules — other rule branches (sanity coverage) ──────────────

describe('routes/deal_insights — runHeuristicRules — other branches', () => {
  test('no contact activity at all → emits no-activity + low-engagement', async () => {
    const out = await runHeuristicRules(makeDeal());
    const types = out.map(i => i.type);
    const insights = out.map(i => i.insight);
    expect(types).toContain('RISK');
    // Both rules expected to fire.
    expect(insights.some(s => /No activity recorded/i.test(s))).toBe(true);
    expect(insights.some(s => /Low engagement/i.test(s))).toBe(true);
  });

  test('contact has email within 30 days → no "no activity" warning', async () => {
    const deal = makeDeal({
      contact: {
        activities: [],
        emails: [{ createdAt: daysAgo(2), subject: 'hi' }],
        callLogs: [],
      },
    });
    const out = await runHeuristicRules(deal);
    expect(out.some(i => /No activity in/i.test(i.insight))).toBe(false);
  });

  test('contact has email 35 days ago → "No activity in 35 days" warning', async () => {
    const deal = makeDeal({
      contact: {
        activities: [],
        emails: [{ createdAt: daysAgo(35), subject: 'old' }],
        callLogs: [],
      },
    });
    const out = await runHeuristicRules(deal);
    const noAct = out.find(i => /No activity in/i.test(i.insight));
    expect(noAct).toBeTruthy();
    expect(noAct.severity).toBe('WARNING');
    expect(noAct.insight).toMatch(/35 days/);
  });

  test('multiple decision makers (>3 distinct participants) → OPPORTUNITY emitted', async () => {
    const deal = makeDeal({
      contact: {
        activities: [],
        emails: [
          { createdAt: new Date(), from: 'a@x.com', to: 'rep@us.com', subject: '' },
          { createdAt: new Date(), from: 'b@x.com', to: 'rep@us.com', subject: '' },
          { createdAt: new Date(), from: 'c@x.com', to: 'rep@us.com', subject: '' },
          { createdAt: new Date(), from: 'd@x.com', to: 'rep@us.com', subject: '' },
        ],
        callLogs: [],
      },
    });
    const out = await runHeuristicRules(deal);
    const opp = out.find(i => i.type === 'OPPORTUNITY');
    expect(opp).toBeTruthy();
    expect(opp.severity).toBe('INFO');
    expect(opp.insight).toMatch(/Multiple decision makers/i);
  });

  test('last email 10 days ago → NEXT_BEST_ACTION follow-up window', async () => {
    const deal = makeDeal({
      contact: {
        activities: [],
        emails: [{ createdAt: daysAgo(10), from: 'rep@x.com', to: 'cust@y.com', subject: 'q' }],
        callLogs: [],
      },
    });
    const out = await runHeuristicRules(deal);
    const nba = out.find(i => i.type === 'NEXT_BEST_ACTION');
    expect(nba).toBeTruthy();
    expect(nba.insight).toMatch(/10 days ago/);
  });

  test('last email 5 days ago → no NEXT_BEST_ACTION (too soon)', async () => {
    const deal = makeDeal({
      contact: {
        activities: [],
        emails: [{ createdAt: daysAgo(5), from: 'rep@x.com', to: 'cust@y.com', subject: 'q' }],
        callLogs: [],
      },
    });
    const out = await runHeuristicRules(deal);
    expect(out.some(i => i.type === 'NEXT_BEST_ACTION')).toBe(false);
  });
});

// ─── attachDealContext — #572 enrichment helper ─────────────────────────────

describe('routes/deal_insights — attachDealContext — #572 envelope enrichment', () => {
  beforeEach(() => {
    prisma.deal.findMany.mockReset();
  });

  test('empty insights array → returns input unchanged, no DB call', async () => {
    const out = await attachDealContext([], 1);
    expect(out).toEqual([]);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('null insights → returns input unchanged', async () => {
    const out = await attachDealContext(null, 1);
    expect(out).toBeNull();
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('insights with no dealIds → all rows get dealContext: null, no DB call', async () => {
    // dealId === null is "no deal linked" (distinct from "deal-id-set-but-
    // missing" which now yields a sentinel envelope per #587). Null stays
    // null so callers can distinguish.
    const insights = [{ id: 1, dealId: null, type: 'RISK' }];
    const out = await attachDealContext(insights, 1);
    expect(out).toEqual([{ id: 1, dealId: null, type: 'RISK', dealContext: null }]);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('happy path — populates dealContext with title/amount/stage/contactName', async () => {
    const insights = [
      { id: 10, dealId: 100, type: 'RISK', insight: 'a' },
      { id: 11, dealId: 100, type: 'RISK', insight: 'b' }, // same deal — single DB row reused
      { id: 12, dealId: 200, type: 'OPPORTUNITY', insight: 'c' },
    ];
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 100,
        title: 'Big Deal',
        amount: 50000,
        currency: 'USD',
        stage: 'proposal',
        probability: 70,
        expectedClose: null,
        deletedAt: null,
        contact: { name: 'Alice', company: 'Acme' },
      },
      {
        id: 200,
        title: 'Other',
        amount: 1000,
        currency: 'EUR',
        stage: 'lead',
        probability: 10,
        expectedClose: new Date('2026-12-01'),
        deletedAt: null,
        contact: { name: 'Bob', company: null },
      },
    ]);

    const out = await attachDealContext(insights, 7);

    // Dedupe of dealIds — DB called once with Set([100, 200]).
    expect(prisma.deal.findMany).toHaveBeenCalledTimes(1);
    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(7);
    expect(callArgs.where.id.in.sort()).toEqual([100, 200]);
    expect(callArgs.select.title).toBe(true);

    // Each insight has dealContext attached, and same-deal rows share data.
    expect(out[0].dealContext.id).toBe(100);
    expect(out[0].dealContext.title).toBe('Big Deal');
    expect(out[0].dealContext.amount).toBe(50000);
    expect(out[0].dealContext.stage).toBe('proposal');
    expect(out[0].dealContext.contactName).toBe('Alice');
    expect(out[0].dealContext.contactCompany).toBe('Acme');
    expect(out[0].dealContext.isArchived).toBe(false);
    // #587: every resolved envelope carries isMissing:false explicitly so
    // the frontend's branch is `if (ctx.isMissing)` rather than checking
    // for an absent flag.
    expect(out[0].dealContext.isMissing).toBe(false);

    expect(out[1].dealContext.id).toBe(100); // same deal — same context
    expect(out[1].dealContext.title).toBe('Big Deal');

    expect(out[2].dealContext.id).toBe(200);
    expect(out[2].dealContext.contactName).toBe('Bob');
    expect(out[2].dealContext.contactCompany).toBeNull();
    expect(out[2].dealContext.isMissing).toBe(false);
  });

  test('soft-deleted deal → isArchived true, deletedAt populated', async () => {
    const deletedAt = new Date('2026-04-01');
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 300,
        title: 'Archived Deal',
        amount: 0,
        currency: 'USD',
        stage: 'proposal',
        probability: 0,
        expectedClose: null,
        deletedAt,
        contact: null,
      },
    ]);
    const out = await attachDealContext([{ id: 1, dealId: 300 }], 1);
    expect(out[0].dealContext.isArchived).toBe(true);
    expect(out[0].dealContext.deletedAt).toEqual(deletedAt);
    expect(out[0].dealContext.contactName).toBeNull();
  });

  test('#587: hard-deleted deal → dealContext is the isMissing:true sentinel, NOT null', async () => {
    // Pre-#587 the helper returned `dealContext: null` for orphan FKs.
    // The frontend's chained fallback (server ctx → /api/deals?limit=100)
    // missed those rows and rendered "Deal details unavailable". Post-fix
    // the helper returns a sentinel envelope so the frontend's only branch
    // is "isMissing? → render placeholder text 'Deal #<id> (no longer
    // available)'" rather than handling null at every site.
    prisma.deal.findMany.mockResolvedValue([]); // no matching rows for dealId=999
    const out = await attachDealContext([{ id: 99, dealId: 999 }], 1);
    expect(out[0].dealContext).not.toBeNull();
    expect(out[0].dealContext.id).toBe(999);
    expect(out[0].dealContext.isMissing).toBe(true);
    expect(out[0].dealContext.isArchived).toBe(false);
    expect(out[0].dealContext.title).toBeNull();
    expect(out[0].dealContext.amount).toBeNull();
    expect(out[0].dealContext.stage).toBeNull();
    expect(out[0].dealContext.contactName).toBeNull();
    // Same key set as a resolved envelope — every key present so the
    // frontend never sees `undefined`.
    expect(Object.keys(out[0].dealContext).sort()).toEqual(
      Object.keys(buildMissingDealContext(999)).sort()
    );
  });

  test('#587: mix of resolved + orphan dealIds in one call → each row gets the correct shape', async () => {
    // dealId 100 resolves to a live deal; dealId 999 has no matching row
    // (hard-deleted / cross-tenant). Both must surface in the output —
    // resolved with isMissing:false, orphan with isMissing:true.
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 100,
        title: 'Live Deal',
        amount: 5000,
        currency: 'USD',
        stage: 'proposal',
        probability: 50,
        expectedClose: null,
        deletedAt: null,
        contact: { name: 'Alice', company: null },
      },
    ]);
    const out = await attachDealContext(
      [
        { id: 1, dealId: 100, type: 'RISK' },
        { id: 2, dealId: 999, type: 'RISK' },
      ],
      1
    );
    expect(out).toHaveLength(2);
    expect(out[0].dealContext.isMissing).toBe(false);
    expect(out[0].dealContext.title).toBe('Live Deal');
    expect(out[1].dealContext.isMissing).toBe(true);
    expect(out[1].dealContext.id).toBe(999);
    expect(out[1].dealContext.title).toBeNull();
  });

  test('#587: buildMissingDealContext returns the canonical sentinel shape', async () => {
    const sentinel = buildMissingDealContext(42);
    expect(sentinel).toEqual({
      id: 42,
      title: null,
      amount: null,
      currency: null,
      stage: null,
      probability: null,
      expectedClose: null,
      deletedAt: null,
      contactName: null,
      contactCompany: null,
      isArchived: false,
      isMissing: true,
    });
  });

  test('cross-tenant scope — where-clause always includes tenantId', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    await attachDealContext([{ id: 1, dealId: 5 }, { id: 2, dealId: 6 }], 42);
    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(42);
    // Must scope by dealIds AND tenantId — never just one.
    expect(callArgs.where.id.in).toBeDefined();
  });

  test('preserves all original insight fields (additive envelope)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 50,
        title: 'X',
        amount: 1,
        currency: 'USD',
        stage: 'lead',
        probability: 50,
        expectedClose: null,
        deletedAt: null,
        contact: { name: 'C', company: null },
      },
    ]);
    const original = {
      id: 7,
      dealId: 50,
      tenantId: 1,
      type: 'RISK',
      severity: 'WARNING',
      insight: 'something',
      isResolved: false,
      generatedAt: new Date('2026-01-01'),
    };
    const out = await attachDealContext([original], 1);
    // Every original key still on the row.
    expect(out[0].id).toBe(7);
    expect(out[0].dealId).toBe(50);
    expect(out[0].type).toBe('RISK');
    expect(out[0].severity).toBe('WARNING');
    expect(out[0].insight).toBe('something');
    expect(out[0].isResolved).toBe(false);
    // Plus the new key.
    expect(out[0].dealContext).toBeTruthy();
  });
});
