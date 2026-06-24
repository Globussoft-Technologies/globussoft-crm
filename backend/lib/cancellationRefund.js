// Cancellation-policy refund math (PRD_TRAVEL_BILLING / CancellationPolicy).
//
// A policy's tiersJson is an array of { daysBeforeServiceStart, refundPercent }
// sorted largest-days-first, e.g.:
//   [ {daysBeforeServiceStart:30, refundPercent:100},   // full refund 30d+ out
//     {daysBeforeServiceStart:7,  refundPercent:50},    // 50% if 7..29d out
//     {daysBeforeServiceStart:0,  refundPercent:0} ]    // nothing < 7d out
//
// At cancel time we pick the tier whose `daysBeforeServiceStart` is the largest
// value that is still <= the days remaining until the trip starts, and apply its
// refundPercent to what the customer has paid. Pure functions — no I/O.

// Days from "now" until the trip's service start. Negative once the trip has
// started/passed. null when there's no start date (can't apply the day-tiers).
function daysUntil(startDate, now = new Date()) {
  if (!startDate) return null;
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const MS = 24 * 60 * 60 * 1000;
  // Floor to whole days; a trip 1.5 days out is "1 day" remaining.
  return Math.floor((start.getTime() - now.getTime()) / MS);
}

// Resolve the applicable refund percent (0..100) for the given days-remaining.
// Returns null when tiers are missing/empty or daysRemaining is unknown.
function pickRefundPercent(tiers, daysRemaining) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  if (daysRemaining == null || !Number.isFinite(daysRemaining)) return null;
  const sorted = [...tiers]
    .filter((t) => t && Number.isFinite(Number(t.daysBeforeServiceStart)) && Number.isFinite(Number(t.refundPercent)))
    .sort((a, b) => Number(b.daysBeforeServiceStart) - Number(a.daysBeforeServiceStart));
  for (const t of sorted) {
    if (daysRemaining >= Number(t.daysBeforeServiceStart)) {
      const p = Number(t.refundPercent);
      return Math.max(0, Math.min(100, p));
    }
  }
  // Below the smallest threshold (e.g. trip already started) → most restrictive.
  return 0;
}

// Full computation: { refundPercent, retentionPercent, refundAmount, computable }.
// `computable` is false when we couldn't resolve a percent (no policy / no date),
// so the caller can fall back to a manual refund decision.
function computeRefund({ tiers, daysRemaining, paidAmount } = {}) {
  const pct = pickRefundPercent(tiers, daysRemaining);
  const paid = Number(paidAmount) || 0;
  if (pct == null) {
    return { refundPercent: null, retentionPercent: null, refundAmount: null, computable: false };
  }
  // Round to 2 decimals (currency).
  const refundAmount = Math.round(paid * pct) / 100;
  return {
    refundPercent: pct,
    retentionPercent: 100 - pct,
    refundAmount,
    computable: true,
  };
}

module.exports = { daysUntil, pickRefundPercent, computeRefund };
