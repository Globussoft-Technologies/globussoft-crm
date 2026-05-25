// Travel CRM — Indian GST tax-calculation helper (pure math).
//
// Slice 1 of the #902 GST & Compliance module (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md). This file ships ONLY the
// CGST/SGST/IGST math + place-of-supply decision + per-category rate
// lookup. No Prisma, no fetch, no IO — just numbers. Subsequent slices
// will consume this helper from route handlers (FR-3.2.3) and from the
// invoice PDF render layer (FR-3.2.5).
//
// === Place-of-supply (PRD §1 + §3.5) ===
//
//   - Intra-state (operator state == customer state):
//       total GST is split into CGST (Centre) + SGST (State), each
//       half the slab rate.  e.g. 18% → 9% CGST + 9% SGST.
//   - Inter-state (operator state != customer state):
//       single IGST line at the full slab rate.  e.g. 18% → 18% IGST.
//   - Export of service (customer outside India): not in scope for
//     this slice; the route layer handles that branch separately via
//     `Contact.country !== 'IN'` + LUT reference (FR-3.5.3, NFR-4.4).
//
// === Rounding ===
//
// Half-up to 2 decimal places via `Math.round(n * 100) / 100`.
// Rationale: matches the way every Indian-GST PDF render (TaxAdda /
// ClearTax / Zoho-Books) rounds line totals — half-up is the
// operator-expected behaviour. Banker's rounding would surface
// 1-paisa diffs on common amounts (e.g. ₹333.33 × 5% = ₹16.6665 →
// banker's gives ₹16.66, half-up gives ₹16.67) and create
// reconciliation noise on every reissue. Pin half-up; revisit if any
// Govt-spec GSTR-1 JSON validator complains about a tie-breaker
// preference (it never has historically).
//
// Caller stringifies for Prisma `Decimal` columns; this module stays
// in JS `number` land for ergonomics.
//
// === Rate defaults (gstRateForCategory) ===
//
// PRD §3.1.2 says "seed govt-default slab rates for top-15 travel
// SAC codes at tenant-create time" — that seeding lives in the future
// tax-rate-master table (FR-3.1.1). This helper exposes a flat
// default-lookup for the route layer to fall back on when no
// TaxRateMaster row matches. Defaults pin the common case:
//
//     hotel        12  (rooms ₹1000–₹7500/night — PRD §1)
//     flight        5  (economy — PRD §1)
//     transport     5  (SAC 9964 passenger transport)
//     visa         18  (TODO: should be 0 for export-of-service per
//                       Q-GST-4 LUT — defaulting to 18 because slice 1
//                       has no LUT context; route layer overrides)
//     tour_package  5  (SAC 9985)
//     service      18  (default B2B services)
//
// Anything else returns 18 (the catch-all default-everything-else).
// PRD §3.1.2 / §3.1.3 — the master table will override these once
// FR-3.1 lands; defaults are operator-safe at launch.

const CATEGORY_RATES = {
  hotel: 12,
  flight: 5,
  transport: 5,
  visa: 18, // TODO: 0 once LUT context lands (FR-3.5.3 / Q-GST-4)
  tour_package: 5,
  service: 18,
};

const DEFAULT_RATE = 18;

/**
 * Round to 2 decimal places using half-up rounding.
 * Half-up matches operator-expected GST PDF rendering.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the CGST/SGST/IGST split for a single taxable amount.
 *
 * Intra-state supply → cgst + sgst (each half the rate), igst=0.
 * Inter-state supply → igst at the full rate, cgst=sgst=0.
 *
 * @param {object} args
 * @param {number} args.taxableAmount - pre-tax amount in rupees
 * @param {number} args.gstPercent    - total GST rate (e.g. 18 for 18%)
 * @param {boolean} args.isInterstate - true if operator+customer states differ
 * @returns {{cgst:number, sgst:number, igst:number, totalTax:number, gross:number}}
 */
function computeGstSplit({ taxableAmount, gstPercent, isInterstate }) {
  const amt = Number(taxableAmount) || 0;
  const rate = Number(gstPercent) || 0;
  const totalTax = round2((amt * rate) / 100);

  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  if (isInterstate) {
    igst = totalTax;
  } else {
    // Half-rate each. Compute from the rate (not from totalTax / 2)
    // so a 5% rate splits cleanly as 2.5% + 2.5% without compounding
    // rounding error on the halving step.
    const halfRate = rate / 2;
    cgst = round2((amt * halfRate) / 100);
    sgst = round2((amt * halfRate) / 100);
  }

  const gross = round2(amt + totalTax);
  return { cgst, sgst, igst, totalTax, gross };
}

/**
 * Compute GST across a list of line items, grouping per-rate buckets.
 * Each line carries its own gstPercent (composite-supply per FR-3.2.4 —
 * no "dominant rate winner", every line taxed at its own rate).
 *
 * @param {Array<{taxableAmount:number, gstPercent:number}>} lines
 * @param {boolean} isInterstate
 * @returns {{
 *   subtotal:number,
 *   buckets:Array<{gstPercent:number, cgst:number, sgst:number, igst:number, totalTax:number}>,
 *   totalCgst:number, totalSgst:number, totalIgst:number,
 *   totalTax:number, grandTotal:number
 * }}
 */
function computeGstForLines(lines, isInterstate) {
  const rows = Array.isArray(lines) ? lines : [];

  // Sum line-level taxable into per-rate buckets first, then compute
  // GST on the bucket total. This matches how GSTR-1 HSN-summary
  // groups (per FR-3.4.3) — per-rate aggregation, not per-line then
  // sum-of-rounded. Spec-aligned + reproducible.
  const bucketByRate = new Map();
  let subtotal = 0;

  for (const line of rows) {
    const amt = Number(line && line.taxableAmount) || 0;
    const rate = Number(line && line.gstPercent) || 0;
    subtotal = round2(subtotal + amt);
    const prev = bucketByRate.get(rate) || 0;
    bucketByRate.set(rate, round2(prev + amt));
  }

  const buckets = [];
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalTax = 0;

  // Stable rate-ascending order so the output is deterministic across
  // input permutations (NFR-4.2 reproducibility).
  const sortedRates = Array.from(bucketByRate.keys()).sort((a, b) => a - b);
  for (const rate of sortedRates) {
    const bucketAmt = bucketByRate.get(rate);
    const split = computeGstSplit({
      taxableAmount: bucketAmt,
      gstPercent: rate,
      isInterstate,
    });
    buckets.push({
      gstPercent: rate,
      cgst: split.cgst,
      sgst: split.sgst,
      igst: split.igst,
      totalTax: split.totalTax,
    });
    totalCgst = round2(totalCgst + split.cgst);
    totalSgst = round2(totalSgst + split.sgst);
    totalIgst = round2(totalIgst + split.igst);
    totalTax = round2(totalTax + split.totalTax);
  }

  const grandTotal = round2(subtotal + totalTax);
  return {
    subtotal,
    buckets,
    totalCgst,
    totalSgst,
    totalIgst,
    totalTax,
    grandTotal,
  };
}

/**
 * Decide whether the supply is inter-state (operator state != customer
 * state) given two ISO 3166-2 state codes. Both codes must be present
 * + non-empty; throws on missing input — the route layer is
 * responsible for catching + 400-ing.
 *
 * Comparison is case-insensitive after trimming, so "IN-MH" / "in-mh"
 * / " IN-MH " all compare equal.
 *
 * @param {string} operatorStateCode
 * @param {string} customerStateCode
 * @returns {boolean} true if codes differ; false if same
 */
function isInterstateSupply(operatorStateCode, customerStateCode) {
  if (operatorStateCode == null || customerStateCode == null) {
    throw new Error(
      "isInterstateSupply: both state codes are required (got null/undefined)"
    );
  }
  const op = String(operatorStateCode).trim().toUpperCase();
  const cu = String(customerStateCode).trim().toUpperCase();
  if (!op || !cu) {
    throw new Error(
      "isInterstateSupply: both state codes are required (got empty string)"
    );
  }
  return op !== cu;
}

/**
 * Returns the default GST rate for a given travel service category.
 * Unknown categories return 18 (catch-all default).
 *
 * @param {string} category - "hotel" | "flight" | "transport" | "visa" | "tour_package" | "service"
 * @returns {number}
 */
function gstRateForCategory(category) {
  if (category == null) return DEFAULT_RATE;
  const key = String(category).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATEGORY_RATES, key)) {
    return CATEGORY_RATES[key];
  }
  return DEFAULT_RATE;
}

module.exports = {
  computeGstSplit,
  computeGstForLines,
  isInterstateSupply,
  gstRateForCategory,
};
