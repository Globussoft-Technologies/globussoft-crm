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

import { describe, it, expect } from 'vitest';
import { formatPercent } from '../utils/percent';

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
});
