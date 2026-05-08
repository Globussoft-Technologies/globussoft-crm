// Wave 11 Agent HH — receiptNumber generator for InventoryReceipt rows.
//
// Receipt numbers are tenant-scoped human-readable identifiers shaped like
// "RCP-YYYY-NNNN" where:
//   - YYYY is the current calendar year (UTC for stability across time zones;
//     a clinic that books a receipt at 23:55 IST on Dec 31 vs 00:05 IST on
//     Jan 1 lands on adjacent rows but with different year prefixes — that's
//     the desired UX).
//   - NNNN is a zero-padded sequence within the (tenantId, YYYY) namespace.
//
// Sequence is computed by reading the highest existing receiptNumber for the
// tenant in the current year and incrementing. The (tenantId, receiptNumber)
// unique index guarantees no two rows can share the same identifier within
// a tenant; this helper is invoked inside a Prisma transaction so the
// "find max + insert next" race is moot.
//
// 4-digit sequence supports up to 9,999 receipts per year per tenant — well
// past any clinic's annual receipt volume. If a tenant overflows (vendor
// integration receiving 1k+ tiny per-mL receipts/day), we widen to 5 digits
// without changing the sort order ("RCP-2026-00009" still sorts < "RCP-2026-00010").

/**
 * Pure formatter for the receiptNumber. Exposed for unit testing without
 * needing to mock Prisma. Caller must supply the year + sequence.
 *
 * @param {number} year   — full 4-digit year (e.g. 2026)
 * @param {number} seq    — 1-based sequence within (tenantId, year)
 * @returns {string}      — e.g. "RCP-2026-0001"
 */
function formatReceiptNumber(year, seq) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`formatReceiptNumber: year must be a 4-digit integer, got ${year}`);
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`formatReceiptNumber: seq must be a positive integer, got ${seq}`);
  }
  return `RCP-${year}-${String(seq).padStart(4, "0")}`;
}

/**
 * Parse a receiptNumber back into its components. Returns null on malformed
 * input (no exception — used by the sequence-incrementer to skip legacy /
 * manually-created rows that don't follow the pattern).
 *
 * @param {string} rn
 * @returns {{ year: number, seq: number } | null}
 */
function parseReceiptNumber(rn) {
  if (typeof rn !== "string") return null;
  const m = rn.match(/^RCP-(\d{4})-(\d+)$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const seq = parseInt(m[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(seq)) return null;
  return { year, seq };
}

/**
 * Inside a Prisma transaction, generate the next available receiptNumber for
 * the given tenant in the current calendar year. Returns the formatted
 * string; caller writes it onto the InventoryReceipt row.
 *
 * @param {object} tx       — Prisma transaction client (`prisma.$transaction`'s `tx`)
 * @param {number} tenantId
 * @param {Date}   [now]    — overridable for testing (defaults to new Date())
 * @returns {Promise<string>} — e.g. "RCP-2026-0001"
 */
async function generateReceiptNumber(tx, tenantId, now = new Date()) {
  const year = now.getUTCFullYear();
  const prefix = `RCP-${year}-`;

  // Find the highest existing seq within this (tenantId, year). Using
  // startsWith on receiptNumber lets MySQL use the (tenantId, receiptNumber)
  // unique index to range-scan; sort descending to grab the max in O(1).
  const latest = await tx.inventoryReceipt.findFirst({
    where: {
      tenantId,
      receiptNumber: { startsWith: prefix },
    },
    orderBy: { receiptNumber: "desc" },
    select: { receiptNumber: true },
  });

  let nextSeq = 1;
  if (latest) {
    const parsed = parseReceiptNumber(latest.receiptNumber);
    if (parsed && parsed.year === year) nextSeq = parsed.seq + 1;
  }

  return formatReceiptNumber(year, nextSeq);
}

module.exports = {
  formatReceiptNumber,
  parseReceiptNumber,
  generateReceiptNumber,
};
