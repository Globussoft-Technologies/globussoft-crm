const ZYLU_PAYMENT_FIELDS = [
  ["Cash", "Cash"],
  ["Card", "Card"],
  ["Online", "Online"],
  ["UPI", "UPI"],
  ["Pay Later", "Pay later"],
  ["Wallet", "Wallet"],
  ["Other", "Other"],
  ["Razorpay", "Razorpay"],
  ["Stripe", "Stripe"],
  ["Wallet Redemption", "Wallet redemption"],
  ["Cashback Redemption", "Cashback redemption"],
];

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function importedSource(value) {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed.source;
  return source && typeof source === "object" ? source : null;
}

export function getImportedVisitDetails(visit) {
  const notes = parseJson(visit?.notes);
  const source = importedSource(visit?.notes);
  if (!source || !notes?.sourceBookingId) return null;

  return {
    staff: String(source.Staff || "").trim(),
    services: String(source["Items / Services"] || "").trim(),
    bookingType: String(source["Booking Type"] || "").trim(),
    bookingNotes: String(source["Booking Notes"] || "").trim(),
    cancelReason: String(source["Void / Cancel Reason"] || "").trim(),
  };
}

function parseAmount(value) {
  const amount = Number(String(value ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

export function getImportedInvoicePaymentBreakdown(invoice) {
  const source = importedSource(invoice?.lineItemsJson);
  if (!source) return [];

  const breakdown = ZYLU_PAYMENT_FIELDS.flatMap(([field, label]) => {
    const amount = parseAmount(source[field]);
    return amount > 0 ? [{ mode: label, amount }] : [];
  });
  const paidAmount = Number(invoice?.amountPaid);
  const breakdownTotal = breakdown.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0 || Math.abs(breakdownTotal - paidAmount) > 0.01) {
    return [];
  }

  return breakdown;
}
