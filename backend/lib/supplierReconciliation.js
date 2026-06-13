// PRD_TRAVEL_SUPPLIER_MASTER G044 (FR-3.4.a-c) — supplier-reconciliation
// auto-match math.
//
// Pure functions only — no Prisma, no I/O. The route handler
// (routes/travel_supplier_reconciliation.js) fetches the unmatched lines +
// candidate PoLines for the supplier-batch in question, feeds them to
// matchLines(), and writes the resulting decisions back.
//
// Match contract
// --------------
//   - Compare each unmatched recon line against the candidate PoLine pool
//     by `pnr` (case-insensitive, trimmed). Lines with no PNR are
//     skipped (returned as { decision: 'unmatched', reason: 'NO_PNR' }).
//   - When multiple PoLines share the same PNR, pick the one with the
//     LOWEST variance (|supplierAmount - lineTotal|).
//   - A candidate PoLine is accepted only when |variance| / supplierAmount
//     ≤ tolerancePct / 100. Otherwise leave the line `unmatched` with
//     reason 'OUT_OF_TOLERANCE'.
//   - PoLines once consumed by a match decision are NOT removed from the
//     pool — multiple recon lines may legitimately reference the same
//     PNR (e.g. partial payments). The lowest-variance pick is per-recon
//     line.
//
// Return shape
// ------------
//   matchLines(reconLines, poLines, tolerancePct) →
//     Array<{
//       reconLineId: number,           // from input
//       decision: 'auto_matched' | 'unmatched',
//       matchedPoLineId?: number,      // when decision='auto_matched'
//       varianceAmount?: number,       // signed: supplier - ours
//       reason?: 'NO_PNR' | 'NO_CANDIDATE' | 'OUT_OF_TOLERANCE',
//     }>
//
// Numerical contract
// ------------------
//   - All amounts are coerced via Number(); strings, Prisma Decimal values,
//     and JS numbers are all accepted. NaN / Infinity → treated as
//     missing (skipped).
//   - varianceAmount is rounded to 2 decimal places.
//   - tolerancePct = 0 means EXACT match required (variance must be 0).
//   - tolerancePct < 0 or non-finite → throws TypeError.

"use strict";

function toNum(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normPnr(p) {
  if (p == null) return null;
  const s = String(p).trim().toUpperCase();
  return s.length > 0 ? s : null;
}

/**
 * Build a Map<normalized-PNR, PoLine[]> from the candidate pool.
 * Exposed for unit-test introspection.
 */
function indexPoLinesByPnr(poLines) {
  const byPnr = new Map();
  if (!Array.isArray(poLines)) return byPnr;
  for (const line of poLines) {
    const pnr = normPnr(line && line.pnr);
    if (!pnr) continue;
    const arr = byPnr.get(pnr);
    if (arr) arr.push(line);
    else byPnr.set(pnr, [line]);
  }
  return byPnr;
}

/**
 * Decide auto-match outcomes for an array of unmatched reconciliation
 * lines against a pool of candidate PoLines.
 *
 * @param {Array} reconLines - { id, pnr, supplierAmount } shape
 * @param {Array} poLines - { id, pnr, lineTotal } shape
 * @param {number|string} tolerancePct - max abs(variance)/supplier as %
 * @returns {Array} decisions (see module docs)
 */
function matchLines(reconLines, poLines, tolerancePct) {
  const tol = toNum(tolerancePct);
  if (tol == null || tol < 0) {
    throw new TypeError(
      "tolerancePct must be a non-negative finite number",
    );
  }
  const byPnr = indexPoLinesByPnr(poLines);
  const decisions = [];
  for (const recon of Array.isArray(reconLines) ? reconLines : []) {
    const reconLineId = recon && recon.id;
    const pnr = normPnr(recon && recon.pnr);
    const supplierAmount = toNum(recon && recon.supplierAmount);
    if (pnr == null) {
      decisions.push({
        reconLineId,
        decision: "unmatched",
        reason: "NO_PNR",
      });
      continue;
    }
    if (supplierAmount == null) {
      decisions.push({
        reconLineId,
        decision: "unmatched",
        reason: "NO_PNR",
      });
      continue;
    }
    const candidates = byPnr.get(pnr) || [];
    if (candidates.length === 0) {
      decisions.push({
        reconLineId,
        decision: "unmatched",
        reason: "NO_CANDIDATE",
      });
      continue;
    }
    // Find the candidate with the lowest variance magnitude.
    let best = null;
    let bestAbs = Infinity;
    for (const cand of candidates) {
      const ourAmt = toNum(cand && cand.lineTotal);
      if (ourAmt == null) continue;
      const variance = supplierAmount - ourAmt;
      const absV = Math.abs(variance);
      if (absV < bestAbs) {
        bestAbs = absV;
        best = { cand, variance };
      }
    }
    if (best == null) {
      decisions.push({
        reconLineId,
        decision: "unmatched",
        reason: "NO_CANDIDATE",
      });
      continue;
    }
    // Tolerance check — relative-to-supplier-amount fraction.
    // supplierAmount=0 + variance=0 is exact (allowed); supplierAmount=0
    // + variance>0 is INF → out of tolerance (cannot be < tol).
    const denom = Math.abs(supplierAmount);
    const fractionPct =
      denom === 0
        ? bestAbs === 0
          ? 0
          : Infinity
        : (bestAbs / denom) * 100;
    if (fractionPct > tol) {
      decisions.push({
        reconLineId,
        decision: "unmatched",
        reason: "OUT_OF_TOLERANCE",
        varianceAmount: round2(best.variance),
        bestCandidatePoLineId: best.cand && best.cand.id,
      });
      continue;
    }
    decisions.push({
      reconLineId,
      decision: "auto_matched",
      matchedPoLineId: best.cand && best.cand.id,
      varianceAmount: round2(best.variance),
    });
  }
  return decisions;
}

/**
 * Sum a list of {supplierAmount} or {lineTotal} rows safely.
 * Used by the route to compute totalSupplierAmount / totalOursAmount
 * when a batch is created.
 */
function sumAmounts(rows, key) {
  let total = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = toNum(r && r[key]);
    if (n != null) total += n;
  }
  return round2(total);
}

module.exports = {
  matchLines,
  indexPoLinesByPnr,
  sumAmounts,
  // Test-only helpers (do not depend on these in route code).
  _internal: { toNum, round2, normPnr },
};
