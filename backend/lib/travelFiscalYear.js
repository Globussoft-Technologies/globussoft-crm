// Travel CRM — Indian fiscal-year helpers + sub-brand invoice-prefix builder.
//
// Indian FY runs April 1 → March 31. A date in 2026-05 (May) lands in FY
// "26-27"; a date in 2026-02 (Feb) lands in FY "25-26".
//
// Prep for #901 slice 5 (per-sub-brand per-FY invoice numbering). The
// existing nextInvoiceNum() in routes/travel_invoices.js uses calendar-year
// "TINV-YYYY-NNNN" and is tenant-scoped only. Travel sub-brands want their
// own per-FY counters formatted like "TS/26-27/0001", "RFU/26-27/0001",
// "TMC/26-27/0001". This module ships ONLY the FY-math + prefix builder
// — the counter / DB write lives in the route (slice 5).
//
// === UTC vs local timezone ===
// All math here uses the input Date's UTC accessors (getUTCFullYear,
// getUTCMonth). Rationale:
//
//   1. Cron-safety — the backend boots with no TZ guarantee on demo /
//      CI / dev machines. A helper that read getMonth() would silently
//      flip a 2026-04-01T00:00:00Z date into FY "25-26" when run on a
//      host whose local TZ is west of UTC (March 31 local).
//   2. Date-only inputs — invoice issue-date is typically a date-only
//      string like "2026-04-01" parsed by the JS engine as UTC midnight.
//      Mixing local accessors against UTC-parsed dates is the canonical
//      off-by-one trap.
//   3. DST is irrelevant — IST has no DST, and even if a caller passes
//      a US-zone date the UTC accessors give a stable answer that
//      doesn't shift on DST boundaries.
//
// Returned `fiscalYearStart` / `fiscalYearEnd` Dates are UTC midnight
// (constructed via Date.UTC). Callers comparing against tenant-local
// "issue date" strings should likewise stay in UTC.
//
// See docs/PRD_TRAVEL_BILLING.md FR (sub-brand invoice numbering).

/**
 * Returns the Indian fiscal-year label for a given Date.
 * FY runs April 1 → March 31. A date in 2026-05 (May) lands in FY "26-27".
 * A date in 2026-02 (Feb) lands in FY "25-26".
 *
 * @param {Date} [date=new Date()] - input date
 * @returns {string} 2-char start / 2-char end of fiscal year, hyphen-joined (e.g. "26-27")
 */
function fiscalYearLabel(date = new Date()) {
  const fyStartYear = _fyStartYear(date);
  const startTwo = String(fyStartYear % 100).padStart(2, '0');
  const endTwo = String((fyStartYear + 1) % 100).padStart(2, '0');
  return `${startTwo}-${endTwo}`;
}

/**
 * Long-form Indian fiscal-year label e.g. "FY2025-26" / "FY2026-27".
 * Used by the public-facing supplier-commission statement + CSV exports
 * (PRD_TRAVEL_SUPPLIER_MASTER G045 — FR-3.5.a / FR-3.5.b). Stored verbatim
 * on the TravelSupplierCommissionEntry row so historical queries stay
 * stable across future FY-helper changes.
 *
 *   fiscalYearLabelLong(new Date('2026-05-15')) → "FY2026-27"
 *   fiscalYearLabelLong(new Date('2026-02-15')) → "FY2025-26"
 *
 * @param {Date} [date=new Date()] - input date
 * @returns {string} "FY<startYear>-<endTwo>" e.g. "FY2025-26"
 */
function fiscalYearLabelLong(date = new Date()) {
  const fyStartYear = _fyStartYear(date);
  const endTwo = String((fyStartYear + 1) % 100).padStart(2, '0');
  return `FY${fyStartYear}-${endTwo}`;
}

/**
 * Validates a long-form FY label string. Returns true iff the input
 * matches the `FY<4-digit-start>-<2-digit-end>` shape AND the end-year
 * literally follows the start-year (e.g. "FY2025-26" ✓, "FY2025-27" ✗,
 * "FY2025-25" ✗). Used by the commission-entry route layer to validate
 * caller-supplied ?fiscalYear filters.
 *
 * @param {string} s - candidate FY label
 * @returns {boolean}
 */
function isValidFyLongLabel(s) {
  if (typeof s !== 'string') return false;
  const m = s.match(/^FY(\d{4})-(\d{2})$/);
  if (!m) return false;
  const start = parseInt(m[1], 10);
  const endTwo = parseInt(m[2], 10);
  const expectedEnd = (start + 1) % 100;
  return endTwo === expectedEnd;
}

/**
 * Returns the inclusive start Date of the FY containing the input date.
 * For 2026-05-15 → returns Date for 2026-04-01T00:00:00Z (UTC midnight).
 *
 * @param {Date} [date=new Date()] - input date
 * @returns {Date} UTC midnight of FY start day
 */
function fiscalYearStart(date = new Date()) {
  const fyStartYear = _fyStartYear(date);
  return new Date(Date.UTC(fyStartYear, 3, 1, 0, 0, 0, 0)); // month index 3 = April
}

/**
 * Returns the EXCLUSIVE end Date of the FY containing the input date.
 * For 2026-05-15 → returns Date for 2027-04-01T00:00:00Z (so FY "26-27"
 * covers 2026-04-01 inclusive through 2027-03-31 23:59:59.999 inclusive).
 *
 * @param {Date} [date=new Date()] - input date
 * @returns {Date} UTC midnight of next FY's start day (exclusive boundary)
 */
function fiscalYearEnd(date = new Date()) {
  const fyStartYear = _fyStartYear(date);
  return new Date(Date.UTC(fyStartYear + 1, 3, 1, 0, 0, 0, 0));
}

// Sub-brand slug → short prefix label. Anything not in the map falls back
// to upper-cased slug. Keep the map tight and grep-able; the call site in
// slice 5 will assert against this.
const SUB_BRAND_LABEL = {
  tmc: 'TMC',
  rfu: 'RFU',
  travel_stall: 'TS',
  visa_sure: 'VS',
};

/**
 * Builds the sub-brand-prefixed invoice prefix for a given subBrand + date.
 * Pure string composition — does NOT touch a database.
 *
 * Examples:
 *   invoicePrefixFor('tmc',          new Date('2026-05-15')) → "TMC/26-27"
 *   invoicePrefixFor('rfu',          new Date('2026-05-15')) → "RFU/26-27"
 *   invoicePrefixFor('travel_stall', new Date('2026-05-15')) → "TS/26-27"
 *   invoicePrefixFor('visa_sure',    new Date('2026-05-15')) → "VS/26-27"
 *   invoicePrefixFor('unknown',      new Date('2026-05-15')) → "UNKNOWN/26-27"
 *
 * Slice 5 will append "/<NNNN>" with a zero-padded serial.
 *
 * @param {string} subBrand - sub-brand slug ("tmc" | "rfu" | "travel_stall" | "visa_sure" | ...)
 * @param {Date} [date=new Date()] - issue date used for FY math
 * @returns {string} "<LABEL>/<fyLabel>" e.g. "TMC/26-27"
 */
function invoicePrefixFor(subBrand, date = new Date()) {
  const slug = String(subBrand || '').toLowerCase();
  const label = SUB_BRAND_LABEL[slug] || String(subBrand || '').toUpperCase();
  return `${label}/${fiscalYearLabel(date)}`;
}

// Internal: returns the calendar year that starts the FY containing `date`.
// April → December: FY-start-year = current year.
// January → March:  FY-start-year = current year - 1.
function _fyStartYear(date) {
  const m = date.getUTCMonth(); // 0 = January, 3 = April
  const y = date.getUTCFullYear();
  return m >= 3 ? y : y - 1;
}

module.exports = {
  fiscalYearLabel,
  fiscalYearLabelLong,
  isValidFyLongLabel,
  fiscalYearStart,
  fiscalYearEnd,
  invoicePrefixFor,
};
