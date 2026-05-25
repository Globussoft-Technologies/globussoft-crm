// Unit tests for backend/lib/payableAging.js
//
// Pins the pure aging math feeding #903 slice 7's supplier-payable /aging
// route (PRD: docs/PRD_TRAVEL_BILLING.md UC-2.5). Locks the bucket-boundary
// semantics that accountants will compare against Tally / Zoho Books /
// QuickBooks aged-payable reports during month-end close:
//
//   - current = daysOverdue ≤ 0 (includes future-due AND due-today)
//   - 1-30    = 1 ≤ daysOverdue ≤ 30 (inclusive at both ends)
//   - 31-60   = 31 ≤ daysOverdue ≤ 60
//   - 61-90   = 61 ≤ daysOverdue ≤ 90
//   - 90+     = daysOverdue > 90 (i.e. ≥ 91)
//
// Also pins the exclusion-reason taxonomy (EXCLUDED_PAID, EXCLUDED_CANCELLED,
// NO_DUE_DATE, INVALID_DUE_DATE, NO_PAYABLE) so the slice-7 route can surface
// "N payables excluded — N1 paid, N2 cancelled, N3 missing-dueDate" to the
// accountant without rebucketing.
//
// Rounding edge: 33.33 + 33.33 + 33.34 must equal 100.00 exactly (matches
// gstCalculation.js + tcsCalculation.js round2 convention) so combined
// month-end-close reports don't accumulate floating-point drift.

import { describe, test, expect } from "vitest";

const {
  AGING_BUCKETS,
  bucketForDays,
  classifyPayable,
  computeAgingReport,
} = await import("../../lib/payableAging.js");

const ONE_DAY_MS = 86_400_000;

// Fixed reference date for deterministic asOf math.
const ASOF = new Date("2026-05-25T12:00:00.000Z");

function daysAgo(n) {
  return new Date(ASOF.getTime() - n * ONE_DAY_MS);
}

function daysAhead(n) {
  return new Date(ASOF.getTime() + n * ONE_DAY_MS);
}

describe("AGING_BUCKETS constant", () => {
  test("exports the five canonical bucket keys in order", () => {
    expect(AGING_BUCKETS).toEqual(["current", "1-30", "31-60", "61-90", "90+"]);
  });
});

describe("bucketForDays() — all 5 buckets", () => {
  test("negative days → current (not yet due)", () => {
    expect(bucketForDays(-5)).toBe("current");
    expect(bucketForDays(-100)).toBe("current");
  });

  test("zero days → current (due today)", () => {
    expect(bucketForDays(0)).toBe("current");
  });

  test("1 day overdue → 1-30 (lower edge)", () => {
    expect(bucketForDays(1)).toBe("1-30");
  });

  test("30 days overdue → 1-30 (upper edge inclusive)", () => {
    expect(bucketForDays(30)).toBe("1-30");
  });

  test("31 days overdue → 31-60 (lower edge)", () => {
    expect(bucketForDays(31)).toBe("31-60");
  });

  test("60 days overdue → 31-60 (upper edge inclusive)", () => {
    expect(bucketForDays(60)).toBe("31-60");
  });

  test("61 days overdue → 61-90 (lower edge)", () => {
    expect(bucketForDays(61)).toBe("61-90");
  });

  test("90 days overdue → 61-90 (upper edge inclusive)", () => {
    expect(bucketForDays(90)).toBe("61-90");
  });

  test("91+ days overdue → 90+ (lower edge of open bucket)", () => {
    expect(bucketForDays(91)).toBe("90+");
    expect(bucketForDays(365)).toBe("90+");
    expect(bucketForDays(99999)).toBe("90+");
  });
});

describe("classifyPayable() — happy paths", () => {
  test("pending + due tomorrow → current", () => {
    const p = { status: "pending", dueDate: daysAhead(1), amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("current");
    expect(r.daysOverdue).toBe(-1);
  });

  test("pending + due 15 days ago → 1-30", () => {
    const p = { status: "pending", dueDate: daysAgo(15), amount: 2500 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("1-30");
    expect(r.daysOverdue).toBe(15);
  });

  test("scheduled + due 45 days ago → 31-60", () => {
    const p = { status: "scheduled", dueDate: daysAgo(45), amount: 5000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("31-60");
  });

  test("accepts ISO string dueDate (not Date instance)", () => {
    const p = { status: "pending", dueDate: daysAgo(75).toISOString(), amount: 100 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("61-90");
  });
});

describe("classifyPayable() — exclusions", () => {
  test("paid → EXCLUDED_PAID", () => {
    const p = { status: "paid", dueDate: daysAgo(10), paidAt: daysAgo(5), amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("EXCLUDED_PAID");
  });

  test("cancelled → EXCLUDED_CANCELLED", () => {
    const p = { status: "cancelled", dueDate: daysAgo(10), amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("EXCLUDED_CANCELLED");
  });

  test("missing dueDate → NO_DUE_DATE", () => {
    const p = { status: "pending", amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("NO_DUE_DATE");
  });

  test("null dueDate → NO_DUE_DATE", () => {
    const p = { status: "pending", dueDate: null, amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("NO_DUE_DATE");
  });

  test("unparseable dueDate string → INVALID_DUE_DATE", () => {
    const p = { status: "pending", dueDate: "not-a-date", amount: 1000 };
    const r = classifyPayable(p, ASOF);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("INVALID_DUE_DATE");
  });

  test("null payable → NO_PAYABLE", () => {
    expect(classifyPayable(null, ASOF)).toEqual({ ok: false, reason: "NO_PAYABLE" });
    expect(classifyPayable(undefined, ASOF)).toEqual({ ok: false, reason: "NO_PAYABLE" });
  });
});

describe("computeAgingReport() — aggregation", () => {
  test("empty array → all buckets zero, grandTotal=0", () => {
    const r = computeAgingReport([], { asOf: ASOF });
    expect(r.grandTotal).toBe(0);
    expect(r.excludedCount).toBe(0);
    for (const b of AGING_BUCKETS) {
      expect(r.bucketTotals[b]).toEqual({ count: 0, totalAmount: 0 });
    }
    expect(r.asOf).toBe(ASOF.toISOString());
  });

  test("null/undefined payables list defaults to empty", () => {
    const r1 = computeAgingReport(null, { asOf: ASOF });
    const r2 = computeAgingReport(undefined, { asOf: ASOF });
    expect(r1.grandTotal).toBe(0);
    expect(r2.grandTotal).toBe(0);
  });

  test("5 payables spread across 5 buckets → each bucket count=1", () => {
    const payables = [
      { status: "pending", dueDate: daysAhead(5), amount: 100 },   // current
      { status: "pending", dueDate: daysAgo(15), amount: 200 },    // 1-30
      { status: "pending", dueDate: daysAgo(45), amount: 300 },    // 31-60
      { status: "pending", dueDate: daysAgo(75), amount: 400 },    // 61-90
      { status: "pending", dueDate: daysAgo(120), amount: 500 },   // 90+
    ];
    const r = computeAgingReport(payables, { asOf: ASOF });
    expect(r.bucketTotals["current"]).toEqual({ count: 1, totalAmount: 100 });
    expect(r.bucketTotals["1-30"]).toEqual({ count: 1, totalAmount: 200 });
    expect(r.bucketTotals["31-60"]).toEqual({ count: 1, totalAmount: 300 });
    expect(r.bucketTotals["61-90"]).toEqual({ count: 1, totalAmount: 400 });
    expect(r.bucketTotals["90+"]).toEqual({ count: 1, totalAmount: 500 });
    expect(r.grandTotal).toBe(1500);
    expect(r.excludedCount).toBe(0);
  });

  test("3 payables in same bucket → count=3, totalAmount summed", () => {
    const payables = [
      { status: "pending", dueDate: daysAgo(40), amount: 1000 },
      { status: "pending", dueDate: daysAgo(50), amount: 2000 },
      { status: "scheduled", dueDate: daysAgo(55), amount: 3000 },
    ];
    const r = computeAgingReport(payables, { asOf: ASOF });
    expect(r.bucketTotals["31-60"]).toEqual({ count: 3, totalAmount: 6000 });
    expect(r.grandTotal).toBe(6000);
  });

  test("mix of pending + paid + cancelled + missing-dueDate → excludedReasons grouped", () => {
    const payables = [
      { status: "pending", dueDate: daysAgo(15), amount: 100 },   // counted, 1-30
      { status: "paid", dueDate: daysAgo(20), amount: 999 },       // excluded
      { status: "paid", dueDate: daysAgo(50), amount: 999 },       // excluded
      { status: "cancelled", dueDate: daysAgo(10), amount: 999 },  // excluded
      { status: "pending", dueDate: null, amount: 999 },           // excluded
      { status: "pending", dueDate: "garbage", amount: 999 },      // excluded
      null,                                                        // excluded
    ];
    const r = computeAgingReport(payables, { asOf: ASOF });
    expect(r.bucketTotals["1-30"]).toEqual({ count: 1, totalAmount: 100 });
    expect(r.grandTotal).toBe(100);
    expect(r.excludedCount).toBe(6);
    expect(r.excludedReasons).toEqual({
      EXCLUDED_PAID: 2,
      EXCLUDED_CANCELLED: 1,
      NO_DUE_DATE: 1,
      INVALID_DUE_DATE: 1,
      NO_PAYABLE: 1,
    });
  });

  test("rounding: 33.33 + 33.33 + 33.34 → grandTotal=100.00 exact (no float drift)", () => {
    const payables = [
      { status: "pending", dueDate: daysAgo(15), amount: 33.33 },
      { status: "pending", dueDate: daysAgo(15), amount: 33.33 },
      { status: "pending", dueDate: daysAgo(15), amount: 33.34 },
    ];
    const r = computeAgingReport(payables, { asOf: ASOF });
    expect(r.bucketTotals["1-30"].totalAmount).toBe(100);
    expect(r.grandTotal).toBe(100);
  });

  test("defaults asOf to now when omitted", () => {
    const before = Date.now();
    const r = computeAgingReport([], {});
    const after = Date.now();
    const asOfMs = new Date(r.asOf).getTime();
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  test("missing/zero amount defaults to 0 (no NaN propagation)", () => {
    const payables = [
      { status: "pending", dueDate: daysAgo(15) },                  // no amount
      { status: "pending", dueDate: daysAgo(15), amount: null },
      { status: "pending", dueDate: daysAgo(15), amount: 50 },
    ];
    const r = computeAgingReport(payables, { asOf: ASOF });
    expect(r.bucketTotals["1-30"]).toEqual({ count: 3, totalAmount: 50 });
    expect(r.grandTotal).toBe(50);
  });
});
