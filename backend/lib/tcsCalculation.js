// Travel CRM — Section 206C TCS (Tax Collected at Source) calculation helper.
//
// Slice 8 of the #901 Travel Billing module (PRD:
// docs/PRD_TRAVEL_BILLING.md UC-2.6 + FR-3.x). This file ships ONLY the
// PURE TCS math + cumulative-FY-spend logic + overseas-destination check.
// No Prisma, no fetch, no IO — just numbers. The route layer + threshold
// lookup against historical customer spend lands in slice 9.
//
// === Section 206C(1G) — overview ===
//
// The Indian Income Tax Act Section 206C(1G) requires the seller of an
// OVERSEAS TOUR PROGRAM PACKAGE to collect TCS from a resident buyer.
// Current rates (as amended Finance Act 2023, effective from 01-Oct-2023):
//
//   - 5% on the amount EXCEEDING ₹7,00,000 per customer per FY (ITR filers)
//   - 20% on the EXCEEDING amount if the buyer is a NON-FILER
//     (no income tax return for last 2 years per Section 206CCA)
//
// Threshold (TCS_FY_THRESHOLD) is per-customer per-FY. The "exceeding amount"
// is computed against the customer's CUMULATIVE FY spend at the time of
// invoice. Once threshold is crossed, ALL subsequent overseas-tour invoices
// in that FY attract TCS on their full amount (no per-invoice reset).
//
// TCS does NOT apply to domestic tour packages — the route layer is
// responsible for setting `isOverseasPackage` correctly from the trip's
// destination(s). Use `isOverseasDestination(countryCode)` for the simple
// heuristic; multi-destination itineraries (some-overseas + some-domestic)
// are a slice-9 concern handled at the route level.
//
// === Rounding ===
//
// Half-up to 2 decimal places via `Math.round(n * 100) / 100`.
// Rationale: matches the way GST PDFs (gstCalculation.js) round line totals,
// so combined invoices with GST + TCS lines round consistently. Pin half-up;
// banker's rounding would surface 1-paisa diffs (e.g. ₹333.33 × 5% =
// ₹16.6665 → half-up gives ₹16.67, banker's gives ₹16.66) on common amounts.
//
// === Defensive behaviour ===
//
// - Negative invoice amount → applies:false (no TCS on credit notes /
//   refunds — operator handles reversal at the route layer).
// - Negative priorFySpend → clamped to 0 (defensive; data corruption signal).
// - Zero invoice amount → applies:false (nothing to tax).
// - Non-numeric inputs → coerced via `Number(x) || 0` (matches
//   gstCalculation.js convention).

const TCS_FY_THRESHOLD = 700000; // ₹7,00,000 per Section 206C(1G)
const TCS_FILER_RATE = 5; // % for ITR filers
const TCS_NON_FILER_RATE = 20; // % for non-filers (Section 206CCA)

/**
 * Round to 2 decimal places using half-up rounding.
 * Matches gstCalculation.js for consistency on combined invoices.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Compute TCS for ONE invoice given the customer's existing FY spend.
 *
 * Returns `applies:false` (with tcsAmount=0) in these cases:
 *   - !isOverseasPackage (domestic skips TCS)
 *   - invoiceAmount <= 0 (zero or negative — no TCS on credit notes)
 *   - newFyTotal <= threshold (cumulative spend still under ₹7L)
 *
 * `exceedingAmount` is computed as the portion of `newFyTotal` that lies
 * ABOVE the threshold AND falls within THIS invoice's amount:
 *   - If priorFySpend >= threshold (already above): exceedingAmount = invoiceAmount
 *   - Else (this invoice straddles threshold): exceedingAmount = newFyTotal - threshold
 *
 * @param {object} args
 * @param {number} args.invoiceAmount     — current invoice's taxable amount (₹)
 * @param {number} args.priorFySpend      — customer's cumulative FY spend BEFORE this invoice (₹)
 * @param {boolean} [args.isNonFiler]     — true if buyer has no ITR for last 2 years (default false)
 * @param {boolean} [args.isOverseasPackage] — TCS only applies to overseas (default true)
 * @returns {{
 *   applies: boolean,
 *   exceedingAmount: number,
 *   rate: number,
 *   tcsAmount: number,
 *   newFyTotal: number
 * }}
 */
function computeTcs({
  invoiceAmount,
  priorFySpend,
  isNonFiler = false,
  isOverseasPackage = true,
}) {
  const amt = Number(invoiceAmount) || 0;
  // Clamp prior to 0 if negative (defensive — data corruption signal).
  const priorRaw = Number(priorFySpend) || 0;
  const prior = priorRaw < 0 ? 0 : priorRaw;
  const rate = isNonFiler ? TCS_NON_FILER_RATE : TCS_FILER_RATE;

  // Domestic / zero / negative invoice → no TCS.
  if (!isOverseasPackage || amt <= 0) {
    return {
      applies: false,
      exceedingAmount: 0,
      rate,
      tcsAmount: 0,
      newFyTotal: round2(prior + Math.max(0, amt)),
    };
  }

  const newFyTotal = round2(prior + amt);

  // Still below or exactly at threshold → no TCS yet.
  if (newFyTotal <= TCS_FY_THRESHOLD) {
    return {
      applies: false,
      exceedingAmount: 0,
      rate,
      tcsAmount: 0,
      newFyTotal,
    };
  }

  // Two cases:
  //   (a) prior already >= threshold → entire invoice is "above"
  //   (b) prior < threshold but new total > threshold → only the
  //       portion straddling the threshold is taxable
  let exceedingAmount;
  if (prior >= TCS_FY_THRESHOLD) {
    exceedingAmount = amt;
  } else {
    exceedingAmount = round2(newFyTotal - TCS_FY_THRESHOLD);
  }

  const tcsAmount = round2((exceedingAmount * rate) / 100);

  return {
    applies: true,
    exceedingAmount,
    rate,
    tcsAmount,
    newFyTotal,
  };
}

/**
 * Compute TCS for a batch of invoices in chronological order. Useful for
 * back-fill scenarios where the operator wants to see the total TCS that
 * would have been collected across a customer's FY purchases — e.g. when
 * importing legacy data or running a "what if" report.
 *
 * Each invoice's `priorFySpend` is taken from the running cumulative total
 * of PRECEDING entries in the array; the caller is responsible for sort
 * order (by invoice date / sequence). Domestic invoices DO contribute to
 * the running cumulative total in this batch helper (they accumulate even
 * though they don't attract TCS) — this matches the per-customer FY-spend
 * semantics where ALL purchases count toward the next overseas invoice's
 * threshold check.
 *
 * NOTE: The slice-9 route layer may diverge from this convention if Govt
 * guidance clarifies that only OVERSEAS purchases accumulate toward the
 * ₹7L threshold (current reading of Section 206C(1G) is ambiguous — see
 * docs/PRD_TRAVEL_BILLING.md Q-TCS-1). This helper pins the conservative
 * interpretation (all spend counts) for now.
 *
 * @param {Array<{
 *   amount: number,
 *   isOverseasPackage: boolean,
 *   isNonFiler?: boolean
 * }>} invoices
 * @returns {{
 *   totalTcs: number,
 *   perInvoice: Array<{
 *     applies: boolean,
 *     exceedingAmount: number,
 *     rate: number,
 *     tcsAmount: number,
 *     newFyTotal: number
 *   }>
 * }}
 */
function computeTcsBatch(invoices) {
  const rows = Array.isArray(invoices) ? invoices : [];
  const perInvoice = [];
  let runningTotal = 0;
  let totalTcs = 0;

  for (const inv of rows) {
    const amt = Number(inv && inv.amount) || 0;
    const isOverseas = inv && inv.isOverseasPackage === true;
    const isNonFiler = inv && inv.isNonFiler === true;
    const result = computeTcs({
      invoiceAmount: amt,
      priorFySpend: runningTotal,
      isNonFiler,
      isOverseasPackage: isOverseas,
    });
    perInvoice.push(result);
    // Cumulative running total accrues ALL spend (overseas + domestic).
    runningTotal = round2(runningTotal + Math.max(0, amt));
    if (result.applies) {
      totalTcs = round2(totalTcs + result.tcsAmount);
    }
  }

  return { totalTcs, perInvoice };
}

/**
 * Check if a tour package qualifies for TCS based on destination country.
 * Simple heuristic: any non-Indian destination is "overseas".
 *
 * Defensive: returns false for null / undefined / non-string / empty input
 * (route layer should validate destination data before calling).
 * Comparison is case-insensitive ('in', 'IN', 'In' all match domestic).
 *
 * @param {string} destinationCountryCode — ISO 3166-1 alpha-2 (e.g. "IN", "AE", "SA", "TH")
 * @returns {boolean} — true if TCS-eligible (overseas), false otherwise
 */
function isOverseasDestination(destinationCountryCode) {
  if (typeof destinationCountryCode !== "string") return false;
  const code = destinationCountryCode.trim().toUpperCase();
  if (!code) return false;
  return code !== "IN";
}

module.exports = {
  TCS_FY_THRESHOLD,
  TCS_FILER_RATE,
  TCS_NON_FILER_RATE,
  computeTcs,
  computeTcsBatch,
  isOverseasDestination,
};
