/**
 * Tests for utils/date — closes #627.
 *
 * The acceptance points (per the dispatch + issue body):
 *   - formatDate('2026-05-07', 'en-IN') → DD/MM/YYYY shape (07/05/2026)
 *   - formatDate('2026-05-07', 'en-US') → MM/DD/YYYY shape (05/07/2026)
 *   - Tenant-driven default locale (no 2nd arg) reads localStorage.tenant.locale
 *   - Falls back to en-US when tenant is missing
 *   - Returns '—' for null / empty / NaN / invalid input
 *
 * Format-token portability: Intl renderings of these locales are
 * stable across Node ICU builds for the year-month-day shape (the
 * delimiter never changes — only TZ-name renderings drift). So we
 * pin format-shape via regex rather than literal-string equality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatDate,
  formatDateShort,
  formatDateMedium,
  formatDateLong,
  formatDateTime,
  tenantLocale,
} from '../utils/date';

function setTenant(tenant) {
  if (tenant) localStorage.setItem('tenant', JSON.stringify(tenant));
  else localStorage.removeItem('tenant');
}

describe('utils/date — formatDate (short)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders DD/MM/YYYY for en-IN', () => {
    const out = formatDate('2026-05-07', 'en-IN');
    expect(out).toMatch(/^07[/\-]05[/\-]2026$/);
  });

  it('renders MM/DD/YYYY for en-US', () => {
    const out = formatDate('2026-05-07', 'en-US');
    expect(out).toMatch(/^05[/\-]07[/\-]2026$/);
  });

  it('renders DD/MM/YYYY for en-GB', () => {
    const out = formatDate('2026-05-07', 'en-GB');
    expect(out).toMatch(/^07[/\-]05[/\-]2026$/);
  });

  it('uses tenant.locale from localStorage when no locale arg', () => {
    setTenant({ defaultCurrency: 'INR', locale: 'en-IN' });
    const out = formatDate('2026-05-07');
    expect(out).toMatch(/^07[/\-]05[/\-]2026$/);
  });

  it('derives locale from tenant.defaultCurrency when locale missing', () => {
    setTenant({ defaultCurrency: 'INR' });
    const out = formatDate('2026-05-07');
    expect(out).toMatch(/^07[/\-]05[/\-]2026$/);
  });

  it('falls back to en-US when tenant is missing', () => {
    const out = formatDate('2026-05-07');
    expect(out).toMatch(/^05[/\-]07[/\-]2026$/);
  });

  it('accepts a Date object', () => {
    const d = new Date('2026-05-07T00:00:00.000Z');
    const out = formatDate(d, 'en-US');
    expect(out).toMatch(/^0[45][/\-]0[67][/\-]2026$/); // TZ-tolerant
  });

  it('returns em-dash for null / empty / invalid', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate(NaN)).toBe('—');
  });

  it('formatDate.short matches formatDate (default export)', () => {
    expect(formatDate.short('2026-05-07', 'en-IN'))
      .toBe(formatDate('2026-05-07', 'en-IN'));
    expect(formatDateShort('2026-05-07', 'en-US'))
      .toBe(formatDate('2026-05-07', 'en-US'));
  });
});

describe('utils/date — formatDateMedium / formatDateLong', () => {
  it('medium renders abbreviated month for en-US', () => {
    // "May 7, 2026" (en-US) — Intl emits "May" abbrev
    const out = formatDateMedium('2026-05-07', 'en-US');
    expect(out).toMatch(/May/);
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/7/);
  });

  it('medium renders abbreviated month for en-IN', () => {
    // "7 May 2026" — en-IN order
    const out = formatDateMedium('2026-05-07', 'en-IN');
    expect(out).toMatch(/May/);
    expect(out).toMatch(/2026/);
  });

  it('long renders full month name', () => {
    const out = formatDateLong('2026-05-07', 'en-US');
    expect(out).toMatch(/May/);
    expect(out).toMatch(/7/);
    expect(out).toMatch(/2026/);
  });

  it('returns em-dash for invalid input', () => {
    expect(formatDateMedium(null)).toBe('—');
    expect(formatDateLong(undefined)).toBe('—');
  });
});

describe('utils/date — formatDateTime', () => {
  it('includes both date and time tokens', () => {
    const out = formatDateTime('2026-05-07T15:45:00', 'en-IN');
    // Should contain the year and an HH:MM-ish chunk
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns em-dash for invalid input', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('utils/date — tenantLocale fallback chain', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns tenant.locale when set', () => {
    setTenant({ locale: 'en-GB' });
    expect(tenantLocale()).toBe('en-GB');
  });

  it('derives from tenant.defaultCurrency when locale missing', () => {
    setTenant({ defaultCurrency: 'EUR' });
    expect(tenantLocale()).toBe('en-IE');
  });

  it('falls back to en-US for empty tenant', () => {
    expect(tenantLocale()).toBe('en-US');
  });

  it('falls back to en-US for unknown currency', () => {
    setTenant({ defaultCurrency: 'XYZ' });
    expect(tenantLocale()).toBe('en-US');
  });
});
