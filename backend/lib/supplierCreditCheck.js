// PRD_TRAVEL_SUPPLIER_MASTER G042 — supplier credit-limit guard helper.
//
// Pure helper that computes a supplier's current outstanding payable balance
// and projects whether a NEW booking / PO amount would breach the supplier's
// configured creditLimit. Consumed by:
//
//   - backend/routes/travel_trips.js  — PATCH /trips/:id (when status flips
//     to "confirmed" AND req.body.supplierId + totalAmount are set)
//   - backend/routes/travel_purchase_orders.js — POST /purchase-orders/:id/send
//     (draft → sent transition)
//   - backend/routes/travel_suppliers.js — GET /suppliers/:id/credit-status
//     (frontend advisory chip endpoint G043)
//
// Math
// ----
// `current` = SUM(TravelSupplierPayable.amount)
//   WHERE supplierId = :id
//   AND status NOT IN ('paid', 'cancelled')
//
// `projected` = current + addAmount
//
// `allowed` = (limit == null) OR (projected <= limit)
//
// Both `amount` and `limit` are Prisma Decimal → Number conversions at the
// route boundary. Cents-vs-rupees is NOT a concern here — the column is
// Decimal(15, 2) so we treat everything as rupees (or whatever currency the
// supplier is configured in via creditCurrency; currency conversion is
// out-of-scope for slice 2 — assume single-currency per supplier).
//
// When `limit` is null, the function returns `allowed: true` unconditionally
// (no credit limit configured = no enforcement). This matches the route-level
// behaviour: a supplier without a creditLimit has unlimited credit.
//
// Pure: no IO outside the prisma client passed in. Both prisma and the
// supplier lookup live INSIDE the helper so it's self-contained for testing.

/**
 * Check whether adding `addAmount` to a supplier's outstanding payable
 * balance would breach their configured creditLimit.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {number} args.tenantId
 * @param {number} args.supplierId
 * @param {number} [args.addAmount=0]   — the new booking / PO amount being projected
 * @returns {Promise<{ allowed: boolean, current: number, limit: number|null, projected: number, supplierExists: boolean }>}
 */
async function checkCreditLimit({ prisma, tenantId, supplierId, addAmount = 0 }) {
  const supplier = await prisma.travelSupplier.findFirst({
    where: { id: supplierId, tenantId },
    select: { id: true, creditLimit: true },
  });
  if (!supplier) {
    return {
      allowed: true,
      current: 0,
      limit: null,
      projected: 0,
      supplierExists: false,
    };
  }

  // Sum outstanding payables (pending + scheduled). Excluded: paid, cancelled.
  // groupBy is more efficient than findMany + reduce — single round-trip
  // returns the SUM aggregate.
  const agg = await prisma.travelSupplierPayable.aggregate({
    where: {
      supplierId,
      tenantId,
      status: { notIn: ["paid", "cancelled"] },
    },
    _sum: { amount: true },
  });
  const currentRaw = agg && agg._sum && agg._sum.amount != null
    ? Number(agg._sum.amount)
    : 0;
  const current = Number.isFinite(currentRaw) ? currentRaw : 0;

  const limitRaw = supplier.creditLimit != null ? Number(supplier.creditLimit) : null;
  const limit = limitRaw != null && Number.isFinite(limitRaw) ? limitRaw : null;

  const add = Number.isFinite(Number(addAmount)) ? Number(addAmount) : 0;
  const projected = roundCents(current + add);

  const allowed = limit == null ? true : projected <= limit;

  return {
    allowed,
    current: roundCents(current),
    limit,
    projected,
    supplierExists: true,
  };
}

/**
 * Derive the 3-band advisory chip status from a credit-check result.
 *
 *   - "ok"        — utilization <  80% (or limit is null)
 *   - "warning"   — 80% ≤ utilization < 100%
 *   - "exceeded"  — utilization ≥ 100%
 *
 * Boundary semantics: exactly 80% is "warning"; exactly 100% is "exceeded".
 * This matches the chip wording: "Near credit limit" at 80%, "Exceeded" at limit.
 *
 * @param {object} result      — output of checkCreditLimit
 * @returns {{ utilizationPct: number|null, status: 'ok'|'warning'|'exceeded' }}
 */
function deriveCreditStatus({ current, limit }) {
  if (limit == null || limit === 0) {
    return { utilizationPct: null, status: "ok" };
  }
  const utilizationPct = Math.round((current / limit) * 1000) / 10; // 1-decimal
  let status = "ok";
  if (utilizationPct >= 100) status = "exceeded";
  else if (utilizationPct >= 80) status = "warning";
  return { utilizationPct, status };
}

// Round to 2 decimals (rupees + paise / cents). Avoids the long-tail
// floating-point noise that Decimal → Number conversion produces.
function roundCents(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  checkCreditLimit,
  deriveCreditStatus,
};
