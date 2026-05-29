// Unit tests for backend/lib/gstCalculation.js
//
// Pins the pure GST math feeding #902 slice 2's route layer:
//   - CGST/SGST split on intra-state vs IGST on inter-state
//   - half-up rounding to 2 decimal places (operator-expected PDF
//     behaviour; banker's would cause 1-paisa reconciliation noise)
//   - per-rate-bucket aggregation across multiple line items
//     (composite-supply per FR-3.2.4 — no dominant-rate winner)
//   - ISO 3166-2 state-code interstate detection (throws on missing
//     input so the route layer can 400 cleanly)
//   - default rate lookup for top travel service categories
//
// Reference scenarios pulled from PRD §3.1 / §3.2 / §3.5 +
// AC-6.1 / AC-6.2. PRD: docs/PRD_TRAVEL_GST_COMPLIANCE.md.

import { describe, test, expect } from "vitest";

const {
  computeGstSplit,
  computeGstForLines,
  isInterstateSupply,
  gstRateForCategory,
} = await import("../../lib/gstCalculation.js");

describe("computeGstSplit (single taxable amount)", () => {
  test("intra-state 18% on ₹1000 → CGST 90 + SGST 90, no IGST (AC-6.1)", () => {
    const r = computeGstSplit({
      taxableAmount: 1000,
      gstPercent: 18,
      isInterstate: false,
    });
    expect(r).toEqual({
      cgst: 90,
      sgst: 90,
      igst: 0,
      totalTax: 180,
      gross: 1180,
    });
  });

  test("inter-state 18% on ₹1000 → IGST 180, no CGST/SGST (AC-6.2)", () => {
    const r = computeGstSplit({
      taxableAmount: 1000,
      gstPercent: 18,
      isInterstate: true,
    });
    expect(r).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 180,
      totalTax: 180,
      gross: 1180,
    });
  });

  test("zero amount → all-zero output regardless of rate / interstate", () => {
    const r = computeGstSplit({
      taxableAmount: 0,
      gstPercent: 18,
      isInterstate: false,
    });
    expect(r).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      gross: 0,
    });
  });

  test("zero rate → no tax, gross == taxable", () => {
    const r = computeGstSplit({
      taxableAmount: 500,
      gstPercent: 0,
      isInterstate: false,
    });
    expect(r).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      gross: 500,
    });
  });

  test("intra-state 5% on ₹1000 (tour package SAC 9985) → CGST 25 + SGST 25", () => {
    const r = computeGstSplit({
      taxableAmount: 1000,
      gstPercent: 5,
      isInterstate: false,
    });
    expect(r.cgst).toBe(25);
    expect(r.sgst).toBe(25);
    expect(r.igst).toBe(0);
    expect(r.totalTax).toBe(50);
    expect(r.gross).toBe(1050);
  });

  test("intra-state 12% on ₹1000 (mid-tier hotel) → CGST 60 + SGST 60", () => {
    const r = computeGstSplit({
      taxableAmount: 1000,
      gstPercent: 12,
      isInterstate: false,
    });
    expect(r).toEqual({
      cgst: 60,
      sgst: 60,
      igst: 0,
      totalTax: 120,
      gross: 1120,
    });
  });

  test("inter-state 12% on ₹1000 → IGST 120, no CGST/SGST", () => {
    const r = computeGstSplit({
      taxableAmount: 1000,
      gstPercent: 12,
      isInterstate: true,
    });
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.igst).toBe(120);
  });

  test("rounding-edge: ₹333.33 × 18% → CGST 30.00 / SGST 30.00 / totalTax 60.00 (half-up)", () => {
    // 333.33 * 9% = 29.9997 → half-up to 30.00 each side
    // 333.33 * 18% = 59.9994 → half-up to 60.00 total
    const r = computeGstSplit({
      taxableAmount: 333.33,
      gstPercent: 18,
      isInterstate: false,
    });
    expect(r.cgst).toBe(30);
    expect(r.sgst).toBe(30);
    expect(r.totalTax).toBe(60);
  });

  test("half-up boundary: ₹333.33 × 5% intra-state → totalTax 16.67 (JSDoc reference, half-up not banker's)", () => {
    // 333.33 * 5% = 16.6665 → half-up gives 16.67 (banker's would give 16.66).
    // Pins the JSDoc rationale in the SUT header — this is THE reference
    // example used to justify Math.round-based half-up over banker's.
    // Distinct from tdsCalculation.js which uses Number.EPSILON nudge;
    // GST module deliberately does NOT (operator-PDF rounding alignment).
    const r = computeGstSplit({
      taxableAmount: 333.33,
      gstPercent: 5,
      isInterstate: false,
    });
    // halfRate = 2.5; 333.33 * 2.5% = 8.33325 → half-up = 8.33 each side
    expect(r.cgst).toBe(8.33);
    expect(r.sgst).toBe(8.33);
    expect(r.totalTax).toBe(16.67);
    expect(r.gross).toBe(350);
  });

  test("NaN / non-finite amount → Number(amt) || 0 coercion → all-zero output", () => {
    // taxableAmount: NaN → Number(NaN) is NaN → NaN || 0 → 0.
    // Pins the defensive coercion path so a poisoned upstream value
    // doesn't NaN-propagate through gross/totalTax in the response.
    const r = computeGstSplit({
      taxableAmount: NaN,
      gstPercent: 18,
      isInterstate: false,
    });
    expect(r).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      gross: 0,
    });
  });

  test("string amount 'abc' → Number coercion to NaN → 0 → all-zero output", () => {
    // String 'abc' → Number('abc') is NaN → NaN || 0 → 0.
    // Same defensive path as NaN; pins it for the string-input variant
    // (e.g. malformed body field that bypassed validator).
    const r = computeGstSplit({
      taxableAmount: "abc",
      gstPercent: 18,
      isInterstate: true,
    });
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.igst).toBe(0);
    expect(r.totalTax).toBe(0);
    expect(r.gross).toBe(0);
  });
});

describe("computeGstForLines (multiple line items)", () => {
  test("two lines at different rates → two buckets in deterministic ascending order", () => {
    const r = computeGstForLines(
      [
        { taxableAmount: 1000, gstPercent: 18 }, // service / B2B
        { taxableAmount: 2000, gstPercent: 5 }, // tour package
      ],
      false
    );
    expect(r.subtotal).toBe(3000);
    expect(r.buckets).toHaveLength(2);
    // Ascending rate order — 5% first, 18% second (NFR-4.2 reproducibility)
    expect(r.buckets[0].gstPercent).toBe(5);
    expect(r.buckets[0].cgst).toBe(50); // 2000 * 2.5%
    expect(r.buckets[0].sgst).toBe(50);
    expect(r.buckets[0].igst).toBe(0);
    expect(r.buckets[1].gstPercent).toBe(18);
    expect(r.buckets[1].cgst).toBe(90); // 1000 * 9%
    expect(r.buckets[1].sgst).toBe(90);
    expect(r.buckets[1].igst).toBe(0);
    expect(r.totalCgst).toBe(140);
    expect(r.totalSgst).toBe(140);
    expect(r.totalIgst).toBe(0);
    expect(r.totalTax).toBe(280);
    expect(r.grandTotal).toBe(3280);
  });

  test("inter-state mixed-rate lines → IGST per bucket, no CGST/SGST", () => {
    const r = computeGstForLines(
      [
        { taxableAmount: 1000, gstPercent: 18 },
        { taxableAmount: 2000, gstPercent: 5 },
      ],
      true
    );
    expect(r.totalCgst).toBe(0);
    expect(r.totalSgst).toBe(0);
    expect(r.totalIgst).toBe(280); // 180 + 100
    expect(r.buckets[0]).toEqual({
      gstPercent: 5,
      cgst: 0,
      sgst: 0,
      igst: 100,
      totalTax: 100,
    });
    expect(r.buckets[1]).toEqual({
      gstPercent: 18,
      cgst: 0,
      sgst: 0,
      igst: 180,
      totalTax: 180,
    });
  });

  test("empty array → zero totals + empty bucket array", () => {
    const r = computeGstForLines([], false);
    expect(r.subtotal).toBe(0);
    expect(r.buckets).toEqual([]);
    expect(r.totalCgst).toBe(0);
    expect(r.totalSgst).toBe(0);
    expect(r.totalIgst).toBe(0);
    expect(r.totalTax).toBe(0);
    expect(r.grandTotal).toBe(0);
  });

  test("two lines at SAME rate → one bucket summing both line amounts", () => {
    const r = computeGstForLines(
      [
        { taxableAmount: 1000, gstPercent: 18 },
        { taxableAmount: 500, gstPercent: 18 },
      ],
      false
    );
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0].gstPercent).toBe(18);
    // 1500 * 9% = 135 each
    expect(r.buckets[0].cgst).toBe(135);
    expect(r.buckets[0].sgst).toBe(135);
    expect(r.totalTax).toBe(270);
  });

  test("non-array input is treated as empty (defensive)", () => {
    const r = computeGstForLines(null, false);
    expect(r.subtotal).toBe(0);
    expect(r.buckets).toEqual([]);
    expect(r.grandTotal).toBe(0);
  });

  test("scrambled input order [18, 5, 12] → buckets returned in [5, 12, 18] ascending (NFR-4.2 determinism)", () => {
    // Pin the rate-ascending sort against an input permutation that
    // doesn't happen to be already-sorted. Three distinct rates with
    // a deliberately-scrambled feed order forces the Array.from(...).sort()
    // path to actually do work. If someone refactors to .keys() iteration
    // order (insertion-order in Map), this test catches it.
    const r = computeGstForLines(
      [
        { taxableAmount: 1000, gstPercent: 18 },
        { taxableAmount: 2000, gstPercent: 5 },
        { taxableAmount: 1500, gstPercent: 12 },
      ],
      false
    );
    expect(r.buckets).toHaveLength(3);
    expect(r.buckets.map((b) => b.gstPercent)).toEqual([5, 12, 18]);
    // Sanity: each bucket's math is right too
    expect(r.buckets[0].cgst).toBe(50); // 2000 * 2.5%
    expect(r.buckets[1].cgst).toBe(90); // 1500 * 6%
    expect(r.buckets[2].cgst).toBe(90); // 1000 * 9%
  });
});

describe("isInterstateSupply (state-code comparison)", () => {
  test("two different state codes → true (inter-state)", () => {
    expect(isInterstateSupply("IN-MH", "IN-KA")).toBe(true);
  });

  test("same state code → false (intra-state)", () => {
    expect(isInterstateSupply("IN-MH", "IN-MH")).toBe(false);
  });

  test("case-insensitive: 'IN-MH' vs 'in-mh' compares equal", () => {
    expect(isInterstateSupply("IN-MH", "in-mh")).toBe(false);
  });

  test("trims whitespace before comparing", () => {
    expect(isInterstateSupply("  IN-MH  ", "IN-MH")).toBe(false);
  });

  test("missing customer state (empty string) → throws", () => {
    expect(() => isInterstateSupply("IN-MH", "")).toThrow(
      /both state codes are required/
    );
  });

  test("missing customer state (null) → throws", () => {
    expect(() => isInterstateSupply("IN-MH", null)).toThrow(
      /both state codes are required/
    );
  });

  test("missing operator state (undefined) → throws", () => {
    expect(() => isInterstateSupply(undefined, "IN-MH")).toThrow(
      /both state codes are required/
    );
  });

  test("whitespace-only string → empty after trim → throws (distinct message branch)", () => {
    // Pins the second throw site — the post-trim emptiness check
    // (route layer can rely on the catch-all). String('   ') is
    // non-null so the null/undefined branch passes; trim+upper then
    // yields '' which fires the second guard with the "got empty
    // string" message variant.
    expect(() => isInterstateSupply("   ", "IN-MH")).toThrow(
      /got empty string/
    );
    expect(() => isInterstateSupply("IN-MH", "\t\n ")).toThrow(
      /got empty string/
    );
  });
});

describe("gstRateForCategory (default-rate lookup)", () => {
  test("hotel → 12 (rooms ₹1000-7500/night per PRD §1)", () => {
    expect(gstRateForCategory("hotel")).toBe(12);
  });

  test("flight → 5 (economy per PRD §1)", () => {
    expect(gstRateForCategory("flight")).toBe(5);
  });

  test("transport → 5 (SAC 9964 passenger transport)", () => {
    expect(gstRateForCategory("transport")).toBe(5);
  });

  test("tour_package → 5 (SAC 9985)", () => {
    expect(gstRateForCategory("tour_package")).toBe(5);
  });

  test("service → 18 (default B2B)", () => {
    expect(gstRateForCategory("service")).toBe(18);
  });

  test("visa → 18 (slice 1 default; LUT context lands later per Q-GST-4)", () => {
    expect(gstRateForCategory("visa")).toBe(18);
  });

  test("unknown category → 18 (catch-all default)", () => {
    expect(gstRateForCategory("widget")).toBe(18);
  });

  test("null / undefined category → 18 (catch-all default, no throw)", () => {
    expect(gstRateForCategory(null)).toBe(18);
    expect(gstRateForCategory(undefined)).toBe(18);
  });

  test("case-insensitive: 'HOTEL' / 'Hotel' / 'hotel' all resolve to 12", () => {
    expect(gstRateForCategory("HOTEL")).toBe(12);
    expect(gstRateForCategory("Hotel")).toBe(12);
    expect(gstRateForCategory("hotel")).toBe(12);
  });

  test("trims whitespace before lookup: ' hotel ' / '  FLIGHT  ' resolve to canonical rates", () => {
    // Pins the .trim() in the lookup path. An upstream form field
    // with leading/trailing whitespace would otherwise miss the
    // CATEGORY_RATES map and fall through to DEFAULT_RATE — silently
    // wrong (e.g. ' hotel ' would render 18% instead of 12%).
    expect(gstRateForCategory(" hotel ")).toBe(12);
    expect(gstRateForCategory("  FLIGHT  ")).toBe(5);
    expect(gstRateForCategory("\ttour_package\n")).toBe(5);
  });
});
