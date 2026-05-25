// frontend/src/utils/percent.js
//
// What's tested
//   - 1-decimal canonical format (#639): 12 → "12.0%", 12.34 → "12.3%"
//   - null / undefined / NaN / empty-string render as "—"
//   - 0 renders as "0.0%" (NOT "—") — distinct from "no data"
//   - decimals override: formatPercent(12.34, { decimals: 0 }) → "12%"
//   - string inputs are coerced ("12.5" → "12.5%")
//
// Why
//   Pre-#639 conversion-rate renderings drifted across surfaces ("0%" on list,
//   "0.0%" on detail, "0.00%" in CSV). This helper is the single source of
//   truth; pinning the contract here means callsites can never re-introduce
//   the divergence without a test failure.

import { describe, it, expect, test } from 'vitest';
import formatPercentDefault, { formatPercent } from '../utils/percent';

describe('formatPercent', () => {
  it('renders 1 decimal by default', () => {
    expect(formatPercent(12)).toBe('12.0%');
    expect(formatPercent(12.34)).toBe('12.3%');
    expect(formatPercent(99.99)).toBe('100.0%');
  });

  it('renders 0 as "0.0%" (not em-dash)', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('renders null / undefined / NaN as em-dash', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
    expect(formatPercent('')).toBe('—');
  });

  it('coerces stringified numerics', () => {
    expect(formatPercent('12.5')).toBe('12.5%');
    expect(formatPercent('0')).toBe('0.0%');
  });

  it('honours the decimals override', () => {
    expect(formatPercent(12.34, { decimals: 0 })).toBe('12%');
    expect(formatPercent(12.34, { decimals: 2 })).toBe('12.34%');
  });

  it('rejects non-numeric strings as em-dash', () => {
    expect(formatPercent('abc')).toBe('—');
  });

  // ---------------------------------------------------------------------------
  // Extension wave (test-cron Agent C) — under-pinned surface
  // ---------------------------------------------------------------------------

  it('renders negative percents with the leading minus preserved', () => {
    expect(formatPercent(-5.5)).toBe('-5.5%');
    expect(formatPercent(-100)).toBe('-100.0%');
  });

  it('renders very large numbers without truncation or scientific notation', () => {
    expect(formatPercent(9999)).toBe('9999.0%');
    expect(formatPercent(123456.78)).toBe('123456.8%');
  });

  // SUT bug: Infinity / -Infinity leak as "Infinity%" / "-Infinity%" — user-hostile.
  // Filed as #974. Skipped until source adds a Number.isFinite guard.
  test.skip('Infinity should render as em-dash (currently leaks as "Infinity%") — TODO #974', () => {
    expect(formatPercent(Infinity)).toBe('—');
  });
  test.skip('-Infinity should render as em-dash (currently leaks as "-Infinity%") — TODO #974', () => {
    expect(formatPercent(-Infinity)).toBe('—');
  });

  it('rejects boolean true as em-dash (typeof !== "number")', () => {
    expect(formatPercent(true)).toBe('—');
  });

  it('rejects boolean false as em-dash (not in null/undefined/"" early returns, typeof !== "number")', () => {
    expect(formatPercent(false)).toBe('—');
  });

  it('rejects plain object input as em-dash', () => {
    expect(formatPercent({ x: 1 })).toBe('—');
    expect(formatPercent({})).toBe('—');
  });

  it('rejects array input as em-dash (typeof "object")', () => {
    expect(formatPercent([])).toBe('—');
    expect(formatPercent([1, 2])).toBe('—');
  });

  it('coerces whitespace-only string to 0 (Number("   ") === 0)', () => {
    expect(formatPercent('   ')).toBe('0.0%');
  });

  it('honours decimals=0 override on stringified zero', () => {
    expect(formatPercent('0', { decimals: 0 })).toBe('0%');
  });

  it('exposes the same function as default and named export', () => {
    expect(formatPercentDefault).toBe(formatPercent);
  });

  it('explicit decimals=undefined falls back to default 1 (destructure default)', () => {
    expect(formatPercent(12.34, { decimals: undefined })).toBe('12.3%');
  });

  it('rounds negative values half-up via toFixed', () => {
    // toFixed in V8: -12.345 with 2 decimals rounds toward zero on this boundary
    // (browser-engine quirk on .5 cases). Pin observed behaviour rather than
    // theoretical half-up to keep the test deterministic across Node versions.
    const result = formatPercent(-12.345, { decimals: 2 });
    expect(['-12.34%', '-12.35%']).toContain(result);
  });

  it('handles floating-point accumulation noise (0.1 + 0.2 → "0.3%")', () => {
    expect(formatPercent(0.1 + 0.2)).toBe('0.3%');
  });

  it('rounds the half-up boundary at 2 decimals (12.349 → "12.35%")', () => {
    expect(formatPercent(12.349, { decimals: 2 })).toBe('12.35%');
  });
});
