// @ts-check
/**
 * #665 — vitest unit suite for backend/lib/validateDateRange.js.
 *
 * The lib hosts a pure helper `validateDateRange({ from, to }, opts?)` used by
 * every list/report route that historically swallowed reversed date ranges.
 *
 * Branch coverage targets:
 *   - both absent → ok
 *   - one side present + valid → ok
 *   - either side present + unparseable → INVALID_DATE
 *   - both valid, to < from → INVERTED_DATE_RANGE
 *   - both valid, equal → ok (single-day window is valid)
 *   - both valid, span > maxYears → DATE_RANGE_TOO_WIDE
 *   - maxYears = 0 disables the wide-range guard
 *   - empty string is treated as absent
 *
 * No prisma / network mocks needed — every helper is pure (input → output).
 */
import { describe, test, expect } from 'vitest';
import { validateDateRange } from '../../lib/validateDateRange.js';

describe('validateDateRange', () => {
  test('both absent returns ok with nulls', () => {
    const r = validateDateRange({});
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeNull();
    expect(r.toDate).toBeNull();
  });

  test('undefined opts is fine', () => {
    expect(validateDateRange({ from: '2026-01-01', to: '2026-01-31' }).ok).toBe(true);
  });

  test('only from present returns ok', () => {
    const r = validateDateRange({ from: '2026-01-01' });
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeInstanceOf(Date);
    expect(r.toDate).toBeNull();
  });

  test('only to present returns ok', () => {
    const r = validateDateRange({ to: '2026-12-31' });
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeNull();
    expect(r.toDate).toBeInstanceOf(Date);
  });

  test('from invalid returns INVALID_DATE 400', () => {
    const r = validateDateRange({ from: 'notadate', to: '2026-01-31' });
    expect(r.ok).toBeUndefined();
    expect(r.error.status).toBe(400);
    expect(r.error.code).toBe('INVALID_DATE');
    expect(r.error.error).toMatch(/'from'/);
  });

  test('to invalid returns INVALID_DATE 400', () => {
    const r = validateDateRange({ from: '2026-01-01', to: 'garbage' });
    expect(r.error.status).toBe(400);
    expect(r.error.code).toBe('INVALID_DATE');
    expect(r.error.error).toMatch(/'to'/);
  });

  test('inverted range returns INVERTED_DATE_RANGE 400', () => {
    const r = validateDateRange({ from: '2026-05-01', to: '2026-04-01' });
    expect(r.error.status).toBe(400);
    expect(r.error.code).toBe('INVERTED_DATE_RANGE');
    expect(r.error.error).toMatch(/'from' must be on or before 'to'/);
  });

  test('inverted range one day apart still trips guard', () => {
    const r = validateDateRange({ from: '2026-05-02', to: '2026-05-01' });
    expect(r.error.code).toBe('INVERTED_DATE_RANGE');
  });

  test('equal from and to is valid (single-day window)', () => {
    const r = validateDateRange({ from: '2026-05-01', to: '2026-05-01' });
    expect(r.ok).toBe(true);
  });

  test('span beyond 5 years returns DATE_RANGE_TOO_WIDE 400', () => {
    const r = validateDateRange({ from: '2020-01-01', to: '2030-01-01' });
    expect(r.error.status).toBe(400);
    expect(r.error.code).toBe('DATE_RANGE_TOO_WIDE');
    expect(r.error.error).toMatch(/5 years/);
  });

  test('maxYears=0 disables the wide-range guard', () => {
    const r = validateDateRange(
      { from: '1900-01-01', to: '2099-12-31' },
      { maxYears: 0 }
    );
    expect(r.ok).toBe(true);
  });

  test('custom maxYears=1 trips at 1y+1d span', () => {
    const r = validateDateRange(
      { from: '2026-01-01', to: '2027-06-01' },
      { maxYears: 1 }
    );
    expect(r.error.code).toBe('DATE_RANGE_TOO_WIDE');
  });

  test('empty-string from is treated as absent', () => {
    const r = validateDateRange({ from: '', to: '2026-12-31' });
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeNull();
    expect(r.toDate).toBeInstanceOf(Date);
  });

  test('empty-string to is treated as absent', () => {
    const r = validateDateRange({ from: '2026-01-01', to: '' });
    expect(r.ok).toBe(true);
  });

  test('null inputs are treated as absent', () => {
    const r = validateDateRange({ from: null, to: null });
    expect(r.ok).toBe(true);
  });

  test('Date objects are accepted', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-31T00:00:00Z');
    const r = validateDateRange({ from, to });
    expect(r.ok).toBe(true);
    expect(r.fromDate.getTime()).toBe(from.getTime());
  });

  test('ISO with time component honoured for inverted check', () => {
    const r = validateDateRange({
      from: '2026-05-01T15:00:00Z',
      to: '2026-05-01T14:00:00Z',
    });
    expect(r.error.code).toBe('INVERTED_DATE_RANGE');
  });

  // ---- Coverage extension: under-pinned surface ----

  test('whitespace-only from is treated as absent (trim path)', () => {
    // isPresent() calls String(v).trim() — non-empty whitespace collapses to ''
    const r = validateDateRange({ from: '   ', to: '2026-12-31' });
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeNull();
    expect(r.toDate).toBeInstanceOf(Date);
  });

  test('maxYears as stringified number coerces via Number() (e.g. "3" trips at >3y)', () => {
    // opts.maxYears = "3" → Number("3") === 3 → strict-> guard at >3y
    const r = validateDateRange(
      { from: '2020-01-01', to: '2024-01-01' }, // ~4y span
      { maxYears: '3' }
    );
    expect(r.error.code).toBe('DATE_RANGE_TOO_WIDE');
    expect(r.error.error).toMatch(/3 years/);
  });

  test('maxYears as NaN disables the wide-range guard (NaN > 0 === false)', () => {
    // Number("garbage") → NaN; NaN > 0 is false → wide guard skipped.
    const r = validateDateRange(
      { from: '1925-01-01', to: '2025-01-01' }, // 100y span
      { maxYears: 'garbage' }
    );
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeInstanceOf(Date);
    expect(r.toDate).toBeInstanceOf(Date);
  });

  test('negative maxYears disables the wide-range guard (-1 > 0 === false)', () => {
    const r = validateDateRange(
      { from: '2016-01-01', to: '2026-01-01' }, // 10y span
      { maxYears: -1 }
    );
    expect(r.ok).toBe(true);
  });

  test('error priority: when both from AND to are invalid, INVALID_DATE on from fires first', () => {
    // Source checks from-validity (lines 55-66) before to-validity (lines 67-78).
    const r = validateDateRange({ from: 'notadate', to: 'alsogarbage' });
    expect(r.error.code).toBe('INVALID_DATE');
    expect(r.error.error).toMatch(/'from'/);
    expect(r.error.error).not.toMatch(/'to'/);
  });

  test('error priority: inverted+too-wide together yields INVERTED_DATE_RANGE (inverted checked first)', () => {
    // from=2030, to=2020 is inverted AND would be too wide (10y) if unwrapped.
    // Source checks inverted at line 80 BEFORE wide-range at line 90.
    const r = validateDateRange({ from: '2030-01-01', to: '2020-01-01' });
    expect(r.error.code).toBe('INVERTED_DATE_RANGE');
  });

  test('no-args invocation succeeds via default {} destructure', () => {
    // function signature: validateDateRange({ from, to } = {}, opts = {})
    // Calling with NO args should NOT throw, both undefined → both absent → ok.
    expect(() => validateDateRange()).not.toThrow();
    const r = validateDateRange();
    expect(r.ok).toBe(true);
    expect(r.fromDate).toBeNull();
    expect(r.toDate).toBeNull();
  });

  test('custom maxYears=10 accepts 9y span and rejects 11y span with "10 years" in message', () => {
    const ok = validateDateRange(
      { from: '2017-01-01', to: '2026-01-01' }, // ~9y span
      { maxYears: 10 }
    );
    expect(ok.ok).toBe(true);

    const tooWide = validateDateRange(
      { from: '2015-01-01', to: '2026-06-01' }, // ~11.4y span
      { maxYears: 10 }
    );
    expect(tooWide.error.code).toBe('DATE_RANGE_TOO_WIDE');
    expect(tooWide.error.error).toMatch(/10 years/);
  });
});
