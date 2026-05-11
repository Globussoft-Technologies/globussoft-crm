// #665 — shared date-range validator for list/report endpoints.
//
// Multiple list / report routes accept ?from=&to= filters but historically did
// NO validation when `to` was earlier than `from`. The user-visible effect:
// the route silently returned an empty result and the operator concluded the
// underlying data was missing (or worse, that the system had eaten it).
// Surfaces audited and confirmed missing validation prior to this helper:
//   - routes/attribution.js  /report?from&to
//   - routes/audit_viewer.js /?from&to + /export.csv?from&to
//   - routes/inventory.js    /inventory/receipts?from&to + /inventory/adjustments?from&to
//   - routes/attendance.js   /me?from&to + /staff/:userId?from&to + /summary?from&to
// (routes/wellness.js's reportRange() and routes/reports.js's local
// validateDateRange() already validated; we don't disturb their existing
// error-code contracts — the canonical generic /reports surface returns
// `INVERTED_RANGE` and the wellness reports surface returns
// `INVERTED_DATE_RANGE`. New callsites adopt this helper which returns
// `INVERTED_DATE_RANGE` — same shape as the wellness/leave precedent.)
//
// Returns { ok: true, fromDate, toDate } on success.
// Returns { error: { status: 400, code, error } } on any failure.
//
// Inputs:
//   `from` and `to` may be undefined/null/empty strings (treated as absent) —
//   both absent is VALID (caller may interpret as "all time" or apply its own
//   default window).
//
// Error codes:
//   INVALID_DATE         — either input was provided but unparseable
//   INVERTED_DATE_RANGE  — both valid, but to < from
//   DATE_RANGE_TOO_WIDE  — span > maxYears (default 5)
//
// Optional opts:
//   maxYears (default 5) — guard against accidental 1900..9999 sweeps that
//                          OOM the route. Set to 0 to disable.

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function isPresent(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

function validateDateRange({ from, to } = {}, opts = {}) {
  const maxYears = opts.maxYears === undefined ? 5 : Number(opts.maxYears);

  const fromPresent = isPresent(from);
  const toPresent = isPresent(to);

  // Both absent → valid; caller chooses its own default window.
  if (!fromPresent && !toPresent) {
    return { ok: true, fromDate: null, toDate: null };
  }

  let fromDate = null;
  let toDate = null;
  if (fromPresent) {
    fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      return {
        error: {
          status: 400,
          code: "INVALID_DATE",
          error: "'from' is not a valid date",
        },
      };
    }
  }
  if (toPresent) {
    toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      return {
        error: {
          status: 400,
          code: "INVALID_DATE",
          error: "'to' is not a valid date",
        },
      };
    }
  }

  if (fromDate && toDate && toDate.getTime() < fromDate.getTime()) {
    return {
      error: {
        status: 400,
        code: "INVERTED_DATE_RANGE",
        error: "'from' must be on or before 'to'",
      },
    };
  }

  if (
    maxYears > 0 &&
    fromDate &&
    toDate &&
    toDate.getTime() - fromDate.getTime() > maxYears * MS_PER_YEAR
  ) {
    return {
      error: {
        status: 400,
        code: "DATE_RANGE_TOO_WIDE",
        error: `date range must not exceed ${maxYears} years`,
      },
    };
  }

  return { ok: true, fromDate, toDate };
}

module.exports = { validateDateRange };
