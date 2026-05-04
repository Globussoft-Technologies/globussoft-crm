// Unit tests for the sanitizeJson + sanitizeText helpers exported from
// backend/routes/sequences.js. These helpers were added in v3.4.9 to
// close the carry-over #1 leak from #398: STEP-level smsBody +
// conditionJson on POST /:id/steps and PUT /steps/:id were stored
// verbatim, so a `<script>` payload could persist on a step body and
// fire when an admin opened the diff view.
//
// Why test the route's helpers directly: vitest config inlines
// `backend/routes/` (vitest.config.js:54), so requiring the routes
// module from a unit test is supported. The route file requires
// `../lib/prisma` at top-level but Prisma connects lazily, so no DB
// handshake happens just from importing.
//
// Coverage targets:
//  - null / undefined are passed through unchanged
//  - empty object / empty array are returned as-is
//  - nested object string values are sanitized
//  - array-of-strings is sanitized element-wise
//  - mixed types (number, boolean, null) inside an object are preserved
//  - merge tags `{{firstName}}` are NOT eaten by sanitize-html
//  - JSON-encoded string blobs are parsed → walked → re-stringified
//  - non-JSON strings fall back to plain sanitizeText
import { describe, test, expect } from 'vitest';

const sequences = require('../../routes/sequences.js');
const { sanitizeText, sanitizeJson } = sequences;

describe('sanitize helpers — module shape', () => {
  test('exports sanitizeText + sanitizeJson as functions', () => {
    expect(typeof sanitizeText).toBe('function');
    expect(typeof sanitizeJson).toBe('function');
  });
});

describe('sanitizeJson — null / undefined / primitive passthrough', () => {
  test('null returns null', () => {
    expect(sanitizeJson(null)).toBeNull();
  });
  test('undefined returns undefined', () => {
    expect(sanitizeJson(undefined)).toBeUndefined();
  });
  test('numbers pass through untouched', () => {
    expect(sanitizeJson(42)).toBe(42);
    expect(sanitizeJson(0)).toBe(0);
  });
  test('booleans pass through untouched', () => {
    expect(sanitizeJson(true)).toBe(true);
    expect(sanitizeJson(false)).toBe(false);
  });
});

describe('sanitizeJson — empty containers', () => {
  test('empty object returns an empty object', () => {
    expect(sanitizeJson({})).toEqual({});
  });
  test('empty array returns an empty array', () => {
    expect(sanitizeJson([])).toEqual([]);
  });
});

describe('sanitizeJson — nested string sanitization', () => {
  test('top-level string field is HTML-stripped', () => {
    const input = { match: '<img src=x onerror=alert(1)>' };
    const out = sanitizeJson(input);
    expect(out.match).not.toMatch(/<img/i);
    expect(out.match).not.toMatch(/onerror/i);
  });
  test('deeply nested string is HTML-stripped', () => {
    const input = {
      rules: { all: [{ field: '<script>alert(1)</script>name' }] },
    };
    const out = sanitizeJson(input);
    expect(out.rules.all[0].field).not.toMatch(/<script/i);
    expect(out.rules.all[0].field).toContain('name');
  });
  test('array of strings is sanitized element-wise', () => {
    const input = ['<b>one</b>', '<i>two</i>', 'plain three'];
    const out = sanitizeJson(input);
    expect(out).toHaveLength(3);
    expect(out[0]).not.toMatch(/<b>/i);
    expect(out[0]).toContain('one');
    expect(out[1]).not.toMatch(/<i>/i);
    expect(out[2]).toBe('plain three');
  });
});

describe('sanitizeJson — mixed types preserved', () => {
  test('object with string + number + boolean keeps non-strings intact', () => {
    const input = {
      label: '<script>x</script>visible',
      count: 7,
      active: true,
      missing: null,
    };
    const out = sanitizeJson(input);
    expect(out.label).not.toMatch(/<script/i);
    expect(out.label).toContain('visible');
    expect(out.count).toBe(7);
    expect(out.active).toBe(true);
    expect(out.missing).toBeNull();
  });
});

describe('sanitizeJson — merge-tag preservation (invariant)', () => {
  test('{{firstName}} survives sanitization in plain text', () => {
    expect(sanitizeText('hello {{firstName}}!')).toBe('hello {{firstName}}!');
  });
  test('{{merge.tag}} survives inside a nested JSON value', () => {
    const input = { template: 'Hi {{firstName}} from {{company}}' };
    const out = sanitizeJson(input);
    expect(out.template).toContain('{{firstName}}');
    expect(out.template).toContain('{{company}}');
  });
  test('merge tag adjacent to malicious HTML is preserved while HTML is stripped', () => {
    const input = { body: '<script>x</script>{{firstName}} welcome!' };
    const out = sanitizeJson(input);
    expect(out.body).not.toMatch(/<script/i);
    expect(out.body).toContain('{{firstName}}');
    expect(out.body).toContain('welcome');
  });
});

describe('sanitizeJson — JSON-string-blob handling', () => {
  test('valid JSON string input is parsed, walked, re-stringified', () => {
    const input = JSON.stringify({ match: '<b>x</b>val' });
    const out = sanitizeJson(input);
    expect(typeof out).toBe('string');
    const reparsed = JSON.parse(out);
    expect(reparsed.match).not.toMatch(/<b>/i);
    expect(reparsed.match).toContain('val');
  });
  test('non-JSON string input falls back to sanitizeText', () => {
    const out = sanitizeJson('<script>alert(1)</script>plain text');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('plain text');
  });
});
