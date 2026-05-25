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

module.exports = { AGING_BUCKETS, bucketForDays, classifyPayable, computeAgingReport };
