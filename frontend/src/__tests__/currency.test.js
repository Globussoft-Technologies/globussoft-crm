import { describe, it, expect } from 'vitest';
import {
  CURRENCY_SYMBOLS,
  formatCurrency,
  convertCurrency,
  parseCurrency,
} from '../utils/currency';

describe('utils/currency — CURRENCY_SYMBOLS table', () => {
  it('covers all the majors the CRM cares about', () => {
    expect(CURRENCY_SYMBOLS.USD).toBe('$');
    expect(CURRENCY_SYMBOLS.INR).toBe('₹');
    expect(CURRENCY_SYMBOLS.EUR).toBe('€');
    expect(CURRENCY_SYMBOLS.GBP).toBe('£');
    expect(CURRENCY_SYMBOLS.AED).toBe('د.إ');
  });
});

describe('utils/currency — formatCurrency', () => {
  it('formats USD with 2 decimals + US grouping', () => {
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatCurrency(0, 'USD')).toBe('$0.00');
  });

  it('formats INR with Indian lakh/crore grouping', () => {
    expect(formatCurrency(100000, 'INR')).toBe('₹1,00,000.00');
    expect(formatCurrency(12345678, 'INR')).toBe('₹1,23,45,678.00');
  });

  it('formats zero-decimal currencies (JPY) without fractional part', () => {
    expect(formatCurrency(1234.5, 'JPY')).toBe('¥1,235');
    expect(formatCurrency(1234.5, 'KRW')).toMatch(/₩1,234|₩1,235/);
  });

  it('handles negative amounts with leading minus', () => {
    expect(formatCurrency(-500, 'USD')).toBe('-$500.00');
    expect(formatCurrency(-100000, 'INR')).toBe('-₹1,00,000.00');
  });

  it('falls back to "<CODE> " prefix for unknown codes', () => {
    expect(formatCurrency(100, 'XYZ')).toBe('XYZ 100.00');
  });

  it('defaults to USD when no code is passed', () => {
    expect(formatCurrency(100)).toBe('$100.00');
  });

  it('coerces string amounts + NaN to 0', () => {
    expect(formatCurrency('1234.5', 'USD')).toBe('$1,234.50');
    expect(formatCurrency('junk', 'USD')).toBe('$0.00');
    // NaN branch: Number.isFinite(NaN)=false, parseFloat(NaN)=NaN, NaN||0=0
    expect(formatCurrency(NaN, 'USD')).toBe('$0.00');
  });

  it('Infinity passes through as "∞" symbol (current behavior)', () => {
    // Known-quirk path: Number.isFinite(Infinity)=false, parseFloat(Infinity)=Infinity,
    // Infinity||0 = Infinity (truthy), so value stays Infinity and toLocaleString renders it.
    expect(formatCurrency(Infinity, 'USD')).toBe('$∞');
  });

  it('lowercases codes are upper-cased internally', () => {
    expect(formatCurrency(100, 'inr')).toMatch(/₹100/);
  });

  it('INR below 1000 has no grouping', () => {
    expect(formatCurrency(999, 'INR')).toBe('₹999.00');
  });
});

describe('utils/currency — convertCurrency', () => {
  const currencies = [
    { code: 'USD', exchangeRate: 1 },
    { code: 'INR', exchangeRate: 83 },
    { code: 'EUR', exchangeRate: 0.92 },
  ];

  it('returns input unchanged when from === to', () => {
    expect(convertCurrency(100, 'USD', 'USD', currencies)).toBe(100);
    expect(convertCurrency(100, 'inr', 'INR', currencies)).toBe(100);
  });

  it('converts USD → INR using exchange rates', () => {
    expect(convertCurrency(100, 'USD', 'INR', currencies)).toBeCloseTo(8300);
  });

  it('converts INR → USD (inverse path)', () => {
    expect(convertCurrency(8300, 'INR', 'USD', currencies)).toBeCloseTo(100);
  });

  it('returns original value when a currency is missing from the list', () => {
    expect(convertCurrency(100, 'USD', 'XYZ', currencies)).toBe(100);
    expect(convertCurrency(100, 'ABC', 'USD', currencies)).toBe(100);
  });

  it('handles empty/non-numeric amounts', () => {
    expect(convertCurrency('abc', 'USD', 'INR', currencies)).toBe(0);
    expect(convertCurrency(null, 'USD', 'INR', currencies)).toBe(0);
  });

  it('defaults exchangeRate=1 when string-rate unparseable', () => {
    const broken = [
      { code: 'USD', exchangeRate: 'abc' },
      { code: 'XYZ', exchangeRate: null },
    ];
    expect(convertCurrency(100, 'USD', 'XYZ', broken)).toBe(100);
  });
});

describe('utils/currency — parseCurrency', () => {
  it('parses a plain number', () => {
    expect(parseCurrency(1234)).toBe(1234);
  });

  it('strips $ and US grouping', () => {
    expect(parseCurrency('$1,234.56')).toBeCloseTo(1234.56);
  });

  it('strips ₹ and Indian grouping', () => {
    expect(parseCurrency('₹1,23,456.78')).toBeCloseTo(123456.78);
  });

  it('handles negative amounts with leading minus', () => {
    expect(parseCurrency('-$500.00')).toBe(-500);
  });

  it('returns 0 for null / empty / junk', () => {
    expect(parseCurrency(null)).toBe(0);
    expect(parseCurrency('')).toBe(0);
    expect(parseCurrency('no-digits-here')).toBe(0);
    expect(parseCurrency('.')).toBe(0);
    expect(parseCurrency('-')).toBe(0);
  });
});
