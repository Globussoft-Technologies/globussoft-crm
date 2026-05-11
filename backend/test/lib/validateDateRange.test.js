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
});
