/**
 * latePenaltyCalculation.js — Arc 2 #901 slice 24
 * ============================================================================
 *
 * Pure late-payment-penalty computation over a single invoice's
 * (`totalAmount`, `dueDate`, `status`) tuple. Read-only — no Prisma access
 * — keeps it trivially unit-testable and call-site-portable.
 *
 * PRD_TRAVEL_BILLING §3 — Travel sub-brands routinely add a flat
 * grace-period plus a per-day or per-cycle interest accrual on overdue
 * customer invoices (operator-configurable; defaults match the ~2025
 * Indian commercial norm of 7-day grace + 1.5% / month simple interest,
 * which is below the 18% / annum upper RBI cap and avoids "usurious"
 * classification).
 *
 * This module exposes a single pure function that callers (currently
 * the /:id/late-penalty preview endpoint; future: customer-facing
 * portal display, reminder cron, statement-of-account PDF rendering)
 * call with the invoice payload + a policy options bag.
 *
 * Rounding convention: half-up to 2 decimal places, matching the rest
 * of the travel-invoice money math (PaymentSchedule milestones, FX
 * baseAmount, TCS amount, TDS sum). Idiom:
 *   Math.round((n + Number.EPSILON) * 100) / 100
 * The Number.EPSILON nudge handles the 0.005 → 0.00 (not 0.01)
 * IEEE-754 float quirk on legitimately-half values.
 *
 * Penalty does NOT apply (returns applies:false, penalty:0) when:
 *   - status is Paid or Voided (closed states; nothing to penalise).
 *   - dueDate is missing/null (no obligation timestamp to anchor on).
 *   - asOf is on or before dueDate (not yet due — operator may call
 *     the preview before the deadline to render "due in N days").
 *   - daysOverdue ≤ graceDays (still inside the grace window).
 *   - invoiceAmount is ≤ 0 (zero-amount or credit-note row — there
 *     is no principal to compound against).
 *
 * Penalty MATH (mode='simple', default):
 *   chargeableDays = max(0, daysOverdue - graceDays)
 *   penalty        = round2(invoiceAmount * (annualRatePercent/100)
 *                            * (chargeableDays / 365))
 *
 * Penalty MATH (mode='flat'):
 *   chargeableDays = max(0, daysOverdue - graceDays)
 *   penalty        = chargeableDays > 0
 *                      ? round2(invoiceAmount * (flatFeePercent/100))
 *                      : 0
 *
 * Future modes (NOT in this slice — land when operator policy widens):
 *   - 'compound' (per-month compound, RBI cap watch).
 *   - 'tiered' (0-30/31-60/61-90 brackets with progressive rates).
 *   - 'currency-aware' (USD-denominated grace + INR-denominated rate).
 *
 * Decimal-vs-Number contract: Prisma returns Decimal columns as
 * `Decimal` wrapper objects in some configurations and as plain strings
 * in others. The helper coerces via Number(invoice.totalAmount) which
 * handles both shapes (Decimal has .toString() that survives the
 * implicit conversion; strings parse via the standard numeric
 * coercion). Non-numeric totalAmount (NaN) is treated as 0 — defensive
 * for production rows that may have legacy nulls.
 */

'use strict';

const DEFAULT_GRACE_DAYS = 7;
const DEFAULT_ANNUAL_RATE_PERCENT = 18; // 1.5% / month × 12
const DEFAULT_FLAT_FEE_PERCENT = 2;
const PAYABLE_STATUSES = ['Issued', 'Partial']; // statuses that can accrue penalty

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toDayDiff(later, earlier) {
  // Floor to whole days (8.5 days overdue → 8 days). Operator-friendly:
  // partial-day timestamps don't round up into a chargeable day.
  const ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Compute late-payment penalty for one invoice.
 *
 * @param {Object} args
 * @param {number|string|null|undefined} args.invoiceAmount  Principal — coerced via Number(); NaN/null → 0.
 * @param {Date|string|null|undefined} args.dueDate         Obligation date.
 * @param {string|null|undefined} args.status               Invoice.status enum (Draft|Issued|Partial|Paid|Voided).
 * @param {Date|string} [args.asOf=new Date()]              Reference "now" — defaults to wall-clock.
 * @param {number} [args.graceDays]                          Override DEFAULT_GRACE_DAYS (clamped ≥ 0).
 * @param {number} [args.annualRatePercent]                  Override DEFAULT_ANNUAL_RATE_PERCENT (clamped ≥ 0).
 * @param {number} [args.flatFeePercent]                     Override DEFAULT_FLAT_FEE_PERCENT (clamped ≥ 0).
 * @param {'simple'|'flat'} [args.mode='simple']             Penalty model.
 *
 * @returns {{
 *   applies: boolean,
 *   daysOverdue: number,
 *   chargeableDays: number,
 *   graceDays: number,
 *   mode: string,
 *   ratePercent: number,
 *   penalty: number,
 *   newBalance: number,
 *   reason: string|null,
 * }}
 *   - applies: did the penalty trigger? (false when in grace, paid, voided, etc.)
 *   - daysOverdue: integer days past dueDate (>=0).
 *   - chargeableDays: daysOverdue minus graceDays, clamped ≥ 0.
 *   - graceDays: effective grace window applied.
 *   - mode: penalty mode used.
 *   - ratePercent: annualRatePercent (simple) or flatFeePercent (flat) used.
 *   - penalty: half-up rounded to 2dp.
 *   - newBalance: round2(invoiceAmount + penalty).
 *   - reason: non-null when applies=false; one of
 *       'INVOICE_CLOSED' | 'NO_DUE_DATE' | 'NOT_YET_DUE' | 'IN_GRACE_WINDOW' | 'ZERO_PRINCIPAL'
 */
function computeLatePenalty(args) {
  const {
    invoiceAmount,
    dueDate,
    status,
    asOf,
    graceDays,
    annualRatePercent,
    flatFeePercent,
    mode,
  } = args || {};

  const effGrace = Math.max(0, Number.isFinite(graceDays) ? graceDays : DEFAULT_GRACE_DAYS);
  const effAnnual = Math.max(
    0,
    Number.isFinite(annualRatePercent) ? annualRatePercent : DEFAULT_ANNUAL_RATE_PERCENT,
  );
  const effFlat = Math.max(
    0,
    Number.isFinite(flatFeePercent) ? flatFeePercent : DEFAULT_FLAT_FEE_PERCENT,
  );
  const effMode = mode === 'flat' ? 'flat' : 'simple';
  const effRatePercent = effMode === 'flat' ? effFlat : effAnnual;

  let principal = Number(invoiceAmount);
  if (!Number.isFinite(principal)) principal = 0;

  const reference = asOf instanceof Date ? asOf : asOf ? new Date(asOf) : new Date();

  function zeroEnvelope(reason, daysOverdue) {
    return {
      applies: false,
      daysOverdue: Math.max(0, daysOverdue || 0),
      chargeableDays: 0,
      graceDays: effGrace,
      mode: effMode,
      ratePercent: effRatePercent,
      penalty: 0,
      newBalance: round2(principal),
      reason,
    };
  }

  // Closed states never accrue.
  if (!PAYABLE_STATUSES.includes(status)) {
    return zeroEnvelope('INVOICE_CLOSED', 0);
  }
  if (dueDate == null) {
    return zeroEnvelope('NO_DUE_DATE', 0);
  }
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(due.getTime())) {
    return zeroEnvelope('NO_DUE_DATE', 0);
  }

  const daysOverdue = toDayDiff(reference, due);
  if (daysOverdue <= 0) {
    return zeroEnvelope('NOT_YET_DUE', 0);
  }
  const chargeableDays = Math.max(0, daysOverdue - effGrace);
  if (chargeableDays === 0) {
    return zeroEnvelope('IN_GRACE_WINDOW', daysOverdue);
  }
  if (principal <= 0) {
    return zeroEnvelope('ZERO_PRINCIPAL', daysOverdue);
  }

  let penalty;
  if (effMode === 'flat') {
    penalty = round2(principal * (effFlat / 100));
  } else {
    penalty = round2(principal * (effAnnual / 100) * (chargeableDays / 365));
  }

  return {
    applies: penalty > 0,
    daysOverdue,
    chargeableDays,
    graceDays: effGrace,
    mode: effMode,
    ratePercent: effRatePercent,
    penalty,
    newBalance: round2(principal + penalty),
    reason: penalty > 0 ? null : 'ZERO_PRINCIPAL',
  };
}

module.exports = {
  computeLatePenalty,
  DEFAULT_GRACE_DAYS,
  DEFAULT_ANNUAL_RATE_PERCENT,
  DEFAULT_FLAT_FEE_PERCENT,
  PAYABLE_STATUSES,
};
