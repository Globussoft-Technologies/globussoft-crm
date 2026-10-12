// Receipt stores overlap only when a payment explicitly identifies the
// schedule/instalment it settled. Equal amounts alone are not an identity.
function travelInvoiceReceiptTotal(schedule = [], payments = [], installments = []) {
  const cents = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value) * 100)) : 0;
  const scheduleCredits = new Map();
  const installmentCredits = new Map();
  let wholeInvoiceCredits = 0;
  let total = 0;
  const seen = new Set();
  for (const payment of payments) {
    if (payment.id != null && seen.has(payment.id)) continue;
    seen.add(payment.id);
    const amount = cents(payment.amount);
    total += amount;
    const meta = payment.receiptMetadata || {};
    const scheduleId = meta.scheduleId || meta.milestoneId;
    if (scheduleId) scheduleCredits.set(Number(scheduleId), (scheduleCredits.get(Number(scheduleId)) || 0) + amount);
    else if (meta.kind === 'travel-invoice') wholeInvoiceCredits += amount;
    const installmentId = meta.tripInstalmentPaymentId || meta.instalmentPaymentId;
    if (installmentId) installmentCredits.set(Number(installmentId), (installmentCredits.get(Number(installmentId)) || 0) + amount);
  }
  for (const row of schedule) {
    const received = cents(row.receivedAmount ?? (row.status === 'paid' ? row.expectedAmount : 0));
    const remainder = Math.max(0, received - (scheduleCredits.get(Number(row.id)) || 0));
    const overlap = Math.min(remainder, wholeInvoiceCredits);
    wholeInvoiceCredits -= overlap;
    total += remainder - overlap;
  }
  for (const row of installments) {
    total += Math.max(0, cents(row.paidAmount) - (installmentCredits.get(Number(row.id)) || 0));
  }
  return total / 100;
}

module.exports = { travelInvoiceReceiptTotal };
