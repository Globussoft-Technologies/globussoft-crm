// refundService.js — single source of truth for issuing a REAL gateway refund.
//
// Used by BOTH the Payments-page admin override (routes/payments.js) and the
// itinerary cancellation flow (routes/travel_itineraries.js). Refunds go
// through the tenant's OWN (BYOK) Razorpay keys, mark the Payment REFUNDED,
// reverse whatever the payment settled (generic invoice / travel milestone /
// travel invoice / travel-quote advance), audit, and emit an event.
//
// Everything is tenant-scoped via the Payment row's own tenantId. Never throws
// for expected conditions — returns { ok:false, status, code, error } so the
// caller maps it to the right HTTP envelope (or, for the cancellation flow,
// decides whether to still advance the lifecycle).

const prisma = require("./prisma");
const { writeAudit } = require("./audit");
const { getTenantRazorpayClient, NOT_CONFIGURED_MESSAGE, parseRazorpayError } = require("./tenantPaymentGateway");

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Is this Payment row a TRAVEL booking collection (advance / milestone / full
// invoice link)? Such payments should refund through the cancellation flow so
// the retention policy applies — the Payments page only allows an ADMIN
// override on them.
function isTravelBookingPayment(meta) {
  if (!meta) return false;
  return (
    meta.type === "travel-quote-advance" ||
    meta.type === "travel-payment-schedule" ||
    meta.kind === "travel-milestone" ||
    meta.kind === "travel-invoice"
  );
}

// A payment is gateway-refundable only if it's a captured Razorpay charge —
// i.e. we hold a real pay_… id. Manual / pending / non-razorpay rows are not.
function isRefundable(payment) {
  return Boolean(
    payment &&
      payment.status === "SUCCESS" &&
      String(payment.gateway || "").toLowerCase() === "razorpay" &&
      /^pay_/.test(String(payment.gatewayId || "")),
  );
}

// Reverse whatever this payment settled so the books match the money going
// back. Best-effort + never throws — a reconcile miss must NOT fail the refund
// (the money is already returned by the time this runs).
async function reverseLinkedRecords(payment, meta) {
  try {
    const scheduleId =
      meta.type === "travel-payment-schedule" || meta.kind === "travel-milestone"
        ? Number(meta.scheduleId)
        : null;
    if (Number.isFinite(scheduleId)) {
      const sched = await prisma.travelPaymentSchedule.findFirst({ where: { id: scheduleId } });
      if (sched) {
        await prisma.travelPaymentSchedule.update({
          where: { id: sched.id },
          data: { status: "pending", paidAt: null, receivedAmount: null },
        });
        const sibs = await prisma.travelPaymentSchedule.findMany({
          where: { invoiceId: sched.invoiceId, tenantId: sched.tenantId },
          select: { status: true },
        });
        const anyPaid = sibs.some((s) => s.status === "paid");
        await prisma.travelInvoice
          .update({ where: { id: sched.invoiceId }, data: { status: anyPaid ? "Partial" : "Issued", paidAt: null } })
          .catch(() => {});
      }
      return;
    }
    if (meta.kind === "travel-invoice" && Number.isFinite(Number(meta.travelInvoiceId))) {
      await prisma.travelInvoice
        .update({ where: { id: Number(meta.travelInvoiceId) }, data: { status: "Issued", paidAt: null } })
        .catch(() => {});
      return;
    }
    if (meta.type === "travel-quote-advance" && Number.isFinite(Number(meta.quoteId))) {
      await prisma.travelQuote
        .updateMany({
          where: { id: Number(meta.quoteId) },
          data: { status: "accepted", advancePaidAt: null, advancePaidAmount: null, advancePaymentId: null },
        })
        .catch(() => {});
      return;
    }
    if (payment.invoiceId) {
      await prisma.invoice
        .update({ where: { id: payment.invoiceId }, data: { status: "REFUNDED" } })
        .catch(() => {});
    }
  } catch (e) {
    console.error("[refundService] reverseLinkedRecords error:", e.message);
  }
}

// Mark the Payment REFUNDED + stash refund details, audit, reverse, emit.
async function finalizeRefund(payment, { refundId, amount, reason, refundStatus, userId }) {
  const meta = safeJsonParse(payment.metadata, {});
  const newMeta = {
    ...meta,
    refund: { id: refundId || null, amount, reason: reason || null, status: refundStatus || "processed" },
  };
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "REFUNDED", metadata: JSON.stringify(newMeta) },
  });
  await writeAudit("Payment", "REFUND", payment.id, userId || null, payment.tenantId, {
    amount, reason: reason || null, refundId: refundId || null, gateway: payment.gateway,
  }).catch(() => {});
  await reverseLinkedRecords(payment, meta);
  try {
    require("./eventBus").emitEvent(
      "payment.refunded",
      { paymentId: payment.id, amount, refundId: refundId || null, tenantId: payment.tenantId },
      payment.tenantId,
    );
  } catch (_e) { /* best-effort */ }
  return updated;
}

/**
 * Issue a real refund for a captured Razorpay payment.
 *
 * @param {object} opts
 * @param {object} opts.payment   The Payment row (must be tenant-scoped already).
 * @param {number} [opts.amount]  Refund amount in MAJOR units; default = full.
 *                                Clamped to (0, payment.amount].
 * @param {string} [opts.reason]
 * @param {number} [opts.userId]
 * @returns {Promise<{ok:true, payment:object, refund:object} | {ok:false, status:number, code:string, error:string}>}
 */
async function refundCapturedPayment({ payment, amount, reason, userId }) {
  if (!payment) return { ok: false, status: 404, code: "PAYMENT_NOT_FOUND", error: "Payment not found" };
  if (payment.status === "REFUNDED") {
    return { ok: false, status: 409, code: "ALREADY_REFUNDED", error: "This payment is already refunded." };
  }
  if (payment.status !== "SUCCESS") {
    return { ok: false, status: 400, code: "NOT_REFUNDABLE", error: `Only successful payments can be refunded (this one is ${payment.status}).` };
  }

  const gw = String(payment.gateway || "").toLowerCase();
  if (gw === "stripe") {
    return { ok: false, status: 501, code: "STRIPE_REFUND_UNAVAILABLE", error: "Stripe refunds aren't wired yet — this flow currently supports Razorpay (BYOK)." };
  }
  if (gw !== "razorpay") {
    return { ok: false, status: 422, code: "MANUAL_PAYMENT", error: "This payment was recorded manually (no gateway charge) — there's nothing to refund through a gateway. Cancel the invoice or record the refund in your books." };
  }
  if (!payment.gatewayId || !/^pay_/.test(String(payment.gatewayId))) {
    return { ok: false, status: 422, code: "NO_GATEWAY_REFERENCE", error: "No Razorpay payment id on this row to refund — it was recorded manually or never captured." };
  }

  const fullAmount = Number(payment.amount || 0);
  let amt = fullAmount;
  if (amount != null && String(amount) !== "") {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || a > fullAmount + 1e-9) {
      return { ok: false, status: 400, code: "INVALID_AMOUNT", error: `Refund amount must be between 0 and ${fullAmount}.` };
    }
    amt = a;
  }
  const amountMinor = Math.round(amt * 100);

  const tenantGateway = await getTenantRazorpayClient(payment.tenantId);
  if (!tenantGateway) {
    return { ok: false, status: 503, code: "NO_GATEWAY", error: NOT_CONFIGURED_MESSAGE };
  }

  let refund;
  try {
    refund = await tenantGateway.client.payments.refund(String(payment.gatewayId), {
      amount: amountMinor,
      speed: "normal",
      notes: { tenantId: String(payment.tenantId), paymentId: String(payment.id), reason: reason || "" },
    });
  } catch (err) {
    console.error("[refundService] razorpay refund failed:", err && err.message);
    const parsed = parseRazorpayError(err);
    return { ok: false, status: parsed.status, code: parsed.code, error: parsed.message };
  }

  const updated = await finalizeRefund(payment, {
    refundId: refund && refund.id,
    amount: amt,
    reason,
    refundStatus: (refund && refund.status) || "processed",
    userId,
  });
  return { ok: true, payment: updated, refund: { id: refund && refund.id, amount: amt, status: (refund && refund.status) || "processed" } };
}

module.exports = {
  refundCapturedPayment,
  finalizeRefund,
  reverseLinkedRecords,
  isRefundable,
  isTravelBookingPayment,
  safeJsonParse,
};
