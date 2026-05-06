/**
 * Tenant-aware datetime helpers (backend-side).
 *
 * Why this module exists — the bug class it pins:
 *   #313: datetime-local form input parsed naively, drifting by the tenant's
 *         TZ offset on save. A user entering '10:30' saw '05:00' after refresh
 *         (UTC equivalent) on an Asia/Kolkata tenant.
 *   #244: Visit timestamps were rendering UTC, not tenant TZ. Cosmetic but wrong.
 *   #387: AuditLog rows have only a UTC timestamp; reviewers reading the audit
 *         can't tell what the local-time-of-action was without doing offset math.
 *
 * Every datetime store/render path on a multi-tenant CRM faces the same three
 * shapes:
 *
 *   1. Parse datetime-local form input (no timezone in the string) IN the
 *      tenant's timezone, store as UTC. → parseDateTimeLocalInTZ
 *   2. Render a stored UTC Date in the tenant's timezone with a TZ label so
 *      the reader knows the wall-clock context. → formatInTenantTZ
 *   3. "Right now in tenant's TZ" — for stamping an audit row's local-time
 *      label, defaulting a form field, etc. → nowInTZ
 *
 * Powered by date-fns-tz (already a dep). Don't roll your own offset math —
 * the library handles DST transitions, IANA zone aliases, half-hour offsets
 * (Asia/Kolkata, Asia/Tehran, Australia/Eucla), and zone-rule history.
 *
 * Usage:
 *   const { parseDateTimeLocalInTZ, formatInTenantTZ, nowInTZ } =
 *     require('./lib/datetime');
 *
 *   // #313 round-trip — store / read are inverses:
 *   const utc = parseDateTimeLocalInTZ('2026-05-15T10:30', 'Asia/Kolkata');
 *   utc.toISOString();                              // '2026-05-15T05:00:00.000Z'
 *   formatInTenantTZ(utc, 'Asia/Kolkata');          // '2026-05-15 10:30 IST'
 *   formatInTenantTZ(utc, 'Asia/Kolkata',
 *     "yyyy-MM-dd'T'HH:mm");                        // '2026-05-15T10:30'
 *
 *   // #244 — render Visit timestamp in tenant TZ:
 *   formatInTenantTZ(visit.startsAt, tenant.timezone || 'Asia/Kolkata');
 *
 *   // #387 — audit-row render:
 *   formatInTenantTZ(audit.createdAt, viewerTZ);    // includes ' IST' / ' GMT-5'
 *
 * Path B note (regression-coverage-backlog #23): this module was created
 * fresh. Existing callsites (routes/wellness.js IST_OFFSET_MS shortcut,
 * any naive `new Date(req.body.foo)` constructions) are NOT migrated by
 * this commit — that's a follow-up sweep tracked in TODOS.md.
 */

const { fromZonedTime, formatInTimeZone } = require('date-fns-tz');

const DEFAULT_DATETIME_LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";
const DEFAULT_DISPLAY_FORMAT = 'yyyy-MM-dd HH:mm zzz';

/**
 * Parse a datetime-local string ('YYYY-MM-DDTHH:mm' or with seconds) as if
 * the wall-clock time were in `tz`, returning a UTC Date.
 *
 * #313 contract: parseDateTimeLocalInTZ('2026-05-15T10:30', 'Asia/Kolkata')
 * produces a Date whose .toISOString() === '2026-05-15T05:00:00.000Z'.
 *
 * @param {string} input - 'YYYY-MM-DDTHH:mm' or 'YYYY-MM-DDTHH:mm:ss'
 * @param {string} tz - IANA zone (e.g. 'Asia/Kolkata', 'America/New_York')
 * @returns {Date} UTC Date. Returns Invalid Date for malformed input or
 *   unknown TZ — caller should isNaN(date.getTime()) check.
 */
function parseDateTimeLocalInTZ(input, tz) {
  if (typeof input !== 'string' || input.length === 0) {
    return new Date(NaN);
  }
  if (typeof tz !== 'string' || tz.length === 0) {
    return new Date(NaN);
  }
  // datetime-local can come without seconds ('2026-05-15T10:30') — fromZonedTime
  // handles both, but we normalise to seconds form for clarity.
  const normalised =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input) ? `${input}:00` : input;
  try {
    return fromZonedTime(normalised, tz);
  } catch {
    return new Date(NaN);
  }
}

/**
 * Render a Date in the given timezone with an optional date-fns format.
 *
 * Default format is 'yyyy-MM-dd HH:mm zzz' which produces strings like
 * '2026-05-15 10:30 IST' (Asia/Kolkata) or '2026-01-15 10:30 GMT-5'
 * (America/New_York in winter — DST-aware).
 *
 * #244 contract: stored UTC Visit.startsAt renders in tenant TZ.
 * #387 contract: output always includes a TZ label (the trailing 'zzz' token).
 *
 * @param {Date|string|number} date - any value Date can construct from
 * @param {string} tz - IANA zone
 * @param {string} [fmt] - date-fns format string (default includes TZ label)
 * @returns {string} formatted string, or '—' for invalid input.
 */
function formatInTenantTZ(date, tz, fmt) {
  if (date == null) return '—';
  if (typeof tz !== 'string' || tz.length === 0) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '—';
  const useFmt = fmt || DEFAULT_DISPLAY_FORMAT;
  try {
    return formatInTimeZone(d, tz, useFmt);
  } catch {
    return '—';
  }
}

/**
 * Format a Date as a datetime-local input value (no TZ suffix) in the given
 * timezone. This is the *render* half of the #313 round-trip — feeding back
 * into a <input type="datetime-local"> after a save reload.
 *
 * @param {Date|string|number} date
 * @param {string} tz - IANA zone
 * @returns {string} 'YYYY-MM-DDTHH:mm' or '—' for invalid input.
 */
function toDateTimeLocalInTZ(date, tz) {
  return formatInTenantTZ(date, tz, DEFAULT_DATETIME_LOCAL_FORMAT);
}

/**
 * Convenience: "right now" rendered in the given timezone, default display
 * format. Equivalent to formatInTenantTZ(new Date(), tz).
 *
 * @param {string} tz - IANA zone
 * @param {string} [fmt] - date-fns format (default includes TZ label)
 * @returns {string}
 */
function nowInTZ(tz, fmt) {
  return formatInTenantTZ(new Date(), tz, fmt);
}

module.exports = {
  parseDateTimeLocalInTZ,
  formatInTenantTZ,
  toDateTimeLocalInTZ,
  nowInTZ,
  DEFAULT_DATETIME_LOCAL_FORMAT,
  DEFAULT_DISPLAY_FORMAT,
};
