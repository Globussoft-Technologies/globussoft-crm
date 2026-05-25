// CA-friendly invoice summary CSV — PRD §4.4 CA / Tally export.
//
// One row per invoice, GST broken out so a chartered accountant can
// file GSTR-1 by pivoting/totaling. Header row pinned (changing it
// breaks downstream spreadsheets accountants build):
//
//   Invoice Number,Issue Date,Contact Name,Billing State,
//   Subtotal (Taxable),CGST,SGST,IGST,Total,Status,Sub-Brand,Notes
//
// Values are CSV-escaped per RFC 4180: fields containing comma /
// quote / newline / carriage-return are wrapped in double-quotes;
// embedded quotes are doubled.

const CSV_HEADER = [
  "Invoice Number",
  "Issue Date",
  "Contact Name",
  "Billing State",
  "Subtotal (Taxable)",
  "CGST",
  "SGST",
  "IGST",
  "Total",
  "Status",
  "Sub-Brand",
  "Notes",
];

/**
 * RFC 4180 escape. Strings containing `,` / `"` / `\n` / `\r` are
 * wrapped in double-quotes; embedded quotes are doubled. null/undefined
 * → empty string (NOT the literal "null"/"undefined").
 *
 * @param {*} s
 * @returns {string}
 */
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format an ISO date / Date object as YYYY-MM-DD for the CSV.
 * Empty string on null / invalid input — keeps the column count
 * stable so accountants' formulas don't break.
 */
function csvDate(d) {
  if (d == null || d === "") return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function csvAmount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

/**
 * @typedef {Object} CsvInvoice
 * @property {string} invoiceNumber
 * @property {Date|string} issueDate
 * @property {string} contactName
 * @property {string} [billingState]
 * @property {number} subtotal
 * @property {number} [cgstAmount]
 * @property {number} [sgstAmount]
 * @property {number} [igstAmount]
 * @property {number} totalAmount
 * @property {string} [status]
 * @property {string} [subBrand]
 * @property {string} [notes]
 */

/**
 * Build the CA summary CSV. Returns a string with a pinned header row
 * + one row per invoice. Trailing newline (RFC 4180 §2.2).
 *
 * @param {CsvInvoice[]} invoices
 * @returns {string}
 */
function buildCaCsv(invoices) {
  const list = Array.isArray(invoices) ? invoices : [];
  const lines = [CSV_HEADER.map(csvEscape).join(",")];

  for (const inv of list) {
    const row = [
      inv.invoiceNumber,
      csvDate(inv.issueDate),
      inv.contactName,
      inv.billingState || "",
      csvAmount(inv.subtotal),
      csvAmount(inv.cgstAmount),
      csvAmount(inv.sgstAmount),
      csvAmount(inv.igstAmount),
      csvAmount(inv.totalAmount),
      inv.status || "",
      inv.subBrand || "",
      inv.notes || "",
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  return lines.join("\n") + "\n";
}

module.exports = { buildCaCsv, csvEscape, CSV_HEADER };
