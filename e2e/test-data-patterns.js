// @ts-check
/**
 * Single source of truth for test-data name patterns.
 *
 * Both `e2e/global-teardown.js` (post-suite scrub) and
 * `backend/scripts/scrub-test-data-pollution.js` (one-shot demo cleanup)
 * import from here so the regex can never drift.
 *
 * Why this exists (#405): the demo box on 2026-05-02 had ~150 polluted
 * rows with names that the teardown regex didn't match —
 * `PHI Audit Test Patient`, `Race Patient B …`, `Tenant B scoped E2E_FLOW_…`,
 * `Today's occupancy only N%`, `QA Form Branch`, `QA Test Branch`,
 * `Walk-in E2E_EXT_…`, `Priya Sharma E2E_FLOW_…`, etc. Every one slipped
 * past `^(E2E |E2E_FLOW_|E2E_AUDIT_|Coverage |…)`. By centralising the
 * patterns the next missing entry is a one-line fix in one place.
 *
 * Do NOT add patterns that could match a real customer name. Anchor at
 * start-of-string when possible. When unanchored, require a unique
 * test-only marker (E2E_, _17[67]\d{10}, @example.test, etc.).
 */

// Test-only NAME / TITLE markers. Used against:
//   Patient.name, Contact.name, Service.name, Estimate.title,
//   EmailMessage.subject, Task.title, Location.name, AgentRecommendation.goal
const TEST_NAME_PATTERNS = [
  // Tagged-prefix patterns (every test using a RUN_TAG ends up here)
  /^E2E /,
  /^E2E_FLOW_/,
  /^E2E_AUDIT_/,
  /^E2E_RBAC_/,
  /^E2E_WC_/,
  /^E2E_EXT_/,
  /^E2E_PB_/,
  /^E2E_SVC_/,
  /^E2E_FLOW_LEDGER_/,
  /^E2E_FLOW_ATT_/,
  /^E2E_FLOW_LEAVE_/,
  /^Coverage /,

  // Embedded-tag patterns (test prefixes a real-looking name with the tag)
  / E2E /,
  / E2E_FLOW_/,
  / E2E_RBAC_/,
  / E2E_EXT_/,

  // Stamped-prefix names (6-digit stamp) — older specs
  /^Loyalty [0-9]{6}/,
  /^Referrer [0-9]{6}/,
  /^Waitlist [0-9]{6}/,
  /^Lifecycle [0-9]{6}/,
  /^Lifecycle_/,
  /^Friend [0-9]{6}/,
  /^Junk [0-9]{6}/,
  /^Junk_/,
  /^Telecaller Queue Lead [0-9]{6}/,

  // Concurrency / RBAC / audit / cross-tenant test fixture names
  /^Race Patient/,
  /^Race Visit Patient/,
  /^PHI Audit/,
  /^Tenant B scoped/,
  /^Walk-in E2E_EXT_/,
  /^Priya Sharma E2E_/,
  /^Aarav Sharma E2E_/,
  /^Aarav Nair /,

  // Misc spec-debris names
  /^Test /,
  /CRM Test/i,
  /^Dedupe /i,
  /^Playwright/i,
  /^QA Form /,
  /^QA Test /,
  /^smoke-test$/,
  /^smoke-test_/,

  // #403/#405 follow-up — rename-on-cleanup marker.
  // The G-20 tenant-isolation spec (commit 04e5b56) and several wellness specs
  // rename created rows to `_teardown_<area>_<id>` instead of hard-deleting,
  // because the rows have FK chains (Patient → Visit → Rx → Consent) that a
  // hard delete would orphan. The marker prefix is what teardown-completeness
  // and demo-hygiene assert on. Demo-monitor sees the prefix and ignores the
  // rows — but the scrub script (run by e2e-full's scrub-demo job) needs to
  // actually DELETE them, otherwise they pile up forever and surface as
  // demo pollution (the QA-reported `_teardown_iso_*`, `_teardown_g6_*`,
  // `_teardown_wc_loc_*` rows on /wellness/patients + /wellness/locations on
  // 2026-05-04). The Patient cascade is safe because every related row is
  // also test data created in the same spec.
  /^_teardown_/,

  // Orchestrator/recommendation spam — task title fan-out from
  // duplicate AgentRecommendation rows. Orchestrator emits ONE row but
  // the cron loop has historically fanned out to 9. Anchor on the exact
  // generated phrasing so a real task with the word "occupancy" survives.
  /^Today's occupancy only /,
  /^Q3 Renewal Call 17/,

  // 13-digit unix-ms timestamp suffix (1.7..xxxxxxxxxxx covers 2025–2027)
  / 17[67]\d{10,11}$/,

  // Single-character / known-ephemera task titles seen on demo
  /^qa$/i,
  /^far$/i,
];

// Test-only EMAIL / IDENTIFIER markers. Used against:
//   Contact.email, User.email (where applicable), Patient.email,
//   ApiKey.label
const TEST_EMAIL_PATTERNS = [
  /@example\.test$/i,
  /@example\.in$/i,
  /@inbound\.local$/i,
  /@racecond\.test$/i,
  /@e2e\.test$/i,
  /@test\.local$/i,
  /^e2e[-_]/i,
  /^e2e-ext-1[67]/i,
  /^dup-/i,
  /^valid-17[67]\d/,
  /\.e2e_(flow|audit|rbac)_/i,
];

// Service.description sentinel used by the wellness real-user-journeys spec.
const TEST_SERVICE_DESCRIPTION_LIKE = '%wellness-real-user-journeys%';

// Build a SQL REGEXP-friendly OR string from the JS regex array. Strips
// the leading `/^` / trailing `/` and the case-insensitive flag where
// safe — MySQL REGEXP is case-insensitive by default for utf8mb4 with a
// _ci collation, which is what this DB uses. Patterns that need
// case-folding (i.e. CRM Test) ride that default; patterns with special
// chars get left alone.
function toSqlOrAlternation(patterns) {
  return patterns
    .map((re) => {
      // Strip the JS regex wrapping. RegExp.toString() returns "/foo/i".
      const s = re.toString();
      const m = s.match(/^\/(.*)\/[gimsuy]*$/);
      return m ? m[1] : s;
    })
    .join('|');
}

const NAME_REGEX_SQL = toSqlOrAlternation(TEST_NAME_PATTERNS);
const EMAIL_REGEX_SQL = toSqlOrAlternation(TEST_EMAIL_PATTERNS);

module.exports = {
  TEST_NAME_PATTERNS,
  TEST_EMAIL_PATTERNS,
  TEST_SERVICE_DESCRIPTION_LIKE,
  NAME_REGEX_SQL,
  EMAIL_REGEX_SQL,
  toSqlOrAlternation,
};
