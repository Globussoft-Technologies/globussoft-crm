// Travel-invoice CA / Tally exporters — TRAVEL_CRM_PRD §4.4 (gap A2,
// docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md).
//
// PURE functions — no Prisma, no I/O. The route layer
// (backend/routes/travel_invoices.js GET /invoices/export/tally.xml +
// GET /invoices/export/ca.csv) does the DB fetch, the per-line GST math
// (same conventions as the gstr1-export endpoint in that file: taxable =
// SAC-bearing lines only, rate via gstRateForCategory, CGST/SGST vs IGST
// split via resolveStateCodes + isInterstateSupply) and the sub-brand
// legal-entity resolution (lib/subBrandConfig.js), then hands this module
// an array of normalized invoice rows.
//
// Sibling modules (generic-CRM Invoice flavour of the same PRD section):
//   backend/lib/tallyXmlExport.js  — envelope conventions mirrored here
//   backend/lib/caCsvExport.js     — RFC 4180 escaping conventions mirrored
// The travel flavour differs enough (per-line SAC rows, TCS 206C ledger,
// sub-brand + legal-entity narration, GST precomputed by the route) that a
// separate module is cleaner than parameterizing the generic one.
//
// === Normalized invoice shape (consumed by BOTH exporters) ===
//
// @typedef {Object} TravelExportLine
// @property {string} [description]    - line description
// @property {string} [sacCode]        - HSN/SAC code ("9963" / "9985"), null when N/A
// @property {number} taxableValue     - line taxable amount (pre-GST, INR 2dp)
// @property {number} [cgst]           - line CGST (0 when interstate)
// @property {number} [sgst]           - line SGST (0 when interstate)
// @property {number} [igst]           - line IGST (0 when intrastate)
//
// @typedef {Object} TravelExportInvoice
// @property {string} invoiceNum         - voucher number, e.g. "TINV-2026-0001"
// @property {Date|string} date          - invoice date (createdAt proxy — see the
//                                          slice-5 NOTE in travel_invoices.js:
//                                          TravelInvoice has no issuedAt column)
// @property {string} customerName       - party ledger name (Contact.name)
// @property {string} [customerGstin]    - buyer GSTIN (Contact.gst), null if absent
// @property {string} subBrand           - tmc | rfu | travelstall | visasure
// @property {string} [legalEntityCode]  - issuing legal entity (subBrandConfig)
// @property {string} [status]           - Draft | Issued | Partial | Paid
//                                          (Voided is excluded at the route layer)
// @property {number} taxableAmount      - invoice taxable total (SAC-bearing lines)
// @property {number} [cgstAmount]       - invoice CGST total
// @property {number} [sgstAmount]       - invoice SGST total
// @property {number} [igstAmount]       - invoice IGST total
// @property {number} [tcsAmount]        - Sec 206C(1G) TCS collected (TravelInvoice.tcsAmount)
// @property {number} [totalAmount]      - grand total; defaults to
//                                          taxable + cgst + sgst + igst + tcs
// @property {TravelExportLine[]} [lines] - per-line rows for the CA CSV
//
// === Money convention ===
// Decimal(15,2) INR throughout (project standard). All amounts rendered
// at exactly 2dp; non-finite / null / undefined → "0.00".

/**
 * XML-escape a string for safe inclusion in a Tally envelope. Returns
 * empty string for null/undefined so the envelope stays well-formed when
 * optional fields are absent. Mirrors lib/tallyXmlExport.js escapeXml.
 *
 * @param {*} s
 * @returns {string}
 */
function escapeXml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Tally accepts dates in YYYYMMDD form (no separators). Empty string for
 * null / invalid input — Tally rejects the voucher with a clear "Date
 * missing" import error, preferable to a garbage date importing silently.
 *
 * @param {Date|string|number|null|undefined} d
 * @returns {string}
 */
function fmtTallyDate(d) {
  if (d == null || d === "") return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * Render a numeric amount at 2dp (INR paise). Non-finite → "0.00".
 * Negatives emitted verbatim — the caller controls sign via
 * ISDEEMEDPOSITIVE on the Tally side.
 *
 * @param {*} n
 * @returns {string}
 */
function money2(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

/**
 * RFC 4180 CSV escape. Fields containing comma / double-quote / CR / LF
 * are wrapped in double-quotes with inner quotes doubled. null/undefined
 * → empty string (NOT the literal "null"/"undefined").
 *
 * @param {*} s
 * @returns {string}
 */
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * YYYY-MM-DD for the CSV date column. Empty string on null / invalid —
 * keeps the column count stable so accountants' formulas don't break.
 *
 * @param {Date|string|number|null|undefined} d
 * @returns {string}
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

// One <ALLLEDGERENTRIES.LIST> block. ISDEEMEDPOSITIVE=No → credit-side
// (sales / output-tax ledgers); Yes → debit-side (party receivable).
function ledgerEntry(ledgerName, isDeemedPositive, amount) {
  return (
    `        <ALLLEDGERENTRIES.LIST>\n` +
    `          <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>\n` +
    `          <ISDEEMEDPOSITIVE>${isDeemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>\n` +
    `          <AMOUNT>${money2(amount)}</AMOUNT>\n` +
    `        </ALLLEDGERENTRIES.LIST>`
  );
}

function buildVoucher(invoice) {
  const invNum = escapeXml(invoice.invoiceNum || "");
  const date = fmtTallyDate(invoice.date);
  const partyLedger = escapeXml(invoice.customerName || "Unknown Customer");

  // Narration carries the sub-brand + issuing legal entity so the CA can
  // post the voucher into the correct company books on import (one tenant
  // may invoice under multiple legal entities — Q21 sub-brand config).
  const narrationParts = [`subBrand=${invoice.subBrand || "unknown"}`];
  if (invoice.legalEntityCode) {
    narrationParts.push(`legalEntity=${invoice.legalEntityCode}`);
  }
  const narration = escapeXml(narrationParts.join(" | "));

  const taxable = Number(invoice.taxableAmount) || 0;
  const cgst = Number(invoice.cgstAmount) || 0;
  const sgst = Number(invoice.sgstAmount) || 0;
  const igst = Number(invoice.igstAmount) || 0;
  const tcs = Number(invoice.tcsAmount) || 0;
  const providedTotal = Number(invoice.totalAmount);
  const total = Number.isFinite(providedTotal) && providedTotal !== 0
    ? providedTotal
    : Math.round((taxable + cgst + sgst + igst + tcs) * 100) / 100;

  const entries = [];

  // Revenue side — always present (even 0.00 keeps the voucher valid).
  entries.push(ledgerEntry("Sales Account", false, taxable));

  // GST output ledgers — only when non-zero. The route layer computes the
  // CGST/SGST-vs-IGST split (intra vs interstate supply), so this renderer
  // simply emits whichever legs carry value.
  if (cgst > 0) entries.push(ledgerEntry("CGST Output", false, cgst));
  if (sgst > 0) entries.push(ledgerEntry("SGST Output", false, sgst));
  if (igst > 0) entries.push(ledgerEntry("IGST Output", false, igst));

  // TCS Sec 206C(1G) — overseas-package collection at source. Liability
  // ledger, credit side (collected from the buyer, owed to the department).
  if (tcs > 0) entries.push(ledgerEntry("TCS Payable (206C)", false, tcs));

  // Party ledger — the receivable side. ISDEEMEDPOSITIVE=Yes + negative
  // amount preserves Tally's double-entry invariant (all AMOUNTs sum to 0).
  entries.push(ledgerEntry(invoice.customerName || "Unknown Customer", true, -total));

  return (
    `    <TALLYMESSAGE>\n` +
    `      <VOUCHER VCHTYPE="Sales" ACTION="Create">\n` +
    `        <DATE>${date}</DATE>\n` +
    `        <VOUCHERNUMBER>${invNum}</VOUCHERNUMBER>\n` +
    `        <NARRATION>${narration}</NARRATION>\n` +
    `        <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>\n` +
    entries.join("\n") + "\n" +
    `      </VOUCHER>\n` +
    `    </TALLYMESSAGE>`
  );
}

/**
 * Build a TallyPrime-importable XML envelope (Gateway of Tally → Import
 * Data → Vouchers): one Sales-voucher TALLYMESSAGE per invoice.
 *
 * @param {TravelExportInvoice[]} invoices
 * @param {Object} opts
 * @param {string} opts.tenantName - SVCURRENTCOMPANY value (tenant.name)
 * @returns {string} XML string
 */
function buildTallyXml(invoices, { tenantName } = {}) {
  const company = escapeXml(tenantName || "");
  const list = Array.isArray(invoices) ? invoices : [];
  const messages = list.map((inv) => buildVoucher(inv)).join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ENVELOPE>\n` +
    `  <HEADER>\n` +
    `    <TALLYREQUEST>Import Data</TALLYREQUEST>\n` +
    `  </HEADER>\n` +
    `  <BODY>\n` +
    `    <IMPORTDATA>\n` +
    `      <REQUESTDESC>\n` +
    `        <REPORTNAME>Vouchers</REPORTNAME>\n` +
    `        <STATICVARIABLES>\n` +
    `          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>\n` +
    `        </STATICVARIABLES>\n` +
    `      </REQUESTDESC>\n` +
    `      <REQUESTDATA>\n` +
    (messages ? messages + "\n" : "") +
    `      </REQUESTDATA>\n` +
    `    </IMPORTDATA>\n` +
    `  </BODY>\n` +
    `</ENVELOPE>\n`
  );
}

// Pinned header row — changing it breaks the spreadsheets CAs build on top.
const CA_CSV_HEADER = [
  "Invoice Number",
  "Invoice Date",
  "Customer",
  "Customer GSTIN",
  "Sub-Brand",
  "Legal Entity",
  "Line Description",
  "HSN/SAC",
  "Taxable Value",
  "CGST",
  "SGST",
  "IGST",
  "TCS",
  "Invoice Total",
  "Status",
];

/**
 * Build the CA-handover CSV: pinned header row + one row per invoice
 * LINE. Invoice-identity columns (number / date / customer / GSTIN /
 * sub-brand / legal entity / status) repeat on every line row so the CA
 * can filter or pivot without VLOOKUPs. Invoice-LEVEL money columns
 * (TCS, Invoice Total) are emitted ONLY on the first row of each invoice
 * (blank on continuation rows) so naive column SUMs stay correct — no
 * double counting on multi-line invoices.
 *
 * Invoices with zero lines still get one row (line columns empty,
 * taxable/GST 0.00) so the file reconciles against the invoice register.
 *
 * CRLF line endings (Excel/GoI-portal friendly — matches the gstr1-export
 * convention in travel_invoices.js) + trailing CRLF. No BOM here — the
 * route layer prepends U+FEFF before sending, keeping this output easy
 * to parse in tests and downstream tooling.
 *
 * @param {TravelExportInvoice[]} invoices
 * @returns {string}
 */
function buildCaCsv(invoices) {
  const CRLF = "\r\n";
  const list = Array.isArray(invoices) ? invoices : [];
  const rows = [CA_CSV_HEADER.map(csvEscape).join(",")];

  for (const inv of list) {
    const identity = [
      inv.invoiceNum,
      csvDate(inv.date),
      inv.customerName,
      inv.customerGstin || "",
      inv.subBrand || "",
      inv.legalEntityCode || "",
    ];
    const lines =
      Array.isArray(inv.lines) && inv.lines.length > 0
        ? inv.lines
        : [{ description: "", sacCode: null, taxableValue: inv.taxableAmount || 0, cgst: inv.cgstAmount || 0, sgst: inv.sgstAmount || 0, igst: inv.igstAmount || 0 }];

    lines.forEach((line, idx) => {
      const first = idx === 0;
      rows.push(
        [
          ...identity,
          line.description || "",
          line.sacCode || "",
          money2(line.taxableValue),
          money2(line.cgst),
          money2(line.sgst),
          money2(line.igst),
          first ? money2(inv.tcsAmount) : "",
          first ? money2(inv.totalAmount) : "",
          inv.status || "",
        ]
          .map(csvEscape)
          .join(","),
      );
    });
  }

  return rows.join(CRLF) + CRLF;
}

module.exports = {
  buildTallyXml,
  buildCaCsv,
  escapeXml,
  fmtTallyDate,
  money2,
  csvEscape,
  csvDate,
  CA_CSV_HEADER,
};
