// PRD_TRAVEL_GST_COMPLIANCE G032 (FR-3.4.7) — Commission-ledger analytics helper.
//
// Pure-math + CSV builder for the supplier-side commission ledger view.
// Reuses the TravelSupplierCommissionEntry data shape already populated
// by routes/travel_supplier_commissions.js (G045).
//
// SCOPE BOUNDARY — distinct from the B2B sub-agent commission ledger
// (PRD_TRAVEL_B2B_AGENT_PORTAL §FR-3.2 — still 🔵 BLOCKED on DD-5.5).
// This ledger covers SUPPLIER-side commissions EARNED on confirmed
// bookings (IATA inward, hotel commission, RFU Umrah kickbacks).
//
// The G045 surface at /api/travel/suppliers/:id/commission-statement
// gives the PER-SUPPLIER view. This G032 ledger is TENANT-WIDE — every
// supplier's entries rolled up into a single chronological register for
// the FY, suitable for export to the accountant.
//
// Type taxonomy (the ?type= filter):
//   iata_inward — IATA-air agent commission (default for air suppliers)
//   hotel       — hotel-side commission
//   air         — non-IATA air supplier commission
//   tour        — tour-package supplier commission
//   visa        — visa-consulting commission
//   other       — fallback (when supplier.supplierCategory doesn't map)
//
// Type derivation: TravelSupplier doesn't have a dedicated commission-type
// column; we derive from supplier.supplierCategory:
//   "flight"      → iata_inward (most air commissions are IATA)
//   "hotel"       → hotel
//   "transport"   → other
//   "visa-consul" → visa
//   "other"       → other
// Operator can override per-row by setting supplier.commissionType (when
// that column lands in a future slice).

const { isValidFyLongLabel, fiscalYearLabelLong } = require('./travelFiscalYear');

/** Rounds an amount to 2dp via JS Number. Returns 0 for null/NaN. */
function toMoney(n) {
  if (n == null) return 0;
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

const VALID_TYPES = Object.freeze([
  'iata_inward',
  'hotel',
  'air',
  'tour',
  'visa',
  'other',
  'all',
]);

function isValidType(t) {
  if (t == null) return true;
  return VALID_TYPES.includes(String(t));
}

/**
 * Derives the commission category from the supplier's category column.
 * Pure function — caller passes the supplier row, we map.
 */
function categoryFromSupplier(supplier) {
  if (!supplier) return 'other';
  // Allow explicit per-supplier override when present (future-compat).
  if (supplier.commissionType) {
    return VALID_TYPES.includes(supplier.commissionType) ? supplier.commissionType : 'other';
  }
  const sc = (supplier.supplierCategory || '').toLowerCase();
  switch (sc) {
    case 'flight':
      return 'iata_inward';
    case 'hotel':
      return 'hotel';
    case 'visa-consul':
    case 'visa_consul':
    case 'visa':
      return 'visa';
    case 'tour':
    case 'package':
      return 'tour';
    case 'transport':
      return 'other';
    default:
      return 'other';
  }
}

/**
 * Normalizes a TravelSupplierCommissionEntry into a ledger row.
 * Strips Prisma decoration; adds derived category + supplier name.
 */
function normalizeEntry(entry) {
  if (!entry) return null;
  const supplier = entry.supplier || {};
  return {
    id: entry.id,
    date: entry.accruedAt || entry.createdAt,
    supplierId: entry.supplierId,
    supplierName: supplier.name || `Supplier #${entry.supplierId}`,
    subBrand: supplier.subBrand || null,
    category: categoryFromSupplier(supplier),
    baseAmount: toMoney(entry.baseAmount),
    commissionPercent: entry.commissionPercent != null ? Number(entry.commissionPercent) : null,
    commissionAmount: toMoney(entry.commissionAmount),
    tdsAmount: toMoney(entry.tdsAmount),
    netAmount: toMoney(entry.netAmount),
    status: entry.status || 'accrued',
    settledAt: entry.settledAt || null,
    fiscalYear: entry.fiscalYear,
    currency: entry.currency || 'INR',
    bookingId: entry.bookingId || null,
    invoiceId: entry.invoiceId || null,
    notes: entry.notes || null,
  };
}

/**
 * Builds the commission ledger from raw TravelSupplierCommissionEntry rows.
 *
 * @param {Object} input
 * @param {Array}  input.entries    - TravelSupplierCommissionEntry rows + joined supplier
 * @param {string} input.type       - one of VALID_TYPES (default 'all')
 * @param {string} input.fiscalYear - e.g. "FY2025-26"
 * @returns {{
 *   fiscalYear: string,
 *   type: string,
 *   entries: Array,
 *   summary: {totalAccrued: number, totalSettled: number, totalReversed: number,
 *             totalTds: number, totalNet: number, byCategory: Object, bySupplier: Array}
 * }}
 */
function buildCommissionLedger({ entries = [], type = 'all', fiscalYear }) {
  const rows = [];
  for (const e of entries) {
    const n = normalizeEntry(e);
    if (!n) continue;
    if (type !== 'all' && n.category !== type) continue;
    rows.push(n);
  }
  // Stable sort by date asc, id asc.
  rows.sort((a, b) => {
    const aDate = a.date ? new Date(a.date).getTime() : 0;
    const bDate = b.date ? new Date(b.date).getTime() : 0;
    if (aDate !== bDate) return aDate - bDate;
    return (a.id || 0) - (b.id || 0);
  });

  let totalAccrued = 0;
  let totalSettled = 0;
  let totalReversed = 0;
  let totalTds = 0;
  let totalNet = 0;
  const byCategory = {};
  const bySupplierMap = new Map();
  for (const r of rows) {
    if (r.status === 'accrued') {
      totalAccrued = Math.round((totalAccrued + r.commissionAmount) * 100) / 100;
      totalNet = Math.round((totalNet + r.netAmount) * 100) / 100;
      totalTds = Math.round((totalTds + r.tdsAmount) * 100) / 100;
    } else if (r.status === 'settled') {
      totalSettled = Math.round((totalSettled + r.commissionAmount) * 100) / 100;
      totalTds = Math.round((totalTds + r.tdsAmount) * 100) / 100;
    } else if (r.status === 'reversed') {
      totalReversed = Math.round((totalReversed + r.commissionAmount) * 100) / 100;
    }

    byCategory[r.category] = byCategory[r.category] || {
      count: 0,
      totalCommission: 0,
      totalTds: 0,
      totalNet: 0,
    };
    if (r.status !== 'reversed') {
      byCategory[r.category].count += 1;
      byCategory[r.category].totalCommission =
        Math.round((byCategory[r.category].totalCommission + r.commissionAmount) * 100) / 100;
      byCategory[r.category].totalTds =
        Math.round((byCategory[r.category].totalTds + r.tdsAmount) * 100) / 100;
      byCategory[r.category].totalNet =
        Math.round((byCategory[r.category].totalNet + r.netAmount) * 100) / 100;
    }

    if (!bySupplierMap.has(r.supplierId)) {
      bySupplierMap.set(r.supplierId, {
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        subBrand: r.subBrand,
        totalCommission: 0,
        totalTds: 0,
        totalNet: 0,
        entryCount: 0,
      });
    }
    const sup = bySupplierMap.get(r.supplierId);
    if (r.status !== 'reversed') {
      sup.totalCommission = Math.round((sup.totalCommission + r.commissionAmount) * 100) / 100;
      sup.totalTds = Math.round((sup.totalTds + r.tdsAmount) * 100) / 100;
      sup.totalNet = Math.round((sup.totalNet + r.netAmount) * 100) / 100;
      sup.entryCount += 1;
    }
  }
  const bySupplier = Array.from(bySupplierMap.values()).sort(
    (a, b) => b.totalCommission - a.totalCommission,
  );

  return {
    fiscalYear: fiscalYear || fiscalYearLabelLong(new Date()),
    type,
    entries: rows.map((r) => ({
      ...r,
      date: r.date ? new Date(r.date).toISOString() : null,
      settledAt: r.settledAt ? new Date(r.settledAt).toISOString() : null,
    })),
    summary: {
      totalAccrued,
      totalSettled,
      totalReversed,
      totalTds,
      totalNet,
      byCategory,
      bySupplier,
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

const COMMISSION_CSV_HEADER = [
  'date',
  'supplierName',
  'subBrand',
  'category',
  'baseAmount',
  'commissionPercent',
  'commissionAmount',
  'tdsAmount',
  'netAmount',
  'status',
  'currency',
  'fiscalYear',
  'bookingId',
  'invoiceId',
];

/**
 * Builds the commission ledger CSV.
 *
 * @param {Object} ledger - return value from buildCommissionLedger()
 * @returns {string} CSV text (CRLF-terminated)
 */
function buildCommissionLedgerCsv(ledger) {
  const rows = [COMMISSION_CSV_HEADER.join(',')];
  for (const e of ledger.entries || []) {
    rows.push([
      csvEscape(e.date || ''),
      csvEscape(e.supplierName),
      csvEscape(e.subBrand || ''),
      csvEscape(e.category),
      csvEscape(toMoney(e.baseAmount).toFixed(2)),
      csvEscape(e.commissionPercent != null ? e.commissionPercent : ''),
      csvEscape(toMoney(e.commissionAmount).toFixed(2)),
      csvEscape(toMoney(e.tdsAmount).toFixed(2)),
      csvEscape(toMoney(e.netAmount).toFixed(2)),
      csvEscape(e.status),
      csvEscape(e.currency || 'INR'),
      csvEscape(e.fiscalYear || ''),
      csvEscape(e.bookingId || ''),
      csvEscape(e.invoiceId || ''),
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

module.exports = {
  toMoney,
  isValidType,
  VALID_TYPES,
  categoryFromSupplier,
  normalizeEntry,
  buildCommissionLedger,
  buildCommissionLedgerCsv,
  COMMISSION_CSV_HEADER,
  csvEscape,
  isValidFyLongLabel,
};
