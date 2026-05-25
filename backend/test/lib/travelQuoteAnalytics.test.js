// Travel CRM — Quote analytics rollup pure-function unit tests.
//
// SUT: backend/lib/travelQuoteAnalytics.js — slice 13 of #900
// (PRD_TRAVEL_QUOTE_BUILDER §3). Feeds GET /api/travel/quotes/analytics.
//
// === What's pinned here ===
// The SUT is a 4-pass aggregation (status / sub-brand / terminal-time /
// expired). These tests pin EACH pass independently plus the helpers:
//   - empty/null/non-array baseline → zeroed envelope
//   - unknown status skipped from byStatus + bySubBrand (but still counted
//     in top-level `total: list.length` — the SUT contract)
//   - byStatus + bySubBrand bucketing across all 4 statuses
//   - bySubBrand falsy → '_unknown' fallback per `String(q.subBrand || ...)`
//   - totalValueByStatus naive sum with string + null coercion
//   - acceptanceRate over terminal states only; null when denom = 0
//   - avgTimeToDecisionDays mean in days, half-up to 2dp;
//     defensive skip when updatedAt < createdAt
//   - expiredCount: non-terminal + validUntil<now ONLY (terminal-expired excluded)
//   - currency: single-currency carry-through, mixed → null,
//     zero quotes → null, missing currency on some quotes still derives a
//     singular currency if the rest share one
//   - opts.now injection determinism
//   - roundHalfUp2 boundary behavior: 0.005 → 0.01 (half-up); -0.005 → 0
//     (Math.round + epsilon biases negative half-cases toward zero);
//     Infinity/NaN passthrough
//   - Exported constants: TERMINAL_STATUSES, NON_TERMINAL_STATUSES,
//     ALL_STATUSES shape
//
// Pure function — no Prisma, no mocks needed. Deterministic via opts.now.

import { describe, it, expect } from "vitest";
import {
  computeQuoteAnalytics,
  roundHalfUp2,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  ALL_STATUSES,
} from "../../lib/travelQuoteAnalytics.js";

const NOW = new Date("2026-05-25T12:00:00Z");
const PAST = new Date("2026-04-01T00:00:00Z").toISOString();
const FUTURE = new Date("2026-06-30T00:00:00Z").toISOString();

// Helper — build a quote with sensible defaults, override per test.
function q(overrides = {}) {
  return {
    id: 1,
    subBrand: "tmc",
    status: "Draft",
    totalAmount: 100,
    currency: "USD",
    validUntil: FUTURE,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeQuoteAnalytics — baseline / defensive inputs", () => {
  it("empty array → total=0, zeroed byStatus, null currency / acceptanceRate / avgTimeToDecisionDays", () => {
    const r = computeQuoteAnalytics([], { now: NOW });
    expect(r.total).toBe(0);
    expect(r.byStatus).toEqual({ Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 });
    expect(r.totalValueByStatus).toEqual({ Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 });
    expect(r.bySubBrand).toEqual({});
    expect(r.acceptanceRate).toBeNull();
    expect(r.avgTimeToDecisionDays).toBeNull();
    expect(r.expiredCount).toBe(0);
    expect(r.currency).toBeNull();
  });

  it("null / undefined / non-array quotes → coerced to empty (no throw)", () => {
    for (const bad of [null, undefined, "not-an-array", 42, { a: 1 }]) {
      const r = computeQuoteAnalytics(bad, { now: NOW });
      expect(r.total).toBe(0);
      expect(r.byStatus).toEqual({ Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 });
      expect(r.currency).toBeNull();
      expect(r.acceptanceRate).toBeNull();
      expect(r.avgTimeToDecisionDays).toBeNull();
    }
  });

  it("unknown status is skipped from byStatus + bySubBrand (but list.length still counts toward total)", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Pending" }),  // unknown
        q({ status: "WeirdValue" }), // unknown
        q({ status: "Draft" }),
      ],
      { now: NOW },
    );
    // SUT contract: total = list.length (NOT filtered by valid-status).
    expect(r.total).toBe(3);
    expect(r.byStatus).toEqual({ Draft: 1, Sent: 0, Accepted: 0, Rejected: 0 });
    // Only the Draft entry made it into bySubBrand.
    expect(r.bySubBrand).toEqual({
      tmc: { total: 1, Draft: 1, Sent: 0, Accepted: 0, Rejected: 0 },
    });
  });
});

describe("computeQuoteAnalytics — byStatus counts across all 4 statuses", () => {
  it("each of Draft / Sent / Accepted / Rejected counted in its own bucket", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft" }),
        q({ status: "Draft" }),
        q({ status: "Sent" }),
        q({ status: "Accepted" }),
        q({ status: "Accepted" }),
        q({ status: "Accepted" }),
        q({ status: "Rejected" }),
      ],
      { now: NOW },
    );
    expect(r.byStatus).toEqual({ Draft: 2, Sent: 1, Accepted: 3, Rejected: 1 });
    expect(r.total).toBe(7);
  });
});

describe("computeQuoteAnalytics — bySubBrand bucketing", () => {
  it("segregates multiple subBrands; each sub-bucket has total + 4 status counts", () => {
    const r = computeQuoteAnalytics(
      [
        q({ subBrand: "tmc", status: "Draft" }),
        q({ subBrand: "tmc", status: "Accepted" }),
        q({ subBrand: "rfu", status: "Sent" }),
        q({ subBrand: "rfu", status: "Rejected" }),
        q({ subBrand: "stall", status: "Accepted" }),
      ],
      { now: NOW },
    );
    expect(r.bySubBrand.tmc).toEqual({ total: 2, Draft: 1, Sent: 0, Accepted: 1, Rejected: 0 });
    expect(r.bySubBrand.rfu).toEqual({ total: 2, Draft: 0, Sent: 1, Accepted: 0, Rejected: 1 });
    expect(r.bySubBrand.stall).toEqual({ total: 1, Draft: 0, Sent: 0, Accepted: 1, Rejected: 0 });
  });

  it("falsy subBrand (null / undefined / empty string) lands under '_unknown'", () => {
    const r = computeQuoteAnalytics(
      [
        q({ subBrand: null, status: "Draft" }),
        q({ subBrand: undefined, status: "Sent" }),
        q({ subBrand: "", status: "Accepted" }),
      ],
      { now: NOW },
    );
    expect(r.bySubBrand._unknown).toEqual({
      total: 3,
      Draft: 1,
      Sent: 1,
      Accepted: 1,
      Rejected: 0,
    });
    // No other buckets created.
    expect(Object.keys(r.bySubBrand)).toEqual(["_unknown"]);
  });
});

describe("computeQuoteAnalytics — totalValueByStatus naive sum + coercion", () => {
  it("sums totalAmount per status; string '150.50' coerced via Number(); null treated as 0", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", totalAmount: 100 }),
        q({ status: "Draft", totalAmount: "150.50" }),  // string coercion
        q({ status: "Draft", totalAmount: null }),      // → 0, no NaN poison
        q({ status: "Sent", totalAmount: 200 }),
        q({ status: "Accepted", totalAmount: 999.99 }),
        q({ status: "Rejected", totalAmount: 50 }),
      ],
      { now: NOW },
    );
    expect(r.totalValueByStatus.Draft).toBeCloseTo(250.5, 6);
    expect(r.totalValueByStatus.Sent).toBe(200);
    expect(r.totalValueByStatus.Accepted).toBeCloseTo(999.99, 6);
    expect(r.totalValueByStatus.Rejected).toBe(50);
  });

  it("non-finite totalAmount (NaN-producing string) does NOT poison the running sum", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", totalAmount: 100 }),
        q({ status: "Draft", totalAmount: "not-a-number" }), // Number(...) → NaN, skipped
        q({ status: "Draft", totalAmount: 50 }),
      ],
      { now: NOW },
    );
    expect(r.totalValueByStatus.Draft).toBe(150);
  });
});

describe("computeQuoteAnalytics — acceptanceRate (terminal states only)", () => {
  it("3 Accepted + 1 Rejected → 0.75", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Accepted" }),
        q({ status: "Accepted" }),
        q({ status: "Accepted" }),
        q({ status: "Rejected" }),
      ],
      { now: NOW },
    );
    expect(r.acceptanceRate).toBe(0.75);
  });

  it("ignores Draft / Sent — only terminal states count toward the denominator", () => {
    // 1 Accepted + 1 Rejected → 0.5, regardless of how many Draft/Sent siblings.
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft" }),
        q({ status: "Draft" }),
        q({ status: "Sent" }),
        q({ status: "Accepted" }),
        q({ status: "Rejected" }),
      ],
      { now: NOW },
    );
    expect(r.acceptanceRate).toBe(0.5);
  });

  it("zero terminal-state quotes → null (not 0)", () => {
    const r = computeQuoteAnalytics(
      [q({ status: "Draft" }), q({ status: "Sent" })],
      { now: NOW },
    );
    expect(r.acceptanceRate).toBeNull();
  });

  it("rounding: 2 Accepted + 1 Rejected → 0.67 (2/3 half-up to 2dp)", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Accepted" }),
        q({ status: "Accepted" }),
        q({ status: "Rejected" }),
      ],
      { now: NOW },
    );
    expect(r.acceptanceRate).toBe(0.67);
  });
});

describe("computeQuoteAnalytics — avgTimeToDecisionDays (terminal-state mean)", () => {
  it("mean(updatedAt - createdAt) in days over terminal states only; half-up to 2dp", () => {
    // Accepted: 2 days → 2 * 86_400_000 ms.
    // Rejected: 4 days.
    // Mean = 3.0 days.
    const r = computeQuoteAnalytics(
      [
        q({
          status: "Accepted",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-03T00:00:00Z",  // +2 days
        }),
        q({
          status: "Rejected",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",  // +4 days
        }),
        // Non-terminal quotes ignored even with large delta.
        q({
          status: "Draft",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",  // +120 days, ignored
        }),
      ],
      { now: NOW },
    );
    expect(r.avgTimeToDecisionDays).toBe(3);
  });

  it("Accepted with updatedAt < createdAt is defensively skipped", () => {
    // The single Accepted with negative delta is skipped → decisionTimeCount = 1.
    // Only the +3-day Rejected contributes → mean = 3 days.
    const r = computeQuoteAnalytics(
      [
        q({
          status: "Accepted",
          createdAt: "2026-05-05T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",  // BEFORE createdAt → defensive skip
        }),
        q({
          status: "Rejected",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-04T00:00:00Z",  // +3 days
        }),
      ],
      { now: NOW },
    );
    expect(r.avgTimeToDecisionDays).toBe(3);
  });

  it("rounding to 2dp half-up — 1/3 day delta", () => {
    // Single Accepted with +8 hours = 0.3333... days → 0.33 after half-up to 2dp.
    const r = computeQuoteAnalytics(
      [
        q({
          status: "Accepted",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T08:00:00Z",  // +8h = 1/3 day
        }),
      ],
      { now: NOW },
    );
    expect(r.avgTimeToDecisionDays).toBe(0.33);
  });

  it("zero terminal-state quotes → null", () => {
    const r = computeQuoteAnalytics(
      [q({ status: "Draft" }), q({ status: "Sent" })],
      { now: NOW },
    );
    expect(r.avgTimeToDecisionDays).toBeNull();
  });
});

describe("computeQuoteAnalytics — expiredCount (non-terminal + past validUntil only)", () => {
  it("Draft + Sent with validUntil < now → counted; Accepted/Rejected with validUntil < now → NOT counted", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", validUntil: PAST }),     // expired → counted
        q({ status: "Sent", validUntil: PAST }),      // expired → counted
        q({ status: "Accepted", validUntil: PAST }),  // terminal — NOT counted
        q({ status: "Rejected", validUntil: PAST }),  // terminal — NOT counted
      ],
      { now: NOW },
    );
    expect(r.expiredCount).toBe(2);
  });

  it("future validUntil → NOT counted as expired", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", validUntil: FUTURE }),
        q({ status: "Sent", validUntil: FUTURE }),
      ],
      { now: NOW },
    );
    expect(r.expiredCount).toBe(0);
  });

  it("missing / null validUntil → NOT counted as expired", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", validUntil: null }),
        q({ status: "Sent", validUntil: undefined }),
      ],
      { now: NOW },
    );
    expect(r.expiredCount).toBe(0);
  });
});

describe("computeQuoteAnalytics — currency single-vs-mixed signal", () => {
  it("all quotes share USD → currency='USD'", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", currency: "USD" }),
        q({ status: "Accepted", currency: "USD" }),
      ],
      { now: NOW },
    );
    expect(r.currency).toBe("USD");
  });

  it("mixed USD + INR → currency=null", () => {
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", currency: "USD" }),
        q({ status: "Accepted", currency: "INR" }),
      ],
      { now: NOW },
    );
    expect(r.currency).toBeNull();
  });

  it("zero quotes → currency=null", () => {
    const r = computeQuoteAnalytics([], { now: NOW });
    expect(r.currency).toBeNull();
  });

  it("some quotes missing currency, the rest share INR → currency='INR' (the lone non-falsy)", () => {
    // SUT only adds truthy currencies to the Set, so a missing currency
    // doesn't pollute the "singular currency" signal.
    const r = computeQuoteAnalytics(
      [
        q({ status: "Draft", currency: "INR" }),
        q({ status: "Sent", currency: null }),
        q({ status: "Accepted", currency: "INR" }),
      ],
      { now: NOW },
    );
    expect(r.currency).toBe("INR");
  });

  it("only an unknown-status quote carries currency → contributes nothing (status filter is upstream)", () => {
    // Unknown-status quotes hit `continue` BEFORE the currency Set add, so
    // an Unknown-status USD quote does NOT contribute USD to the signal.
    // (This is the actual SUT contract — pinned.)
    const r = computeQuoteAnalytics(
      [
        q({ status: "Pending", currency: "USD" }),    // unknown — skipped entirely
        q({ status: "Draft", currency: "INR" }),
      ],
      { now: NOW },
    );
    expect(r.currency).toBe("INR");
  });
});

describe("computeQuoteAnalytics — opts.now injection determinism", () => {
  it("same input + same opts.now → byte-identical envelope", () => {
    const input = [
      q({ status: "Draft", validUntil: PAST }),
      q({ status: "Accepted", validUntil: PAST }),
    ];
    const a = computeQuoteAnalytics(input, { now: NOW });
    const b = computeQuoteAnalytics(input, { now: NOW });
    expect(a).toEqual(b);
  });

  it("opts.now controls the expiredCount boundary — a Draft quote validUntil=2026-05-20 is expired @2026-05-25 but NOT @2026-05-15", () => {
    const quote = q({ status: "Draft", validUntil: "2026-05-20T00:00:00Z" });
    const expiredAt = computeQuoteAnalytics([quote], { now: new Date("2026-05-25T00:00:00Z") });
    const notYet = computeQuoteAnalytics([quote], { now: new Date("2026-05-15T00:00:00Z") });
    expect(expiredAt.expiredCount).toBe(1);
    expect(notYet.expiredCount).toBe(0);
  });

  it("falls back to new Date() when opts.now is omitted or invalid", () => {
    // We don't pin a specific value — just that the function runs and yields
    // a structurally-correct envelope.
    const r1 = computeQuoteAnalytics([q({ status: "Draft" })]);
    expect(r1.total).toBe(1);
    const r2 = computeQuoteAnalytics([q({ status: "Draft" })], { now: "not a Date" });
    expect(r2.total).toBe(1);
  });
});

describe("roundHalfUp2 — boundary cases", () => {
  it("0.005 → 0.01 (half-up at the 2dp boundary)", () => {
    expect(roundHalfUp2(0.005)).toBe(0.01);
  });

  it("0.015 → 0.02 (half-up — Math.round half-to-even would have given 0.02 too here, but float repr makes this non-trivial; SUT's epsilon trick should hold)", () => {
    expect(roundHalfUp2(0.015)).toBe(0.02);
  });

  it("-0.005 → -0 (Math.round + epsilon biases the negative half-case toward zero; signed-zero preserved)", () => {
    // (-0.005 + Number.EPSILON) * 100 ≈ -0.4999... → Math.round rounds toward
    // +Infinity (i.e. toward 0 for negatives) → -0 / 100 = -0. JS preserves
    // signed zero; assert numeric equality (== 0) and the sign explicitly.
    const result = roundHalfUp2(-0.005);
    expect(result === 0).toBe(true);          // numerically zero
    expect(Object.is(result, -0)).toBe(true); // ...but the negative zero
  });

  it("plain non-half values round normally (1.234 → 1.23, 1.236 → 1.24)", () => {
    expect(roundHalfUp2(1.234)).toBe(1.23);
    expect(roundHalfUp2(1.236)).toBe(1.24);
  });

  it("Infinity passes through unchanged", () => {
    expect(roundHalfUp2(Infinity)).toBe(Infinity);
    expect(roundHalfUp2(-Infinity)).toBe(-Infinity);
  });

  it("NaN passes through unchanged (NaN !== NaN, assert via Number.isNaN)", () => {
    expect(Number.isNaN(roundHalfUp2(NaN))).toBe(true);
  });

  it("0 → 0", () => {
    expect(roundHalfUp2(0)).toBe(0);
  });

  it("large integers round-trip", () => {
    expect(roundHalfUp2(1234567)).toBe(1234567);
  });
});

describe("exported constants — shape pin", () => {
  it("TERMINAL_STATUSES is a Set containing exactly Accepted + Rejected", () => {
    expect(TERMINAL_STATUSES).toBeInstanceOf(Set);
    expect(TERMINAL_STATUSES.has("Accepted")).toBe(true);
    expect(TERMINAL_STATUSES.has("Rejected")).toBe(true);
    expect(TERMINAL_STATUSES.has("Draft")).toBe(false);
    expect(TERMINAL_STATUSES.has("Sent")).toBe(false);
    expect(TERMINAL_STATUSES.size).toBe(2);
  });

  it("NON_TERMINAL_STATUSES is a Set containing exactly Draft + Sent", () => {
    expect(NON_TERMINAL_STATUSES).toBeInstanceOf(Set);
    expect(NON_TERMINAL_STATUSES.has("Draft")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("Sent")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("Accepted")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("Rejected")).toBe(false);
    expect(NON_TERMINAL_STATUSES.size).toBe(2);
  });

  it("ALL_STATUSES array order is Draft, Sent, Accepted, Rejected", () => {
    expect(Array.isArray(ALL_STATUSES)).toBe(true);
    expect(ALL_STATUSES).toEqual(["Draft", "Sent", "Accepted", "Rejected"]);
  });

  it("TERMINAL ∪ NON_TERMINAL = ALL_STATUSES (no overlap)", () => {
    const union = new Set([...TERMINAL_STATUSES, ...NON_TERMINAL_STATUSES]);
    expect(union.size).toBe(ALL_STATUSES.length);
    for (const s of ALL_STATUSES) expect(union.has(s)).toBe(true);
  });
});
