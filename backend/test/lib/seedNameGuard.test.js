// Unit tests for backend/lib/seedNameGuard.js
//
// Closes #728 (item 1) — seed-time guard rejecting obviously-test /
// XSS-string fixture names from sliding into customer-visible demo
// data on re-seed.
//
// The guard is intentionally lenient — it's a "is this row clearly
// fuzz / e2e debris?" check, NOT a general XSS validator. Real XSS
// payloads are stripped by sanitizeBody middleware at request time.
// What this guard catches is the manual-test-leftover class:
// `alert('xss') UI Test Campaign` typed into the UI by a tester,
// `E2E_*` rows from a crashed e2e teardown, `_teardown_*` rollbacks,
// `IsoTest *` tenant-isolation specs.
import { describe, test, expect } from 'vitest';

const { isSuspectSeedName, SUSPECT_PATTERNS } = await import(
  '../../lib/seedNameGuard.js'
);

describe('seedNameGuard — isSuspectSeedName', () => {
  // ── XSS-string fuzz inputs ───────────────────────────────────────
  test('rejects the canonical pen-test alert() name (#728 item 1)', () => {
    expect(isSuspectSeedName("alert('xss') UI Test Campaign 🚀")).toBe(true);
  });

  test('rejects bare alert(...)', () => {
    expect(isSuspectSeedName('alert(1)')).toBe(true);
    expect(isSuspectSeedName('ALERT(1)')).toBe(true); // case-insensitive
  });

  test('rejects <script>...</script> lead-ins', () => {
    expect(isSuspectSeedName('<script>alert(1)</script>')).toBe(true);
    expect(isSuspectSeedName('<SCRIPT src=x.js>')).toBe(true);
  });

  test('rejects onerror= handler injection', () => {
    expect(isSuspectSeedName('onerror=alert(1)')).toBe(true);
    expect(isSuspectSeedName('ONERROR=alert(1)')).toBe(true);
  });

  // ── E2E test-fixture prefixes ────────────────────────────────────
  test('rejects E2E_* fixture prefix', () => {
    expect(isSuspectSeedName('E2E_PSD_12345')).toBe(true);
    expect(isSuspectSeedName('E2E_FLOW_signup')).toBe(true);
  });

  test('rejects TEST_* bulk-fixture prefix', () => {
    expect(isSuspectSeedName('TEST_lead_123')).toBe(true);
  });

  test('rejects _teardown_* rollback prefix', () => {
    expect(isSuspectSeedName('_teardown_csv_1715000000')).toBe(true);
  });

  test('rejects IsoTest tenant-isolation prefix', () => {
    expect(isSuspectSeedName('IsoTest Estimate E2E_ISO_42')).toBe(true);
  });

  // ── Legitimate customer-visible names ────────────────────────────
  test('accepts a normal marketing-campaign name', () => {
    expect(isSuspectSeedName('Q2 2026 Feature Announcement')).toBe(false);
    expect(isSuspectSeedName('Partner Referral Program Q2')).toBe(false);
    expect(isSuspectSeedName('Holiday Season Nurture Sequence')).toBe(false);
  });

  test('accepts names containing the word "test" mid-string', () => {
    // The guard pins lead-in prefixes, so "Beta Test Campaign" survives.
    expect(isSuspectSeedName('Beta Test Campaign')).toBe(false);
    expect(isSuspectSeedName('A/B Test: Q4 Launch')).toBe(false);
  });

  test('accepts names with emoji and non-ASCII (the suffix on the #728 row was incidental)', () => {
    expect(isSuspectSeedName('Q1 Launch 🚀')).toBe(false);
    expect(isSuspectSeedName('Diwali Sale २०२६')).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────────────────
  test('non-string input is not "suspect"', () => {
    expect(isSuspectSeedName(null)).toBe(false);
    expect(isSuspectSeedName(undefined)).toBe(false);
    expect(isSuspectSeedName(123)).toBe(false);
    expect(isSuspectSeedName({})).toBe(false);
  });

  test('empty / whitespace-only string is not "suspect"', () => {
    // The seed loop has its own required-name validation; this guard
    // only fires on positively-suspect strings.
    expect(isSuspectSeedName('')).toBe(false);
    expect(isSuspectSeedName('   ')).toBe(false);
  });

  test('leading whitespace does not bypass the prefix check', () => {
    // The XSS attacker's first move is `  alert(1)` to bypass naive
    // ^startsWith checks. The helper trims first.
    expect(isSuspectSeedName("   alert('xss')")).toBe(true);
    expect(isSuspectSeedName('\t<script>x</script>')).toBe(true);
  });

  test('SUSPECT_PATTERNS export is non-empty (smoke test for future extensions)', () => {
    expect(Array.isArray(SUSPECT_PATTERNS)).toBe(true);
    expect(SUSPECT_PATTERNS.length).toBeGreaterThanOrEqual(7);
    for (const re of SUSPECT_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});
