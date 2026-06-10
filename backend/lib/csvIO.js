// Issue #816 — CSV import/export library for wellness list pages.
//
// Implements an RFC-4180 compatible parser + writer used by the per-entity
// import/export endpoints in routes/wellnessCsv.js. Lives in lib/ rather than
// inside the route so the parser + writer can be exercised independently by
// vitest without booting the route's prisma client.
//
// Why a hand-rolled parser rather than papaparse / csv-parse: those aren't
// already on backend/package.json (the only CSV-shaped dep is `xlsx`, which
// is heavyweight for a list-export use case + happens to misparse some
// real-world quoted-comma cases). The library is small enough to maintain
// in-tree and the test surface pins the contract.
//
// Contract:
//   - parseCsv(text)            -> { headers: string[], rows: object[] }
//                                   rows are objects keyed by header name.
//                                   trailing blank lines are dropped.
//                                   embedded newlines inside quoted fields
//                                   are preserved verbatim.
//   - toCsv(headers, rows)      -> string (CRLF line endings + final CRLF)
//                                   rows may be an array-of-arrays OR an
//                                   array-of-objects keyed by header.
//   - withBom(csvString)        -> "\\uFEFF" + csvString (Excel UTF-8 sniff).
//   - escapeCell(value)         -> string (exported for callers building
//                                   custom layouts; same rules as toCsv).

"use strict";

// ── Cell escape ────────────────────────────────────────────────────
//
// Rule: any cell containing `"`, `,`, `\r`, or `\n` is wrapped in `"…"` and
// internal `"` doubled to `""`. null / undefined collapse to "". Date
// instances render as ISO-8601 (no TZ shift). Booleans render as "true" /
// "false" — caller can pre-stringify if a different boolean rendering is
// desired (e.g. "yes" / "no").
function escapeCell(value) {
  if (value === null || value === undefined) return "";
  let s;
  if (value instanceof Date) {
    s = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else if (typeof value === "boolean") {
    s = value ? "true" : "false";
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── Writer ────────────────────────────────────────────────────────
function toCsv(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error("toCsv: headers must be a non-empty array");
  }
  const out = [headers.map(escapeCell).join(",")];
  for (const row of rows || []) {
    let cells;
    if (Array.isArray(row)) {
      cells = row.map(escapeCell);
    } else if (row && typeof row === "object") {
      cells = headers.map((h) => escapeCell(row[h]));
    } else {
      // null / undefined / scalar row → emit a blank line for that header set
      cells = headers.map(() => "");
    }
    out.push(cells.join(","));
  }
  return out.join("\r\n") + "\r\n";
}

function withBom(csvString) {
  // U+FEFF (UTF-8 BOM). Excel sniffs this byte sequence to detect
  // UTF-8 encoding on import; without it, multi-byte glyphs (₹,
  // accented patient names) render as mojibake. We write the BOM via
  // a hex escape rather than a literal so the ESLint
  // `no-irregular-whitespace` rule doesn't flag the source.
  return String.fromCharCode(0xFEFF) + csvString;
}

// ── Parser ────────────────────────────────────────────────────────
//
// State-machine RFC-4180 parser. Handles:
//   * \r\n, \n, and \r line endings (mixed within the same file)
//   * fields wrapped in `"…"` with embedded commas / newlines / `""`-escaped
//     quotes
//   * trailing newline (don't emit a phantom empty row)
//   * UTF-8 BOM at file start (silently stripped)
//
// Does NOT support: quoted fields with mid-field unescaped quotes (treats
// them as literal — same as Excel). Returns `{headers, rows}` where rows
// are objects keyed by header. Missing trailing columns → undefined.
function parseCsv(text) {
  if (typeof text !== "string") {
    throw new Error("parseCsv: input must be a string");
  }
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        // Lookahead — escaped quote?
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    // Outside quotes.
    if (c === '"') {
      // Open-quote ONLY valid at start of field. Mid-field quotes are kept
      // as literals so malformed input doesn't bring the whole file down.
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      // End of record. \r\n is one terminator, not two.
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      if (c === "\r" && i + 1 < len && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Flush any trailing field/row that wasn't terminated by a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  // Drop trailing blank records (a file that ends with \r\n leaves a [""]).
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map((h) => String(h).trim());
  const rows = [];
  for (let r = 1; r < records.length; r += 1) {
    const obj = {};
    const cells = records[r];
    for (let h = 0; h < headers.length; h += 1) {
      const key = headers[h];
      if (!key) continue;
      obj[key] = h < cells.length ? cells[h] : undefined;
    }
    // Pin a hidden row index (1-based against the data, so header is 1
    // and first data row is 2 — same convention as Excel cell refs).
    Object.defineProperty(obj, "__row", { value: r + 1, enumerable: false });
    rows.push(obj);
  }

  return { headers, rows };
}

// ── XLSX helpers ──────────────────────────────────────────────────
//
// Thin wrappers over the `xlsx` SheetJS dependency (already in
// backend/package.json — used by the patient export/template path). Kept
// behind a lazy require so a missing install can't crash module load.
// Used by routes/wellnessCsv.js to emit XLSX template + export buffers and
// to parse uploaded `.xlsx` imports into the same `{ headers, rows }`
// shape parseCsv returns, so the downstream import loop stays format-blind.

let _xlsxLib = null;
function loadXlsx() {
  if (_xlsxLib) return _xlsxLib;
   
  _xlsxLib = require("xlsx");
  return _xlsxLib;
}

function toXlsxBuffer(headers, rows, sheetName = "Sheet1") {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error("toXlsxBuffer: headers must be a non-empty array");
  }
  const XLSX = loadXlsx();
  const aoa = [headers.slice()];
  for (const row of rows || []) {
    if (Array.isArray(row)) {
      aoa.push(headers.map((_h, i) => normalizeXlsxCell(row[i])));
    } else if (row && typeof row === "object") {
      aoa.push(headers.map((h) => normalizeXlsxCell(row[h])));
    } else {
      aoa.push(headers.map(() => ""));
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function normalizeXlsxCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

// parseXlsxBuffer(buffer) -> { headers, rows } matching parseCsv's contract.
// Reads the first sheet, treats row 1 as headers, coerces every cell to a
// string so the row callbacks (which assume CSV semantics) keep working.
function parseXlsxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("parseXlsxBuffer: input must be a Buffer");
  }
  const XLSX = loadXlsx();
  const wb = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[firstSheetName];
  // header:1 -> array of arrays; raw:false -> formatted strings; defval:""
  // so missing trailing cells render as "" instead of undefined.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (!aoa.length) return { headers: [], rows: [] };
  const headers = (aoa[0] || []).map((h) => String(h ?? "").trim());
  const rows = [];
  for (let r = 1; r < aoa.length; r += 1) {
    const cells = aoa[r] || [];
    // Skip completely-blank rows (Excel often pads with empty trailing rows).
    const nonEmpty = cells.some((c) => String(c ?? "").trim() !== "");
    if (!nonEmpty) continue;
    const obj = {};
    for (let h = 0; h < headers.length; h += 1) {
      const key = headers[h];
      if (!key) continue;
      const cell = h < cells.length ? cells[h] : "";
      obj[key] = cell === null || cell === undefined ? "" : String(cell);
    }
    Object.defineProperty(obj, "__row", { value: r + 1, enumerable: false });
    rows.push(obj);
  }
  return { headers, rows };
}

module.exports = {
  parseCsv,
  toCsv,
  withBom,
  escapeCell,
  toXlsxBuffer,
  parseXlsxBuffer,
};
