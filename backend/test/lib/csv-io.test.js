// Issue #816 — unit tests for backend/lib/csvIO.js
//
// Pins the parser + writer + escape contract that the wellness CSV
// import/export endpoints in routes/wellnessCsv.js (and the toolbar
// component on the frontend) both rely on.
//
// Pure-fn tests — no prisma, no fs, no network.

import { describe, test, expect } from 'vitest';

const { parseCsv, toCsv, withBom, escapeCell } = require('../../lib/csvIO');

describe('escapeCell', () => {
  test('returns "" for null / undefined', () => {
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
  });

  test('passes plain ASCII through unchanged', () => {
    expect(escapeCell('hello')).toBe('hello');
    expect(escapeCell('42')).toBe('42');
  });

  test('quotes + escapes embedded commas', () => {
    expect(escapeCell('a,b')).toBe('"a,b"');
  });

  test('quotes + escapes embedded double-quotes', () => {
    expect(escapeCell('a"b')).toBe('"a""b"');
  });

  test('quotes + preserves embedded newlines', () => {
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('renders Date as ISO-8601', () => {
    const d = new Date('2026-05-18T12:00:00.000Z');
    expect(escapeCell(d)).toBe('2026-05-18T12:00:00.000Z');
  });

  test('renders boolean as true / false', () => {
    expect(escapeCell(true)).toBe('true');
    expect(escapeCell(false)).toBe('false');
  });
});

describe('toCsv', () => {
  test('joins header + array-of-arrays rows with CRLF + trailing CRLF', () => {
    const out = toCsv(['a', 'b'], [[1, 2], [3, 4]]);
    expect(out).toBe('a,b\r\n1,2\r\n3,4\r\n');
  });

  test('serialises object rows keyed by header (missing → empty)', () => {
    const out = toCsv(['name', 'age'], [{ name: 'Sam', age: 30 }, { name: 'Jo' }]);
    expect(out).toBe('name,age\r\nSam,30\r\nJo,\r\n');
  });

  test('escapes cells that contain commas / quotes / newlines', () => {
    const out = toCsv(['n', 'note'], [['Smith', 'has, comma'], ['O\'Brien', 'has "quote"']]);
    expect(out).toBe('n,note\r\nSmith,"has, comma"\r\nO\'Brien,"has ""quote"""\r\n');
  });

  test('empty rows still emit the header line', () => {
    expect(toCsv(['x'], [])).toBe('x\r\n');
  });

  test('throws when headers are missing or empty', () => {
    expect(() => toCsv([], [])).toThrow();
    expect(() => toCsv(null, [])).toThrow();
  });
});

describe('parseCsv', () => {
  test('parses a simple header + two rows', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ a: '1', b: '2' });
    expect(rows[1]).toMatchObject({ a: '3', b: '4' });
  });

  test('round-trips through toCsv → parseCsv', () => {
    const original = [{ name: 'Sam', city: 'NY' }, { name: 'Jo', city: 'LA' }];
    const csv = toCsv(['name', 'city'], original);
    const { rows } = parseCsv(csv);
    expect(rows.map((r) => ({ name: r.name, city: r.city }))).toEqual(original);
  });

  test('preserves commas inside quoted fields', () => {
    const { rows } = parseCsv('a,b\r\n"x,y",2\r\n');
    expect(rows[0].a).toBe('x,y');
    expect(rows[0].b).toBe('2');
  });

  test('escapes doubled quotes inside quoted fields', () => {
    const { rows } = parseCsv('a\r\n"she said ""hi"""\r\n');
    expect(rows[0].a).toBe('she said "hi"');
  });

  test('preserves embedded newlines inside quoted fields', () => {
    const { rows } = parseCsv('a,b\r\n"line1\nline2",end\r\n');
    expect(rows[0].a).toBe('line1\nline2');
    expect(rows[0].b).toBe('end');
  });

  test('handles \\n line endings as well as \\r\\n', () => {
    const { headers, rows } = parseCsv('a,b\n1,2\n3,4');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ a: '3', b: '4' });
  });

  test('strips UTF-8 BOM at file start', () => {
    const csv = '﻿name\r\nSam\r\n';
    const { headers } = parseCsv(csv);
    expect(headers).toEqual(['name']);
  });

  test('exposes the original row number via __row (header = 1)', () => {
    const { rows } = parseCsv('h\r\nrow2\r\nrow3\r\n');
    expect(rows[0].__row).toBe(2);
    expect(rows[1].__row).toBe(3);
  });

  test('drops trailing blank rows', () => {
    const { rows } = parseCsv('h\r\n1\r\n2\r\n\r\n');
    expect(rows).toHaveLength(2);
  });

  test('empty input yields empty headers + rows', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  test('throws on non-string input', () => {
    expect(() => parseCsv(null)).toThrow();
    expect(() => parseCsv(123)).toThrow();
  });
});

describe('withBom', () => {
  test('prepends UTF-8 BOM', () => {
    expect(withBom('hello')).toBe('﻿hello');
  });
});
