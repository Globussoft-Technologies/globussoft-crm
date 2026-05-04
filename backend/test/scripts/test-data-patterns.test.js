// @ts-check
/**
 * Unit tests for e2e/test-data-patterns.js — the single source of truth for
 * test-data name/email markers that:
 *   1. e2e/global-teardown.js scrubs after every CI suite run, AND
 *   2. backend/scripts/scrub-test-data-pollution.js scrubs from demo via the
 *      e2e-full.yml post-matrix scrub-demo job.
 *
 * Why this test exists (#403/#405):
 *   The QA pass on 2026-05-04 found `_teardown_iso_*`, `_teardown_g6_*`, and
 *   `_teardown_wc_loc_*` rows accumulating on the demo's wellness tenant —
 *   leftovers from G-20 tenant-isolation specs, G-6 appointment-reminders
 *   specs, and wellness-clinical specs that use the rename-on-cleanup pattern
 *   (rename to `_teardown_<area>_<id>` instead of hard-deleting because
 *   Patient → Visit → Rx → Consent FK chains would orphan on hard delete).
 *   The marker prefix was added in commit 04e5b56 specifically so demo-monitor
 *   would ignore those rows — but the scrub script's pattern list was never
 *   updated to actually DELETE them, so they piled up forever.
 *
 *   This test pins the canonical patterns:
 *     - matches every known pollution shape (positive cases)
 *     - does NOT match real customer / clinical names (negative cases)
 *     - explicitly covers the _teardown_ rename marker so the gap that
 *       caused #403/#405 cannot reopen
 *
 *   The test runs in the BACKEND vitest gate so a future refactor of
 *   e2e/test-data-patterns.js that drops a pattern fails CI immediately.
 */
import { describe, test, expect } from 'vitest';
import {
  TEST_NAME_PATTERNS,
  TEST_EMAIL_PATTERNS,
} from '../../../e2e/test-data-patterns.js';

const isTestName = (s) =>
  typeof s === 'string' && s.length > 0 && TEST_NAME_PATTERNS.some((p) => p.test(s));
const isTestEmail = (s) =>
  typeof s === 'string' && s.length > 0 && TEST_EMAIL_PATTERNS.some((p) => p.test(s));

describe('TEST_NAME_PATTERNS — must catch every shape #405 listed', () => {
  // Each table row reflects a real polluted row observed on demo. Adding a new
  // row here = pinning a name shape. Removing one = explicitly accepting
  // it might leak.
  const POSITIVE_CASES = [
    // Tagged-prefix patterns (every spec using a RUN_TAG)
    ['E2E Patient 422650',                   'tagged ^E2E '],
    ['E2E_FLOW_154491',                      'tagged ^E2E_FLOW_'],
    ['E2E_RBAC_1777717414554',               'tagged ^E2E_RBAC_'],
    ['E2E_AUDIT_1777717414554',              'tagged ^E2E_AUDIT_'],
    ['E2E_WC_1777717299158',                 'tagged ^E2E_WC_'],
    ['E2E_EXT_1777012274020',                'tagged ^E2E_EXT_'],
    ['Coverage Patient 1777012274020',       'tagged ^Coverage '],

    // Embedded-tag patterns (real-looking name + tag)
    ['Walk-in E2E_EXT_1777012274020',        'embedded E2E_EXT_'],
    ['Priya Sharma E2E_FLOW_1777012274020',  'embedded E2E_FLOW_'],
    ['Aarav Sharma E2E_FLOW_1777012274020',  'embedded E2E_FLOW_'],

    // Stamped-prefix names
    ['Loyalty 425205',                       'Loyalty <6digit>'],
    ['Lifecycle 425205',                     'Lifecycle <6digit>'],
    ['Lifecycle_1777717414554',              'Lifecycle_'],
    ['Junk 425205',                          'Junk <6digit>'],
    ['Junk_1777717414554',                   'Junk_'],
    ['Telecaller Queue Lead 424344',         'Telecaller Queue Lead <6digit>'],
    ['Friend 425205',                        'Friend <6digit>'],
    ['Waitlist 425205',                      'Waitlist <6digit>'],
    ['Referrer 425205',                      'Referrer <6digit>'],

    // Concurrency / RBAC / audit / cross-tenant test fixture names
    ['Race Patient B 1777717403768',         'Race Patient'],
    ['Race Visit Patient 1777717401522',     'Race Visit Patient'],
    ['PHI Audit Test Patient',               'PHI Audit'],
    ['Tenant B scoped E2E_FLOW_154491',      'Tenant B scoped'],

    // Misc spec-debris names
    ['Test Patient 001 1777012274020',       '^Test '],
    ['CRM Test Branch 1777012274020',        'CRM Test (case-insensitive)'],
    ['Dedupe Race',                          '^Dedupe '],
    ['Playwright Test 1777012274020',        '^Playwright'],
    ['QA Form Branch',                       '^QA Form '],
    ['QA Test Branch',                       '^QA Test '],
    ['smoke-test',                           'smoke-test exact'],
    ['smoke-test_1777012274020',             'smoke-test_'],

    // Orchestrator fan-out spam
    ["Today's occupancy only 1%",            'occupancy fan-out'],
    ['Q3 Renewal Call 1777012274020',        'Q3 Renewal Call <stamp>'],

    // 13-digit unix-ms timestamp suffix
    ['Some Real Name 1777012274020',         'trailing 13-digit timestamp'],

    // Single-character / ephemera task titles
    ['qa',                                   'qa exact'],
    ['far',                                  'far exact'],

    // #403/#405 follow-up — _teardown_ rename marker. THIS is the gap that
    // caused the most recent regression. Without these rows in the pattern
    // list, the scrub script ran cleanly but didn't touch the renamed rows,
    // so they piled up on demo for weeks.
    ['_teardown_iso_1630',                   '_teardown_iso_'],
    ['_teardown_iso_fk_patient_1629',        '_teardown_iso_fk_patient_'],
    ['_teardown_g6_1564',                    '_teardown_g6_'],
    ['_teardown_wc_loc_104',                 '_teardown_wc_loc_'],
    ['_teardown_leak_999',                   '_teardown_leak_ (#426 spec)'],
  ];

  test.each(POSITIVE_CASES)('matches %s (%s)', (name, _label) => {
    expect(isTestName(name), `"${name}" should be flagged as test data`).toBe(true);
  });
});

describe('TEST_NAME_PATTERNS — must NOT match real customer / clinical names', () => {
  // Anti-cases — names that look real and must survive the scrub. If a real
  // customer ever happens to be called any of these, they'd be deleted on
  // every e2e-full run. Anchor patterns conservatively to keep this list
  // honest.
  const NEGATIVE_CASES = [
    'Aarav Patel',
    'Priya Sharma',                          // legit Indian customer name
    'Kavita Reddy',                          // dedup target, but the bare name is real
    'Sneha Iyer',
    'Rishu Singh',                           // the actual demo Owner persona
    'Dr. Harsh',
    'CRMNext Solutions',                     // no leading "Test" — real-sounding company
    'Hair Transplant (FUE)',                 // service catalog
    'Botox Treatment',
    'Q3 sales pipeline',                     // no Renewal Call prefix
    'occupancy report draft',                // no leading "Today's"
    'Customer Service Quality Audit',        // not "PHI Audit"
    "Today's revenue summary",               // no "occupancy only"
    'East Region',                           // territory name
    'Sumit Ghosh',                           // QA team member's name
    'Race condition for SLA',                // not "Race Patient/Visit Patient"
    'Sunday Operations',
    'Far away clinic',                       // not bare "far"
    '',                                      // empty / null guard
  ];

  test.each(NEGATIVE_CASES)('does NOT flag %s', (name) => {
    expect(isTestName(name), `"${name}" must NOT be flagged as test data`).toBe(false);
  });
});

describe('TEST_EMAIL_PATTERNS', () => {
  const POSITIVE_EMAILS = [
    'q3-test@example.test',
    'lead@example.in',
    'inbound@inbound.local',
    'race@racecond.test',
    'flow@e2e.test',
    'qa-mass@test.local',
    'e2e-ext-1777012274020@test.local',
    'e2e_flow_qa@example.com',
    'dup-1@example.com',
    'valid-1777012274020@example.com',
  ];

  const NEGATIVE_EMAILS = [
    'rishu@enhancedwellness.in',
    'admin@globussoft.com',
    'priya.sharma@gmail.com',
    'support@drharors.com',
    'hello@example.org',                      // not .test or .in
    '',                                       // empty / null guard
  ];

  test.each(POSITIVE_EMAILS)('flags %s as test email', (email) => {
    expect(isTestEmail(email), `"${email}" should be flagged`).toBe(true);
  });

  test.each(NEGATIVE_EMAILS)('does NOT flag %s', (email) => {
    expect(isTestEmail(email), `"${email}" must NOT be flagged`).toBe(false);
  });
});
