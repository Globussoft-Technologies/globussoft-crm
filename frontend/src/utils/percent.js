// Closes #639 — single source of truth for percent formatting.
//
// Pre-this-helper, conversion-rate renderings were inconsistent across
// surfaces: "0%" on the Marketplace Leads list (Math.round style),
// "0.0%" on the Funnel detail (.toFixed(1)), "0.00%" in CSV exports.
// Centralise on 1-decimal precision across every conversion-style stat
// so the same metric reads identically wherever it's rendered.
//
// Contract:
//   - null / undefined / NaN → "—" (em-dash placeholder, matches Funnel.fmtPct)
//   - 0 → "0.0%" (NOT "—") — 0% is a real value, distinct from "no data"
//   - decimals defaults to 1; callers can override (e.g. dashboards that
//     want whole-number-only percents).
//   - Accepts both raw numbers (12.5) and pre-stringified ("12.5") so it
//     can swallow backend payloads that already called .toFixed().

/**
 * Format a percent value consistently across the app.
 *
 * @param {number|string|null|undefined} value
 * @param {{ decimals?: number }} [opts]
 * @returns {string}
 */
export function formatPercent(value, opts = {}) {
  const { decimals = 1 } = opts;
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || Number.isNaN(num)) return '—';
  return `${num.toFixed(decimals)}%`;
}

export default formatPercent;
