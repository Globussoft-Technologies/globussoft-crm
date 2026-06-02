// Auto-record a cash-drawer expense (PettyCashLedger WITHDRAWAL) for a
// platform purchase such as a subscription, so it shows in the POS Cash
// Register's Expenses tab and is subtracted from the drawer's expected cash.
//
// The petty-cash ledger is shift-scoped, so this only records when the tenant
// has an OPEN shift (the drawer is active). If none is open there is nowhere
// to deduct from — we return { recorded: false, reason: 'NO_OPEN_SHIFT' } and
// the caller carries on (the subscription purchase itself is unaffected).
//
// Best-effort by contract: callers wrap in try/catch and never let a ledger
// failure break the purchase flow.

const prisma = require("./prisma");

// Most-recently opened shift for the tenant. If multiple registers have open
// shifts we attribute the expense to the newest — a deterministic, explainable
// choice (the drawer the owner most recently started).
async function findOpenShift(tenantId) {
  return prisma.shift.findFirst({
    where: { tenantId, status: "OPEN" },
    orderBy: { id: "desc" },
  });
}

/**
 * Record a SUBSCRIPTION-category withdrawal for the tenant's open shift.
 * @param {Object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.userId   - acting admin (stored on the ledger row)
 * @param {number} opts.amount   - amount to deduct (drawer currency)
 * @param {string} [opts.reason] - human label (defaults to "Subscription")
 * @returns {Promise<{recorded:boolean, entry?:object, reason?:string}>}
 */
async function recordSubscriptionExpense({ tenantId, userId, amount, reason }) {
  const amt = Number(amount);
  if (!tenantId || !Number.isFinite(amt) || amt <= 0) {
    return { recorded: false, reason: "INVALID_INPUT" };
  }
  const shift = await findOpenShift(tenantId);
  if (!shift) return { recorded: false, reason: "NO_OPEN_SHIFT" };

  const entry = await prisma.pettyCashLedger.create({
    data: {
      tenantId,
      shiftId: shift.id,
      type: "WITHDRAWAL",
      category: "SUBSCRIPTION",
      amount: amt,
      reason: String(reason || "Subscription").trim().slice(0, 1000),
      userId: userId || shift.userId,
    },
  });
  return { recorded: true, entry, shiftId: shift.id };
}

module.exports = { recordSubscriptionExpense, findOpenShift };
