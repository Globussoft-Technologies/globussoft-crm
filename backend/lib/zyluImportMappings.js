const INVOICE_PAYMENT_FIELDS = [
  ["Cash", "cash"],
  ["Card", "card"],
  ["Online", "online"],
  ["UPI", "upi"],
  ["Pay Later", "paylater"],
  ["Wallet", "wallet"],
  ["Other", "other"],
  ["Razorpay", "razorpay"],
  ["Stripe", "stripe"],
  ["Wallet Redemption", "wallet_redemption"],
  ["Cashback Redemption", "cashback_redemption"],
];

function parseZyluInvoicePaymentBreakdown(lineItemsJson) {
  let parsed = lineItemsJson;
  if (typeof lineItemsJson === "string") {
    try {
      parsed = JSON.parse(lineItemsJson);
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") return [];
  const source = parsed.source;
  if (!source || typeof source !== "object") return [];

  return INVOICE_PAYMENT_FIELDS.flatMap(([field, mode]) => {
    const amount = Number(String(source[field] ?? "").replace(/[₹,\s]/g, ""));
    return Number.isFinite(amount) && amount > 0 ? [{ mode, amount }] : [];
  });
}

module.exports = { parseZyluInvoicePaymentBreakdown };
