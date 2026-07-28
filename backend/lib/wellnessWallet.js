const prisma = require("./prisma");

/**
 * Append-only wallet ledger write used by the wellness wallet/gift-card/
 * coupon/cashback route family. Updates Wallet.balance and creates a
 * WalletTransaction row inside the same Prisma $transaction.
 *
 * Sign convention: credits positive, debits negative (mirrors QuickBooks).
 * The `type` must start with `CREDIT_` or `DEBIT_`.
 */
async function writeWalletTransaction({
  tenantId,
  walletId,
  type,
  absAmount,
  performedBy,
  reason,
  visitId = null,
  invoiceId = null,
  giftCardId = null,
  couponId = null,
}) {
  const isCredit = String(type || "").startsWith("CREDIT_");
  const isDebit = String(type || "").startsWith("DEBIT_");
  if (!isCredit && !isDebit) {
    throw new Error(`Invalid wallet transaction type: ${type}`);
  }
  const signed = isCredit ? Math.abs(absAmount) : -Math.abs(absAmount);
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findFirst({
      where: { id: walletId, tenantId },
    });
    if (!wallet) throw new Error("WALLET_NOT_FOUND");
    const newBalance = +(wallet.balance + signed).toFixed(2);
    if (newBalance < 0) {
      const e = new Error("INSUFFICIENT_BALANCE");
      e.code = "INSUFFICIENT_BALANCE";
      throw e;
    }
    await tx.wallet.update({
      where: { id: walletId },
      data: { balance: newBalance },
    });
    return tx.walletTransaction.create({
      data: {
        tenantId,
        walletId,
        type,
        amount: signed,
        reason: reason || null,
        visitId,
        invoiceId,
        giftCardId,
        couponId,
        balanceAfter: newBalance,
        performedBy,
      },
    });
  });
}

/**
 * Find an existing Wallet for a patient or create one in the tenant's
 * default currency. Returns the wallet row.
 */
async function getOrCreateWallet(req, patientId) {
  let wallet = await prisma.wallet.findFirst({
    where: { tenantId: req.user.tenantId, patientId },
  });
  if (wallet) return wallet;
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { defaultCurrency: true },
  });
  return prisma.wallet.create({
    data: {
      tenantId: req.user.tenantId,
      patientId,
      currency: tenant?.defaultCurrency || "INR",
    },
  });
}

module.exports = { writeWalletTransaction, getOrCreateWallet };
