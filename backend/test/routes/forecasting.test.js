// @ts-check
/**
 * Unit tests for backend/routes/forecasting.js — pin the per-deal
 * arithmetic invariants for the forecasting Expected/Best Case/Committed/
 * Closed bucketing helper.
 *
 * Why this file exists (closes #573):
 *   The /forecasting page rendered Expected = $175.9M against Closed =
 *   $1.17M (151× plausible). Root cause: Deal.probability is `Int @default(50)`
 *   in prisma/schema.prisma with NO upper-bound constraint, so a stray write
 *   (or import migration) of probability=99999 multiplies through to the
 *   $175M number on what was a $175k deal.
 *
 *   The fix lives in backend/routes/forecasting.js's bucketDealMetrics
 *   helper (also propagated to /pipeline + /snapshot/run). Per-deal
 *   sanitisation runs BEFORE the multiplication so the sentinel is
 *   visible per-deal (not a post-aggregate cap that loses signal).
 *
 *   Defensive cap formula:
 *     - sanitizeAmount(raw)     : NaN/Infinity/negative → 0
 *     - clampProbability(raw)   : ∈ [0, 100]; NaN → 0
 *     - bucketDealMetrics()     : Expected ≤ sum(amount) of OPEN deals
 *
 * Gap-card-vs-reality drift documented:
 *   - Card said extend `backend/test/routes/forecasting.test.js if it
 *     exists`. It did not exist; this is the new file (matches the
 *     `backend/test/<area>/<module>.test.js` convention from CLAUDE.md
 *     standing rules + vitest.config.js's routes/ inlining).
 *   - Card said the "Expected cap at sum(amount) for non-Closed deals" —
 *     code reality is the cap is on OPEN-stage deals (won/lost excluded
 *     from bestCase/expected), which is the same set as "non-Closed AND
 *     not lost". The test asserts the actual route invariant.
 *
 * Pattern reference: backend/test/utils/formatMoney.test.js — pure
 * helper-shape tests, no DB, no mocks needed for these path-1 cases.
 * The helpers were exported from forecasting.js for testability.
 */
import { describe, test, expect } from 'vitest';

const {
  bucketDealMetrics,
  sanitizeAmount,
  clampProbability,
} = require('../../routes/forecasting');

describe('forecasting/sanitizeAmount — finite non-negative input', () => {
  test('numeric input passes through unchanged', () => {
    expect(sanitizeAmount(125000)).toBe(125000);
    expect(sanitizeAmount(0)).toBe(0);
    expect(sanitizeAmount(0.01)).toBe(0.01);
  });

  test('string-numeric input is coerced', () => {
    expect(sanitizeAmount('42000')).toBe(42000);
  });

  test('NaN → 0', () => {
    expect(sanitizeAmount(NaN)).toBe(0);
    expect(sanitizeAmount('not-a-number')).toBe(0);
  });

  test('Infinity → 0', () => {
    expect(sanitizeAmount(Infinity)).toBe(0);
    expect(sanitizeAmount(-Infinity)).toBe(0);
  });

  test('negative amount → 0 (a negative deal value is not a real signal)', () => {
    expect(sanitizeAmount(-500)).toBe(0);
  });

  test('null / undefined → 0', () => {
    expect(sanitizeAmount(null)).toBe(0);
    expect(sanitizeAmount(undefined)).toBe(0);
  });
});

describe('forecasting/clampProbability — [0, 100] window', () => {
  test('values inside [0, 100] pass through unchanged', () => {
    expect(clampProbability(0)).toBe(0);
    expect(clampProbability(50)).toBe(50);
    expect(clampProbability(100)).toBe(100);
    expect(clampProbability(75)).toBe(75);
  });

  test('values above 100 clamp to 100 (THE bug class — #573 root cause)', () => {
    expect(clampProbability(101)).toBe(100);
    expect(clampProbability(99999)).toBe(100);
    expect(clampProbability(1e9)).toBe(100);
  });

  test('negative values clamp to 0', () => {
    expect(clampProbability(-1)).toBe(0);
    expect(clampProbability(-99999)).toBe(0);
  });

  test('NaN / non-numeric → 0', () => {
    expect(clampProbability(NaN)).toBe(0);
    expect(clampProbability('garbage')).toBe(0);
    expect(clampProbability(null)).toBe(0);
    expect(clampProbability(undefined)).toBe(0);
  });

  test('Infinity → 0 (not 100; non-finite is treated as no-signal)', () => {
    expect(clampProbability(Infinity)).toBe(0);
  });
});

// ─── bucketDealMetrics — the aggregate invariant ───────────────────────────

describe('forecasting/bucketDealMetrics — basic aggregation', () => {
  test('empty list → all zeros', () => {
    const m = bucketDealMetrics([]);
    expect(m).toEqual({ expected: 0, committed: 0, bestCase: 0, closed: 0 });
  });

  test('one won deal → closed + committed only, no expected/bestCase', () => {
    const m = bucketDealMetrics([
      { amount: 125000, probability: 100, stage: 'won' },
    ]);
    expect(m.closed).toBe(125000);
    expect(m.committed).toBe(125000);
    expect(m.expected).toBe(0);
    expect(m.bestCase).toBe(0);
  });

  test('one open deal at 50% → expected = amount × 0.5; bestCase = amount', () => {
    const m = bucketDealMetrics([
      { amount: 100000, probability: 50, stage: 'proposal' },
    ]);
    expect(m.expected).toBe(50000);
    expect(m.bestCase).toBe(100000);
    expect(m.closed).toBe(0);
  });

  test('open deal at probability >= 90 contributes to committed (the canonical wedge)', () => {
    const m = bucketDealMetrics([
      { amount: 100000, probability: 90, stage: 'proposal' },
    ]);
    expect(m.committed).toBe(100000);
    expect(m.bestCase).toBe(100000);
    expect(m.expected).toBe(90000);
  });

  test('lost deal contributes nothing', () => {
    const m = bucketDealMetrics([
      { amount: 100000, probability: 0, stage: 'lost' },
    ]);
    expect(m).toEqual({ expected: 0, committed: 0, bestCase: 0, closed: 0 });
  });
});

// ─── #573 — the actual regression contract ─────────────────────────────────

describe('forecasting/bucketDealMetrics — #573 arithmetic-blowup defence', () => {
  test('per-deal probability is clamped to [0, 100] before multiplying', () => {
    // The root cause: a stray probability=99999 on a $175k deal
    // pre-fix produced 175000 * 99999/100 = ~$175M Expected.
    // Post-fix: 99999 clamps to 100 → expected = 175000.
    const m = bucketDealMetrics([
      { amount: 175000, probability: 99999, stage: 'proposal' },
    ]);
    expect(m.expected).toBe(175000);
    expect(m.bestCase).toBe(175000);
  });

  test('a deal with probability=99999 contributes the same as probability=100', () => {
    // Acceptance bullet from the dispatch.
    const overflow = bucketDealMetrics([
      { amount: 50000, probability: 99999, stage: 'proposal' },
    ]);
    const clamped = bucketDealMetrics([
      { amount: 50000, probability: 100, stage: 'proposal' },
    ]);
    expect(overflow.expected).toBe(clamped.expected);
    expect(overflow.committed).toBe(clamped.committed);
    expect(overflow.bestCase).toBe(clamped.bestCase);
  });

  test('Expected cannot exceed sum of OPEN-deal amounts (the load-bearing invariant)', () => {
    // Build a synthetic deal list where if probability were unclamped,
    // Expected would explode past the sum-of-amounts ceiling.
    const deals = [
      { amount: 100000, probability: 50000, stage: 'proposal' },  // bad
      { amount: 50000,  probability: 9999,  stage: 'contacted' }, // bad
      { amount: 25000,  probability: 75,    stage: 'lead' },      // good
      { amount: 200000, probability: 100,   stage: 'won' },       // closed, ignored for bestCase
    ];
    const m = bucketDealMetrics(deals);
    const openAmountTotal = 100000 + 50000 + 25000;
    expect(m.expected).toBeLessThanOrEqual(openAmountTotal);
    expect(m.bestCase).toBe(openAmountTotal);
    expect(m.closed).toBe(200000);
  });

  test('NaN / Infinity amount is dropped to 0 (never inflates totals)', () => {
    const m = bucketDealMetrics([
      { amount: NaN, probability: 50, stage: 'proposal' },
      { amount: Infinity, probability: 50, stage: 'proposal' },
      { amount: 100000, probability: 50, stage: 'proposal' },
    ]);
    expect(m.expected).toBe(50000);
    expect(m.bestCase).toBe(100000);
  });

  test('Negative amount is dropped to 0 (never reduces totals)', () => {
    const m = bucketDealMetrics([
      { amount: -100000, probability: 50, stage: 'proposal' },
      { amount: 100000, probability: 50, stage: 'proposal' },
    ]);
    // Negative would have produced expected = -50000+50000 = 0 if accepted;
    // dropped → just the positive deal's contribution.
    expect(m.expected).toBe(50000);
    expect(m.bestCase).toBe(100000);
  });

  test('mixed realistic pipeline does NOT trigger the post-aggregate cap', () => {
    // Real demo-ish data: nothing pathological. The defensive cap should
    // be a no-op here; per-deal math is exactly the aggregate.
    const deals = [
      { amount: 125000, probability: 100, stage: 'won' },
      { amount: 150000, probability: 80,  stage: 'proposal' },
      { amount: 95000,  probability: 40,  stage: 'contacted' },
      { amount: 200000, probability: 20,  stage: 'lead' },
      { amount: 33000,  probability: 0,   stage: 'lost' },
    ];
    const m = bucketDealMetrics(deals);
    // expected = 150000*0.8 + 95000*0.4 + 200000*0.2 = 120000 + 38000 + 40000 = 198000
    expect(m.expected).toBe(198000);
    // bestCase = 150000 + 95000 + 200000 = 445000
    expect(m.bestCase).toBe(445000);
    // closed = 125000
    expect(m.closed).toBe(125000);
    // committed = 125000 (won) + 0 (no others ≥ 90% AND open ; won already counted)
    expect(m.committed).toBe(125000);
  });
});

// ─── Extended coverage: under-pinned helper edges (+10 cases) ──────────────
// Forecasting.js is 476 LOC with 22 existing cases — biggest absolute SUT-to-
// test gap in routes/. These cases pin contracts that hadn't been asserted:
// stage-casing normalisation, missing-stage default in bucketDealMetrics
// (note: differs from /pipeline's "lead" default — bucketDealMetrics treats
// missing stage as OPEN because OPEN_STAGES returns true unless lowercased
// stage is "won"|"lost"), decimal rounding to 2dp, the won+probability≥90
// double-count contract, scaling across many deals, and helper purity.

describe('forecasting/bucketDealMetrics — stage casing & defaults', () => {
  test('stage casing is normalised (WON / Won / won all count as closed)', () => {
    const m = bucketDealMetrics([
      { amount: 10000, probability: 100, stage: 'WON' },
      { amount: 20000, probability: 100, stage: 'Won' },
      { amount: 30000, probability: 100, stage: 'won' },
    ]);
    expect(m.closed).toBe(60000);
    expect(m.committed).toBe(60000);
    expect(m.bestCase).toBe(0); // none open
    expect(m.expected).toBe(0);
  });

  test('LOST in any casing contributes nothing', () => {
    const m = bucketDealMetrics([
      { amount: 50000, probability: 80, stage: 'LOST' },
      { amount: 75000, probability: 50, stage: 'Lost' },
    ]);
    expect(m).toEqual({ expected: 0, committed: 0, bestCase: 0, closed: 0 });
  });

  test('missing/undefined stage is treated as OPEN (not won/lost → contributes to expected & bestCase)', () => {
    // OPEN_STAGES returns true for any stage that isn't won/lost — including
    // undefined/null/'' (since "".toLowerCase() === "" which is neither).
    const m = bucketDealMetrics([
      { amount: 100000, probability: 40 }, // no stage at all
      { amount: 50000, probability: 60, stage: null },
      { amount: 25000, probability: 20, stage: '' },
    ]);
    // expected = 100000*0.4 + 50000*0.6 + 25000*0.2 = 40000 + 30000 + 5000 = 75000
    expect(m.expected).toBe(75000);
    // bestCase = 100000 + 50000 + 25000 = 175000
    expect(m.bestCase).toBe(175000);
    expect(m.closed).toBe(0);
  });
});

describe('forecasting/bucketDealMetrics — committed bucket nuances', () => {
  test('won deal with probability=0 still counts toward committed (won is unconditional)', () => {
    // committed = won OR probability >= 90 — so a probability=0 won deal
    // (e.g. owner forgot to update probability when marking won) still lands
    // in committed by virtue of the won-stage clause.
    const m = bucketDealMetrics([
      { amount: 80000, probability: 0, stage: 'won' },
    ]);
    expect(m.committed).toBe(80000);
    expect(m.closed).toBe(80000);
  });

  test('open deal exactly at 90% is committed (boundary inclusive)', () => {
    const m = bucketDealMetrics([
      { amount: 60000, probability: 89, stage: 'proposal' },
      { amount: 40000, probability: 90, stage: 'proposal' },
    ]);
    // Only the 90% deal hits the >= 90 threshold.
    expect(m.committed).toBe(40000);
    // Both contribute to bestCase + expected (both open).
    expect(m.bestCase).toBe(100000);
    // expected = 60000*0.89 + 40000*0.90 = 53400 + 36000 = 89400
    expect(m.expected).toBe(89400);
  });

  test('a won deal is counted ONCE in committed even though both clauses match', () => {
    // committed = sum(amount) where stage==won OR probability>=90. The two
    // clauses overlap on a won-deal-at-100%; the code does a single-pass add
    // inside an `if (... || ...)` so committed sums each deal at most once.
    const m = bucketDealMetrics([
      { amount: 100000, probability: 100, stage: 'won' },
    ]);
    expect(m.committed).toBe(100000); // not 200000
    expect(m.closed).toBe(100000);
  });
});

describe('forecasting/bucketDealMetrics — rounding & scaling', () => {
  test('expected is rounded to 2 decimal places (no floating-point garbage in API output)', () => {
    // Pick a probability that produces a value with >2dp before rounding.
    // 33333 * 0.07 = 2333.31 (exact); use a less round combo:
    // 99999 * 0.07 = 6999.93 — still clean.
    // Force a known irrational-looking product: 100/3 isn't representable,
    // but the route only multiplies probability/100 (always exact for int %).
    // Probability=33, amount=100.01 → 100.01 * 0.33 = 33.0033 → rounds to 33.
    const m = bucketDealMetrics([
      { amount: 100.01, probability: 33, stage: 'proposal' },
    ]);
    expect(m.expected).toBe(33);
    expect(m.bestCase).toBe(100.01);
  });

  test('aggregating 1000 small deals scales linearly and stays within Expected≤BestCase', () => {
    // Defensive cap should be a no-op; expected ≤ bestCase by construction.
    const deals = [];
    for (let i = 0; i < 1000; i++) {
      deals.push({ amount: 1000, probability: 50, stage: 'proposal' });
    }
    const m = bucketDealMetrics(deals);
    // expected = 1000 * 1000 * 0.5 = 500000
    expect(m.expected).toBe(500000);
    // bestCase = 1000 * 1000 = 1000000
    expect(m.bestCase).toBe(1000000);
    expect(m.expected).toBeLessThanOrEqual(m.bestCase);
  });

  test('helpers are pure — calling bucketDealMetrics twice with the same input yields the same output', () => {
    const deals = [
      { amount: 150000, probability: 80, stage: 'proposal' },
      { amount: 75000, probability: 100, stage: 'won' },
    ];
    const m1 = bucketDealMetrics(deals);
    const m2 = bucketDealMetrics(deals);
    expect(m1).toEqual(m2);
    // Input list is not mutated.
    expect(deals).toEqual([
      { amount: 150000, probability: 80, stage: 'proposal' },
      { amount: 75000, probability: 100, stage: 'won' },
    ]);
  });

  test('string-numeric amounts inside a deal list are coerced through sanitizeAmount', () => {
    // bucketDealMetrics passes deal.amount through sanitizeAmount, which
    // does Number() coercion — so a CSV-imported deal with amount='42000'
    // still aggregates correctly.
    const m = bucketDealMetrics([
      { amount: '42000', probability: 50, stage: 'proposal' },
      { amount: '8000', probability: 100, stage: 'won' },
    ]);
    expect(m.expected).toBe(21000); // 42000 * 0.5
    expect(m.bestCase).toBe(42000);
    expect(m.closed).toBe(8000);
    expect(m.committed).toBe(8000);
  });
});
