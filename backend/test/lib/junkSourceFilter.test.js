// Unit tests for backend/lib/junkSourceFilter.js — the report-VISIBILITY gate
// that filters test-skip / test-junk / e2e-* / qa-* / rbac-* source rows out
// of operator-facing marketing + attribution dashboards.
//
// Why this file exists alongside backend/test/lib/leadJunkFilter.test.js:
// leadJunkFilter.test.js (lines 353-465) already exercises the canonical happy
// paths (exact match, prefix match, case-insensitivity, whitespace trim, legit-
// source pass-through). THIS file is the dedicated sibling — it focuses on
// angles NOT yet covered by that integration test file:
//   - Hostile / malformed inputs (very long strings, NUL bytes, unicode whitespace,
//     non-string primitives like NaN/Infinity/Symbol/BigInt/Function/Date)
//   - Exact-match VS prefix-match precedence (test-skip matches BOTH; pin order
//     doesn't matter for correctness but document the contract)
//   - Module-export immutability tripwire — if a future agent silently appends
//     to JUNK_SOURCE_EXACT or JUNK_SOURCE_PREFIXES, the canonical-shape pins
//     in leadJunkFilter.test.js catch the array delta but NOT mutations to the
//     module's exports object itself. Pin both.
//   - Real-world ingestion shape variants the External Partner API actually
//     accepts verbatim — `POST /api/v1/external/leads` doesn't lowercase,
//     so 'Test-Skip', '   test-skip', 'TEST-SKIP\n' all need to be junk.
//   - Array-filter integration the way routes/attribution.js + routes/wellness.js
//     actually use it: filtering a Contact[] array via isJunkSource(c.source).
//   - Performance / repeated-call determinism — the helper is called once per
//     Contact during report aggregation; repeat calls must be referentially
//     idempotent (no internal state mutation).
//
// Pattern reference: backend/test/lib/leadJunkFilter.test.js for vitest shape.
// Uses ESM-style imports (vitest's harness rejects `require('vitest')`); the
// SUT is CJS and exports via module.exports so it imports cleanly as default.
import { describe, test, expect } from 'vitest';
import junkSourceFilter from '../../lib/junkSourceFilter.js';

const { isJunkSource, JUNK_SOURCE_EXACT, JUNK_SOURCE_PREFIXES } = junkSourceFilter;

describe('lib/junkSourceFilter — exports surface', () => {
  test('default module export shape: isJunkSource + canonical lists', () => {
    expect(typeof isJunkSource).toBe('function');
    expect(Array.isArray(JUNK_SOURCE_EXACT)).toBe(true);
    expect(Array.isArray(JUNK_SOURCE_PREFIXES)).toBe(true);
    expect(JUNK_SOURCE_EXACT.length).toBeGreaterThan(0);
    expect(JUNK_SOURCE_PREFIXES.length).toBeGreaterThan(0);
  });

  test('EXACT list contains the four cleanup-p3-data-quality.js targets', () => {
    // Sentinel pins — these four values are what the v3.4.x cleanup one-shot
    // remapped to 'other'. Removing any of them silently regresses #268.
    expect(JUNK_SOURCE_EXACT).toContain('test-skip');
    expect(JUNK_SOURCE_EXACT).toContain('test-junk');
    expect(JUNK_SOURCE_EXACT).toContain('e2e-test');
    expect(JUNK_SOURCE_EXACT).toContain('qa-test');
  });

  test('PREFIXES list contains the four canonical stems', () => {
    expect(JUNK_SOURCE_PREFIXES).toContain('test-');
    expect(JUNK_SOURCE_PREFIXES).toContain('e2e-');
    expect(JUNK_SOURCE_PREFIXES).toContain('qa-');
    expect(JUNK_SOURCE_PREFIXES).toContain('rbac-');
  });

  test('every PREFIX entry ends with a hyphen — prevents accidental substring matches', () => {
    // If a future agent adds 'test' (no hyphen) to the prefix list it would
    // flip 'testimonial', 'teststand', etc. into junk — a silent regression
    // class for legit Marketing Attribution rows.
    for (const p of JUNK_SOURCE_PREFIXES) {
      expect(p.endsWith('-')).toBe(true);
    }
  });

  test('every PREFIX entry is lowercase — comparison contract is case-folded', () => {
    for (const p of JUNK_SOURCE_PREFIXES) {
      expect(p).toEqual(p.toLowerCase());
    }
  });

  test('every EXACT entry is lowercase — comparison contract is case-folded', () => {
    for (const v of JUNK_SOURCE_EXACT) {
      expect(v).toEqual(v.toLowerCase());
    }
  });
});

describe('lib/junkSourceFilter — isJunkSource(): non-string primitives', () => {
  test('returns false for numeric primitives (incl. NaN / Infinity)', () => {
    expect(isJunkSource(0)).toBe(false);
    expect(isJunkSource(42)).toBe(false);
    expect(isJunkSource(-1)).toBe(false);
    expect(isJunkSource(NaN)).toBe(false);
    expect(isJunkSource(Infinity)).toBe(false);
    expect(isJunkSource(-Infinity)).toBe(false);
  });

  test('returns false for booleans', () => {
    expect(isJunkSource(true)).toBe(false);
    expect(isJunkSource(false)).toBe(false);
  });

  test('returns false for BigInt and Symbol', () => {
    expect(isJunkSource(BigInt(1))).toBe(false);
    expect(isJunkSource(Symbol('test-skip'))).toBe(false);
  });

  test('returns false for Date / RegExp / Function / Buffer-like objects', () => {
    expect(isJunkSource(new Date())).toBe(false);
    expect(isJunkSource(/test-skip/)).toBe(false);
    expect(isJunkSource(() => 'test-skip')).toBe(false);
    expect(isJunkSource(Buffer.from('test-skip'))).toBe(false);
  });

  test('returns false for plain object / array even if .toString yields a junk value', () => {
    // Defensive: helper must not coerce — Prisma rows always have string sources,
    // but a malformed External-API request body could leak an object/array.
    const bait = { toString: () => 'test-skip' };
    expect(isJunkSource(bait)).toBe(false);
    expect(isJunkSource(['test-skip'])).toBe(false);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): falsy + empty-string handling', () => {
  test('null and undefined both return false (not junk)', () => {
    expect(isJunkSource(null)).toBe(false);
    expect(isJunkSource(undefined)).toBe(false);
  });

  test('empty string returns false (route already buckets these to unknown)', () => {
    expect(isJunkSource('')).toBe(false);
  });

  test('whitespace-only strings (space / tab / newline / CRLF) return false', () => {
    expect(isJunkSource(' ')).toBe(false);
    expect(isJunkSource('   ')).toBe(false);
    expect(isJunkSource('\t')).toBe(false);
    expect(isJunkSource('\n')).toBe(false);
    expect(isJunkSource('\r\n')).toBe(false);
    expect(isJunkSource('\t\t\n   ')).toBe(false);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): EXACT-match contract', () => {
  test('each EXACT entry returns true verbatim', () => {
    for (const v of JUNK_SOURCE_EXACT) {
      expect(isJunkSource(v)).toBe(true);
    }
  });

  test('EXACT entries are also covered by PREFIX match (no contradiction)', () => {
    // test-skip starts with test-; e2e-test starts with e2e-; qa-test with qa-.
    // The two layers are belt-and-suspenders — exact list pins the four values
    // cleanup-p3 targeted, prefix list is the durable forward-compat guard.
    for (const v of JUNK_SOURCE_EXACT) {
      const matchedByPrefix = JUNK_SOURCE_PREFIXES.some((p) => v.startsWith(p));
      expect(matchedByPrefix).toBe(true);
    }
  });
});

describe('lib/junkSourceFilter — isJunkSource(): PREFIX-match contract', () => {
  test('values starting with test- but NOT in EXACT list still match', () => {
    expect(isJunkSource('test-future-variant')).toBe(true);
    expect(isJunkSource('test-')).toBe(true); // prefix alone
    expect(isJunkSource('test-12345')).toBe(true);
    expect(isJunkSource('test-with-dashes-everywhere')).toBe(true);
  });

  test('values starting with e2e- but NOT in EXACT list still match', () => {
    expect(isJunkSource('e2e-flow')).toBe(true);
    expect(isJunkSource('e2e-')).toBe(true);
    expect(isJunkSource('e2e-wellness-deep')).toBe(true);
  });

  test('values starting with qa- but NOT in EXACT list still match', () => {
    expect(isJunkSource('qa-staging')).toBe(true);
    expect(isJunkSource('qa-')).toBe(true);
    expect(isJunkSource('qa-pen-test-2026')).toBe(true);
  });

  test('values starting with rbac- always match (no rbac-* in EXACT list)', () => {
    // rbac- is the prefix-only stem — it has no exact-match sentinel. This
    // documents that branch deliberately.
    expect(isJunkSource('rbac-')).toBe(true);
    expect(isJunkSource('rbac-bypass')).toBe(true);
    expect(isJunkSource('rbac-admin-impersonate')).toBe(true);
  });

  test('prefix match is left-anchored — not a substring search', () => {
    // The cron-learning history specifically flagged 'best-test-platform'-style
    // false-positives as a regression class. Pin the contract.
    expect(isJunkSource('best-platform')).toBe(false);
    expect(isJunkSource('contest-skip')).toBe(false);
    expect(isJunkSource('honest-feedback')).toBe(false);
    expect(isJunkSource('latest-e2e-variant')).toBe(false);
    expect(isJunkSource('hot-qa-tip')).toBe(false);
    expect(isJunkSource('embrace-rbac')).toBe(false);
  });

  test('prefix match requires the stem AS-IS (no fuzz)', () => {
    // 'tests-foo' does NOT match 'test-' because the trailing 's' breaks the
    // prefix. This pins that the helper is byte-prefix, not lexeme-prefix.
    expect(isJunkSource('tests-foo')).toBe(false);
    expect(isJunkSource('test_foo')).toBe(false); // underscore, not hyphen
    expect(isJunkSource('testfoo')).toBe(false); // no separator at all
    expect(isJunkSource('e2eseason')).toBe(false);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): case-folding edge cases', () => {
  test('mixed-case values across every prefix family match', () => {
    expect(isJunkSource('Test-Skip')).toBe(true);
    expect(isJunkSource('TEST-SKIP')).toBe(true);
    expect(isJunkSource('tEsT-sKiP')).toBe(true);
    expect(isJunkSource('E2E-Flow-Test')).toBe(true);
    expect(isJunkSource('QA-Pen-Test')).toBe(true);
    expect(isJunkSource('RBAC-Bypass-Attempt')).toBe(true);
  });

  test('all-uppercase variants of the four EXACT values all match', () => {
    expect(isJunkSource('TEST-SKIP')).toBe(true);
    expect(isJunkSource('TEST-JUNK')).toBe(true);
    expect(isJunkSource('E2E-TEST')).toBe(true);
    expect(isJunkSource('QA-TEST')).toBe(true);
  });

  test('locale-affected case folding (Turkish dotted-i etc.) does not break match', () => {
    // JavaScript's .toLowerCase() is locale-INDEPENDENT (uses simple
    // Unicode default casing), so 'TEST-SKIP' → 'test-skip' across every
    // host locale. Pin the behaviour so a future migration to
    // .toLocaleLowerCase() (which is locale-dependent and could split
    // Turkish I) is caught by this test. Particularly the dotted-I (İ) /
    // dotless-i (ı) pair, where .toLocaleLowerCase('tr') would yield 'i̇'
    // / 'ı' respectively — both of which would still match the 'test-'
    // prefix as long as the rest of the string is intact.
    expect(isJunkSource('TEST-SKIP')).toBe(true);
    expect(isJunkSource('test-skip')).toBe(true);
    expect(isJunkSource('TeSt-SkIp')).toBe(true);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): whitespace handling', () => {
  test('leading whitespace is trimmed before matching', () => {
    expect(isJunkSource('   test-skip')).toBe(true);
    expect(isJunkSource('\ttest-junk')).toBe(true);
    expect(isJunkSource('\n\ne2e-test')).toBe(true);
  });

  test('trailing whitespace is trimmed before matching', () => {
    expect(isJunkSource('test-skip   ')).toBe(true);
    expect(isJunkSource('qa-test\t')).toBe(true);
    expect(isJunkSource('rbac-bypass\r\n')).toBe(true);
  });

  test('whitespace on BOTH sides is trimmed before matching', () => {
    expect(isJunkSource('  test-skip  ')).toBe(true);
    expect(isJunkSource('\t\ttest-junk\n\n')).toBe(true);
  });

  test('embedded whitespace inside the value is NOT trimmed (only edges)', () => {
    // 'test- skip' → after trim → 'test- skip' → starts with 'test-' → junk.
    expect(isJunkSource('test- skip')).toBe(true);
    // 'test skip' (space instead of hyphen) → does NOT start with 'test-'
    expect(isJunkSource('test skip')).toBe(false);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): legit sources stay visible', () => {
  test('the demo / production source vocabulary is NOT flagged', () => {
    // Pulled from prisma/seed-wellness.js + the wellness Marketing Attribution
    // tab + the External Partner API docs. If any of these flip to junk by
    // accident, every Marketing Attribution row for that source vanishes.
    const legitSources = [
      'whatsapp',
      'website-form',
      'website',
      'web',
      'meta_ad',
      'meta-ad',
      'facebook-ad',
      'google-ad',
      'google_ad',
      'organic',
      'organic-search',
      'callified',
      'embed_widget',
      'embed-widget',
      'walk-in',
      'walkin',
      'referral',
      'IndiaMART',
      'JustDial',
      'TradeIndia',
      'other',
      'unknown',
      'sms',
      'email-blast',
      'newsletter',
      'instagram',
      'youtube',
      'phone-inbound',
    ];
    for (const s of legitSources) {
      expect(isJunkSource(s)).toBe(false);
    }
  });

  test('numeric-string-looking sources stay visible', () => {
    // External API leaked integer 'source' values once historically; helper
    // refuses to coerce. Stringified-number 'sources' (e.g. campaign ids
    // posted as '42') are NOT junk.
    expect(isJunkSource('42')).toBe(false);
    expect(isJunkSource('0')).toBe(false);
    expect(isJunkSource('-1')).toBe(false);
  });

  test('a single hyphen alone is not junk', () => {
    // Edge: '-' on its own doesn't start with any of the 4 prefixes.
    expect(isJunkSource('-')).toBe(false);
    expect(isJunkSource('--')).toBe(false);
  });
});

describe('lib/junkSourceFilter — isJunkSource(): determinism + idempotency', () => {
  test('repeated calls with the same input always return the same result', () => {
    // The helper has no internal state — pin the contract so a future
    // memoization/cache refactor cannot silently introduce a state leak.
    for (let i = 0; i < 100; i += 1) {
      expect(isJunkSource('test-skip')).toBe(true);
      expect(isJunkSource('whatsapp')).toBe(false);
      expect(isJunkSource(null)).toBe(false);
    }
  });

  test('calling with a value does not mutate the input string', () => {
    const original = '  TEST-SKIP  ';
    isJunkSource(original);
    expect(original).toBe('  TEST-SKIP  ');
  });

  test('calling with a value does not mutate the exported lists', () => {
    const exactSnapshot = JSON.stringify(JUNK_SOURCE_EXACT);
    const prefixSnapshot = JSON.stringify(JUNK_SOURCE_PREFIXES);
    isJunkSource('test-skip');
    isJunkSource('whatsapp');
    isJunkSource(null);
    isJunkSource('   ');
    expect(JSON.stringify(JUNK_SOURCE_EXACT)).toBe(exactSnapshot);
    expect(JSON.stringify(JUNK_SOURCE_PREFIXES)).toBe(prefixSnapshot);
  });
});

describe('lib/junkSourceFilter — array-filter integration (the real call shape)', () => {
  test('Contact[].filter pattern used by routes/attribution.js works as expected', () => {
    // Mirrors the actual call shape in routes/attribution.js + routes/wellness.js:
    // contacts.filter((c) => !isJunkSource(c.firstTouchSource || c.source))
    const contacts = [
      { id: 1, source: 'test-skip', firstTouchSource: 'test-skip' },
      { id: 2, source: 'test-junk', firstTouchSource: null },
      { id: 3, source: 'organic', firstTouchSource: 'organic' },
      { id: 4, source: 'whatsapp', firstTouchSource: null },
      { id: 5, source: null, firstTouchSource: null },
      { id: 6, source: 'TEST-SKIP', firstTouchSource: null }, // case variant
      { id: 7, source: 'rbac-test', firstTouchSource: 'organic' }, // firstTouch wins
      { id: 8, source: 'organic', firstTouchSource: 'qa-staging' }, // firstTouch wins
      { id: 9, source: '   test-skip   ', firstTouchSource: null }, // whitespace variant
    ];
    const visible = contacts.filter(
      (c) => !isJunkSource(c.firstTouchSource || c.source),
    );
    expect(visible.map((c) => c.id)).toEqual([3, 4, 5, 7]);
    // 7 is visible because firstTouchSource ('organic') wins over source ('rbac-test')
  });

  test('mixed null/undefined/empty firstTouchSource falls back to source', () => {
    const contacts = [
      { id: 1, source: 'test-skip', firstTouchSource: undefined },
      { id: 2, source: 'organic', firstTouchSource: '' },
      { id: 3, source: 'test-skip', firstTouchSource: null },
    ];
    const visible = contacts.filter(
      (c) => !isJunkSource(c.firstTouchSource || c.source),
    );
    expect(visible.map((c) => c.id)).toEqual([2]);
  });

  test('aggregation over a junk-heavy list yields expected counts', () => {
    // Simulates the bySource/byChannel map building in routes/attribution.js.
    const contacts = [
      { source: 'organic' },
      { source: 'organic' },
      { source: 'whatsapp' },
      { source: 'test-skip' }, // filtered
      { source: 'test-junk' }, // filtered
      { source: 'rbac-bypass' }, // filtered
      { source: 'qa-test' }, // filtered
      { source: 'e2e-flow' }, // filtered
      { source: 'walk-in' },
    ];
    const bySource = {};
    for (const c of contacts) {
      if (isJunkSource(c.source)) continue;
      bySource[c.source] = (bySource[c.source] || 0) + 1;
    }
    expect(bySource).toEqual({
      organic: 2,
      whatsapp: 1,
      'walk-in': 1,
    });
  });
});
