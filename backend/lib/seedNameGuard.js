// #728 (item 1) — Seed-name guard helper.
//
// A pen-test pass found an XSS-string-named A/B Test campaign
// (`alert('xss') UI Test Campaign 🚀`) lingering in the Enhanced
// Wellness demo tenant. React escapes the name on render so it's not
// actually exploitable, but it's customer-visible chrome that doesn't
// belong in a demo. Root cause was a manual test run that submitted
// the row via the UI; subsequent re-seeds had no guard to reject the
// obvious fuzz patterns on insertion.
//
// This helper centralises the "is this an obviously-test / fuzz-input
// name?" check so every seed file (and any future bulk-create code
// path that ingests user-supplied names) can reuse it. The regex
// matches the three canonical XSS-string lead-ins; the explicit list
// catches the boilerplate test-prefix conventions used by the e2e
// suite (`E2E_*`, `TEST_*`, `_teardown_*`).
//
// Intentionally lenient — this is meant to catch demo / fuzz-input
// contamination, NOT to be a general XSS validator. The global
// sanitizeBody middleware in backend/middleware/security.js handles
// real XSS payloads on every API request; this is just a seed-time
// "don't let demo chrome look like a hacker pasted into our CRM"
// guard.

const SUSPECT_PATTERNS = [
  /^alert\(/i,        // alert('xss')
  /^<script/i,        // <script>...
  /^onerror=/i,       // onerror=alert(1)
  /^E2E_/,            // e2e-fixture prefix
  /^TEST_/,           // bulk test-data prefix
  /^_teardown_/,      // teardown-rollback prefix
  /^IsoTest /,        // tenant-isolation spec prefix
];

/**
 * Returns true when `name` looks like a test fixture / fuzz input
 * that should not appear in customer-visible demo data.
 *
 * @param {unknown} name - candidate name (Campaign.name, Pipeline.name, etc.)
 * @returns {boolean}
 */
function isSuspectSeedName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return SUSPECT_PATTERNS.some((re) => re.test(trimmed));
}

module.exports = { isSuspectSeedName, SUSPECT_PATTERNS };
