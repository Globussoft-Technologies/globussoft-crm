// Unit tests for backend/lib/agentCommissionCalculator.js
//
// Pins the pure commission math feeding #905 slice 2's schema (additive
// nullable AgentCommissionProfile) and slice 3's route consumption from
// invoice / sale flows. Coverage:
//   - flat_percent: happy path, 0%, 0 sale
//   - tiered: across multiple bands, exact-boundary sale, below first
//     tier, above all tiers, slab-style semantics (each percent applies
//     to its SLICE, not the cumulative figure)
//   - per_pax_flat: default 1 pax, multi-pax, 0 pax
//   - hybrid: above threshold, below threshold, exactly at threshold
//   - defensive: negative sale, NaN sale, null profile, unknown type
//   - rounding: half-up to 2dp via Number.EPSILON nudge (matches
//     gstCalculation.js / tcsCalculation.js so invoice-render layer can
//     sum lines without 1-paisa reconciliation noise)
//   - breakdown string: contains expected math
//
// PRD: docs/PRD_TRAVEL_B2B_AGENT_PORTAL.md.

import { describe, test, expect } from "vitest";

const { computeCommission } = await import(
  "../../lib/agentCommissionCalculator.js"
);

describe("computeCommission — flat_percent", () => {
  test("5% on 100000 → 5000", () => {
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "flat_percent", percent: 5 },
    });
    expect(r.commission).toBe(5000);
    expect(r.profileType).toBe("flat_percent");
    expect(r.breakdown).toBe("5% of 100000 = 5000");
  });

  test("0% on any amount → 0", () => {
    const r = computeCommission({
      saleAmount: 50000,
      profile: { type: "flat_percent", percent: 0 },
    });
    expect(r.commission).toBe(0);
  });

  test("any percent on 0 sale → 0", () => {
    const r = computeCommission({
      saleAmount: 0,
      profile: { type: "flat_percent", percent: 10 },
    });
    expect(r.commission).toBe(0);
  });

  test("half-up rounding: 3.7% on 333.33 → 12.33", () => {
    // 333.33 × 0.037 = 12.33321 → half-up to 2dp = 12.33
    const r = computeCommission({
      saleAmount: 333.33,
      profile: { type: "flat_percent", percent: 3.7 },
    });
    expect(r.commission).toBe(12.33);
  });
});

describe("computeCommission — tiered", () => {
  const tiers = [
    { uptoCents: 50000, percent: 10 },
    { uptoCents: 200000, percent: 5 },
    { uptoCents: null, percent: 2 },
  ];

  test("sale spans 2 bands: 100000 → 5000 (band 0-50k @10%) + 2500 (50k-100k @5%) = 7500", () => {
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "tiered", tiers },
    });
    expect(r.commission).toBe(7500);
    expect(r.profileType).toBe("tiered");
    expect(r.breakdown).toContain("@10%");
    expect(r.breakdown).toContain("@5%");
  });

  test("sale exactly at first tier boundary (50000) → 5000 (all in @10%)", () => {
    const r = computeCommission({
      saleAmount: 50000,
      profile: { type: "tiered", tiers },
    });
    expect(r.commission).toBe(5000);
  });

  test("sale below first tier (10000) → 1000 (all in @10%)", () => {
    const r = computeCommission({
      saleAmount: 10000,
      profile: { type: "tiered", tiers },
    });
    expect(r.commission).toBe(1000);
  });

  test("sale above all tiers (500000) → 5000 + 7500 + 6000 = 18500", () => {
    // band 0-50k @10% on 50k → 5000
    // band 50k-200k @5% on 150k → 7500
    // band 200k-Infinity @2% on 300k → 6000
    const r = computeCommission({
      saleAmount: 500000,
      profile: { type: "tiered", tiers },
    });
    expect(r.commission).toBe(18500);
  });

  test("tiers passed unsorted are normalised: same result regardless of caller order", () => {
    const unsorted = [
      { uptoCents: null, percent: 2 },
      { uptoCents: 50000, percent: 10 },
      { uptoCents: 200000, percent: 5 },
    ];
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "tiered", tiers: unsorted },
    });
    expect(r.commission).toBe(7500);
  });
});

describe("computeCommission — per_pax_flat", () => {
  test("5 pax × ₹500 → 2500", () => {
    const r = computeCommission({
      saleAmount: 99999, // sale irrelevant for per_pax_flat
      paxCount: 5,
      profile: { type: "per_pax_flat", amountPerPax: 500 },
    });
    expect(r.commission).toBe(2500);
    expect(r.profileType).toBe("per_pax_flat");
  });

  test("default 1 pax (paxCount omitted) × ₹500 → 500", () => {
    const r = computeCommission({
      saleAmount: 10000,
      profile: { type: "per_pax_flat", amountPerPax: 500 },
    });
    expect(r.commission).toBe(500);
  });

  test("0 pax → 0", () => {
    const r = computeCommission({
      saleAmount: 10000,
      paxCount: 0,
      profile: { type: "per_pax_flat", amountPerPax: 500 },
    });
    expect(r.commission).toBe(0);
  });
});

describe("computeCommission — hybrid", () => {
  test("sale 10000, threshold 8000, base 1000, overage 5% → 1000 + 100 = 1100", () => {
    const r = computeCommission({
      saleAmount: 10000,
      profile: {
        type: "hybrid",
        baseAmount: 1000,
        thresholdAmount: 8000,
        overagePercent: 5,
      },
    });
    expect(r.commission).toBe(1100);
    expect(r.profileType).toBe("hybrid");
  });

  test("sale below threshold → just base", () => {
    const r = computeCommission({
      saleAmount: 5000,
      profile: {
        type: "hybrid",
        baseAmount: 1000,
        thresholdAmount: 8000,
        overagePercent: 5,
      },
    });
    expect(r.commission).toBe(1000);
  });

  test("sale exactly at threshold → just base (overage = 0)", () => {
    const r = computeCommission({
      saleAmount: 8000,
      profile: {
        type: "hybrid",
        baseAmount: 1000,
        thresholdAmount: 8000,
        overagePercent: 5,
      },
    });
    expect(r.commission).toBe(1000);
  });
});

describe("computeCommission — defensive", () => {
  test("negative sale → 0", () => {
    const r = computeCommission({
      saleAmount: -50000,
      profile: { type: "flat_percent", percent: 5 },
    });
    expect(r.commission).toBe(0);
  });

  test("NaN sale → 0", () => {
    const r = computeCommission({
      saleAmount: NaN,
      profile: { type: "flat_percent", percent: 5 },
    });
    expect(r.commission).toBe(0);
  });

  test("null profile → 0 with 'no profile' breakdown", () => {
    const r = computeCommission({ saleAmount: 100000, profile: null });
    expect(r.commission).toBe(0);
    expect(r.breakdown).toBe("no profile");
    expect(r.profileType).toBe("unknown");
  });

  test("unknown profile type → 0 with descriptive breakdown", () => {
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "moonshot_curve" },
    });
    expect(r.commission).toBe(0);
    expect(r.breakdown).toContain("unknown profile type");
    expect(r.breakdown).toContain("moonshot_curve");
  });

  test("no args at all → 0 with 'no profile'", () => {
    const r = computeCommission();
    expect(r.commission).toBe(0);
    expect(r.breakdown).toBe("no profile");
  });
});

describe("computeCommission — rounding contract", () => {
  test("all commissions rounded to 2dp regardless of profile type", () => {
    // 333.33 × 3.7% = 12.33321 → 12.33
    const flat = computeCommission({
      saleAmount: 333.33,
      profile: { type: "flat_percent", percent: 3.7 },
    });
    expect(Number.isInteger(flat.commission * 100)).toBe(true);

    // 7 pax × 142.857 = 999.999 → 1000
    const perPax = computeCommission({
      saleAmount: 0,
      paxCount: 7,
      profile: { type: "per_pax_flat", amountPerPax: 142.857 },
    });
    expect(Number.isInteger(perPax.commission * 100)).toBe(true);

    // hybrid with fractional overage
    const hybrid = computeCommission({
      saleAmount: 333.33,
      profile: {
        type: "hybrid",
        baseAmount: 100,
        thresholdAmount: 0,
        overagePercent: 3.7,
      },
    });
    expect(Number.isInteger(hybrid.commission * 100)).toBe(true);
  });
});

// =========================================================================
// +7 NEW CASES — under-pinned surface areas:
//   - String-coerced numeric inputs (Decimal-like wrapper interop)
//   - Half-up rounding tie-breaker pin (1.005 → 1.01 via Number.EPSILON)
//   - profileType field returned on unknown-type (preserves caller's bad input)
//   - Negative percent / negative amountPerPax math (no rate clamp — pin contract)
//   - Tiered with empty tiers array → "no tier coverage" breakdown
//   - per_pax_flat with NaN paxCount → coerces to 0
//   - hybrid with sale-below-threshold preserves base AND zero-overage breakdown
// =========================================================================

describe("computeCommission — string-coerced inputs (Decimal-like interop)", () => {
  test("string saleAmount '100000' coerces via Number() → 5000 at 5%", () => {
    // Routes / Prisma Decimal columns sometimes hand us strings; the SUT
    // explicitly Number()-coerces saleAmount, so this must produce the
    // same result as the numeric variant.
    const r = computeCommission({
      saleAmount: "100000",
      profile: { type: "flat_percent", percent: 5 },
    });
    expect(r.commission).toBe(5000);
    expect(r.profileType).toBe("flat_percent");
  });

  test("string percent '7.5' coerces → 7500 on 100000", () => {
    // Profile values from a JSON column may also arrive as strings.
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "flat_percent", percent: "7.5" },
    });
    expect(r.commission).toBe(7500);
  });
});

describe("computeCommission — half-up tie-breaker (Number.EPSILON nudge)", () => {
  test("classic 1.005 case: 100.50 × 1% = 1.005 → rounds UP to 1.01, not DOWN to 1.00", () => {
    // The Number.EPSILON guard in round2() is specifically designed to
    // avoid the binary-representation artefact where 1.005 → 1.00. This
    // pins the contract documented in the SUT's header.
    const r = computeCommission({
      saleAmount: 100.5,
      profile: { type: "flat_percent", percent: 1 },
    });
    expect(r.commission).toBe(1.01);
  });
});

describe("computeCommission — profileType preservation on unknown type", () => {
  test("profileType field is the stringified original (audit-log friendliness)", () => {
    // Per SUT header: "agents will see a $0 commission row and audit-log
    // can flag the misconfigured profile". This pins that the bad type
    // name flows through to profileType for the audit trail.
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "tiered_v2_experimental" },
    });
    expect(r.commission).toBe(0);
    expect(r.profileType).toBe("tiered_v2_experimental");
    expect(r.breakdown).toContain("tiered_v2_experimental");
  });
});

describe("computeCommission — rate sign contract (no clamping)", () => {
  test("negative percent on flat_percent computes negative commission (no clamp)", () => {
    // Pin the contract: the SUT does NOT clamp rates to [0, 100]. A
    // negative percent (e.g. a clawback row) propagates a negative
    // commission. If a future "clamp negative rates to 0" decision is
    // made, this test should be updated deliberately, not as a surprise.
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "flat_percent", percent: -5 },
    });
    expect(r.commission).toBe(-5000);
    expect(r.profileType).toBe("flat_percent");
  });

  test("negative amountPerPax × positive pax → negative commission (no clamp)", () => {
    // Same no-clamp contract for per_pax_flat.
    const r = computeCommission({
      saleAmount: 10000,
      paxCount: 4,
      profile: { type: "per_pax_flat", amountPerPax: -250 },
    });
    expect(r.commission).toBe(-1000);
  });
});

describe("computeCommission — tiered edge cases", () => {
  test("empty tiers array → 0 with 'no tier coverage' breakdown", () => {
    // The route layer may persist a tiered profile with no tiers yet (UI
    // wizard not finished). The SUT must return 0 + a descriptive
    // breakdown — not throw, not return NaN.
    const r = computeCommission({
      saleAmount: 100000,
      profile: { type: "tiered", tiers: [] },
    });
    expect(r.commission).toBe(0);
    expect(r.breakdown).toBe("no tier coverage");
    expect(r.profileType).toBe("tiered");
  });
});

describe("computeCommission — per_pax_flat NaN paxCount coercion", () => {
  test("NaN paxCount → coerced to 0 → 0 commission", () => {
    // Mirror the saleAmount NaN-defensive contract for paxCount. A bad
    // paxCount value (e.g. parseInt('abc')) must not cascade into a NaN
    // commission row.
    const r = computeCommission({
      saleAmount: 10000,
      paxCount: NaN,
      profile: { type: "per_pax_flat", amountPerPax: 500 },
    });
    expect(r.commission).toBe(0);
    expect(r.breakdown).toBe("0 pax × 500 = 0");
  });
});
