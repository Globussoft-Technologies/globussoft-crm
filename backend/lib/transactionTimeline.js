/**
 * Pure builder for the customer "My Transactions" timeline + summary.
 *
 * Extracted from routes/wellness.js GET /my-transactions so the
 * normalisation + de-dup math can be unit-tested without a DB / HTTP stack.
 * The route does all the Prisma queries (and the audit), then hands the raw
 * rows here; this module is side-effect-free.
 *
 * Summary math (de-dup reasoning — keep in sync with the route header):
 *   totalPaid = value of purchases the customer actually made =
 *       Σ COMPLETED Sale.total − Σ REFUNDED Sale.total      (POS, any tender)
 *     + Σ SUCCESS Payment.amount                             (online gateway,
 *                                                             incl. gift-card
 *                                                             purchases)
 *     + Σ non-cancelled Subscription.amount                 (recurring plans)
 * Wallet TOP_UPs are a FUNDING mechanism (money loaded, later spent at POS
 * which is already in Sale.total) so they are reported SEPARATELY under the
 * wallet block, NOT folded into totalPaid.
 *
 * Gift-card specifics (the bit that was buggy before this module existed):
 *   - A gift-card PURCHASE is real money out → it surfaces as a Payment with
 *     metadata.kind='giftcard_purchase' and invoiceId=null. selectGiftCardPayments
 *     filters the tenant's invoice-less payments down to the ones that belong
 *     to this caller (by metadata.buyerUserId or metadata.patientId) and only
 *     SUCCESS / REFUNDED rows (abandoned PENDING orders are noise). These count
 *     toward onlineTotal → totalPaid and render as a "Gift card purchase" debit.
 *   - The matching wallet CREDIT (the gift value) shows separately as a Wallet
 *     row. A REDEEMED gift card is therefore already represented twice (wallet
 *     credit + purchase expense), so it is SKIPPED here to avoid a confusing
 *     third "+price" line. Only outstanding (un-redeemed) cards show, as an
 *     informational pending credit that is NOT counted in any spend total.
 */

// Only confirmed money movements surface as gift-card-purchase rows.
const GIFTCARD_PAYMENT_STATUSES = ["SUCCESS", "REFUNDED"];

const WALLET_LABELS = {
  TOP_UP: "Wallet top-up",
  REDEEM: "Wallet payment",
  REFUND: "Wallet refund",
  CASHBACK: "Cashback credited",
  GIFTCARD_ISSUE: "Gift card loaded to wallet",
  GIFTCARD_REDEEM: "Gift card redeemed to wallet",
  MANUAL_ADJUSTMENT: "Wallet adjustment",
};

/**
 * From the tenant's invoice-less Payment rows, pick the gift-card purchases
 * that belong to `patient` (the buyer OR the credited recipient) and are in a
 * confirmed state. Each kept row is tagged { kind: 'giftcard_purchase' }.
 *
 * @param {Array} rawPayments Payment rows (invoiceId = null) carrying metadata
 * @param {{ id:number, userId:number }} patient
 */
function selectGiftCardPayments(rawPayments, patient) {
  const out = [];
  for (const p of rawPayments || []) {
    if (!GIFTCARD_PAYMENT_STATUSES.includes(p.status)) continue;
    let m = {};
    try {
      m = JSON.parse(p.metadata || "{}");
    } catch {
      m = {};
    }
    const mine =
      Number(m.buyerUserId) === patient.userId ||
      Number(m.patientId) === patient.id;
    if (m.kind === "giftcard_purchase" && mine) {
      out.push({ ...p, invoiceNum: null, kind: "giftcard_purchase" });
    }
  }
  return out;
}

/**
 * Build the normalised, newest-first transaction timeline + summary.
 *
 * @param {object} input
 * @param {{ id:number, userId:number }} input.patient
 * @param {Array} [input.sales]              Sale rows (+ lineItems)
 * @param {Array} [input.walletTxns]         WalletTransaction rows
 * @param {Array} [input.memberships]        Membership rows (+ plan)
 * @param {Array} [input.plans]              TreatmentPlan rows (+ service)
 * @param {Array} [input.giftCards]          GiftCard rows (issuedTo/redeemedBy patient)
 * @param {Array} [input.invoicePayments]    Payment rows already tagged kind:'invoice' (+ invoiceNum)
 * @param {Array} [input.giftCardPaymentRows] Raw invoice-less Payment rows to filter for gift-card buys
 * @param {Array} [input.subscriptions]      Subscription rows
 * @param {number} [input.walletBalance]     current wallet balance
 * @returns {{ transactions: Array, summary: object }}
 */
function buildTransactionTimeline({
  patient,
  sales = [],
  walletTxns = [],
  memberships = [],
  plans = [],
  giftCards = [],
  invoicePayments = [],
  giftCardPaymentRows = [],
  subscriptions = [],
  walletBalance = 0,
} = {}) {
  const payments = [
    ...invoicePayments,
    ...selectGiftCardPayments(giftCardPaymentRows, patient),
  ];

  const txns = [];

  for (const s of sales) {
    const items = (s.lineItems || []).map((li) => ({
      name: li.name,
      kind: li.lineType,
      quantity: li.quantity,
      amount: li.lineTotal,
    }));
    const desc =
      items.length > 0
        ? items
            .map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`)
            .join(", ")
        : "Point-of-sale purchase";
    txns.push({
      id: `sale-${s.id}`,
      type: "POS_SALE",
      category: "Purchase",
      title: `Purchase · ${s.invoiceNumber}`,
      description: desc,
      amount: s.total,
      direction: s.status === "REFUNDED" ? "credit" : "debit",
      status: s.status,
      paymentMethod: s.paymentMethod,
      reference: s.invoiceNumber,
      date: s.createdAt,
      items,
    });
  }

  for (const w of walletTxns) {
    const credit = w.amount >= 0;
    const label = WALLET_LABELS[w.type] || "Wallet transaction";
    txns.push({
      id: `wallet-${w.id}`,
      type: "WALLET",
      category: "Wallet",
      title: label,
      description: w.reason || label,
      amount: Math.abs(w.amount),
      direction: credit ? "credit" : "debit",
      status: "COMPLETED",
      reference: null,
      date: w.createdAt,
      balanceAfter: w.balanceAfter,
    });
  }

  for (const m of memberships) {
    txns.push({
      id: `membership-${m.id}`,
      type: "MEMBERSHIP",
      category: "Membership",
      title: `Membership · ${m.plan?.name || "Plan"}`,
      description: `Valid ${new Date(m.startDate).toLocaleDateString()} – ${new Date(m.endDate).toLocaleDateString()}`,
      amount: m.plan?.price ?? 0,
      direction: "debit",
      status: m.status,
      reference: null,
      date: m.createdAt,
    });
  }

  for (const p of plans) {
    txns.push({
      id: `plan-${p.id}`,
      type: "TREATMENT_PLAN",
      category: "Treatment",
      title: `Treatment plan · ${p.name}`,
      description: `${p.completedSessions}/${p.totalSessions} sessions${p.service?.name ? ` · ${p.service.name}` : ""}`,
      amount: p.totalPrice,
      direction: "debit",
      status: p.status,
      reference: null,
      date: p.startedAt,
    });
  }

  for (const g of giftCards) {
    // Redeemed cards are already represented by the wallet credit (+ value)
    // and the purchase Payment (− price), so skip them here. Outstanding
    // cards render as an informational pending credit (NOT counted in totals).
    if (g.redeemedBy === patient.id) continue;
    txns.push({
      id: `giftcard-${g.id}`,
      type: "GIFTCARD",
      category: "Gift Card",
      title: `Gift card · ${g.name || g.code}`,
      description: `Pending credit · value ${g.amount}`,
      amount: g.amount,
      direction: "credit",
      status: g.status,
      reference: g.code,
      date: g.createdAt,
    });
  }

  for (const p of payments) {
    const isGiftCardBuy = p.kind === "giftcard_purchase";
    txns.push({
      id: `payment-${p.id}`,
      type: "PAYMENT",
      // Gift-card purchases group under the Gift Card filter as the EXPENSE
      // (the matching wallet credit shows as a Wallet row).
      category: isGiftCardBuy ? "Gift Card" : "Online Payment",
      title: isGiftCardBuy
        ? "Gift card purchase"
        : `Online payment${p.invoiceNum ? ` · ${p.invoiceNum}` : ""}`,
      description: `${p.gateway || "Gateway"}${p.gatewayId ? ` · ${p.gatewayId}` : ""}`,
      amount: p.amount,
      direction: p.status === "REFUNDED" ? "credit" : "debit",
      status: p.status,
      reference: p.gatewayId || null,
      date: p.paidAt || p.createdAt,
    });
  }

  for (const sub of subscriptions) {
    const amt = sub.amount != null ? Number(sub.amount) : 0;
    txns.push({
      id: `subscription-${sub.id}`,
      type: "SUBSCRIPTION",
      category: "Subscription",
      title: `Subscription · ${sub.planName}`,
      description: `${sub.status}${sub.renewalDate ? ` · renews ${new Date(sub.renewalDate).toLocaleDateString()}` : ""}`,
      amount: amt,
      direction: "debit",
      status: sub.status,
      reference: sub.razorpayPaymentId || sub.razorpayOrderId || null,
      date: sub.startDate || sub.createdAt,
    });
  }

  // Newest-first.
  txns.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const sumBy = (arr, pred, pick) =>
    arr.reduce((acc, x) => (pred(x) ? acc + (pick(x) || 0) : acc), 0);

  const posTotal =
    sumBy(sales, (s) => s.status === "COMPLETED", (s) => s.total) -
    sumBy(sales, (s) => s.status === "REFUNDED", (s) => s.total);
  const onlineTotal = sumBy(
    payments,
    (p) => p.status === "SUCCESS",
    (p) => p.amount,
  );
  const subscriptionsTotal = sumBy(
    subscriptions,
    (s) => s.status !== "CANCELLED",
    (s) => (s.amount != null ? Number(s.amount) : 0),
  );
  const walletTopUps = sumBy(
    walletTxns,
    (w) => w.type === "TOP_UP",
    (w) => w.amount,
  );

  const summary = {
    totalPaid: posTotal + onlineTotal + subscriptionsTotal,
    posTotal,
    onlineTotal,
    subscriptionsTotal,
    walletBalance: walletBalance || 0,
    walletTopUps,
    transactionCount: txns.length,
  };

  return { transactions: txns, summary };
}

module.exports = {
  buildTransactionTimeline,
  selectGiftCardPayments,
  GIFTCARD_PAYMENT_STATUSES,
};
