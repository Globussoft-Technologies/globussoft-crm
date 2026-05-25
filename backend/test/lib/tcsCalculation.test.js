// Unit tests for backend/lib/tcsCalculation.js
//
// Pins the pure Section 206C(1G) TCS math feeding #901 slice 9's route
// layer:
//   - Threshold detection (₹7L per-customer per-FY)
//   - Filer (5%) vs non-filer (20%) rate flip per Section 206CCA
//   - "Straddle" case where one invoice crosses the threshold mid-way
//   - "Fully above" case where prior cumulative already exceeds threshold
//   - Domestic packages don't attract TCS (isOverseasPackage:false)
//   - Defensive zero/negative invoice handling (no TCS on credit notes)
//   - Half-up rounding to 2 decimal places (matches gstCalculation.js for
//     combined-invoice consistency)
//   - Batch helper for back-fill / what-if reports
//   - isOverseasDestination heuristic for ISO 3166-1 alpha-2 codes
//
// Reference scenarios derived from PRD UC-2.6 + FR-3.x. PRD:
// docs/PRD_TRAVEL_BILLING.md. Threshold lookup against historical
// customer spend lands in slice 9 at the route layer.

import { describe, test, expect } from "vitest";

const {
  TCS_FY_THRESHOLD,
  TCS_FILER_RATE,
  TCS_NON_FILER_RATE,
  computeTcs,
  computeTcsBatch,
  isOverseasDestination,
} = await import("../../lib/tcsCalculation.js");

describe("constants (Section 206C(1G) reference values)", () => {
  test("threshold pinned at ₹7,00,000 per FY", () => {
    expect(TCS_FY_THRESHOLD).toBe(700000);
  });

  test("filer rate pinned at 5% (post-01-Oct-2023)", () => {
    expect(TCS_FILER_RATE).toBe(5);
  });

  test("non-filer rate pinned at 20% (Section 206CCA)", () => {
    expect(TCS_NON_FILER_RATE).toBe(20);
  });
});

describe("computeTcs (single-invoice TCS math)", () => {
  test("below threshold: ₹500K invoice + zero prior → no TCS", () => {
    const r = computeTcs({
      invoiceAmount: 500000,
      priorFySpend: 0,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(false);
    expect(r.tcsAmount).toBe(0);
    expect(r.exceedingAmount).toBe(0);
    expect(r.newFyTotal).toBe(500000);
    expect(r.rate).toBe(5); // filer rate exposed even when applies:false
  });

  test("straddles threshold: ₹500K prior + ₹500K invoice → tcs on ₹3L @ 5% = ₹15K", () => {
    const r = computeTcs({
      invoiceAmount: 500000,
      priorFySpend: 500000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(true);
    expect(r.newFyTotal).toBe(1000000);
    expect(r.exceedingAmount).toBe(300000); // 1M - 700K
    expect(r.rate).toBe(5);
    expect(r.tcsAmount).toBe(15000); // 3L * 5%
  });

  test("fully above threshold: ₹1M prior + ₹500K invoice → tcs on full invoice @ 5% = ₹25K", () => {
    const r = computeTcs({
      invoiceAmount: 500000,
      priorFySpend: 1000000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(true);
    expect(r.exceedingAmount).toBe(500000); // entire invoice taxable
    expect(r.rate).toBe(5);
    expect(r.tcsAmount).toBe(25000);
    expect(r.newFyTotal).toBe(1500000);
  });

  test("non-filer rate flip: same fully-above case → 20% instead of 5% = ₹100K", () => {
    const r = computeTcs({
      invoiceAmount: 500000,
      priorFySpend: 1000000,
      isOverseasPackage: true,
      isNonFiler: true,
    });
    expect(r.applies).toBe(true);
    expect(r.rate).toBe(20);
    expect(r.tcsAmount).toBe(100000); // 5L * 20%
  });

  test("exactly at threshold: ₹700K prior + ₹0 invoice → applies:false (no excess)", () => {
    const r = computeTcs({
      invoiceAmount: 0,
      priorFySpend: 700000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(false);
    expect(r.tcsAmount).toBe(0);
  });

  test("threshold edge: ₹699K prior + ₹2K invoice = ₹701K → tcs on ₹1K @ 5% = ₹50", () => {
    const r = computeTcs({
      invoiceAmount: 2000,
      priorFySpend: 699000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(true);
    expect(r.exceedingAmount).toBe(1000); // 701K - 700K
    expect(r.tcsAmount).toBe(50); // 1K * 5%
  });

  test("domestic package: ₹1M invoice (way above threshold) → applies:false", () => {
    const r = computeTcs({
      invoiceAmount: 1000000,
      priorFySpend: 0,
      isOverseasPackage: false,
    });
    expect(r.applies).toBe(false);
    expect(r.tcsAmount).toBe(0);
  });

  test("zero invoice amount → applies:false (nothing to tax)", () => {
    const r = computeTcs({
      invoiceAmount: 0,
      priorFySpend: 1000000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(false);
    expect(r.tcsAmount).toBe(0);
  });

  test("negative invoice amount (credit note) → applies:false (no TCS on refunds)", () => {
    const r = computeTcs({
      invoiceAmount: -50000,
      priorFySpend: 1000000,
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(false);
    expect(r.tcsAmount).toBe(0);
  });

  test("negative priorFySpend (defensive) → clamped to 0", () => {
    const r = computeTcs({
      invoiceAmount: 800000,
      priorFySpend: -100000, // data corruption signal — treat as 0
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(true);
    expect(r.exceedingAmount).toBe(100000); // 800K - 700K (prior treated as 0)
    expect(r.tcsAmount).toBe(5000);
  });

  test("rounding-edge: ₹333.33 above threshold @ 5% → ₹16.67 (half-up)", () => {
    // 333.33 * 5% = 16.6665 → half-up to 16.67
    const r = computeTcs({
      invoiceAmount: 333.33,
      priorFySpend: 700000, // prior == threshold, so entire invoice is "above"
      isOverseasPackage: true,
    });
    expect(r.applies).toBe(true);
    expect(r.exceedingAmount).toBe(333.33);
    expect(r.tcsAmount).toBe(16.67);
  });

  test("rounding-edge: ₹333.33 above threshold @ 20% (non-filer) → ₹66.67 (half-up)", () => {
    // 333.33 * 20% = 66.666 → half-up to 66.67
    const r = computeTcs({
      invoiceAmount: 333.33,
      priorFySpend: 700000,
      isOverseasPackage: true,
      isNonFiler: true,
    });
    expect(r.applies).toBe(true);
    expect(r.tcsAmount).toBe(66.67);
  });
});

describe("computeTcsBatch (multi-invoice cumulative TCS)", () => {
  test("empty array → totalTcs=0 + empty perInvoice array", () => {
    const r = computeTcsBatch([]);
    expect(r.totalTcs).toBe(0);
    expect(r.perInvoice).toEqual([]);
  });

  test("non-array input is treated as empty (defensive)", () => {
    const r = computeTcsBatch(null);
    expect(r.totalTcs).toBe(0);
    expect(r.perInvoice).toEqual([]);
  });

  test("three invoices crossing threshold mid-way: only post-threshold portions attract TCS", () => {
    // inv1: ₹300K (running 0 → 300K, below threshold) → no TCS
    // inv2: ₹500K (running 300K → 800K, straddles, exceeding=100K) → 5K TCS
    // inv3: ₹400K (running 800K → 1.2M, fully above, exceeding=400K) → 20K TCS
    const r = computeTcsBatch([
      { amount: 300000, isOverseasPackage: true },
      { amount: 500000, isOverseasPackage: true },
      { amount: 400000, isOverseasPackage: true },
    ]);
    expect(r.perInvoice).toHaveLength(3);
    expect(r.perInvoice[0].applies).toBe(false);
    expect(r.perInvoice[0].tcsAmount).toBe(0);
    expect(r.perInvoice[1].applies).toBe(true);
    expect(r.perInvoice[1].exceedingAmount).toBe(100000);
    expect(r.perInvoice[1].tcsAmount).toBe(5000);
    expect(r.perInvoice[2].applies).toBe(true);
    expect(r.perInvoice[2].exceedingAmount).toBe(400000);
    expect(r.perInvoice[2].tcsAmount).toBe(20000);
    expect(r.totalTcs).toBe(25000); // 5K + 20K
  });

  test("mixed overseas + domestic: only overseas attract TCS, but all accumulate toward threshold", () => {
    // inv1: ₹400K OVERSEAS  (running 0 → 400K, below) → no TCS
    // inv2: ₹400K DOMESTIC  (running 400K → 800K, accumulates but isOverseasPackage:false) → no TCS
    // inv3: ₹200K OVERSEAS  (running 800K → 1M, fully above, exceeding=200K) → 10K TCS
    const r = computeTcsBatch([
      { amount: 400000, isOverseasPackage: true },
      { amount: 400000, isOverseasPackage: false }, // domestic
      { amount: 200000, isOverseasPackage: true },
    ]);
    expect(r.perInvoice[0].applies).toBe(false);
    expect(r.perInvoice[1].applies).toBe(false); // domestic skips
    expect(r.perInvoice[2].applies).toBe(true);
    expect(r.perInvoice[2].exceedingAmount).toBe(200000); // full invoice (prior 800K > threshold)
    expect(r.perInvoice[2].tcsAmount).toBe(10000); // 200K * 5%
    expect(r.totalTcs).toBe(10000);
  });

  test("non-filer flag per-invoice respected in batch", () => {
    // First invoice straddles threshold as non-filer (20%); second as filer (5%).
    const r = computeTcsBatch([
      { amount: 1000000, isOverseasPackage: true, isNonFiler: true }, // 0 → 1M, exceeding 300K @ 20% = 60K
      { amount: 200000, isOverseasPackage: true, isNonFiler: false }, // 1M → 1.2M, full @ 5% = 10K
    ]);
    expect(r.perInvoice[0].rate).toBe(20);
    expect(r.perInvoice[0].tcsAmount).toBe(60000);
    expect(r.perInvoice[1].rate).toBe(5);
    expect(r.perInvoice[1].tcsAmount).toBe(10000);
    expect(r.totalTcs).toBe(70000);
  });
});

describe("isOverseasDestination (ISO 3166-1 alpha-2 heuristic)", () => {
  test("'IN' → false (India is domestic)", () => {
    expect(isOverseasDestination("IN")).toBe(false);
  });

  test("'SA' → true (Saudi Arabia — Umrah destination)", () => {
    expect(isOverseasDestination("SA")).toBe(true);
  });

  test("'AE' → true (UAE — Dubai school trips)", () => {
    expect(isOverseasDestination("AE")).toBe(true);
  });

  test("'TH' → true (Thailand — family-holiday destination)", () => {
    expect(isOverseasDestination("TH")).toBe(true);
  });

  test("case-insensitive: 'in' / 'In' / 'IN' all resolve to false", () => {
    expect(isOverseasDestination("in")).toBe(false);
    expect(isOverseasDestination("In")).toBe(false);
    expect(isOverseasDestination("IN")).toBe(false);
  });

  test("empty string → false (defensive)", () => {
    expect(isOverseasDestination("")).toBe(false);
  });

  test("null → false (defensive)", () => {
    expect(isOverseasDestination(null)).toBe(false);
  });

  test("undefined → false (defensive)", () => {
    expect(isOverseasDestination(undefined)).toBe(false);
  });

  test("non-string (number) → false (defensive)", () => {
    expect(isOverseasDestination(91)).toBe(false);
  });

  test("whitespace-only string → false (defensive)", () => {
    expect(isOverseasDestination("   ")).toBe(false);
  });
});
