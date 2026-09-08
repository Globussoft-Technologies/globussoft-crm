const prisma = require("./prisma");

const SUCCESS_PAYMENT_STATUSES = new Set(["SUCCESS", "PAID", "CAPTURED"]);
const TRIP_PAYMENT_KINDS = new Set([
  "tmc-instalment",
  "travel-trip-installment",
  "landing-page-registration",
]);

function parseMetadata(payment) {
  if (!payment?.metadata) return {};
  try {
    const parsed = JSON.parse(payment.metadata);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function isSuccessfulPayment(payment) {
  return SUCCESS_PAYMENT_STATUSES.has(String(payment?.status || "").toUpperCase());
}

function numericId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function reconcileTripInstalmentPayment({ db = prisma, instalment, amountMajor, capturedAt = new Date() }) {
  if (!instalment) return null;
  const amount = Number(instalment.amount) || 0;
  const previousPaid = Number(instalment.paidAmount) || 0;
  const capturedAmount = Number(amountMajor);
  const applied = Number.isFinite(capturedAmount) && capturedAmount > 0
    ? capturedAmount
    : Math.max(amount - previousPaid, 0);
  const paidAmount = Math.min(amount, previousPaid + applied);
  const status = paidAmount >= amount ? "paid" : "partial";
  let updated = instalment;
  if (String(instalment.status).toLowerCase() !== "paid" || paidAmount !== previousPaid) {
    updated = await db.tripInstalmentPayment.update({
      where: { id: instalment.id },
      data: { status, paidAmount, paidAt: capturedAt },
    });
  }

  return updated;
}

async function fetchCapturedGatewayPayment(payment, gateway) {
  if (!gateway?.client || isSuccessfulPayment(payment)) return null;

  const metadata = parseMetadata(payment);
  const paymentLinkId = metadata.plinkId ||
    (String(payment.gatewayId || "").startsWith("plink_") ? payment.gatewayId : null);
  if (paymentLinkId && gateway.client.paymentLink?.fetch) {
    try {
      const remote = await gateway.client.paymentLink.fetch(paymentLinkId);
      const status = String(remote?.status || "").toUpperCase();
      if (["PAID", "PARTIALLY_PAID"].includes(status)) {
        return {
          paidAt: remote?.updated_at ? new Date(remote.updated_at * 1000) : new Date(),
          amountMajor: remote?.amount_paid != null
            ? Number(remote.amount_paid) / 100
            : undefined,
        };
      }
    } catch (_err) {
      // A gateway status refresh is best-effort. The webhook or the next
      // portal load remains responsible for eventual convergence.
    }
    return null;
  }

  const orderId = metadata.orderId || payment.gatewayId;
  if (!orderId || !gateway.client.orders?.fetch) return null;
  try {
    const remote = await gateway.client.orders.fetch(orderId);
    const amountPaidPaise = Number(remote?.amount_paid);
    const expectedPaise = Number(payment.amount) * 100;
    const status = String(remote?.status || "").toLowerCase();
    if (status !== "paid" && !(Number.isFinite(amountPaidPaise) && amountPaidPaise > 0)) {
      return null;
    }
    return {
      paidAt: remote?.created_at ? new Date(remote.created_at * 1000) : new Date(),
      amountMajor: Number.isFinite(amountPaidPaise) && amountPaidPaise > 0
        ? amountPaidPaise / 100
        : (Number.isFinite(expectedPaise) ? Number(payment.amount) : undefined),
    };
  } catch (_err) {
    return null;
  }
}

async function resolveLandingParticipantId({ db, metadata }) {
  const directId = numericId(metadata.participantId);
  if (directId) return directId;
  const draftToken = String(metadata.draftToken || "").trim();
  if (!draftToken || !db.pendingTripRegistration?.findUnique) return null;
  const draft = await db.pendingTripRegistration.findUnique({
    where: { draftToken },
    select: { convertedToParticipantId: true },
  });
  return numericId(draft?.convertedToParticipantId);
}

/**
 * Make a customer payment and the TMC installment ledger converge.
 *
 * This is deliberately shared by the portal read path, the token payment
 * portal, and gateway callback recovery. Webhooks remain the normal fast
 * path, but a missed/delayed webhook must not leave a parent seeing "Pay now"
 * after Razorpay already reports the payment as captured.
 */
async function reconcileTripPaymentRecord({
  db = prisma,
  payment,
  gateway,
  capturedAt = new Date(),
}) {
  if (!payment) return { payment: null, refreshed: false, instalment: null };
  const metadata = parseMetadata(payment);
  if (!TRIP_PAYMENT_KINDS.has(String(metadata.kind || ""))) {
    return { payment, refreshed: false, instalment: null };
  }

  let currentPayment = payment;
  let effectiveCapturedAt = payment.paidAt || capturedAt;
  let capturedAmount = Number(payment.amount);
  let refreshed = false;
  if (!isSuccessfulPayment(currentPayment)) {
    const remote = await fetchCapturedGatewayPayment(currentPayment, gateway);
    if (!remote) return { payment: currentPayment, refreshed: false, instalment: null };
    if (Number.isFinite(Number(remote.amountMajor)) && Number(remote.amountMajor) > 0) {
      capturedAmount = Number(remote.amountMajor);
    }
    currentPayment = await db.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: remote.paidAt || capturedAt,
      },
    });
    effectiveCapturedAt = remote.paidAt || capturedAt;
    refreshed = true;
  }

  const tripId = numericId(metadata.tripId);
  if (!tripId) return { payment: currentPayment, refreshed, instalment: null };

  const participantId = metadata.kind === "landing-page-registration"
    ? await resolveLandingParticipantId({ db, metadata })
    : numericId(metadata.participantId);
  if (!participantId) {
    // Landing-page payments can succeed before staff converts the registration
    // draft. Leave the Payment row successful and retry allocation after the
    // conversion; marking it reconciled here would lose the allocation.
    return { payment: currentPayment, refreshed, instalment: null };
  }

  if (metadata.kind === "landing-page-registration") {
    const { applyLandingPagePaymentToTrip } = require("./landingPagePayments");
    await applyLandingPagePaymentToTrip({
      db,
      tripId,
      participantId,
      amountMajor: capturedAmount,
      mode: metadata.paymentMode === "complete" ? "complete" : "installment",
      installmentIndex: Number.isInteger(Number(metadata.installmentIndex))
        ? Number(metadata.installmentIndex)
        : 0,
      capturedAt: effectiveCapturedAt,
    });
    return { payment: currentPayment, refreshed, instalment: null };
  }

  const instalmentId = numericId(metadata.instalmentId);
  const instalment = instalmentId
    ? await db.tripInstalmentPayment.findFirst({
        where: { id: instalmentId, tripId, participantId },
      })
    : metadata.url
      ? await db.tripInstalmentPayment.findFirst({
          where: { tripId, participantId, paymentLinkUrl: metadata.url },
        })
      : null;
  const updatedInstalment = await reconcileTripInstalmentPayment({
    db,
    instalment,
    amountMajor: capturedAmount,
    capturedAt: effectiveCapturedAt,
  });
  return { payment: currentPayment, refreshed, instalment: updatedInstalment };
}

module.exports = {
  SUCCESS_PAYMENT_STATUSES,
  TRIP_PAYMENT_KINDS,
  isSuccessfulPayment,
  parseMetadata,
  reconcileTripInstalmentPayment,
  reconcileTripPaymentRecord,
};
