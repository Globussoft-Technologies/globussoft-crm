// Travel CRM — Quote analytics rollup (PRD_TRAVEL_QUOTE_BUILDER §3).
//
// Slice 13 of #900. Pure aggregation helper consumed by
//   GET /api/travel/quotes/analytics
//
// Takes a list of TravelQuote rows (already filtered by tenant + caller's
// subBrandAccess set in the route layer) and produces a rollup the operator
// dashboard renders as tiles + charts:
//
//   {
//     total,                            // total quote count in scope
//     byStatus: { Draft, Sent, Accepted, Rejected },
//     bySubBrand: { tmc: { total, accepted, ... }, rfu: {...}, ... },
//     totalValueByStatus: { Draft, Sent, Accepted, Rejected },  // sum of totalAmount per status (single-currency only)
//     acceptanceRate,                   // accepted / (accepted + rejected), null when denominator is 0
//     avgTimeToDecisionDays,            // mean(updatedAt - createdAt) over terminal-state quotes, null when none
//     expiredCount,                     // count of (status ∈ {Draft, Sent}) AND validUntil < now
//     currency,                         // tenant default currency carried through; null if quotes are mixed-currency
//   }
//
// === Why a helper rather than inline reduce in the route ===
// The aggregation has 4 distinct passes (status / sub-brand / terminal-time /
// expired). Keeping them in a pure function lets vitest pin the maths without
// booting express. Future slices can grow this (per-month breakdown,
// per-line-type spend) without bloating the route handler.
//
// === Mixed currencies ===
// The aggregation INTENTIONALLY does not FX-convert. If the scoped quotes
// span multiple currencies, totalValueByStatus.<status> values are still
// summed naively (caller's responsibility to know what they asked for) but
// the top-level `currency` field is set to null as a signal. When all
// quotes share a single currency, `currency` is set to that value. This
// matches the PRD's FR-3.4.3 "FX locked at accept time, not roll-up time"
// stance.
//
// === Acceptance rate ===
// Computed over Accepted + Rejected only — Draft/Sent are mid-flight and
// shouldn't drag the rate down. Returns null (not 0) when the denominator
// is 0 so the dashboard tile can render "n/a" rather than a misleading 0%.
//
// === Time-to-decision ===
// Mean(updatedAt - createdAt) in days, rounded to 2 decimals (half-up). Only
// includes quotes whose status ∈ {Accepted, Rejected} — these are the only
// quotes whose updatedAt is a real "decision" timestamp. Returns null when
// no terminal-state quotes are in scope.
//
// === Expired ===
// Mirrors the GET /api/travel/quotes/expired filter exactly: status ∈
// {Draft, Sent} AND validUntil < now. The `now` argument is injected so
// tests can pin a deterministic clock; production passes new Date().

"use strict";

const TERMINAL_STATUSES = new Set(["Accepted", "Rejected"]);
const NON_TERMINAL_STATUSES = new Set(["Draft", "Sent"]);
const ALL_STATUSES = ["Draft", "Sent", "Accepted", "Rejected"];

// Round x to 2 decimals with half-up rounding. JavaScript's Math.round uses
// half-to-even on some platforms; this helper guarantees half-up for the
// avgTimeToDecisionDays surface so tests don't drift across Node versions.
function roundHalfUp2(x) {
  if (!Number.isFinite(x)) return x;
  // Add a tiny epsilon to pull values exactly on the .005 boundary onto the
  // up side regardless of binary-float representation.
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the analytics rollup over a list of TravelQuote rows.
 *
 * @param {Array<{
 *   id: number,
 *   subBrand: string,
 *   status: string,
 *   totalAmount: number | string | null,
 *   currency: string,
 *   validUntil: Date | string | null,
 *   createdAt: Date | string,
 *   updatedAt: Date | string,
 * }>} quotes
 * @param {{ now?: Date }} [opts]
 * @returns {object} the rollup envelope (see header).
 */
function computeQuoteAnalytics(quotes, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const list = Array.isArray(quotes) ? quotes : [];

  const byStatus = { Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 };
  const totalValueByStatus = { Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 };
  const bySubBrand = {};
  let acceptedCount = 0;
  let rejectedCount = 0;
  let expiredCount = 0;
  let decisionTimeSumMs = 0;
  let decisionTimeCount = 0;
  const currencies = new Set();

  for (const q of list) {
    const status = ALL_STATUSES.includes(q.status) ? q.status : null;
    if (!status) continue;

    byStatus[status] += 1;
    const amt = q.totalAmount == null ? 0 : Number(q.totalAmount);
    if (Number.isFinite(amt)) totalValueByStatus[status] += amt;

    if (q.currency) currencies.add(q.currency);

    const sb = String(q.subBrand || "_unknown");
    if (!bySubBrand[sb]) {
      bySubBrand[sb] = { total: 0, Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 };
    }
    bySubBrand[sb].total += 1;
    bySubBrand[sb][status] += 1;

    if (status === "Accepted") acceptedCount += 1;
    if (status === "Rejected") rejectedCount += 1;

    if (TERMINAL_STATUSES.has(status)) {
      const createdMs = new Date(q.createdAt).getTime();
      const updatedMs = new Date(q.updatedAt).getTime();
      if (
        Number.isFinite(createdMs)
        && Number.isFinite(updatedMs)
        && updatedMs >= createdMs
      ) {
        decisionTimeSumMs += updatedMs - createdMs;
        decisionTimeCount += 1;
      }
    }

    if (NON_TERMINAL_STATUSES.has(status) && q.validUntil) {
      const vu = new Date(q.validUntil).getTime();
      if (Number.isFinite(vu) && vu < now.getTime()) expiredCount += 1;
    }
  }

  const decisionDenom = acceptedCount + rejectedCount;
  const acceptanceRate = decisionDenom > 0
    ? roundHalfUp2(acceptedCount / decisionDenom)
    : null;

  const avgTimeToDecisionDays = decisionTimeCount > 0
    ? roundHalfUp2(decisionTimeSumMs / decisionTimeCount / 86400000)
    : null;

  const currency = currencies.size === 1
    ? Array.from(currencies)[0]
    : null;

  return {
    total: list.length,
    byStatus,
    bySubBrand,
    totalValueByStatus,
    acceptanceRate,
    avgTimeToDecisionDays,
    expiredCount,
    currency,
  };
}

module.exports = {
  computeQuoteAnalytics,
  // exported for unit tests:
  roundHalfUp2,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  ALL_STATUSES,
};
