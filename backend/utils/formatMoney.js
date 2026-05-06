/**
 * Tenant-aware money formatting (backend-side).
 *
 * Backend port of frontend/src/utils/money.js (kept verbatim semantics —
 * same currency-symbol map, same Intl.NumberFormat call, same fallback).
 *
 * Why it exists backend-side: the wellness vertical's PDF renderer
 * (services/pdfRenderer.js — invoice, prescription, consent), SMS
 * templates, and server-side email rendering all need to format
 * currency in tenant locale. Without this helper, callsites either
 * hardcode `$${amount}` (regression class #286, #330 — `$` showing on
 * a wellness/INR tenant) or drift between callsites.
 *
 * Signature compatibility:
 *   - Gap card #22 contract: formatMoney(310, 'INR', 'en-IN') → '₹310.00'
 *   - Frontend back-compat:  formatMoney(1234, { currency: 'USD' })
 *
 * Both forms are supported. The 2nd argument is treated as a string
 * currency code if it's a string; otherwise as the options object.
 *
 * Usage:
 *   const { formatMoney, currencySymbol } = require('./utils/formatMoney');
 *   formatMoney(1234.5, 'INR', 'en-IN')   // '₹1,234.50'
 *   formatMoney(310, 'INR', 'en-IN')       // '₹310.00'
 *   formatMoney(3.73, 'USD', 'en-US')      // '$3.73'
 */

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

function defaultLocale(currency) {
  return localeByCurrency[currency] || 'en-US';
}

function currencySymbol(currency = 'USD', locale = defaultLocale(currency)) {
  try {
    const parts = new Intl.NumberFormat(locale, {
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
 *
 * @param {number|string} amount - numeric amount (string is parsed via Number())
 * @param {string|object} [currencyOrOpts] - currency code (e.g. 'INR') OR
 *        an options object `{ currency, locale, maximumFractionDigits, minimumFractionDigits }`
 * @param {string} [locale] - BCP-47 locale (e.g. 'en-IN'); only used when 2nd arg is a string
 * @returns {string} formatted money string. Returns '—' for non-finite amount.
 *
 * Acceptance from gap card #22:
 *   - INR formatting: formatMoney(310, 'INR', 'en-IN') → '₹310.00'
 *   - USD formatting: formatMoney(3.73, 'USD', 'en-US') → '$3.73'
 *   - Sub-paise rounded to 2dp: formatMoney(123.456789, 'INR') → '₹123.46'
 *   - Never produces double symbols ($ ₹ or ₹ $)
 *   - On wellness/INR tenant, no path produces $
 */
function formatMoney(amount, currencyOrOpts, locale) {
  const n = Number(amount);
  if (!isFinite(n)) return '—';

  let opts = {};
  if (typeof currencyOrOpts === 'string') {
    opts = { currency: currencyOrOpts, locale };
  } else if (currencyOrOpts && typeof currencyOrOpts === 'object') {
    opts = currencyOrOpts;
  }

  const currency = opts.currency || 'USD';
  const fmtLocale = opts.locale || defaultLocale(currency);

  // Default behaviour: always show 2dp for currency. The gap card
  // explicitly requires `formatMoney(310, 'INR', 'en-IN')` → '₹310.00'
  // (NOT '₹310') and `formatMoney(123.456789, 'INR')` → '₹123.46'.
  const maximumFractionDigits = opts.maximumFractionDigits ?? 2;
  const minimumFractionDigits = opts.minimumFractionDigits ?? 2;

  try {
    return new Intl.NumberFormat(fmtLocale, {
      style: 'currency',
      currency,
      maximumFractionDigits,
      minimumFractionDigits,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

module.exports = {
  formatMoney,
  currencySymbol,
  localeByCurrency,
};
