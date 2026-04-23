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
