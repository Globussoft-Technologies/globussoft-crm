// Travel CRM — Supplier Payable Aging helper (PRD_TRAVEL_BILLING UC-2.5).
//
// Slice 4 of #903 Supplier Master follow-on. Pure helper that buckets supplier
// payables by days-overdue. Industry-standard aging buckets used by accounting
// teams for month-end close:
//
//   - current  → not yet due (daysOverdue ≤ 0)
//   - 1-30     → 1 to 30 days overdue
//   - 31-60    → 31 to 60 days overdue
//   - 61-90    → 61 to 90 days overdue
//   - 90+      → more than 90 days overdue
//
// Only PENDING / SCHEDULED payables count toward aging. PAID and CANCELLED
// payables are excluded — once a supplier invoice is settled (or voided) it
// is no longer a liability and should not appear on the aged-payable report.
//
// === Days-overdue semantics ===
//
// `daysOverdue = floor((asOf - dueDate) / 86_400_000)`:
//
//   - negative → not yet due (future dueDate) → bucket = "current"
//   - 0        → due today                    → bucket = "current"
//   - 1..30    → 1 to 30 days overdue         → bucket = "1-30"
//   - 31..60   → 31 to 60 days overdue        → bucket = "31-60"
//   - 61..90   → 61 to 90 days overdue        → bucket = "61-90"
//   - 91+      → 91+ days overdue             → bucket = "90+"
//
// Boundary convention is inclusive at the upper edge of each bucket: a payable
// 30 days overdue lands in "1-30", a payable 31 days overdue lands in "31-60".
// This matches the convention used by Tally / Zoho Books / QuickBooks for
// supplier-payable aging reports — accountants reading the report can match
// row counts against their existing reports without re-bucketing.
//
// === Rounding ===
//
// Bucket totals + grand total are half-up rounded to 2 decimal places via
// round2() — matches gstCalculation.js / tcsCalculation.js so combined
// month-end reports (aged payable + GST liability + TCS collected) round
// consistently across the suite.
//
// Pure JS — no Prisma, no fetch, no IO. Route consumption (the supplier-payable
// /aging endpoint feeding the Travel admin's month-end-close dashboard) lands
// in slice 7 of #903.

const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];

/**
 * Map a days-overdue integer to its aging bucket key.
 *
 * @param {number} daysOverdue — negative=not-yet-due, 0=due-today, positive=overdue
 * @returns {string} — one of AGING_BUCKETS
 */
function bucketForDays(daysOverdue) {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

/**
 * Classify a single payable by its aging bucket.
 *
 * Returns `{ ok: false, reason }` when the payable should be excluded from
 * the aging report — caller is responsible for tallying excludedReasons.
 *
 * @param {{ dueDate?: Date|string|null, paidAt?: Date|string|null, status?: string, amount?: number }} payable
 * @param {Date} [asOf] — date to age against (default now)
 * @returns {{ ok: boolean, bucket?: string, daysOverdue?: number, reason?: string }}
 */
function classifyPayable(payable, asOf = new Date()) {
  if (!payable) return { ok: false, reason: "NO_PAYABLE" };
  if (payable.status === "paid" || payable.status === "cancelled") {
    return { ok: false, reason: `EXCLUDED_${payable.status.toUpperCase()}` };
  }
  if (!payable.dueDate) return { ok: false, reason: "NO_DUE_DATE" };
  const due = payable.dueDate instanceof Date ? payable.dueDate : new Date(payable.dueDate);
  if (Number.isNaN(due.getTime())) return { ok: false, reason: "INVALID_DUE_DATE" };
  const daysOverdue = Math.floor((asOf.getTime() - due.getTime()) / 86_400_000);
  return { ok: true, bucket: bucketForDays(daysOverdue), daysOverdue };
}

/**
 * Aggregate a list of payables into aging buckets.
 *
 * Excluded payables (paid / cancelled / missing-dueDate / invalid-dueDate /
 * null entries) are tallied into `excludedCount` + `excludedReasons` so the
 * route layer can surface "N payables excluded from aging report" for the
 * accountant's review.
 *
 * @param {Array} payables — array of payable objects with { dueDate, status, amount }
 * @param {object} [opts]
 * @param {Date} [opts.asOf] — date to age against (default now)
 * @returns {{
 *   asOf: string,
 *   bucketTotals: Record<string, { count: number, totalAmount: number }>,
 *   grandTotal: number,
 *   excludedCount: number,
 *   excludedReasons: Record<string, number>
 * }}
 */
function computeAgingReport(payables, opts = {}) {
  const asOf = opts.asOf instanceof Date ? opts.asOf : new Date();
  const bucketTotals = {};
  for (const b of AGING_BUCKETS) bucketTotals[b] = { count: 0, totalAmount: 0 };
  let grandTotal = 0;
  let excludedCount = 0;
  const excludedReasons = {};

  for (const p of payables || []) {
    const result = classifyPayable(p, asOf);
    if (!result.ok) {
      excludedCount++;
      excludedReasons[result.reason] = (excludedReasons[result.reason] || 0) + 1;
      continue;
    }
    const amount = Number(p && p.amount ? p.amount : 0);
    bucketTotals[result.bucket].count++;
    bucketTotals[result.bucket].totalAmount = round2(bucketTotals[result.bucket].totalAmount + amount);
    grandTotal = round2(grandTotal + amount);
  }

  return {
    asOf: asOf.toISOString(),
    bucketTotals,
    grandTotal,
    excludedCount,
    excludedReasons,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// === Monthly rollup (Arc 2 #903 slice 18) ===
//
// Group a list of payables into per-YYYY-MM buckets, splitting count +
// total amount by status (pending / scheduled / paid / cancelled). Feeds
// the per-supplier dashboard "monthly invoice rollup" widget — operators
// pull a single supplier's per-month payable schedule for cash-flow
// planning (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d + §3.5.b "commission
// ledger per FY" precursor — FY-wide rollup composes from monthly).
//
// Bucketing key is the payable's `dueDate` (forward-looking liability
// calendar — when each obligation is/was scheduled to be paid). Rows
// with a null / invalid dueDate are excluded with reason — caller can
// surface "N payables excluded from monthly rollup" for the operator.
//
// Status split per month is essential — a month with ₹50K total amount
// is very different if it's 50K-pending vs 50K-paid. Operators glance
// at the rollup and immediately see "March: ₹50K owed (45K pending,
// 5K paid)" without further drill-down.
//
// === Output shape ===
//
//   {
//     months: [
//       { month: "2026-03", totalAmount: 50000, totalCount: 12,
//         byStatus: {
//           pending:   { count: 9, totalAmount: 45000 },
//           scheduled: { count: 0, totalAmount: 0 },
//           paid:      { count: 3, totalAmount: 5000 },
//           cancelled: { count: 0, totalAmount: 0 },
//         },
//       },
//       ...
//     ],
//     grandTotal: 50000,
//     totalCount: 12,
//     excludedCount: 0,
//     excludedReasons: {},
//   }
//
// Months are sorted ASC by YYYY-MM key so callers can render the timeline
// left-to-right without re-sorting. Empty months (no payables) are NOT
// emitted — callers showing a contiguous month axis fill gaps client-side.
// (Rationale: the rollup is response-size-bounded by the actual payable
// timeline rather than by an arbitrary axis window.)

const ROLLUP_STATUSES = ["pending", "scheduled", "paid", "cancelled"];

/**
 * Format a Date as YYYY-MM (UTC). Used as the rollup bucket key.
 *
 * @param {Date} d
 * @returns {string} — "YYYY-MM"
 */
function monthKey(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Build a per-YYYY-MM rollup of payables, split by status.
 *
 * Exclusion reasons:
 *   - NO_PAYABLE     → null entry in input array
 *   - NO_DUE_DATE    → payable.dueDate is null/undefined
 *   - INVALID_DUE_DATE → payable.dueDate doesn't parse
 *
 * Unknown statuses are tallied under their literal status key but NOT
 * added to the per-status break (kept under totalAmount + totalCount).
 * This guards against future-added status values that haven't been
 * wired into ROLLUP_STATUSES yet — caller still sees the total.
 *
 * @param {Array} payables
 * @returns {{
 *   months: Array<{ month: string, totalAmount: number, totalCount: number,
 *     byStatus: Record<string, { count: number, totalAmount: number }>
 *   }>,
 *   grandTotal: number,
 *   totalCount: number,
 *   excludedCount: number,
 *   excludedReasons: Record<string, number>
 * }}
 */
function computeMonthlyRollup(payables) {
  const buckets = new Map(); // key=YYYY-MM -> aggregate
  let grandTotal = 0;
  let totalCount = 0;
  let excludedCount = 0;
  const excludedReasons = {};

  function excluded(reason) {
    excludedCount++;
    excludedReasons[reason] = (excludedReasons[reason] || 0) + 1;
  }

  for (const p of payables || []) {
    if (!p) {
      excluded("NO_PAYABLE");
      continue;
    }
    if (!p.dueDate) {
      excluded("NO_DUE_DATE");
      continue;
    }
    const due = p.dueDate instanceof Date ? p.dueDate : new Date(p.dueDate);
    if (Number.isNaN(due.getTime())) {
      excluded("INVALID_DUE_DATE");
      continue;
    }

    const key = monthKey(due);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { month: key, totalAmount: 0, totalCount: 0, byStatus: {} };
      for (const s of ROLLUP_STATUSES) {
        bucket.byStatus[s] = { count: 0, totalAmount: 0 };
      }
      buckets.set(key, bucket);
    }

    const amount = Number(p.amount || 0);
    bucket.totalAmount = round2(bucket.totalAmount + amount);
    bucket.totalCount++;

    const status = typeof p.status === "string" ? p.status : "pending";
    if (ROLLUP_STATUSES.includes(status)) {
      bucket.byStatus[status].count++;
      bucket.byStatus[status].totalAmount = round2(
        bucket.byStatus[status].totalAmount + amount,
      );
    }
    // Unknown statuses still land in totalAmount + totalCount but are
    // intentionally NOT echoed under byStatus — the caller's UI legend
    // is fixed to ROLLUP_STATUSES and an unknown key would render blank.

    grandTotal = round2(grandTotal + amount);
    totalCount++;
  }

  const months = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    months,
    grandTotal,
    totalCount,
    excludedCount,
    excludedReasons,
  };
}

// === Quarterly rollup (Arc 2 #903 slice 20) ===
//
// Group a list of payables into per-YYYY-Qn buckets, splitting count +
// total amount by status (pending / scheduled / paid / cancelled). Feeds
// the per-supplier dashboard "next 4 quarters payable schedule" widget
// (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d + §3.5.b "commission ledger per
// FY" — the FY ledger composes from quarterly which composes from
// monthly).
//
// Quarter boundaries are calendar-based (Q1=Jan-Mar, Q2=Apr-Jun,
// Q3=Jul-Sep, Q4=Oct-Dec). Indian financial-year quarters (Apr-Jun = Q1
// FY, etc.) are out of scope for this slice — surface both labels in a
// future slice if the finance team needs them.
//
// Composes from computeMonthlyRollup by collapsing each (year, quarter)
// triplet of monthly buckets — preserves the per-status break + exclusion
// reasons so callers get a strict superset of the monthly contract at a
// coarser granularity.
//
// === Output shape ===
//
//   {
//     quarters: [
//       { quarter: "2026-Q1", year: 2026, q: 1,
//         totalAmount: 750, totalCount: 18,
//         byStatus: {
//           pending:   { count: 14, totalAmount: 700 },
//           scheduled: { count: 0,  totalAmount: 0 },
//           paid:      { count: 4,  totalAmount: 50 },
//           cancelled: { count: 0,  totalAmount: 0 },
//         },
//       },
//       ...
//     ],
//     grandTotal: 750,
//     totalCount: 18,
//     excludedCount: 0,
//     excludedReasons: {},
//   }
//
// Quarters sorted ASC by (year, q). Empty quarters (no payables) are NOT
// emitted — mirror the monthly contract; callers fill gaps client-side.

/**
 * Compute the calendar quarter (1..4) for a 1-based month (1..12).
 *
 * @param {number} month1to12
 * @returns {number} — 1..4
 */
function quarterForMonth(month1to12) {
  return Math.floor((month1to12 - 1) / 3) + 1;
}

/**
 * Format a (year, quarter) pair as YYYY-Qn (e.g. "2026-Q1").
 *
 * @param {number} year
 * @param {number} q — 1..4
 * @returns {string}
 */
function quarterKey(year, q) {
  return `${year}-Q${q}`;
}

/**
 * Build a per-YYYY-Qn rollup of payables, split by status.
 *
 * Composes from computeMonthlyRollup — every monthly bucket is folded
 * into its enclosing (year, quarter) pair so the per-status break
 * preserves the same correctness contract.
 *
 * Exclusion reasons mirror the monthly rollup (NO_PAYABLE / NO_DUE_DATE
 * / INVALID_DUE_DATE) since the underlying classifier is shared.
 *
 * @param {Array} payables
 * @returns {{
 *   quarters: Array<{ quarter: string, year: number, q: number,
 *     totalAmount: number, totalCount: number,
 *     byStatus: Record<string, { count: number, totalAmount: number }>
 *   }>,
 *   grandTotal: number,
 *   totalCount: number,
 *   excludedCount: number,
 *   excludedReasons: Record<string, number>
 * }}
 */
function computeQuarterlyRollup(payables) {
  const monthly = computeMonthlyRollup(payables);
  const buckets = new Map(); // key=YYYY-Qn -> aggregate

  for (const m of monthly.months) {
    // m.month is "YYYY-MM"; parse year + month then map to quarter.
    const [yStr, mStr] = m.month.split("-");
    const year = Number(yStr);
    const month = Number(mStr);
    const q = quarterForMonth(month);
    const key = quarterKey(year, q);

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        quarter: key,
        year,
        q,
        totalAmount: 0,
        totalCount: 0,
        byStatus: {},
      };
      for (const s of ROLLUP_STATUSES) {
        bucket.byStatus[s] = { count: 0, totalAmount: 0 };
      }
      buckets.set(key, bucket);
    }

    bucket.totalAmount = round2(bucket.totalAmount + m.totalAmount);
    bucket.totalCount += m.totalCount;
    for (const s of ROLLUP_STATUSES) {
      bucket.byStatus[s].count += m.byStatus[s].count;
      bucket.byStatus[s].totalAmount = round2(
        bucket.byStatus[s].totalAmount + m.byStatus[s].totalAmount,
      );
    }
  }

  const quarters = [...buckets.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.q - b.q;
  });

  return {
    quarters,
    grandTotal: monthly.grandTotal,
    totalCount: monthly.totalCount,
    excludedCount: monthly.excludedCount,
    excludedReasons: monthly.excludedReasons,
  };
}

module.exports = {
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
};
