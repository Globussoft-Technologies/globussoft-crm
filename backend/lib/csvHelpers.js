// Wave 7 Agent A — Shared RFC4180 CSV helpers.
//
// Closes PRD Gap §10 item 3 (CSV import/export framework). Promoted to lib/
// from inline implementations in routes/contacts.js (CSV-injection sanitiser,
// formula-prefix detection) and routes/audit_viewer.js (RFC4180 escaping)
// so the four new export/import surfaces (services / products / memberships /
// bookings) share a single canonical implementation.
//
// Why these specific behaviours:
//   - escapeCell wraps any cell containing comma, quote, CR, or LF in double
//     quotes and doubles internal quotes per RFC4180 §2.6/§2.7. ANY mismatch
//     here makes Excel choke on the "name with, comma" row class.
//   - sanitizeCellForExport prefixes a single quote on cells starting with
//     =, +, -, @, tab, or CR — these are spreadsheet formula-injection
//     vectors (CVE-class). Applied on EXPORT, not import — the value stored
//     in the DB stays clean; the spreadsheet-targeted prefix is added at the
//     moment we hand bytes to Excel/Sheets/Numbers.
//   - serializeRows accepts an array of objects + a column-spec list and
//     returns an RFC4180-formatted string with UTF-8 BOM prefix. The BOM
//     is essential for Excel-on-Windows to interpret UTF-8 correctly when
//     opening a .csv directly (without BOM, "Müller" comes through as garbage).
//   - parseCsv is a single-pass RFC4180 parser tolerant of CRLF, LF, and CR
//     line endings + Excel's "double quote escape" inside a quoted field. No
//     external dependency; the project doesn't currently bundle a csv-parser
//     and we don't want to add one for ~150 lines of code.
//
// All helpers are pure and exception-free at the cell level — bad rows
// surface as parse errors with a row-number context that callers turn into
// the per-row error report (rowNumber + reason CSV).

const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_RE = /[",\r\n]/;
const UTF8_BOM = "﻿";

/**
 * Wrap a cell in double quotes + double any internal quotes per RFC4180.
 * null / undefined render as empty string. Numbers + booleans coerce via String().
 * @param {*} value
 * @returns {string}
 */
function escapeCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (NEEDS_QUOTING_RE.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Prefix a single quote on cells that look like spreadsheet formulas.
 * Pure no-op on non-strings + on safe cells. Used on export only — the
 * value persisted in the database is unmodified.
 * @param {*} value
 * @returns {*}
 */
function sanitizeCellForExport(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return FORMULA_INJECTION_RE.test(value) ? `'${value}` : value;
}

/**
 * Serialise an array of row objects into an RFC4180 CSV string with UTF-8 BOM.
 * @param {Array<{key: string, header: string, render?: (row: any) => any}>} columns
 *   - key:    object key on each row
 *   - header: human-readable column header
 *   - render: optional transformer (defaults to row[key])
 * @param {Array<Object>} rows
 * @returns {string}
 */
function serializeRows(columns, rows) {
  const headerLine = columns.map((c) => escapeCell(c.header)).join(",");
  const bodyLines = rows.map((row) =>
    columns
      .map((c) => {
        const raw = c.render ? c.render(row) : row[c.key];
        const sanitized = sanitizeCellForExport(raw);
        return escapeCell(sanitized);
      })
      .join(","),
  );
  return UTF8_BOM + [headerLine, ...bodyLines].join("\r\n");
}

/**
 * Single-pass RFC4180 parser. Tolerates CRLF / LF / CR line endings + escape
 * sequences inside quoted fields. Returns { headers, rows } where rows is an
 * array of objects keyed by header.
 *
 * Strips the UTF-8 BOM if present (Excel-on-Windows exports include it).
 * @param {string} input
 * @returns {{ headers: string[], rows: Object[] }}
 */
function parseCsv(input) {
  if (typeof input !== "string") throw new TypeError("parseCsv expects a string");
  // Strip UTF-8 BOM
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // close field + row
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      // swallow CRLF as a single newline
      if (ch === "\r" && i + 1 < len && input[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Tail: flush final field/row if file didn't end with newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  if (records.length === 0) return { headers: [], rows: [] };

  // Skip trailing all-empty rows that Excel appends.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] === undefined ? "" : r[idx];
    });
    return obj;
  });

  return { headers, rows };
}

/**
 * Build a per-row error-report CSV for failed import rows. Returns the body
 * of the report (caller sets Content-Type + Disposition).
 * @param {Array<{ rowNumber: number, reason: string }>} errors
 * @returns {string}
 */
function buildErrorReport(errors) {
  const cols = [
    { key: "rowNumber", header: "rowNumber" },
    { key: "reason", header: "reason" },
  ];
  return serializeRows(cols, errors);
}

/**
 * Set the standard CSV-download response headers.
 * @param {import('express').Response} res
 * @param {string} filename
 */
function setCsvDownloadHeaders(res, filename) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

module.exports = {
  escapeCell,
  sanitizeCellForExport,
  serializeRows,
  parseCsv,
  buildErrorReport,
  setCsvDownloadHeaders,
  UTF8_BOM,
  FORMULA_INJECTION_RE,
};
