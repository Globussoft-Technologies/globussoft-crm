// PRD_TRAVEL_GST_COMPLIANCE G030 (FR-3.4.4) — Customer-ledger analytics helper.
//
// Pure-math + CSV builder for the per-customer ledger view. Given a
// pre-loaded set of invoices and payments belonging to one customer (or
// GSTIN-scoped group of customers), produces a chronological ledger with
// opening/closing balance + running balance per transaction.
//
// The route layer at backend/routes/travel_invoice_ledgers.js owns:
//   - request parsing (gstin / fy / contactId query params)
//   - tenant scoping (req.travelTenant.id)
//   - sub-brand access enforcement
//   - the Prisma queries that load invoices + payments
//
// This module owns ONLY the pure transformation. Easy to unit-test, easy
// to extend with new transaction types (memos, refunds, JV) without
// reaching into the route layer.
//
// Fiscal year semantics — Indian FY runs April 1 → March 31. fy="FY2025-26"
// covers 2025-04-01 inclusive through 2026-04-01 exclusive. Opening
// balance for FY=N is the running balance carried forward from FY=N-1
// (sum of all invoices issued before the FY start MINUS all payments
// received before the FY start, for the same customer scope).
//
// Money semantics — all amounts are 2dp Decimal at the DB layer. We do
// JS Number math throughout with explicit Math.round(*100)/100 rounding.
// This is acceptable for ledger display where rounding errors are
// bounded by per-row entries; the DB-stored Decimal values remain
// authoritative.

const { fiscalYearStart, fiscalYearEnd, isValidFyLongLabel } = require('./travelFiscalYear');

/** Rounds an amount to 2dp via JS Number. Returns 0 for null/NaN. */
function toMoney(n) {
  if (n == null) return 0;
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/**
 * Computes opening balance from pre-FY history.
 * openingBalance = sum(invoiceTotals before FY start) − sum(payments before FY start)
 *
 * @param {Array<{date: Date, type: string, debit?: number, credit?: number}>} preFyEntries
 * @returns {number} 2dp rounded balance
 */
function computeOpeningBalance(preFyEntries) {
  if (!Array.isArray(preFyEntries) || preFyEntries.length === 0) return 0;
  let total = 0;
  for (const e of preFyEntries) {
    total += toMoney(e.debit || 0) - toMoney(e.credit || 0);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Builds the customer ledger entries from raw invoice + payment rows.
 *
 * Conventions:
 *   - invoice → debit (customer owes more)
 *   - credit-note → credit (customer owes less)
 *   - payment → credit (customer paid down balance)
 *
 * @param {Object} input
 * @param {Array} input.invoices - TravelInvoice rows (with date + totalAmount + invoiceNum + docType)
 * @param {Array} input.payments - TravelPaymentSchedule rows with receivedAmount > 0 + paidAt
 * @param {Date}  input.fyStart  - inclusive FY start (UTC midnight)
 * @param {Date}  input.fyEnd    - exclusive FY end (UTC midnight)
 * @returns {{
 *   openingBalance: number,
 *   transactions: Array<{date: string, type: string, refNumber: string, debit: number, credit: number, runningBalance: number}>,
 *   closingBalance: number,
 *   summary: {totalInvoiced: number, totalPaid: number, totalOutstanding: number, invoiceCount: number, paymentCount: number}
 * }}
 */
function buildCustomerLedger({ invoices, payments, fyStart, fyEnd }) {
  invoices = Array.isArray(invoices) ? invoices : [];
  payments = Array.isArray(payments) ? payments : [];

  // Normalize all events to { date, type, refNumber, debit, credit }
  const all = [];
  for (const inv of invoices) {
    if (!inv) continue;
    const issueDate = inv.createdAt || inv.issuedAt || inv.dueDate;
    if (!issueDate) continue;
    const docType = inv.docType || 'TaxInvoice';
    const isCreditNote = docType === 'CreditNote';
    const amt = toMoney(inv.totalAmount);
    all.push({
      date: new Date(issueDate),
      type: isCreditNote ? 'credit-note' : 'invoice',
      refNumber: inv.invoiceNum || `INV-${inv.id}`,
      debit: isCreditNote ? 0 : amt,
      credit: isCreditNote ? amt : 0,
    });
  }
  for (const p of payments) {
    if (!p) continue;
    const paidDate = p.paidAt;
    if (!paidDate) continue;
    const recv = toMoney(p.receivedAmount);
    if (recv <= 0) continue;
    all.push({
      date: new Date(paidDate),
      type: 'payment',
      refNumber: p.invoiceNum ? `${p.invoiceNum}#M${p.milestoneOrder || 1}` : `PAY-${p.id}`,
      debit: 0,
      credit: recv,
    });
  }

  // Sort chronologically; secondary sort by type so on same-day,
  // invoices land before payments (matches accountant convention).
  all.sort((a, b) => {
    const dt = a.date.getTime() - b.date.getTime();
    if (dt !== 0) return dt;
    const order = { invoice: 0, 'credit-note': 1, payment: 2 };
    const ao = order[a.type] ?? 9;
    const bo = order[b.type] ?? 9;
    return ao - bo;
  });

  const preFy = all.filter((e) => e.date < fyStart);
  const inFy = all.filter((e) => e.date >= fyStart && e.date < fyEnd);

  const opening = computeOpeningBalance(preFy);
  let running = opening;
  const transactions = [];
  let totalInvoiced = 0;
  let totalPaid = 0;
  let invoiceCount = 0;
  let paymentCount = 0;

  for (const e of inFy) {
    running = Math.round((running + e.debit - e.credit) * 100) / 100;
    transactions.push({
      date: e.date.toISOString(),
      type: e.type,
      refNumber: e.refNumber,
      debit: e.debit,
      credit: e.credit,
      runningBalance: running,
    });
    if (e.type === 'invoice') {
      totalInvoiced += e.debit;
      invoiceCount += 1;
    } else if (e.type === 'credit-note') {
      totalInvoiced -= e.credit;
    } else if (e.type === 'payment') {
      totalPaid += e.credit;
      paymentCount += 1;
    }
  }

  const closing = running;
  return {
    openingBalance: opening,
    transactions,
    closingBalance: closing,
    summary: {
      totalInvoiced: Math.round(totalInvoiced * 100) / 100,
      totalPaid: Math.round(totalPaid * 100) / 100,
      totalOutstanding: Math.round((totalInvoiced - totalPaid) * 100) / 100,
      invoiceCount,
      paymentCount,
    },
  };
}

/**
 * RFC-4180 CSV escape. Wraps in double-quotes if value contains comma /
 * quote / CR / LF; doubles inner quotes.
 */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Builds the CSV for a customer ledger. Header is fixed; one row per
 * transaction. Opening + closing balance render as synthetic header /
 * footer rows so a CA picking the file up can reconcile end-to-end.
 *
 * @param {Object} ledger - return value from buildCustomerLedger()
 * @param {Object} meta   - { contactName, gstin, fiscalYear, currency }
 * @returns {string} CSV text (CRLF-terminated lines)
 */
function buildCustomerLedgerCsv(ledger, meta = {}) {
  const HEADER = ['date', 'type', 'refNumber', 'debit', 'credit', 'runningBalance'];
  const rows = [HEADER.join(',')];
  // Synthetic opening-balance row at the top for reconciliation.
  rows.push([
    '',
    'opening',
    `Opening Balance ${meta.fiscalYear || ''}`.trim(),
    '',
    '',
    csvEscape(ledger.openingBalance.toFixed(2)),
  ].join(','));
  for (const t of ledger.transactions || []) {
    rows.push([
      csvEscape(t.date),
      csvEscape(t.type),
      csvEscape(t.refNumber),
      csvEscape(toMoney(t.debit).toFixed(2)),
      csvEscape(toMoney(t.credit).toFixed(2)),
      csvEscape(toMoney(t.runningBalance).toFixed(2)),
    ].join(','));
  }
  rows.push([
    '',
    'closing',
    `Closing Balance ${meta.fiscalYear || ''}`.trim(),
    '',
    '',
    csvEscape(ledger.closingBalance.toFixed(2)),
  ].join(','));
  return rows.join('\r\n') + '\r\n';
}

/**
 * Convenience wrapper — parses a long-FY-label string and returns
 * the inclusive start + exclusive end dates needed by the builder.
 *
 * @param {string} fyLabel - "FY2025-26"
 * @returns {{fyStart: Date, fyEnd: Date}} UTC midnight boundaries
 * @throws {Error} if fyLabel is malformed
 */
function fyBoundaries(fyLabel) {
  if (!isValidFyLongLabel(fyLabel)) {
    const err = new Error('fy must be a valid FY label e.g. FY2025-26');
    err.code = 'INVALID_FISCAL_YEAR';
    throw err;
  }
  // Use the FY's start month (April) to seed the FY-helper math.
  const fyStartYear = parseInt(fyLabel.slice(2, 6), 10);
  const probe = new Date(Date.UTC(fyStartYear, 5, 1)); // any date inside the FY
  return { fyStart: fiscalYearStart(probe), fyEnd: fiscalYearEnd(probe) };
}

module.exports = {
  toMoney,
  computeOpeningBalance,
  buildCustomerLedger,
  buildCustomerLedgerCsv,
  csvEscape,
  fyBoundaries,
};
