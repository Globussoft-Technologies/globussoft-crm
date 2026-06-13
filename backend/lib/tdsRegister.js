// PRD_TRAVEL_GST_COMPLIANCE G031 (FR-3.4.6) — TDS Register analytics helper.
//
// IMPORTANT — SCOPE DRIFT NOTE:
//   PRD_TRAVEL_GST_COMPLIANCE FR-3.4.6 originally framed this report as
//   "TDS deducted BY CUSTOMERS when they pay us." That requires per-payment
//   TDS-deduction fields on the customer-payment side, which DO NOT exist
//   in the current schema (TravelPaymentSchedule has no tdsAmount column).
//
//   This implementation pivots to the SUPPLIER-SIDE TDS register —
//   TDS we (the operator) deduct when we pay suppliers / commission
//   agents (Section 194H 5%, Section 194J 10%, Section 194C 1-2% on
//   contractor payments). This data IS in the schema today
//   (TravelSupplierCommissionEntry.tdsAmount).
//
//   The customer-side TDS register stays open as a future enhancement
//   pending DD-5.x decision on whether to add Payment.tdsAmount.
//
//   The agent dispatching prompt explicitly framed the report as
//   "TDS records deducted by us (when we paid suppliers)" — this matches
//   the schema-available reality. Documented for the next reviewer.
//
// Pure-math + CSV builder for the TDS register view. Given a pre-loaded
// set of TDS-bearing entries belonging to a tenant + FY (+ optional
// section filter), produces a chronological register with per-deductee
// rollup. CSV output column order matches Form 26Q (the govt-spec
// quarterly TDS return form a CA uploads to TRACES portal).
//
// Section codes:
//   194H — commission / brokerage (5% default — DD-5.5)
//   194J — professional / technical services (10%)
//   194C — contractor payments (1% individual, 2% company)
//   ALL  — combined view across all sections

const { fiscalYearLabelLong, isValidFyLongLabel } = require('./travelFiscalYear');

/** Rounds an amount to 2dp via JS Number. Returns 0 for null/NaN. */
function toMoney(n) {
  if (n == null) return 0;
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

// Form 26Q section codes accepted by the filter. "all" is the no-filter case.
const VALID_SECTIONS = Object.freeze(['194H', '194J', '194C', 'all']);

function isValidSection(s) {
  if (s == null) return true;
  return VALID_SECTIONS.includes(String(s));
}

/**
 * Maps a TravelSupplierCommissionEntry row to a TDS register entry.
 * Section 194H is the canonical commission section per DD-5.5.
 *
 * @param {Object} entry - TravelSupplierCommissionEntry row + joined supplier
 * @returns {Object} normalized TDS register entry
 */
function fromCommissionEntry(entry) {
  if (!entry) return null;
  const tds = toMoney(entry.tdsAmount);
  if (tds <= 0) return null;
  const supplier = entry.supplier || {};
  return {
    date: entry.accruedAt || entry.createdAt,
    deducteeName: supplier.name || `Supplier #${entry.supplierId}`,
    deducteePan: supplier.kyc?.panNumber || null,
    deducteeGstin: supplier.gstin || null,
    section: '194H', // commission/brokerage — DD-5.5
    natureOfPayment: 'Commission on travel booking',
    grossAmount: toMoney(entry.commissionAmount),
    tdsAmount: tds,
    challanNumber: null,    // future: from a SupplierTdsChallan table
    challanDate: null,
    sourceModel: 'TravelSupplierCommissionEntry',
    sourceId: entry.id,
    fiscalYear: entry.fiscalYear,
    currency: entry.currency || 'INR',
  };
}

/**
 * Optional second source — if a future schema adds tdsAmount to
 * TravelSupplierPayable, this helper handles it. Returns null if
 * the input row carries no TDS, so it's safe to map() over a mixed list.
 *
 * @param {Object} payable - TravelSupplierPayable row + joined supplier
 * @returns {Object|null}
 */
function fromSupplierPayable(payable) {
  if (!payable || payable.tdsAmount == null) return null;
  const tds = toMoney(payable.tdsAmount);
  if (tds <= 0) return null;
  const supplier = payable.supplier || {};
  return {
    date: payable.paidAt || payable.dueDate || payable.createdAt,
    deducteeName: supplier.name || `Supplier #${payable.supplierId}`,
    deducteePan: supplier.kyc?.panNumber || null,
    deducteeGstin: supplier.gstin || null,
    section: payable.tdsSection || '194C',
    natureOfPayment: payable.tdsNature || 'Supplier payment',
    grossAmount: toMoney(payable.amount),
    tdsAmount: tds,
    challanNumber: payable.tdsChallanNumber || null,
    challanDate: payable.tdsChallanDate || null,
    sourceModel: 'TravelSupplierPayable',
    sourceId: payable.id,
    fiscalYear: payable.fiscalYear || null,
    currency: payable.currency || 'INR',
  };
}

/**
 * Builds the TDS register from raw entries + payables.
 *
 * @param {Object} input
 * @param {Array}  input.commissionEntries - TravelSupplierCommissionEntry rows
 * @param {Array}  input.supplierPayables  - TravelSupplierPayable rows (optional)
 * @param {string} input.section           - one of '194H' | '194J' | '194C' | 'all'
 * @param {string} input.fiscalYear        - e.g. "FY2025-26"
 * @returns {{
 *   fiscalYear: string,
 *   section: string,
 *   entries: Array,
 *   summary: {totalDeducted: number, totalGross: number, totalEntries: number, byDeductee: Array, bySection: Object}
 * }}
 */
function buildTdsRegister({ commissionEntries = [], supplierPayables = [], section = 'all', fiscalYear }) {
  const rows = [];
  for (const e of commissionEntries) {
    const r = fromCommissionEntry(e);
    if (!r) continue;
    if (r.status === 'reversed') continue;
    if (section !== 'all' && r.section !== section) continue;
    rows.push(r);
  }
  for (const p of supplierPayables) {
    const r = fromSupplierPayable(p);
    if (!r) continue;
    if (section !== 'all' && r.section !== section) continue;
    rows.push(r);
  }
  // Sort by date asc + section asc + sourceId asc for stable order.
  rows.sort((a, b) => {
    const aDate = a.date ? new Date(a.date).getTime() : 0;
    const bDate = b.date ? new Date(b.date).getTime() : 0;
    if (aDate !== bDate) return aDate - bDate;
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    return (a.sourceId || 0) - (b.sourceId || 0);
  });

  // Per-deductee + per-section rollups.
  const byDeducteeMap = new Map();
  const bySection = {};
  let totalDeducted = 0;
  let totalGross = 0;
  for (const r of rows) {
    totalDeducted += r.tdsAmount;
    totalGross += r.grossAmount;
    const key = r.deducteeName + '|' + (r.deducteePan || '');
    if (!byDeducteeMap.has(key)) {
      byDeducteeMap.set(key, {
        deducteeName: r.deducteeName,
        deducteePan: r.deducteePan,
        deducteeGstin: r.deducteeGstin,
        totalGross: 0,
        totalTds: 0,
        entryCount: 0,
      });
    }
    const dd = byDeducteeMap.get(key);
    dd.totalGross = Math.round((dd.totalGross + r.grossAmount) * 100) / 100;
    dd.totalTds = Math.round((dd.totalTds + r.tdsAmount) * 100) / 100;
    dd.entryCount += 1;
    bySection[r.section] = bySection[r.section] || { count: 0, totalTds: 0, totalGross: 0 };
    bySection[r.section].count += 1;
    bySection[r.section].totalTds = Math.round((bySection[r.section].totalTds + r.tdsAmount) * 100) / 100;
    bySection[r.section].totalGross = Math.round((bySection[r.section].totalGross + r.grossAmount) * 100) / 100;
  }
  const byDeductee = Array.from(byDeducteeMap.values()).sort((a, b) => b.totalTds - a.totalTds);

  return {
    fiscalYear: fiscalYear || fiscalYearLabelLong(new Date()),
    section,
    entries: rows.map((r) => ({
      date: r.date ? new Date(r.date).toISOString() : null,
      deducteeName: r.deducteeName,
      deducteePan: r.deducteePan,
      deducteeGstin: r.deducteeGstin,
      section: r.section,
      natureOfPayment: r.natureOfPayment,
      grossAmount: r.grossAmount,
      tdsAmount: r.tdsAmount,
      challanNumber: r.challanNumber,
      challanDate: r.challanDate ? new Date(r.challanDate).toISOString() : null,
      sourceModel: r.sourceModel,
      sourceId: r.sourceId,
      currency: r.currency,
    })),
    summary: {
      totalDeducted: Math.round(totalDeducted * 100) / 100,
      totalGross: Math.round(totalGross * 100) / 100,
      totalEntries: rows.length,
      byDeductee,
      bySection,
    },
  };
}

/** RFC-4180 CSV escape. */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Form 26Q-friendly CSV header. Column order chosen to match the
 * NSDL Form 26Q quarterly TDS return — the file should drop into a
 * CA's Excel template with minimal rework.
 *
 * Form 26Q minimal columns (sourced from NSDL spec):
 *   - PAN of Deductee (required)
 *   - Name of Deductee
 *   - Section under which deduction made
 *   - Date of Payment / Credit
 *   - Amount Paid / Credited (gross)
 *   - Total Tax Deducted (TDS)
 *   - BSR Code of branch (challan)
 *   - Date on which Tax Deposited
 *   - Challan Serial Number
 *
 * Currency is appended for non-INR tenants.
 */
const TDS_26Q_HEADER = [
  'paymentDate',
  'deducteeName',
  'deducteePan',
  'deducteeGstin',
  'section',
  'natureOfPayment',
  'grossAmount',
  'tdsAmount',
  'challanNumber',
  'challanDate',
  'currency',
  'sourceModel',
  'sourceId',
];

/**
 * Builds the TDS register CSV in Form 26Q column order.
 *
 * @param {Object} register - return value from buildTdsRegister()
 * @returns {string} CSV text (CRLF-terminated)
 */
function buildTdsRegisterCsv(register) {
  const rows = [TDS_26Q_HEADER.join(',')];
  for (const e of register.entries || []) {
    rows.push([
      csvEscape(e.date || ''),
      csvEscape(e.deducteeName),
      csvEscape(e.deducteePan || ''),
      csvEscape(e.deducteeGstin || ''),
      csvEscape(e.section),
      csvEscape(e.natureOfPayment || ''),
      csvEscape(toMoney(e.grossAmount).toFixed(2)),
      csvEscape(toMoney(e.tdsAmount).toFixed(2)),
      csvEscape(e.challanNumber || ''),
      csvEscape(e.challanDate || ''),
      csvEscape(e.currency || 'INR'),
      csvEscape(e.sourceModel),
      csvEscape(e.sourceId),
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

module.exports = {
  toMoney,
  isValidSection,
  VALID_SECTIONS,
  fromCommissionEntry,
  fromSupplierPayable,
  buildTdsRegister,
  buildTdsRegisterCsv,
  TDS_26Q_HEADER,
  csvEscape,
  isValidFyLongLabel,
};
