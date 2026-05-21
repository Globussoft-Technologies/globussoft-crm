// Tally XML envelope generator — PRD §4.4 CA / Tally export.
//
// Pure function: takes an array of Invoice rows (with linked contact +
// optional billing-address fields) plus tenant metadata; returns a
// Tally-compatible XML string the user can save as .xml and import via
// TallyPrime's Gateway of Tally → Import Data → Vouchers.
//
// Tally envelope shape (TallyPrime spec):
//   <ENVELOPE>
//     <HEADER>
//       <TALLYREQUEST>Import Data</TALLYREQUEST>
//     </HEADER>
//     <BODY>
//       <IMPORTDATA>
//         <REQUESTDESC>
//           <REPORTNAME>Vouchers</REPORTNAME>
//           <STATICVARIABLES>
//             <SVCURRENTCOMPANY>{companyName}</SVCURRENTCOMPANY>
//           </STATICVARIABLES>
//         </REQUESTDESC>
//         <REQUESTDATA>
//           <TALLYMESSAGE>
//             <VOUCHER VCHTYPE="Sales" ACTION="Create">
//               <DATE>20260521</DATE>                    ← YYYYMMDD
//               <VOUCHERNUMBER>INV-001</VOUCHERNUMBER>
//               <NARRATION>Travel Stall — Bali package</NARRATION>
//               <PARTYLEDGERNAME>{contactName}</PARTYLEDGERNAME>
//               <ALLLEDGERENTRIES.LIST>
//                 <LEDGERNAME>Sales Account</LEDGERNAME>
//                 <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
//                 <AMOUNT>{taxableAmount}</AMOUNT>
//               </ALLLEDGERENTRIES.LIST>
//               <ALLLEDGERENTRIES.LIST>
//                 <LEDGERNAME>CGST Output</LEDGERNAME>
//                 <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
//                 <AMOUNT>{cgstAmount}</AMOUNT>
//               </ALLLEDGERENTRIES.LIST>
//               ...SGST / IGST blocks as applicable...
//               <ALLLEDGERENTRIES.LIST>
//                 <LEDGERNAME>{contactName}</LEDGERNAME>
//                 <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
//                 <AMOUNT>-{totalAmount}</AMOUNT>        ← negative = receivable
//               </ALLLEDGERENTRIES.LIST>
//             </VOUCHER>
//           </TALLYMESSAGE>
//           ...one TALLYMESSAGE per Invoice...
//         </REQUESTDATA>
//       </IMPORTDATA>
//     </BODY>
//   </ENVELOPE>
//
// Sign convention (critical, easy to get wrong):
//   ISDEEMEDPOSITIVE=No  → standard debit/credit
//   ISDEEMEDPOSITIVE=Yes → reverses sign for receivables (party ledger)
//
// GST handling:
//   - intrastate sale (sellerState === buyerState) → CGST + SGST (each half of GST)
//   - interstate sale (sellerState !== buyerState) → IGST (full)
//   - export / zero-rated → no GST blocks, just sales ledger + party
//
// XML escaping: every string field must be passed through escapeXml()
// to prevent malformed envelopes when contact names or invoice numbers
// contain &, <, >, ", or '.
//
// Cite: https://help.tallysolutions.com/article/Tally.ERP9/Import_Data/XML_format_for_voucher.htm

/**
 * XML-escape a string for safe inclusion in a Tally envelope. Returns
 * empty string for null/undefined so the envelope stays well-formed
 * even when optional fields (notes, billing address) are absent.
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
 * Tally accepts dates in YYYYMMDD form (no separators). Returns empty
 * string for null / invalid inputs — Tally will reject the voucher with
 * a clear "Date missing" import error, which is preferable to writing
 * a garbage date that imports silently and later confuses reconciliation.
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
 * Format a numeric amount to 2dp. Tally accepts decimal numbers;
 * INR rounds to paise (0.01). Non-finite / null / undefined → "0.00".
 * Negatives are emitted verbatim — the caller controls the sign via
 * ISDEEMEDPOSITIVE.
 *
 * @param {*} n
 * @returns {string}
 */
function tallyAmount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

/**
 * @typedef {Object} TallyInvoice
 * @property {number|string} [id]
 * @property {string} invoiceNumber       - voucher number, e.g. "INV-001"
 * @property {Date|string} issueDate      - voucher date
 * @property {string} contactName         - party ledger name
 * @property {string} [billingAddress]    - optional, embedded in NARRATION
 * @property {string} [buyerState]        - optional; defaults to sellerState (intrastate)
 * @property {number} subtotal            - taxable amount (pre-GST)
 * @property {number} [cgstAmount]        - intrastate CGST (defaults 0)
 * @property {number} [sgstAmount]        - intrastate SGST (defaults 0)
 * @property {number} [igstAmount]        - interstate IGST (defaults 0)
 * @property {number} totalAmount         - grand total (subtotal + GST)
 * @property {string} [notes]             - free-form, embedded in NARRATION
 */

function buildVoucher(invoice, sellerState) {
  const invNum = escapeXml(invoice.invoiceNumber || "");
  const date = fmtTallyDate(invoice.issueDate);
  const contactName = invoice.contactName || "Unknown Customer";
  const partyLedger = escapeXml(contactName);

  const narrationParts = [];
  if (invoice.notes) narrationParts.push(invoice.notes);
  if (invoice.billingAddress) narrationParts.push(invoice.billingAddress);
  const narration = escapeXml(narrationParts.join(" — "));

  const subtotal = Number(invoice.subtotal) || 0;
  const cgst = Number(invoice.cgstAmount) || 0;
  const sgst = Number(invoice.sgstAmount) || 0;
  const igst = Number(invoice.igstAmount) || 0;
  const total = Number(invoice.totalAmount) || subtotal + cgst + sgst + igst;

  // Determine intrastate vs interstate. If buyerState is absent we default
  // to sellerState (intrastate assumption — the conservative default for
  // domestic B2B; an out-of-state CA will catch missing state info on
  // import and fix it there).
  const buyerState = invoice.buyerState || sellerState || "";
  const intrastate = sellerState && buyerState && String(sellerState).toLowerCase() === String(buyerState).toLowerCase();

  const entries = [];

  // Sales account — the revenue side (always present).
  entries.push(
    `        <ALLLEDGERENTRIES.LIST>\n` +
    `          <LEDGERNAME>Sales Account</LEDGERNAME>\n` +
    `          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n` +
    `          <AMOUNT>${tallyAmount(subtotal)}</AMOUNT>\n` +
    `        </ALLLEDGERENTRIES.LIST>`
  );

  // GST blocks — only if non-zero.
  if (intrastate) {
    if (cgst > 0) {
      entries.push(
        `        <ALLLEDGERENTRIES.LIST>\n` +
        `          <LEDGERNAME>CGST Output</LEDGERNAME>\n` +
        `          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n` +
        `          <AMOUNT>${tallyAmount(cgst)}</AMOUNT>\n` +
        `        </ALLLEDGERENTRIES.LIST>`
      );
    }
    if (sgst > 0) {
      entries.push(
        `        <ALLLEDGERENTRIES.LIST>\n` +
        `          <LEDGERNAME>SGST Output</LEDGERNAME>\n` +
        `          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n` +
        `          <AMOUNT>${tallyAmount(sgst)}</AMOUNT>\n` +
        `        </ALLLEDGERENTRIES.LIST>`
      );
    }
  } else {
    if (igst > 0) {
      entries.push(
        `        <ALLLEDGERENTRIES.LIST>\n` +
        `          <LEDGERNAME>IGST Output</LEDGERNAME>\n` +
        `          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n` +
        `          <AMOUNT>${tallyAmount(igst)}</AMOUNT>\n` +
        `        </ALLLEDGERENTRIES.LIST>`
      );
    }
  }

  // Party ledger — the receivable side. ISDEEMEDPOSITIVE=Yes reverses the
  // sign so Tally records this as a debit to the party (money owed by
  // them). AMOUNT is negative-of-total so the double-entry invariant
  // (all AMOUNTs sum to zero across the voucher) holds.
  entries.push(
    `        <ALLLEDGERENTRIES.LIST>\n` +
    `          <LEDGERNAME>${partyLedger}</LEDGERNAME>\n` +
    `          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n` +
    `          <AMOUNT>${tallyAmount(-total)}</AMOUNT>\n` +
    `        </ALLLEDGERENTRIES.LIST>`
  );

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
 * Build a Tally XML envelope containing zero-or-more voucher messages.
 * Pure function — no DB calls, no I/O.
 *
 * @param {Object} args
 * @param {string} args.companyName       - SVCURRENTCOMPANY value (e.g. tenant.name or legalEntity)
 * @param {string} [args.sellerState]     - seller state (drives intra/interstate split)
 * @param {TallyInvoice[]} args.invoices  - one TALLYMESSAGE per row
 * @returns {string} XML string
 */
function buildTallyXml({ companyName, sellerState, invoices }) {
  const company = escapeXml(companyName || "");
  const list = Array.isArray(invoices) ? invoices : [];
  const messages = list.map((inv) => buildVoucher(inv, sellerState)).join("\n");

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

module.exports = { buildTallyXml, escapeXml, fmtTallyDate, tallyAmount };
