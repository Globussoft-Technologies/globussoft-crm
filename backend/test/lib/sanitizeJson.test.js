// Sibling vitest for backend/lib/sanitizeJson.js — targets the GAPS the
// existing backend/test/utils/sanitize-json.test.js (16+ shape-preservation
// cases) does NOT cover. Per CLAUDE.md the existing file pins the canonical
// shape-preservation contract; this file pins the OTHER branches:
//
//   - deep nesting (3+ levels of object/array interleave)
//   - arrays of arrays + mixed-type arrays
//   - very long strings (helper has no cap; pin that contract so a future
//     "cap at N chars" change is a deliberate decision, not silent regression)
//   - strings containing multiple sanitisable tags (helper must strip ALL,
//     not just the first match)
//   - non-mutating contract — the input object/array MUST NOT be mutated
//     in place. Sequences / lead-routing / ab-tests routes re-use the
//     incoming body object after sanitization for response shaping; an
//     in-place mutation would silently leak sanitised values back into the
//     pre-write hooks (audit log, websocket emit) that ran on the raw body.
//   - sanitizeJsonForStringColumn — the 4th exported helper that none of
//     the existing tests cover at all. Pins all 4 input-shape branches:
//     null → null, object → JSON string, array → JSON string, JSON-string-in
//     → JSON-string-out unchanged shape.
//   - entity decoding — `&amp;` `&lt;` `&gt;` `&quot;` `&#x27;` `&#39;` must
//     decode back to raw characters (#187: "Q3 Plan & Brief" must stay raw).
//   - whitespace trimming — sanitizeText must trim leading/trailing spaces
//     so " hello " stays "hello".
//   - JSON-string-of-primitive — `JSON.stringify(42)` returns the string
//     "42", which IS valid JSON and parses to a number; pin that the helper
//     handles this branch (parse succeeds, walk on a number, re-stringify).
//
// Why these matter:
//   Five live routes (sequences, lead_routing, ab_tests, marketing,
//   report_schedules) write user-controlled JSON into String?@db.Text
//   columns via these helpers. Each gap above corresponds to a class of
//   regression that would silently break ONE route's contract while the
//   existing 16-case suite stays green:
//     - non-mutation contract → audit log emit
//     - sanitizeJsonForStringColumn → routes that store an object directly
//       (Prisma would error if the helper handed back a non-string)
//     - deep nesting → ab_tests variantA / variantB (3-level builder JSON)
//     - entity decoding → marketing campaign name containing "&"
//
// References:
//   - backend/lib/sanitizeJson.js (198 LOC, 4 exports)
//   - backend/test/utils/sanitize-json.test.js (existing, shape-preservation)
//   - CLAUDE.md "JSON-string columns" standing rule

import { describe, test, expect } from 'vitest';

const {
  sanitizeText,
  sanitizeJson,
  sanitizeJsonForStringColumn,
} = require('../../lib/sanitizeJson.js');

// ---------------------------------------------------------------------------
// Deep nesting — 3+ levels of object/array interleave
// ---------------------------------------------------------------------------
describe('sanitizeJson — deep nesting (3+ levels)', () => {
  test('strips HTML at depth 4 (object → object → array → object)', () => {
    const input = {
      level1: {
        level2: {
          items: [
            { label: '<script>boom</script>visible' },
          ],
        },
      },
    };
    const out = sanitizeJson(input);
    expect(out.level1.level2.items[0].label).not.toMatch(/<script/i);
    expect(out.level1.level2.items[0].label).toContain('visible');
  });

  test('strips HTML at depth 5 (alternating array/object)', () => {
    const input = [{ a: [{ b: [{ c: '<iframe src=evil></iframe>deep' }] }] }];
    const out = sanitizeJson(input);
    expect(out[0].a[0].b[0].c).not.toMatch(/<iframe/i);
    expect(out[0].a[0].b[0].c).toContain('deep');
  });

  test('preserves shape at depth 4 (no flattening, no key drop)', () => {
    const input = {
      a: { b: { c: { d: 'clean' } } },
      sibling: 'safe',
    };
    const out = sanitizeJson(input);
    expect(out).toHaveProperty('a.b.c.d', 'clean');
    expect(out).toHaveProperty('sibling', 'safe');
  });
});

// ---------------------------------------------------------------------------
// Arrays of arrays + mixed-type arrays
// ---------------------------------------------------------------------------
describe('sanitizeJson — array shape variants', () => {
  test('array of arrays: HTML in inner array is stripped, shape preserved', () => {
    const input = [['<b>one</b>', 'two'], ['<i>three</i>', 'four']];
    const out = sanitizeJson(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(2);
    expect(out[0][0]).not.toMatch(/<b>/i);
    expect(out[0][0]).toContain('one');
    expect(out[1][0]).not.toMatch(/<i>/i);
    expect(out[1][1]).toBe('four');
  });

  test('mixed-type array: strings sanitised, numbers/booleans/null intact', () => {
    const input = ['<script>x</script>a', 42, true, null, false, 0, { k: '<b>v</b>' }];
    const out = sanitizeJson(input);
    expect(out).toHaveLength(7);
    expect(out[0]).not.toMatch(/<script/i);
    expect(out[0]).toContain('a');
    expect(out[1]).toBe(42);
    expect(out[2]).toBe(true);
    expect(out[3]).toBeNull();
    expect(out[4]).toBe(false);
    expect(out[5]).toBe(0);
    expect(out[6].k).not.toMatch(/<b>/i);
    expect(out[6].k).toContain('v');
  });

  test('empty inner arrays survive', () => {
    const input = { rows: [[], [], ['x']] };
    const out = sanitizeJson(input);
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual([]);
    expect(out.rows[1]).toEqual([]);
    expect(out.rows[2]).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// Very long strings — pin "no cap" contract
// ---------------------------------------------------------------------------
describe('sanitizeJson — very long strings (no cap contract)', () => {
  test('10KB clean string passes through full-length', () => {
    const long = 'x'.repeat(10_000);
    expect(sanitizeText(long)).toHaveLength(10_000);
  });

  test('100KB string survives without truncation', () => {
    const long = 'a'.repeat(100_000);
    const out = sanitizeJson({ body: long });
    expect(out.body).toHaveLength(100_000);
  });

  test('long string with embedded HTML strips HTML but keeps the rest', () => {
    const prefix = 'p'.repeat(5_000);
    const suffix = 's'.repeat(5_000);
    const input = `${prefix}<script>alert(1)</script>${suffix}`;
    const out = sanitizeText(input);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('alert(1)');
    // The text content of <script>...</script> ('alert(1)') gets stripped
    // along with the tags by sanitize-html when allowedTags=[].
    // What survives: the prefix + suffix raw characters.
    expect(out.length).toBeGreaterThanOrEqual(10_000);
    expect(out).toContain(prefix);
    expect(out).toContain(suffix);
  });
});

// ---------------------------------------------------------------------------
// Multiple sanitisable tags in one string
// ---------------------------------------------------------------------------
describe('sanitizeJson — multiple sanitisable tags', () => {
  test('strips ALL <script> tags, not just the first', () => {
    const out = sanitizeText('<script>a</script>x<script>b</script>y<script>c</script>z');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('x');
    expect(out).toContain('y');
    expect(out).toContain('z');
  });

  test('strips a mix of tag types in one string', () => {
    const out = sanitizeText('<script>s</script>A<iframe></iframe>B<style>.x{}</style>C');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<style/i);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
  });

  test('handles nested malicious tags', () => {
    const out = sanitizeText('<div><script>x</script></div>visible');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<div/i);
    expect(out).toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// Non-mutating contract — input must NOT be modified in place
// ---------------------------------------------------------------------------
describe('sanitizeJson — non-mutating contract', () => {
  test('input object is not mutated in place', () => {
    const input = { label: '<script>x</script>visible', count: 1 };
    const snapshot = JSON.stringify(input);
    sanitizeJson(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    // Original string still contains the script tag — sanitization did not
    // overwrite the field on the source object.
    expect(input.label).toContain('<script>');
  });

  test('input array is not mutated in place', () => {
    const input = ['<b>one</b>', 'two'];
    const snapshot = JSON.stringify(input);
    sanitizeJson(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input[0]).toBe('<b>one</b>');
  });

  test('deeply nested input is not mutated', () => {
    const input = { a: { b: { c: '<i>x</i>v' } } };
    const snapshot = JSON.stringify(input);
    sanitizeJson(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('output is a different reference than the input', () => {
    const input = { x: 'y' };
    const out = sanitizeJson(input);
    expect(out).not.toBe(input);
  });

  test('output array is a different reference than the input array', () => {
    const input = ['a', 'b'];
    const out = sanitizeJson(input);
    expect(out).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// sanitizeJsonForStringColumn — the 4th export, untested by existing suite
// ---------------------------------------------------------------------------
describe('sanitizeJsonForStringColumn — all input-shape branches', () => {
  test('null returns null (so Prisma writes NULL, not the string "null")', () => {
    expect(sanitizeJsonForStringColumn(null)).toBeNull();
  });

  test('undefined returns null (same NULL-write contract)', () => {
    expect(sanitizeJsonForStringColumn(undefined)).toBeNull();
  });

  test('object input → JSON-string output', () => {
    const out = sanitizeJsonForStringColumn({ k: 'v' });
    expect(typeof out).toBe('string');
    expect(JSON.parse(out)).toEqual({ k: 'v' });
  });

  test('object input with HTML is sanitised before stringification', () => {
    const out = sanitizeJsonForStringColumn({ label: '<script>x</script>v' });
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.label).not.toMatch(/<script/i);
    expect(parsed.label).toContain('v');
  });

  test('array input → JSON-string output', () => {
    const out = sanitizeJsonForStringColumn(['<b>a</b>', 'b']);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).not.toMatch(/<b>/i);
    expect(parsed[1]).toBe('b');
  });

  test('JSON-string input → JSON-string output (idempotent under round-trip)', () => {
    const input = JSON.stringify({ k: '<i>v</i>' });
    const out = sanitizeJsonForStringColumn(input);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.k).not.toMatch(/<i>/i);
    expect(parsed.k).toContain('v');
  });

  test('non-JSON string input → sanitised non-JSON string (fallback path)', () => {
    const out = sanitizeJsonForStringColumn('<script>x</script>plain');
    expect(typeof out).toBe('string');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('plain');
  });

  test('empty object → "{}"', () => {
    expect(sanitizeJsonForStringColumn({})).toBe('{}');
  });

  test('empty array → "[]"', () => {
    expect(sanitizeJsonForStringColumn([])).toBe('[]');
  });

  test('nested object is sanitised + stringified end-to-end', () => {
    const input = { rules: { all: [{ field: '<script>x</script>name' }] } };
    const out = sanitizeJsonForStringColumn(input);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed.rules.all[0].field).not.toMatch(/<script/i);
    expect(parsed.rules.all[0].field).toContain('name');
  });
});

// ---------------------------------------------------------------------------
// Entity decoding — #187 contract (raw `&` `<` `>` `"` `'` survive)
// ---------------------------------------------------------------------------
describe('sanitizeText — entity decoding (#187 contract)', () => {
  test('raw ampersand survives ("Q3 Plan & Brief")', () => {
    expect(sanitizeText('Q3 Plan & Brief')).toBe('Q3 Plan & Brief');
  });

  test('&amp; entity decodes back to &', () => {
    expect(sanitizeText('A &amp; B')).toBe('A & B');
  });

  test('&lt; and &gt; entities decode back to < and >', () => {
    expect(sanitizeText('x &lt;= y &gt; z')).toBe('x <= y > z');
  });

  test('&quot; entity decodes back to "', () => {
    expect(sanitizeText('say &quot;hi&quot;')).toBe('say "hi"');
  });

  test('&#x27; and &#39; entities decode back to apostrophe', () => {
    expect(sanitizeText("it&#x27;s")).toBe("it's");
    expect(sanitizeText("it&#39;s")).toBe("it's");
  });

  test('entity decoding survives nested sanitizeJson walk', () => {
    const out = sanitizeJson({ name: 'Q3 Plan & Brief' });
    expect(out.name).toBe('Q3 Plan & Brief');
  });
});

// ---------------------------------------------------------------------------
// Whitespace + edge-case strings
// ---------------------------------------------------------------------------
describe('sanitizeText — whitespace + edge cases', () => {
  test('trims leading and trailing whitespace', () => {
    expect(sanitizeText('   hello   ')).toBe('hello');
  });

  test('preserves internal whitespace', () => {
    expect(sanitizeText('a  b  c')).toBe('a  b  c');
  });

  test('empty string returns empty string', () => {
    expect(sanitizeText('')).toBe('');
  });

  test('whitespace-only string trims to empty string', () => {
    expect(sanitizeText('     ')).toBe('');
  });

  test('non-string input passes through (number, boolean, null, undefined)', () => {
    expect(sanitizeText(42)).toBe(42);
    expect(sanitizeText(true)).toBe(true);
    expect(sanitizeText(null)).toBeNull();
    expect(sanitizeText(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JSON-string-of-primitive edge cases
// ---------------------------------------------------------------------------
describe('sanitizeJson — JSON-string-of-primitive edge cases', () => {
  test('JSON-encoded number string → re-stringified number string', () => {
    // JSON.stringify(42) === '42', which parses as a valid JSON number.
    // The helper enters the JSON-string branch, parses to 42, walks 42
    // (primitive passthrough), re-stringifies to "42".
    expect(sanitizeJson('42')).toBe('42');
  });

  test('JSON-encoded boolean string → re-stringified boolean string', () => {
    expect(sanitizeJson('true')).toBe('true');
    expect(sanitizeJson('false')).toBe('false');
  });

  test('JSON-encoded null string → re-stringified "null"', () => {
    // The literal 4-char string "null" is valid JSON; parses to null;
    // _walkSanitize(null) returns null; JSON.stringify(null) === "null".
    expect(sanitizeJson('null')).toBe('null');
  });

  test('JSON-encoded array string → re-stringified, contents sanitised', () => {
    const input = JSON.stringify(['<b>x</b>v', 'plain']);
    const out = sanitizeJson(input);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out);
    expect(parsed[0]).not.toMatch(/<b>/i);
    expect(parsed[0]).toContain('v');
    expect(parsed[1]).toBe('plain');
  });

  test('malformed JSON-looking string falls back to sanitizeText path', () => {
    // Starts with `{` but isn't valid JSON → JSON.parse throws → fallback.
    const out = sanitizeJson('{not valid json<script>x</script>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('not valid json');
  });
});
