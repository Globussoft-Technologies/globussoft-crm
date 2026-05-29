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
//
// Extension batch (#903 slices 18 + 20): adds coverage for the monthly +
// quarterly rollup helpers (monthKey / quarterForMonth / quarterKey /
// computeMonthlyRollup / computeQuarterlyRollup) feeding the per-supplier
// dashboard widgets (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d).

import { describe, test, expect } from "vitest";

const {
  AGING_BUCKETS,
  bucketForDays,
  classifyPayable,
  computeAgingReport,
  ROLLUP_STATUSES,
  monthKey,
  computeMonthlyRollup,
  quarterForMonth,
  quarterKey,
  computeQuarterlyRollup,
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

// === Monthly + quarterly rollup coverage (#903 slices 18 + 20) ===
//
// Extension batch — pins monthKey + quarterForMonth + quarterKey +
// computeMonthlyRollup + computeQuarterlyRollup against the per-supplier
// dashboard's "monthly invoice rollup" + "next 4 quarters payable schedule"
// widgets (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d).
//
// IMPORTANT contract drift from computeAgingReport:
//   - computeAgingReport EXCLUDES paid + cancelled (they're not liabilities).
//   - computeMonthlyRollup / computeQuarterlyRollup INCLUDE paid + cancelled
//     (they're surfaced under byStatus so operators see "₹50K owed (45K
//     pending, 5K paid)" without further drill-down per the SUT comment).
//   - Rollups only exclude null entries + null/invalid dueDate.
// The tests below pin BOTH taxonomies so a future "unify the exclusion rules"
// refactor surfaces clearly which contract it's breaking.

describe("monthKey(d)", () => {
  test("UTC date → YYYY-MM key with zero-padded month", () => {
    expect(monthKey(new Date("2026-01-15T12:00:00.000Z"))).toBe("2026-01");
    expect(monthKey(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
    expect(monthKey(new Date("2026-12-31T12:00:00.000Z"))).toBe("2026-12");
  });

  test("last UTC instant of month stays in that month (no roll-forward)", () => {
    expect(monthKey(new Date("2026-01-31T23:59:59.999Z"))).toBe("2026-01");
    expect(monthKey(new Date("2026-03-31T23:59:59.999Z"))).toBe("2026-03");
  });

  test("invalid Date → 'NaN-NaN' (pin actual: SUT does not validate)", () => {
    // SUT extracts getUTCFullYear() + getUTCMonth() unconditionally; an
    // Invalid Date yields NaN for both → string-templated to "NaN-NaN".
    // Callers (computeMonthlyRollup) gate via Number.isNaN(due.getTime())
    // BEFORE calling monthKey so this never surfaces in production paths.
    expect(monthKey(new Date("not-a-date"))).toBe("NaN-NaN");
  });
});

describe("quarterForMonth(m)", () => {
  test("month 1-3 → Q1", () => {
    expect(quarterForMonth(1)).toBe(1);
    expect(quarterForMonth(2)).toBe(1);
    expect(quarterForMonth(3)).toBe(1);
  });

  test("month 4-6 → Q2", () => {
    expect(quarterForMonth(4)).toBe(2);
    expect(quarterForMonth(5)).toBe(2);
    expect(quarterForMonth(6)).toBe(2);
  });

  test("month 7-9 → Q3", () => {
    expect(quarterForMonth(7)).toBe(3);
    expect(quarterForMonth(8)).toBe(3);
    expect(quarterForMonth(9)).toBe(3);
  });

  test("month 10-12 → Q4", () => {
    expect(quarterForMonth(10)).toBe(4);
    expect(quarterForMonth(11)).toBe(4);
    expect(quarterForMonth(12)).toBe(4);
  });

  test("out-of-range month → garbage quarter (pin actual: SUT does not validate)", () => {
    // SUT is Math.floor((m - 1) / 3) + 1; for m=0 returns 0; m=13 returns 5.
    // Callers (computeQuarterlyRollup) only ever pass 1..12 parsed from a
    // monthKey output, so this never surfaces. Pinning the math so a future
    // "add validation" refactor is a deliberate decision, not an accident.
    expect(quarterForMonth(0)).toBe(0);
    expect(quarterForMonth(13)).toBe(5);
    expect(quarterForMonth(-1)).toBe(0);
  });
});

describe("quarterKey(year, q)", () => {
  test("2026, 1 → '2026-Q1'", () => {
    expect(quarterKey(2026, 1)).toBe("2026-Q1");
    expect(quarterKey(2026, 4)).toBe("2026-Q4");
    expect(quarterKey(2030, 3)).toBe("2030-Q3");
  });

  test("out-of-range quarter → string template no validation (pin actual)", () => {
    // SUT is pure `${year}-Q${q}` interpolation — no clamping. Callers only
    // ever pass 1..4 from quarterForMonth on a real month, so 0/5/-1 never
    // surface. Pin so a future "add validation" refactor is deliberate.
    expect(quarterKey(2026, 0)).toBe("2026-Q0");
    expect(quarterKey(2026, 5)).toBe("2026-Q5");
    expect(quarterKey(2026, -1)).toBe("2026-Q-1");
  });
});

describe("ROLLUP_STATUSES constant", () => {
  test("exports the four canonical rollup statuses", () => {
    expect(ROLLUP_STATUSES).toEqual(["pending", "scheduled", "paid", "cancelled"]);
  });
});

describe("computeMonthlyRollup(payables)", () => {
  test("empty input → empty months[], zeros (not null)", () => {
    const r = computeMonthlyRollup([]);
    expect(r.months).toEqual([]);
    expect(r.grandTotal).toBe(0);
    expect(r.totalCount).toBe(0);
    expect(r.excludedCount).toBe(0);
    expect(r.excludedReasons).toEqual({});
  });

  test("null/undefined input → empty rollup", () => {
    expect(computeMonthlyRollup(null).months).toEqual([]);
    expect(computeMonthlyRollup(undefined).months).toEqual([]);
  });

  test("multiple months → sorted ASC + per-status break populated", () => {
    const payables = [
      // March: 2 pending + 1 paid
      { status: "pending", dueDate: "2026-03-01", amount: 100 },
      { status: "pending", dueDate: "2026-03-15", amount: 200 },
      { status: "paid", dueDate: "2026-03-20", amount: 50 },
      // January: 1 scheduled
      { status: "scheduled", dueDate: "2026-01-10", amount: 1000 },
      // May: 1 cancelled
      { status: "cancelled", dueDate: "2026-05-05", amount: 25 },
    ];
    const r = computeMonthlyRollup(payables);
    expect(r.months.map((m) => m.month)).toEqual(["2026-01", "2026-03", "2026-05"]);

    const jan = r.months[0];
    expect(jan.totalAmount).toBe(1000);
    expect(jan.totalCount).toBe(1);
    expect(jan.byStatus.scheduled).toEqual({ count: 1, totalAmount: 1000 });
    expect(jan.byStatus.pending).toEqual({ count: 0, totalAmount: 0 });

    const mar = r.months[1];
    expect(mar.totalAmount).toBe(350);
    expect(mar.totalCount).toBe(3);
    expect(mar.byStatus.pending).toEqual({ count: 2, totalAmount: 300 });
    expect(mar.byStatus.paid).toEqual({ count: 1, totalAmount: 50 });

    const may = r.months[2];
    expect(may.totalAmount).toBe(25);
    expect(may.byStatus.cancelled).toEqual({ count: 1, totalAmount: 25 });

    expect(r.grandTotal).toBe(1375);
    expect(r.totalCount).toBe(5);
    expect(r.excludedCount).toBe(0);
  });

  test("rollup taxonomy DIFFERS from aging report — paid + cancelled are INCLUDED", () => {
    // computeAgingReport excludes paid + cancelled (excludedReasons grows).
    // computeMonthlyRollup includes them under byStatus + only excludes
    // missing-payable / missing-dueDate / invalid-dueDate. This test pins
    // that asymmetry so a "unify exclusion rules" refactor is deliberate.
    const payables = [
      { status: "pending", dueDate: "2026-04-01", amount: 100 },
      { status: "paid", dueDate: "2026-04-02", amount: 200 },
      { status: "cancelled", dueDate: "2026-04-03", amount: 300 },
      { status: "pending", dueDate: null, amount: 999 },          // excluded
      { status: "pending", dueDate: "not-a-date", amount: 999 },  // excluded
      null,                                                        // excluded
    ];
    const r = computeMonthlyRollup(payables);
    expect(r.months.length).toBe(1);
    const apr = r.months[0];
    expect(apr.totalCount).toBe(3);
    expect(apr.totalAmount).toBe(600);
    expect(apr.byStatus.pending).toEqual({ count: 1, totalAmount: 100 });
    expect(apr.byStatus.paid).toEqual({ count: 1, totalAmount: 200 });
    expect(apr.byStatus.cancelled).toEqual({ count: 1, totalAmount: 300 });
    expect(r.grandTotal).toBe(600);
    expect(r.excludedCount).toBe(3);
    expect(r.excludedReasons).toEqual({
      NO_DUE_DATE: 1,
      INVALID_DUE_DATE: 1,
      NO_PAYABLE: 1,
    });
  });

  test("unknown status → counted in totalAmount + totalCount but NOT in byStatus", () => {
    // SUT comment: "Unknown statuses still land in totalAmount + totalCount
    // but are intentionally NOT echoed under byStatus".
    const payables = [
      { status: "pending", dueDate: "2026-06-01", amount: 100 },
      { status: "weird-future-status", dueDate: "2026-06-02", amount: 500 },
    ];
    const r = computeMonthlyRollup(payables);
    const jun = r.months[0];
    expect(jun.totalAmount).toBe(600);
    expect(jun.totalCount).toBe(2);
    expect(jun.byStatus.pending).toEqual({ count: 1, totalAmount: 100 });
    // No "weird-future-status" key surfaces in byStatus — only canonical
    // ROLLUP_STATUSES keys live there.
    expect(Object.keys(jun.byStatus).sort()).toEqual(
      ["cancelled", "paid", "pending", "scheduled"],
    );
  });

  test("missing status defaults to 'pending' (SUT: typeof !== 'string' fallback)", () => {
    const payables = [
      { dueDate: "2026-07-15", amount: 50 },                  // no status
      { status: null, dueDate: "2026-07-20", amount: 25 },    // null status
    ];
    const r = computeMonthlyRollup(payables);
    expect(r.months[0].byStatus.pending).toEqual({ count: 2, totalAmount: 75 });
  });
});

describe("computeQuarterlyRollup(payables)", () => {
  test("empty input → empty quarters[], zeros", () => {
    const r = computeQuarterlyRollup([]);
    expect(r.quarters).toEqual([]);
    expect(r.grandTotal).toBe(0);
    expect(r.totalCount).toBe(0);
    expect(r.excludedCount).toBe(0);
    expect(r.excludedReasons).toEqual({});
  });

  test("multi-quarter spread → sorted ASC by (year, q)", () => {
    const payables = [
      // 2026 Q3 (Jul-Sep)
      { status: "pending", dueDate: "2026-08-15", amount: 800 },
      // 2025 Q4 (Oct-Dec)
      { status: "pending", dueDate: "2025-11-05", amount: 100 },
      // 2026 Q1 (Jan-Mar) — 2 entries collapsed from Jan + Feb
      { status: "pending", dueDate: "2026-01-10", amount: 50 },
      { status: "scheduled", dueDate: "2026-02-20", amount: 150 },
    ];
    const r = computeQuarterlyRollup(payables);
    expect(r.quarters.map((q) => q.quarter)).toEqual(["2025-Q4", "2026-Q1", "2026-Q3"]);

    const q1_2026 = r.quarters[1];
    expect(q1_2026.year).toBe(2026);
    expect(q1_2026.q).toBe(1);
    expect(q1_2026.totalAmount).toBe(200);
    expect(q1_2026.totalCount).toBe(2);
    expect(q1_2026.byStatus.pending).toEqual({ count: 1, totalAmount: 50 });
    expect(q1_2026.byStatus.scheduled).toEqual({ count: 1, totalAmount: 150 });

    expect(r.grandTotal).toBe(1100);
    expect(r.totalCount).toBe(4);
  });

  test("Q1/Q2 boundary: 2026-03-31 last instant vs 2026-04-01 → 2 distinct quarters", () => {
    const payables = [
      { status: "pending", dueDate: "2026-03-31T23:59:59.999Z", amount: 100 },
      { status: "pending", dueDate: "2026-04-01T00:00:00.000Z", amount: 200 },
    ];
    const r = computeQuarterlyRollup(payables);
    expect(r.quarters.length).toBe(2);
    expect(r.quarters[0].quarter).toBe("2026-Q1");
    expect(r.quarters[0].totalAmount).toBe(100);
    expect(r.quarters[1].quarter).toBe("2026-Q2");
    expect(r.quarters[1].totalAmount).toBe(200);
  });

  test("quarterly exclusion taxonomy mirrors monthly (composes via computeMonthlyRollup)", () => {
    // Quarterly delegates to monthly for both bucketing AND exclusions; this
    // pins that exclusion-reason taxonomy is identical (NO_PAYABLE /
    // NO_DUE_DATE / INVALID_DUE_DATE) so the contract stays consistent.
    const payables = [
      { status: "pending", dueDate: "2026-04-10", amount: 100 },
      { status: "pending", dueDate: null, amount: 999 },
      { status: "pending", dueDate: "bogus", amount: 999 },
      null,
    ];
    const r = computeQuarterlyRollup(payables);
    expect(r.quarters.length).toBe(1);
    expect(r.quarters[0].quarter).toBe("2026-Q2");
    expect(r.quarters[0].totalAmount).toBe(100);
    expect(r.excludedCount).toBe(3);
    expect(r.excludedReasons).toEqual({
      NO_DUE_DATE: 1,
      INVALID_DUE_DATE: 1,
      NO_PAYABLE: 1,
    });
  });

  test("4 quarters in one year → all 4 emitted in order", () => {
    const payables = [
      { status: "pending", dueDate: "2026-10-15", amount: 4 }, // Q4
      { status: "pending", dueDate: "2026-01-15", amount: 1 }, // Q1
      { status: "pending", dueDate: "2026-07-15", amount: 3 }, // Q3
      { status: "pending", dueDate: "2026-04-15", amount: 2 }, // Q2
    ];
    const r = computeQuarterlyRollup(payables);
    expect(r.quarters.map((q) => q.q)).toEqual([1, 2, 3, 4]);
    expect(r.quarters.map((q) => q.totalAmount)).toEqual([1, 2, 3, 4]);
    expect(r.grandTotal).toBe(10);
  });
});
