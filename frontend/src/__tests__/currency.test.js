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

  it('covers the regional/secondary symbols (prefix-style + non-Latin)', () => {
    // Prefix-style North-American + APAC dollars
    expect(CURRENCY_SYMBOLS.CAD).toBe('C$');
    expect(CURRENCY_SYMBOLS.AUD).toBe('A$');
    expect(CURRENCY_SYMBOLS.HKD).toBe('HK$');
    expect(CURRENCY_SYMBOLS.SGD).toBe('S$');
    expect(CURRENCY_SYMBOLS.NZD).toBe('NZ$');
    expect(CURRENCY_SYMBOLS.BRL).toBe('R$');
    expect(CURRENCY_SYMBOLS.MXN).toBe('Mex$');
    // Non-Latin / ISO-letter symbols
    expect(CURRENCY_SYMBOLS.CHF).toBe('CHF');
    expect(CURRENCY_SYMBOLS.ZAR).toBe('R');
    expect(CURRENCY_SYMBOLS.SAR).toBe('ر.س');
    expect(CURRENCY_SYMBOLS.KRW).toBe('₩');
    expect(CURRENCY_SYMBOLS.RUB).toBe('₽');
    expect(CURRENCY_SYMBOLS.TRY).toBe('₺');
    expect(CURRENCY_SYMBOLS.THB).toBe('฿');
    // JPY and CNY share the ¥ glyph
    expect(CURRENCY_SYMBOLS.JPY).toBe('¥');
    expect(CURRENCY_SYMBOLS.CNY).toBe('¥');
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

  it('rounds floats per .toFixed(2) JS-builtin semantics (pinned)', () => {
    // .toFixed(2) results are ICU-/Node-build-portable; we pin the current outputs
    // so any future helper-swap to a different rounder (round-half-to-even, etc.) shows up.
    // Note: 1.005 → "$1.00" or "$1.01" depending on the float64 representation — both have
    // been observed across Node minors, so accept either.
    expect(formatCurrency(1.005, 'USD')).toMatch(/^\$1\.0[01]$/);
    expect(formatCurrency(1.015, 'USD')).toBe('$1.02');
    // 0.1+0.2 = 0.30000000000000004 in float64; toFixed(2) → "0.30"
    expect(formatCurrency(0.1 + 0.2, 'USD')).toBe('$0.30');
  });

  it('formats crore-scale INR with deep lakh/crore grouping', () => {
    // 10 crore = 10,00,00,000
    expect(formatCurrency(100000000, 'INR')).toBe('₹10,00,00,000.00');
    // 100 crore
    expect(formatCurrency(1000000000, 'INR')).toBe('₹1,00,00,00,000.00');
  });

  it('handles null + undefined codes by defaulting to USD', () => {
    // String(null||'USD') -> 'USD', String(undefined||'USD') -> 'USD'
    expect(formatCurrency(100, null)).toBe('$100.00');
    expect(formatCurrency(100, undefined)).toBe('$100.00');
  });

  it('zero-decimal codes WITHOUT a symbol entry hit the fallback prefix with 0 decimals', () => {
    // VND / CLP / IDR are in ZERO_DECIMAL_CODES but not in CURRENCY_SYMBOLS
    // -> fallback symbol "VND " and 0 decimals
    expect(formatCurrency(1234.5, 'VND')).toBe('VND 1,235');
    expect(formatCurrency(1234.5, 'IDR')).toBe('IDR 1,235');
    expect(formatCurrency(1234.5, 'CLP')).toBe('CLP 1,235');
  });

  it('handles tiny negative fractions and -0 sanely', () => {
    // -0.001 → toFixed(2) = '-0.00', and sign branch prepends -, formatIndian path strips leading -
    // Western path: toLocaleString('-0.001'.toFixed(2)=-0.00) → '-0.00', value < 0 is false (−0 < 0 is false),
    // so the OUTER branch keeps the locale's negative sign.
    const s = formatCurrency(-0.001, 'USD');
    expect(s).toMatch(/0\.00$/); // resolves to either '$0.00' or '-$0.00'/'$-0.00' depending on locale
    // Strongly-negative small fraction should clip to -$0.01 because toFixed(2) on -0.009 → '-0.01'
    expect(formatCurrency(-0.009, 'USD')).toBe('-$0.01');
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

  it('returns value unchanged when currencies arg is omitted (defaults to [])', () => {
    // No currency list → from/to lookups both miss → value passthrough
    expect(convertCurrency(100, 'USD', 'INR')).toBe(100);
  });

  it('returns value unchanged when from/to codes are null or empty', () => {
    // String(null||'') → '' → ''.toUpperCase() === '' on both sides → from === to short-circuit
    expect(convertCurrency(100, null, null, currencies)).toBe(100);
    expect(convertCurrency(100, '', '', currencies)).toBe(100);
  });

  it('preserves sign across conversion (negative amounts)', () => {
    // Refunds / chargebacks flow through the same helper
    expect(convertCurrency(-100, 'USD', 'INR', currencies)).toBeCloseTo(-8300);
    expect(convertCurrency(-83, 'INR', 'USD', currencies)).toBeCloseTo(-1);
  });

  it('chains via base currency for non-USD ↔ non-USD pairs (INR → EUR)', () => {
    // amount_in_base = 8300/83 = 100 USD ; * 0.92 → 92 EUR
    expect(convertCurrency(8300, 'INR', 'EUR', currencies)).toBeCloseTo(92);
    // EUR → INR : 92/0.92=100 USD ; * 83 → 8300 INR
    expect(convertCurrency(92, 'EUR', 'INR', currencies)).toBeCloseTo(8300);
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

  it('passes numeric inputs through unchanged (including 0, negatives, floats)', () => {
    // Short-circuits at typeof === 'number'
    expect(parseCurrency(0)).toBe(0);
    expect(parseCurrency(-500)).toBe(-500);
    expect(parseCurrency(1234.56)).toBeCloseTo(1234.56);
    // NaN is technically a number → passes through (current behavior — pin it)
    expect(Number.isNaN(parseCurrency(NaN))).toBe(true);
  });

  it('returns 0 for undefined (null-coalescing branch)', () => {
    // `str == null` matches both null and undefined
    expect(parseCurrency(undefined)).toBe(0);
  });

  it('strips arbitrary symbol prefixes + suffixes and whitespace', () => {
    expect(parseCurrency('€ 1,234.56')).toBeCloseTo(1234.56);
    expect(parseCurrency('£500')).toBe(500);
    expect(parseCurrency('  $42.00  ')).toBe(42);
    // CHF-style ISO prefix with space
    expect(parseCurrency('CHF 999.99')).toBeCloseTo(999.99);
    // Trailing currency code (some PDFs render this way)
    expect(parseCurrency('1,000.00 USD')).toBe(1000);
  });

  it('parses negative INR amounts with lakh/crore grouping', () => {
    expect(parseCurrency('-₹1,23,456.78')).toBeCloseTo(-123456.78);
    expect(parseCurrency('-₹1,00,00,000.00')).toBe(-10000000);
  });

  it('multiple dots or stray dashes survive parseFloat (current behavior — pin it)', () => {
    // parseFloat('1.2.3') === 1.2 ; parseFloat('1-2') === 1 — these are JS-builtin quirks we inherit
    expect(parseCurrency('$1.2.3')).toBeCloseTo(1.2);
    expect(parseCurrency('1-2')).toBe(1);
  });
});
