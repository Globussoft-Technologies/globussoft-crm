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

const WELLNESS_PAYMENT_MODE_LABELS = {
  cash: "Cash",
  card: "Card",
  online: "Online",
  upi: "UPI",
  pay_later: "Pay later",
  wallet: "Wallet",
  other: "Other",
  razorpay: "Razorpay",
  stripe: "Stripe",
  wallet_redemption: "Wallet redemption",
  cashback_redemption: "Cashback redemption",
  bank_transfer: "Bank transfer",
};

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
  const responseBreakdown = parseJson(invoice?.paymentBreakdown);
  const source = parseJson(invoice?.importedPaymentSplit);
  const breakdown = Array.isArray(responseBreakdown)
    ? responseBreakdown.flatMap((item) => {
        const key = String(item?.mode || "").trim().toLowerCase();
        const mode = WELLNESS_PAYMENT_MODE_LABELS[key] || String(item?.mode || "").trim();
        const amount = parseAmount(item?.amount);
        return mode && amount > 0 ? [{ mode, amount }] : [];
      })
    : source && typeof source === "object" && !Array.isArray(source)
      ? ZYLU_PAYMENT_FIELDS.flatMap(([field, label]) => {
          const amount = parseAmount(source[field]);
          return amount > 0 ? [{ mode: label, amount }] : [];
        })
      : [];
  const paidAmount = Number(invoice?.amountPaid);
  const breakdownTotal = breakdown.reduce((sum, item) => sum + item.amount, 0);
  const differenceInMinorUnits = Math.abs(
    Math.round(breakdownTotal * 100) - Math.round(paidAmount * 100),
  );
  if (
    breakdown.length < 2 ||
    !Number.isFinite(paidAmount) ||
    paidAmount <= 0 ||
    differenceInMinorUnits > 1
  ) {
    return [];
  }

  return breakdown;
}
