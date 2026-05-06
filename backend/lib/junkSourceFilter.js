/**
 * Junk-source filter — server-side guard for marketing/attribution reports.
 *
 * Closes #268. Original symptom (P3 demo bug): the wellness Marketing Attribution
 * tab on the demo box exposed `test-skip` and `test-junk` source rows alongside
 * legit sources (whatsapp, website-form, organic, etc.). The April 2026
 * `cleanup-p3-data-quality.js` one-shot remapped existing rows to `'other'`,
 * but did NOT prevent the same junk source values from re-entering the
 * tenant via the External Partner API or the embed widget — every wellness
 * E2E spec creates contacts with `source: 'test-skip'` or `source: 'test-junk'`
 * (see `e2e/tests/wellness-deep.spec.js:386` + `wellness.spec.js:507`), and on
 * cross-machine `e2e-full` runs against demo, those linger between teardown
 * cycles and re-pollute the demo screenshot until the next manual scrub.
 *
 * This module is the cheap, deterministic, server-side guard that filters
 * those values out at REPORT time — independent of whether the cleanup script
 * has been re-run. Pairs with the existing `leadJunkFilter.js` (which gates
 * INGESTION); this one gates VISIBILITY.
 *
 * Filter is **case-insensitive** because the External API doesn't lowercase
 * source values before persisting (`POST /api/v1/external/leads` accepts
 * `'Test-Skip'` / `'TEST-JUNK'` verbatim). Prefix-match on the canonical test
 * stems so future variants (`test-foo`, `e2e-bar`, `rbac-baz`) get filtered too —
 * matches the original issue's suggested fix exactly: source IN ('test-%',
 * 'e2e-%', 'rbac-%').
 *
 * Used by:
 *   - backend/routes/attribution.js  (GET /report — touchpoint aggregation)
 *   - backend/routes/wellness.js     (computeAttribution — wellness reports)
 */

// Canonical exact-match list (the four values the cleanup script targeted) —
// kept for backward-compat / unit-test pinning. Prefix matching below is the
// real filter.
const JUNK_SOURCE_EXACT = ["test-skip", "test-junk", "e2e-test", "qa-test"];

// Prefix stems — covers every variant the seeds + e2e suite + RBAC tests
// have ever introduced. Lowercased for case-insensitive comparison.
const JUNK_SOURCE_PREFIXES = ["test-", "e2e-", "qa-", "rbac-"];

/**
 * Returns true if the given source string should be filtered out of
 * marketing/attribution reports.
 *
 * Treats null / undefined / empty / non-string as "not junk" — the report
 * already buckets those into 'unknown' and the operator should still see them
 * (they represent leads with no UTM tagging, which is a real signal).
 */
function isJunkSource(source) {
  if (typeof source !== "string") return false;
  const s = source.trim().toLowerCase();
  if (!s) return false;
  if (JUNK_SOURCE_EXACT.includes(s)) return true;
  for (const p of JUNK_SOURCE_PREFIXES) {
    if (s.startsWith(p)) return true;
  }
  return false;
}

module.exports = {
  isJunkSource,
  JUNK_SOURCE_EXACT,
  JUNK_SOURCE_PREFIXES,
};
