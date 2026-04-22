/**
 * Tenant-aware money formatting.
 *
 * Reads the current tenant's `defaultCurrency` + `locale` from localStorage
 * (set at login; see App.jsx AuthContext), and formats amounts via Intl.
 * Works for USD, INR, EUR, GBP, AED, SGD, etc. — falls back gracefully.
 *
 * Usage:
 *   import { formatMoney, currencySymbol } from '../utils/money';
 *   formatMoney(1234.5)              // "₹1,234.50"  (for IN tenant)
 *                                     // "$1,234.50"  (for US tenant)
 *   formatMoney(1234, { currency: 'USD' })   // force USD
 *   currencySymbol()                 // "₹" or "$" or …
 */

function readTenant() {
  try {
    return JSON.parse(localStorage.getItem('tenant') || 'null');
  } catch {
    return null;
  }
}

const localeByCurrency = {
  INR: 'en-IN',
  USD: 'en-US',
  EUR: 'en-IE',
  GBP: 'en-GB',
  AED: 'en-AE',
  SGD: 'en-SG',
  AUD: 'en-AU',
  CAD: 'en-CA',
};

export function tenantCurrency() {
  const t = readTenant();
  return t?.defaultCurrency || 'USD';
}

export function tenantLocale() {
  const t = readTenant();
  if (t?.locale) return t.locale;
  return localeByCurrency[tenantCurrency()] || 'en-US';
}

export function currencySymbol(currency = tenantCurrency()) {
  try {
    const parts = new Intl.NumberFormat(tenantLocale(), {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value || currency;
  } catch {
    return currency;
  }
}

/**
 * Format a numeric amount as money.
 * @param {number|string} amount
 * @param {object} [opts] - { currency, locale, maximumFractionDigits }
 */
export function formatMoney(amount, opts = {}) {
  const n = Number(amount);
  if (!isFinite(n)) return '—';
  const currency = opts.currency || tenantCurrency();
  const locale = opts.locale || tenantLocale();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: opts.maximumFractionDigits ?? (n % 1 === 0 ? 0 : 2),
      minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

/**
 * Compact money format (e.g. ₹1.2L, $1.2M) — great for dashboard tiles
 * where space is tight.
 */
export function formatMoneyCompact(amount, opts = {}) {
  const n = Number(amount);
  if (!isFinite(n)) return '—';
  const currency = opts.currency || tenantCurrency();
  const locale = opts.locale || tenantLocale();

  // Indian number system has its own scale (Lakh/Crore). Intl doesn't expose
  // these as notation='compact' directly for INR — build our own in that case.
  if (currency === 'INR' && Math.abs(n) >= 100000) {
    if (Math.abs(n) >= 10000000) return `${currencySymbol('INR')}${(n / 10000000).toFixed(2)}Cr`;
    return `${currencySymbol('INR')}${(n / 100000).toFixed(2)}L`;
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return formatMoney(n, opts);
  }
}
