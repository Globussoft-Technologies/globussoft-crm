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

// v3.4.11: helpers moved from routes/sequences.js to backend/lib/sanitizeJson.js
// for reuse across the lead_routing / ab_tests / marketing / report_schedules
// routes identified by the v3.4.10 audit. Importing from the new canonical
// path; the test name (`sanitize-json.test.js`) stays the same since the
// covered helper signature is unchanged.
const { sanitizeText, sanitizeJson, sanitizeHtmlBody } = require('../../lib/sanitizeJson.js');

describe('sanitize helpers — module shape', () => {
  test('exports sanitizeText + sanitizeJson as functions', () => {
    expect(typeof sanitizeText).toBe('function');
    expect(typeof sanitizeJson).toBe('function');
    expect(typeof sanitizeHtmlBody).toBe('function');
  });
});

// #596 — sanitizeHtmlBody preserves a marketing-email allow-list while
// stripping the XSS surface. Used by routes/marketing.js for the campaign
// "Body (HTML)" field (pre-fix the body was routed through sanitizeText
// which silently stripped every tag).
describe('sanitizeHtmlBody — #596 marketing email body allow-list', () => {
  test('preserves <p>, <br>, <strong>, <em>, <a> tags verbatim', () => {
    const input = '<p>Hello <strong>world</strong>!<br/>Visit <a href="https://example.com">our site</a>.</p>';
    const out = sanitizeHtmlBody(input);
    expect(out).toContain('<p>');
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('<br');
    expect(out).toContain('<a href="https://example.com">');
  });

  test('preserves heading tags (h1–h6)', () => {
    const out = sanitizeHtmlBody('<h1>Big Title</h1><h2>Sub</h2>');
    expect(out).toContain('<h1>Big Title</h1>');
    expect(out).toContain('<h2>Sub</h2>');
  });

  test('preserves lists (ul/ol/li)', () => {
    const out = sanitizeHtmlBody('<ul><li>One</li><li>Two</li></ul>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>One</li>');
    expect(out).toContain('<li>Two</li>');
  });

  test('strips <script> and any inline event handlers', () => {
    const input = '<p>Hi</p><script>alert(1)</script><p onclick="alert(2)">Click</p>';
    const out = sanitizeHtmlBody(input);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('onclick');
  });

  test('strips <iframe> / <object> / <embed>', () => {
    const out = sanitizeHtmlBody('<iframe src="x"></iframe><object></object><embed/>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  test('preserves merge tags inside HTML', () => {
    const out = sanitizeHtmlBody('<p>Hello {{first_name}}!</p>');
    expect(out).toContain('{{first_name}}');
  });

  test('forces noopener+noreferrer on target=_blank anchors', () => {
    const out = sanitizeHtmlBody('<a href="https://example.com" target="_blank">click</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });

  test('preserves images with safe attributes', () => {
    const out = sanitizeHtmlBody('<img src="https://cdn.x/y.png" alt="logo" width="100" />');
    expect(out).toContain('<img');
    expect(out).toContain('src="https://cdn.x/y.png"');
    expect(out).toContain('alt="logo"');
  });

  test('strips javascript: scheme from anchors', () => {
    const out = sanitizeHtmlBody('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });

  test('passes through non-string input', () => {
    expect(sanitizeHtmlBody(null)).toBeNull();
    expect(sanitizeHtmlBody(undefined)).toBeUndefined();
    expect(sanitizeHtmlBody(42)).toBe(42);
  });

  test('empty string returns empty string', () => {
    expect(sanitizeHtmlBody('')).toBe('');
  });

  test('round-trip preserves a realistic marketing email body', () => {
    const input = `<h1>Hello {{first_name}}</h1><p style="color:#0a7">Welcome to <strong>Globus Wellness</strong>.</p><p><a href="https://example.com">Book now</a></p>`;
    const out = sanitizeHtmlBody(input);
    expect(out).toContain('<h1>Hello {{first_name}}</h1>');
    expect(out).toContain('<strong>Globus Wellness</strong>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('Book now');
    // Color style passes the allow-list.
    expect(out).toMatch(/color:\s*#0a7/);
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
