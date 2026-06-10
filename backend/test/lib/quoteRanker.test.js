// Unit tests for backend/lib/quoteRanker.js
//
// Pure-function ranker — no DB, no fetch. Pins the deterministic
// composite-score math per PRD_RATEHAWK_INTEGRATION FR-6 + DC-4:
//
//   - price (LOWER is better) — default 50%
//   - supplierRating (HIGHER is better) — default 25%
//   - cancellationFlex (FREE_CANCEL > PARTIAL > NON_REFUNDABLE) — default 25%
//
// Same (quotes, opts) → same ranked output, every time. This is the
// load-bearing audit invariant: a refund-dispute case opened a year
// after the unified-search ran should be able to recompute the same
// ranking against the same inputs.

import { describe, test, expect } from "vitest";

const { rankQuotes, DEFAULT_WEIGHTS, CANCEL_FLEX_SCORES } = await import(
  "../../lib/quoteRanker.js"
);

function q(overrides = {}) {
  return {
    provider: "ratehawk",
    propertyName: "Stub Property",
    price: 10000,
    supplierRating: 4.0,
    cancellationPolicy: "FREE_CANCEL",
    ...overrides,
  };
}

describe("rankQuotes — basic shape", () => {
  test("empty array → returns []", () => {
    expect(rankQuotes([])).toEqual([]);
  });

  test("non-array (null / undefined) → returns []", () => {
    expect(rankQuotes(null)).toEqual([]);
    expect(rankQuotes(undefined)).toEqual([]);
  });

  test("single quote → rank 1, score 0-100", () => {
    const out = rankQuotes([q()]);
    expect(out).toHaveLength(1);
    expect(out[0].rank).toBe(1);
    expect(out[0].rankScore).toBeGreaterThanOrEqual(0);
    expect(out[0].rankScore).toBeLessThanOrEqual(100);
  });

  test("DEFAULT_WEIGHTS export shape", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      price: 50,
      supplierRating: 25,
      cancellationFlex: 25,
    });
  });

  test("CANCEL_FLEX_SCORES export shape", () => {
    expect(CANCEL_FLEX_SCORES.FREE_CANCEL).toBe(1.0);
    expect(CANCEL_FLEX_SCORES.PARTIAL).toBe(0.5);
    expect(CANCEL_FLEX_SCORES.NON_REFUNDABLE).toBe(0.0);
  });
});

describe("rankQuotes — sort semantics", () => {
  test("two-quote price-only sort: lower price ranks higher", () => {
    // Both identical on rating + flex → score driven entirely by price axis.
    const out = rankQuotes([
      q({ provider: "ratehawk", price: 12000 }),
      q({ provider: "bookingExpedia", price: 9000 }),
    ]);
    expect(out[0].provider).toBe("bookingExpedia");
    expect(out[0].rank).toBe(1);
    expect(out[1].provider).toBe("ratehawk");
    expect(out[1].rank).toBe(2);
  });

  test("higher-priced quote lands last when all other axes are equal", () => {
    const out = rankQuotes([
      q({ provider: "a", price: 5000 }),
      q({ provider: "b", price: 15000 }),
      q({ provider: "c", price: 10000 }),
    ]);
    expect(out.map((r) => r.provider)).toEqual(["a", "c", "b"]);
  });

  test("FREE_CANCEL outranks NON_REFUNDABLE all-else-equal", () => {
    const out = rankQuotes([
      q({ provider: "nrf", cancellationPolicy: "NON_REFUNDABLE" }),
      q({ provider: "free", cancellationPolicy: "FREE_CANCEL" }),
    ]);
    expect(out[0].provider).toBe("free");
    expect(out[1].provider).toBe("nrf");
  });

  test("PARTIAL ranks between FREE_CANCEL and NON_REFUNDABLE", () => {
    const out = rankQuotes([
      q({ provider: "nrf", cancellationPolicy: "NON_REFUNDABLE" }),
      q({ provider: "free", cancellationPolicy: "FREE_CANCEL" }),
      q({ provider: "partial", cancellationPolicy: "PARTIAL" }),
    ]);
    expect(out.map((r) => r.provider)).toEqual(["free", "partial", "nrf"]);
  });

  test("supplier-rating tie-breaker: higher rating wins when price + flex equal", () => {
    const out = rankQuotes([
      q({ provider: "low-rating", supplierRating: 2.5 }),
      q({ provider: "high-rating", supplierRating: 4.8 }),
    ]);
    expect(out[0].provider).toBe("high-rating");
    expect(out[1].provider).toBe("low-rating");
  });
});

describe("rankQuotes — weight overrides", () => {
  test("weights={price:100, others:0} → pure price sort", () => {
    // FREE_CANCEL + high rating cannot outrank lower price under this weight.
    const out = rankQuotes(
      [
        q({
          provider: "expensive-luxury",
          price: 50000,
          supplierRating: 5.0,
          cancellationPolicy: "FREE_CANCEL",
        }),
        q({
          provider: "cheap-rough",
          price: 8000,
          supplierRating: 1.0,
          cancellationPolicy: "NON_REFUNDABLE",
        }),
      ],
      { weights: { price: 100, supplierRating: 0, cancellationFlex: 0 } },
    );
    expect(out[0].provider).toBe("cheap-rough");
    expect(out[1].provider).toBe("expensive-luxury");
  });

  test("weights={cancellationFlex:100, others:0} → pure flex sort", () => {
    const out = rankQuotes(
      [
        q({
          provider: "expensive-flex",
          price: 50000,
          cancellationPolicy: "FREE_CANCEL",
        }),
        q({
          provider: "cheap-locked",
          price: 5000,
          cancellationPolicy: "NON_REFUNDABLE",
        }),
      ],
      { weights: { price: 0, supplierRating: 0, cancellationFlex: 100 } },
    );
    expect(out[0].provider).toBe("expensive-flex");
  });

  test("partial-override merges with DEFAULT_WEIGHTS for unspecified axes", () => {
    // Only override `price` — supplierRating + cancellationFlex inherit defaults.
    const out = rankQuotes(
      [q({ price: 10000 }), q({ price: 8000 })],
      { weights: { price: 80 } },
    );
    expect(out).toHaveLength(2);
    // Sanity: the lower-priced row still ranks first under heavy price weight.
    expect(out[0].price).toBe(8000);
  });
});

describe("rankQuotes — missing / malformed fields", () => {
  test("missing supplierRating → defaults to 0, no crash", () => {
    const out = rankQuotes([
      q({ provider: "rated", supplierRating: 4.5 }),
      q({ provider: "no-rating", supplierRating: undefined }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].provider).toBe("rated");
  });

  test("missing cancellationPolicy → neutral 0.5 flex score, no crash", () => {
    const out = rankQuotes([
      q({ provider: "explicit-free", cancellationPolicy: "FREE_CANCEL" }),
      q({ provider: "missing", cancellationPolicy: undefined }),
      q({ provider: "explicit-nrf", cancellationPolicy: "NON_REFUNDABLE" }),
    ]);
    // missing collapses to neutral 0.5 — should rank between FREE_CANCEL and NON_REFUNDABLE.
    expect(out.map((r) => r.provider)).toEqual([
      "explicit-free",
      "missing",
      "explicit-nrf",
    ]);
  });

  test("unknown cancellationPolicy string → neutral 0.5 flex score", () => {
    const out = rankQuotes([
      q({ provider: "weird", cancellationPolicy: "SOMETHING_NEW" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rankScore).toBeGreaterThanOrEqual(0);
  });

  test("NaN price → coerces to 0 (no crash, but obviously ranks oddly)", () => {
    const out = rankQuotes([
      q({ provider: "ok", price: 10000 }),
      q({ provider: "bad", price: "not-a-number" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("rankQuotes — score guarantees", () => {
  test("composite score is always 0-100 inclusive", () => {
    const out = rankQuotes([
      q({ provider: "a", price: 1000, supplierRating: 5.0, cancellationPolicy: "FREE_CANCEL" }),
      q({ provider: "b", price: 50000, supplierRating: 0, cancellationPolicy: "NON_REFUNDABLE" }),
      q({ provider: "c", price: 25000, supplierRating: 2.5, cancellationPolicy: "PARTIAL" }),
    ]);
    for (const row of out) {
      expect(row.rankScore).toBeGreaterThanOrEqual(0);
      expect(row.rankScore).toBeLessThanOrEqual(100);
    }
    // Best row scores higher than worst row.
    expect(out[0].rankScore).toBeGreaterThan(out[out.length - 1].rankScore);
  });

  test("all-identical quotes → all rows share the same score, stable order preserved", () => {
    const input = [
      q({ provider: "a" }),
      q({ provider: "b" }),
      q({ provider: "c" }),
    ];
    const out = rankQuotes(input);
    expect(out[0].rankScore).toBe(out[1].rankScore);
    expect(out[1].rankScore).toBe(out[2].rankScore);
    // Stable: input order preserved on tie.
    expect(out.map((r) => r.provider)).toEqual(["a", "b", "c"]);
  });

  test("ranks are 1..N contiguous integers", () => {
    const out = rankQuotes([
      q({ provider: "a", price: 1000 }),
      q({ provider: "b", price: 2000 }),
      q({ provider: "c", price: 3000 }),
      q({ provider: "d", price: 4000 }),
    ]);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  test("all weights zero → degenerate; returns input order with score 0", () => {
    const out = rankQuotes(
      [q({ provider: "a", price: 1000 }), q({ provider: "b", price: 9000 })],
      { weights: { price: 0, supplierRating: 0, cancellationFlex: 0 } },
    );
    expect(out.map((r) => r.provider)).toEqual(["a", "b"]);
    expect(out[0].rankScore).toBe(0);
    expect(out[1].rankScore).toBe(0);
  });
});

describe("rankQuotes — quote payload preservation", () => {
  test("original quote fields survive on the ranked row", () => {
    const out = rankQuotes([
      q({
        provider: "ratehawk",
        propertyName: "Hilton Makkah",
        price: 12500,
        sourceRef: "rh-12345",
        currency: "USD",
      }),
    ]);
    expect(out[0]).toMatchObject({
      provider: "ratehawk",
      propertyName: "Hilton Makkah",
      price: 12500,
      sourceRef: "rh-12345",
      currency: "USD",
    });
    expect(out[0].rank).toBe(1);
    expect(typeof out[0].rankScore).toBe("number");
  });

  test("ranker does not mutate the input array", () => {
    const input = [
      q({ provider: "a", price: 5000 }),
      q({ provider: "b", price: 10000 }),
    ];
    const before = JSON.stringify(input);
    rankQuotes(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
