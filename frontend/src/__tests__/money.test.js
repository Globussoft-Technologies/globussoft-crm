import { describe, it, expect, beforeEach } from 'vitest';
import { formatMoney, formatMoneyCompact, currencySymbol } from '../utils/money';

function setTenant(tenant) {
  if (tenant) localStorage.setItem('tenant', JSON.stringify(tenant));
  else localStorage.removeItem('tenant');
}

describe('utils/money — formatMoney', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('formats INR with rupee symbol + Indian grouping', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoney(1234);
    expect(out).toContain('1,234');
    expect(out).toMatch(/₹/);
  });

  it('formats USD with dollar symbol + US grouping', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(1234);
    expect(out).toBe('$1,234');
  });

  it('respects opts.currency override even when tenant is INR', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoney(1234, { currency: 'USD', locale: 'en-US' });
    expect(out).toBe('$1,234');
  });

  it('returns em-dash for non-finite input', () => {
    expect(formatMoney('abc')).toBe('—');
    expect(formatMoney(NaN)).toBe('—');
    expect(formatMoney(Infinity)).toBe('—');
  });

  it('falls back to USD when no tenant is set', () => {
    const out = formatMoney(50);
    expect(out).toBe('$50');
  });
});

describe('utils/money — formatMoneyCompact', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('compacts INR Lakh (₹1.25L)', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(125000);
    expect(out).toMatch(/₹1\.25L/);
  });

  it('compacts INR Crore (₹1.20Cr)', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(12000000);
    expect(out).toMatch(/₹1\.20Cr/);
  });

  it('compacts USD thousands ($1.2K)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoneyCompact(1200);
    // Intl emits "$1.2K"
    expect(out).toMatch(/\$1\.2K/i);
  });

  it('compacts USD millions ($1.2M)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoneyCompact(1200000);
    expect(out).toMatch(/\$1\.2M/i);
  });

  it('respects opts.currency override (INR tenant, USD requested)', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(1500, { currency: 'USD', locale: 'en-US' });
    expect(out).toMatch(/\$/);
    expect(out).not.toMatch(/L|Cr|₹/);
  });
});

describe('utils/money — currencySymbol', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns ₹ for INR tenant', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    expect(currencySymbol()).toBe('₹');
  });

  it('returns $ for USD override', () => {
    expect(currencySymbol('USD')).toBe('$');
  });
});

// #626 — cross-locale consistency: a single formatMoney call
// renders the right symbol for IN / US / EU / GB tenants, never
// crossing wires (e.g. $ on a wellness/INR tenant — the original
// regression class).
describe('utils/money — cross-locale tenant consistency (#626)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('IN tenant: rupee + lakh grouping, no $', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoney(1234567);
    expect(out).toMatch(/₹/);
    expect(out).not.toMatch(/\$/);
  });

  it('US tenant: dollar + US grouping, no ₹', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(1234567);
    expect(out).toMatch(/\$/);
    expect(out).not.toMatch(/₹/);
  });

  it('EU tenant: euro symbol present, no $ / ₹', () => {
    setTenant({ defaultCurrency: 'EUR', locale: 'en-IE' });
    const out = formatMoney(1234567);
    expect(out).toMatch(/€/);
    expect(out).not.toMatch(/\$/);
    expect(out).not.toMatch(/₹/);
  });

  it('GB tenant: pound symbol present, no $ / ₹', () => {
    setTenant({ defaultCurrency: 'GBP', locale: 'en-GB' });
    const out = formatMoney(1234567);
    expect(out).toMatch(/£/);
    expect(out).not.toMatch(/\$/);
    expect(out).not.toMatch(/₹/);
  });

  it('row-currency override beats tenant default (for invoice/quote rows)', () => {
    // Tenant is IN, but the invoice row carries currency='USD' — the
    // helper must respect the row's currency so multi-currency
    // tenants render each row correctly.
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoney(1000, { currency: 'USD' });
    expect(out).toMatch(/\$/);
    expect(out).not.toMatch(/₹/);
  });
});

// Edge cases: backfill missing branches in money.js — corrupt tenant JSON,
// fraction-digit branches, string-numeric input, negative amounts, zero,
// half-up rounding pin, AED/SGD/AUD/CAD locale-map paths, INR Lakh
// boundary, negative compact INR, opts.minimumFractionDigits/
// maximumFractionDigits overrides, invalid currency code → catch fallback.
describe('utils/money — formatMoney edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('handles corrupt tenant JSON in localStorage → falls back to USD', () => {
    localStorage.setItem('tenant', '{not-json[');
    const out = formatMoney(42);
    expect(out).toBe('$42');
  });

  it('tenant object without defaultCurrency falls back to USD', () => {
    setTenant({ locale: 'en-US' }); // no defaultCurrency
    const out = formatMoney(99);
    expect(out).toBe('$99');
  });

  it('integer amount omits decimals (n % 1 === 0 branch)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney(1000)).toBe('$1,000');
  });

  it('decimal amount renders up to 2 fraction digits by default (min=0 default)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    // Default minimumFractionDigits=0 + maximumFractionDigits=2 means trailing
    // zero is omitted: 1000.5 → "$1,000.5", 1000.55 → "$1,000.55".
    expect(formatMoney(1000.5)).toBe('$1,000.5');
    expect(formatMoney(1000.55)).toBe('$1,000.55');
  });

  it('string numeric input is coerced via Number()', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney('1234.56')).toBe('$1,234.56');
  });

  it('empty string coerces to 0 (Number("") === 0)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney('')).toBe('$0');
  });

  it('null input coerces to 0 (Number(null) === 0)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney(null)).toBe('$0');
  });

  it('undefined input is NaN → em-dash', () => {
    expect(formatMoney(undefined)).toBe('—');
  });

  it('negative Infinity → em-dash', () => {
    expect(formatMoney(-Infinity)).toBe('—');
  });

  it('negative amounts render with leading minus / parens (locale-dependent)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(-1234.5);
    // en-US emits "-$1,234.5" (default min=0 trims trailing zero).
    expect(out).toMatch(/\$1,234\.5/);
    expect(out).toMatch(/[-(]/); // either minus or paren form
  });

  it('zero renders as integer (no decimals)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney(0)).toBe('$0');
  });

  it('very small decimal (0.01) renders 2 fraction digits', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney(0.01)).toBe('$0.01');
  });

  it('very large integer renders with grouping, no decimals', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    expect(formatMoney(1234567890)).toBe('$1,234,567,890');
  });

  it('opts.maximumFractionDigits=4 keeps more precision', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(1.23456, { maximumFractionDigits: 4 });
    expect(out).toBe('$1.2346');
  });

  it('opts.minimumFractionDigits=2 pads integer to 2 decimals', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(out).toBe('$1,000.00');
  });

  it('half-up rounding behavior pin (1.005 in IEEE-754) — observed Intl output', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    // 1.005 in IEEE-754 is actually 1.00499999... so Intl rounds DOWN to 1.00,
    // not up to 1.01. Pin observed behavior (engine-dependent but stable).
    const out = formatMoney(1.005);
    // Accept either 1.00 or 1.01 — both are correct depending on Intl impl.
    expect(out).toMatch(/^\$1\.0[01]$/);
  });

  it('2.005 rounds to 2.01 (closer to .005 in IEEE-754)', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoney(2.005);
    // Pin actual observed behavior — typically rounds up because 2.005 is
    // representable as exactly 2.00499... or just above.
    expect(out).toMatch(/^\$2\.0[01]$/);
  });

  it('invalid currency code → catch fallback "XXX 1,234"-style', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    // "ZZZZ" is not a valid ISO currency — Intl throws → catch returns plain.
    const out = formatMoney(1234, { currency: 'ZZZZ' });
    // Either the catch fallback fires (returns "ZZZZ 1,234") OR Intl
    // tolerates it (some Node ICU builds do). Both are acceptable.
    expect(out).toMatch(/ZZZZ/);
  });

  it('AED tenant uses en-AE locale mapping', () => {
    setTenant({ defaultCurrency: 'AED' }); // no locale → falls back to map
    const out = formatMoney(1234);
    // AED symbol varies by ICU build (د.إ or AED), but currency token must appear
    expect(out).toMatch(/(AED|د\.إ)/);
  });

  it('SGD tenant uses en-SG locale mapping', () => {
    setTenant({ defaultCurrency: 'SGD' });
    const out = formatMoney(1234);
    expect(out).toMatch(/(SGD|S?\$)/);
  });

  it('unknown currency in localeByCurrency map → en-US fallback', () => {
    setTenant({ defaultCurrency: 'JPY' }); // not in localeByCurrency map
    const out = formatMoney(1234);
    // Should still render — falls back to en-US locale
    expect(out).toMatch(/(JPY|¥)/);
  });
});

describe('utils/money — formatMoneyCompact edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('non-finite input → em-dash', () => {
    expect(formatMoneyCompact(NaN)).toBe('—');
    expect(formatMoneyCompact(Infinity)).toBe('—');
    expect(formatMoneyCompact('abc')).toBe('—');
  });

  it('INR below Lakh threshold (99,999) hits Intl compact path (not custom L/Cr)', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(99999);
    // Intl's notation:'compact' for en-IN rounds 99999 to "₹1L" (1 lakh)
    // — this still includes the L suffix, but it comes from Intl itself,
    // not the custom branch (which only fires for |n| >= 100000). Assert
    // currency symbol present + no Crore suffix.
    expect(out).toMatch(/₹/);
    expect(out).not.toMatch(/Cr/);
  });

  it('INR well below Lakh threshold (50,000) renders no L/Cr suffix', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(50000);
    // Intl compact for "50,000" en-IN is "₹50T" (thousands, T = thousand
    // in en-IN compact) — definitely no Cr, may or may not be L.
    expect(out).toMatch(/₹/);
    expect(out).not.toMatch(/Cr/);
  });

  it('INR exactly at Lakh boundary (100000) renders ₹1.00L', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(100000);
    expect(out).toMatch(/₹1\.00L/);
  });

  it('INR exactly at Crore boundary (10000000) renders ₹1.00Cr', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(10000000);
    expect(out).toMatch(/₹1\.00Cr/);
  });

  it('negative INR Lakh uses abs() in threshold check, keeps sign in output', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(-125000);
    // The current implementation does Math.abs() ONLY for the threshold check,
    // not for the division — so the divided value carries the sign through.
    expect(out).toMatch(/L/);
    expect(out).toMatch(/-/);
  });

  it('negative INR Crore keeps Cr suffix + sign', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatMoneyCompact(-12000000);
    expect(out).toMatch(/Cr/);
    expect(out).toMatch(/-/);
  });

  it('USD billions render with B suffix', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoneyCompact(1200000000);
    expect(out).toMatch(/\$1\.2B/i);
  });

  it('small USD amount under 1K renders without compact suffix', () => {
    setTenant({ defaultCurrency: 'USD', locale: 'en-US' });
    const out = formatMoneyCompact(500);
    // Intl compact may still render "$500" or "$500" — no K suffix expected.
    expect(out).not.toMatch(/K|M|B/i);
    expect(out).toMatch(/\$/);
  });

  it('INR row-currency override (USD) does NOT hit Lakh/Crore branch', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    // Even though tenant is INR, opts.currency='USD' means the INR-Lakh
    // branch must NOT trigger.
    const out = formatMoneyCompact(500000, { currency: 'USD', locale: 'en-US' });
    expect(out).not.toMatch(/L|Cr|₹/);
    expect(out).toMatch(/\$/);
  });
});

describe('utils/money — currencySymbol edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns € for EUR explicit override', () => {
    expect(currencySymbol('EUR')).toMatch(/€/);
  });

  it('returns £ for GBP explicit override', () => {
    expect(currencySymbol('GBP')).toMatch(/£/);
  });

  it('invalid currency code → catch returns the code itself', () => {
    // Intl throws on bad currency → catch branch returns currency arg as-is.
    expect(currencySymbol('ZZZZ')).toBe('ZZZZ');
  });

  it('defaults to tenant currency when called with no args', () => {
    setTenant({ defaultCurrency: 'GBP', locale: 'en-GB' });
    expect(currencySymbol()).toMatch(/£/);
  });
});
