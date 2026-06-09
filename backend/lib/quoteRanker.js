// Travel CRM — unified quote ranker.
//
// Pure function: takes an array of provider quotes (each with
// { provider, price, supplierRating?, cancellationPolicy, ... }) and
// returns them sorted descending by a weighted composite 0-100 score
// (higher = better), each enriched with `rank` (1-based) + `rankScore`.
//
// Per PRD_RATEHAWK_INTEGRATION FR-6 + DC-4 — ranker is the same
// pure-math discipline as travelPricing.js so refund-dispute replay
// reproduces yesterday's ranking bit-for-bit a year from now. No DB,
// no fetch.
//
// Composite axes:
//   - price (default 50%) — LOWER is better; normalised by min/max.
//   - supplierRating (default 25%) — HIGHER is better; assumed 0-5 scale.
//   - cancellationFlex (default 25%) — FREE_CANCEL > PARTIAL >
//     NON_REFUNDABLE; mapped to 1.0 / 0.5 / 0.0.
//
// Tie-break: original input order (stable sort).
//
// See docs/PRD_RATEHAWK_INTEGRATION.md §3 FR-6, §5.2 DC-4.

const DEFAULT_WEIGHTS = {
  price: 50,
  supplierRating: 25,
  cancellationFlex: 25,
};

// Cancellation-policy → flex score (0-1). Unknown / missing values
// collapse to a neutral 0.5 so a missing policy doesn't auto-win or
// auto-lose against a NON_REFUNDABLE peer.
const CANCEL_FLEX_SCORES = {
  FREE_CANCEL: 1.0,
  PARTIAL: 0.5,
  NON_REFUNDABLE: 0.0,
};

function _cancelScore(policy) {
  if (policy == null || policy === "") return 0.5;
  const key = String(policy).toUpperCase();
  if (key in CANCEL_FLEX_SCORES) return CANCEL_FLEX_SCORES[key];
  return 0.5;
}

function _safeNumber(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/**
 * Normalize a numeric axis to 0-1.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {boolean} lowerIsBetter
 */
function _normalize(value, min, max, lowerIsBetter) {
  if (max === min) return 1.0; // all rows identical on this axis → neutral
  const t = (value - min) / (max - min);
  return lowerIsBetter ? 1 - t : t;
}

/**
 * Rank a list of provider quotes.
 *
 * @param {Array<Object>} quotes
 * @param {Object} [opts]
 * @param {Object} [opts.weights] partial override of DEFAULT_WEIGHTS
 * @returns {Array<Object>} new array, sorted by composite desc, each
 *   row carrying `rank: 1..N` + `rankScore: 0..100` (rounded to 2 dp).
 */
function rankQuotes(quotes, opts = {}) {
  if (!Array.isArray(quotes) || quotes.length === 0) return [];

  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  // Weight-sum normaliser so caller-supplied weights of any magnitude
  // still produce a 0-100 composite — passes the "weights={price:100}"
  // pure-price-sort test deterministically.
  const weightSum =
    _safeNumber(weights.price, 0) +
    _safeNumber(weights.supplierRating, 0) +
    _safeNumber(weights.cancellationFlex, 0);

  if (weightSum <= 0) {
    // All weights zero / negative → degenerate; preserve input order
    // with zero scores so the caller still gets a sensible response.
    return quotes.map((q, i) => ({ ...q, rank: i + 1, rankScore: 0 }));
  }

  // Compute the per-axis min/max bounds for normalisation.
  const prices = quotes.map((q) => _safeNumber(q.price, 0));
  const ratings = quotes.map((q) => _safeNumber(q.supplierRating, 0));
  const flexes = quotes.map((q) => _cancelScore(q.cancellationPolicy));

  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  const ratingMin = Math.min(...ratings);
  const ratingMax = Math.max(...ratings);
  const flexMin = Math.min(...flexes);
  const flexMax = Math.max(...flexes);

  // Enrich each row with its composite 0-100 score, preserving original
  // index for stable tie-break.
  const enriched = quotes.map((q, originalIndex) => {
    const priceN = _normalize(
      _safeNumber(q.price, 0),
      priceMin,
      priceMax,
      true,
    );
    const ratingN = _normalize(
      _safeNumber(q.supplierRating, 0),
      ratingMin,
      ratingMax,
      false,
    );
    const flexN = _normalize(
      _cancelScore(q.cancellationPolicy),
      flexMin,
      flexMax,
      false,
    );

    const wPrice = _safeNumber(weights.price, 0);
    const wRating = _safeNumber(weights.supplierRating, 0);
    const wFlex = _safeNumber(weights.cancellationFlex, 0);

    const composite =
      (priceN * wPrice + ratingN * wRating + flexN * wFlex) / weightSum;
    // Multiply to 0-100 then round to 2 dp so the JSON envelope is
    // human-readable + the test suite can pin equality without
    // floating-point drift.
    const rankScore = Math.round(composite * 10000) / 100;

    return { quote: q, rankScore, originalIndex };
  });

  // Sort descending by score; stable tie-break on original index so the
  // input order survives across identical scores.
  enriched.sort((a, b) => {
    if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
    return a.originalIndex - b.originalIndex;
  });

  return enriched.map((row, i) => ({
    ...row.quote,
    rankScore: row.rankScore,
    rank: i + 1,
  }));
}

module.exports = { rankQuotes, DEFAULT_WEIGHTS, CANCEL_FLEX_SCORES };
