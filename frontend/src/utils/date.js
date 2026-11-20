/**
 * Tenant-aware date formatting (frontend).
 *
 * Closes #627 — date format inconsistency. Sweeps every ad-hoc
 * `.toLocaleDateString()` call and `${y}-${m}-${d}` string-build in
 * pages/ + components/ onto a single helper that respects the
 * tenant's `locale` (en-IN → DD/MM/YYYY, en-US → MM/DD/YYYY, etc.).
 *
 * The four exported helpers cover the formats issue #627 calls out:
 *   - formatDate.short    — locale-canonical short date     (08/05/2026 vs 5/8/2026)
 *   - formatDate.medium   — locale month-name short          (8 May 2026 / May 8, 2026)
 *   - formatDate.long     — locale month-name long           (8 May 2026 / May 8, 2026)
 *   - formatDate.dateTime — short date + short time          (08/05/2026, 15:45)
 *
 * Default-export `formatDate(value, locale?)` is the most common form
 * (the short variant) so callsites stay terse:
 *
 *     import { formatDate } from '../utils/date';
 *     formatDate(visit.createdAt)              // uses tenant locale
 *     formatDate(visit.createdAt, 'en-IN')     // forces a locale
 *
 * Locale resolution mirrors utils/money.js:
 *   1. opts.locale (explicit)
 *   2. tenant.locale (from localStorage, set at login)
 *   3. derived from tenant.defaultCurrency (INR→en-IN, USD→en-US, …)
 *   4. 'en-US' fallback
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

export function tenantLocale() {
  const t = readTenant();
  if (t?.locale) return t.locale;
  if (t?.defaultCurrency && localeByCurrency[t.defaultCurrency]) {
    return localeByCurrency[t.defaultCurrency];
  }
  return 'en-US';
}

export function tenantTimezone(tenant = readTenant()) {
  return tenant?.vertical === 'generic' ? tenant.timezone || 'UTC' : undefined;
}

export function workspaceDayKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = toDate(value);
  if (!date) return '';
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tenantTimezone() };
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  const { year, month, day } = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${year}-${month}-${day}`;
}

// Date-only fields are calendar dates. Preserve them even when an instant
// at UTC midnight would otherwise appear as the previous day.
export function formatTimestamp(value, options = {}, locale) {
  const date = toDate(value);
  if (!date) return '—';
  const timeZone = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? 'UTC'
    : options.timeZone || tenantTimezone();
  try {
    return new Intl.DateTimeFormat(locale || tenantLocale(), { ...options, timeZone }).format(date);
  } catch {
    return date.toISOString();
  }
}

function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Locale-canonical short date: 08/05/2026 (en-IN) / 05/08/2026 (en-US).
 * en-IN renders DD/MM/YYYY by Intl spec; en-US renders MM/DD/YYYY.
 *
 * @param {string|number|Date|null|undefined} value
 * @param {string} [locale]
 * @returns {string} formatted date or '—' when value is missing/invalid
 */
export function formatDateShort(value, locale) {
  return formatTimestamp(value, { year: 'numeric', month: '2-digit', day: '2-digit' }, locale);
}

/**
 * Medium date — abbreviated month name (8 May 2026 / May 8, 2026).
 */
export function formatDateMedium(value, locale) {
  return formatTimestamp(value, { year: 'numeric', month: 'short', day: 'numeric' }, locale);
}

/**
 * Long date — full month name (8 May 2026 / May 8, 2026).
 */
export function formatDateLong(value, locale) {
  return formatTimestamp(value, { year: 'numeric', month: 'long', day: 'numeric' }, locale);
}

/**
 * Short date + short time (08/05/2026, 15:45 / 5/8/2026, 3:45 PM).
 */
export function formatDateTime(value, locale) {
  return formatTimestamp(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }, locale);
}

/**
 * Default — the short locale-canonical form. The most common usage on
 * tables/cards/timeline rows.
 */
export function formatDate(value, locale) {
  return formatDateShort(value, locale);
}

formatDate.short = formatDateShort;
formatDate.medium = formatDateMedium;
formatDate.long = formatDateLong;
formatDate.dateTime = formatDateTime;

export default formatDate;
