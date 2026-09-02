const prisma = require("./prisma");
const { materializeTripInstalmentsFromPlan } = require("./travelTripInstalments");

function makeError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function parseMoneyAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/[₹,$\s]/g, "")
    .replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPaise(value) {
  const major = parseMoneyAmount(value);
  if (major == null) return null;
  return Math.round(major * 100);
}

function parsePageContent(page) {
  if (!page) return null;
  const content = page.content;
  if (content && typeof content === "object") return content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch (_err) {
    return null;
  }
}

function normaliseInstallment(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const amountMajor = parseMoneyAmount(entry.amount);
  if (!(amountMajor > 0)) return null;
  const dueDate = entry.dueDate ? new Date(entry.dueDate) : null;
  return {
    index,
    label: String(entry.tag || entry.title || `Instalment ${index + 1}`),
    title: String(entry.title || entry.tag || `Instalment ${index + 1}`),
    sub: String(entry.sub || ""),
    dueDate: dueDate && Number.isFinite(dueDate.getTime()) ? dueDate : null,
    amountMajor,
    amountPaise: Math.round(amountMajor * 100),
    raw: entry,
  };
}

function getLandingPagePaymentConfig(page) {
  const content = parsePageContent(page);
  const investment = content && content.investment && typeof content.investment === "object"
    ? content.investment
    : {};
  const payment = investment.payment && typeof investment.payment === "object"
    ? investment.payment
    : {};
  const installments = Array.isArray(investment.installments)
    ? investment.installments
        .map((entry, index) => normaliseInstallment(entry, index))
        .filter(Boolean)
    : [];

  return {
    enabled: payment.enabled === true,
    allowCompletePayment: payment.allowCompletePayment !== false,
    defaultMode: String(payment.defaultMode || "installment").toLowerCase() === "complete"
      ? "complete"
      : "installment",
    currency: String(payment.currency || investment.currency || "INR").toUpperCase(),
    installmentLabel: typeof payment.installmentLabel === "string" && payment.installmentLabel.trim()
      ? payment.installmentLabel.trim()
      : "Installment-wise payment",
    completeLabel: typeof payment.completeLabel === "string" && payment.completeLabel.trim()
      ? payment.completeLabel.trim()
      : "Complete payment",
    buttonLabel: typeof payment.buttonLabel === "string" && payment.buttonLabel.trim()
      ? payment.buttonLabel.trim()
      : "Pay & continue",
    stepTitle: typeof payment.stepTitle === "string" && payment.stepTitle.trim()
      ? payment.stepTitle.trim()
      : "Secure payment",
    intro: typeof payment.intro === "string" && payment.intro.trim()
      ? payment.intro.trim()
      : "Choose how you would like to pay for this registration.",
    installments,
    payment,
    investment,
    content,
  };
}

function resolveLandingPagePaymentSelection(page, selection = {}) {
  const cfg = getLandingPagePaymentConfig(page);
  if (!cfg.enabled) {
    throw makeError("Payment collection is disabled for this landing page", 409, "PAYMENT_DISABLED");
  }
  if (!cfg.installments.length) {
    throw makeError("No instalment amounts are configured for this landing page", 409, "PAYMENT_UNAVAILABLE");
  }

  const requestedMode = String(selection.mode || selection.paymentMode || cfg.defaultMode || "installment")
    .trim()
    .toLowerCase();
  const mode = requestedMode === "complete" || requestedMode === "full" || requestedMode === "all"
    ? "complete"
    : "installment";

  if (mode === "complete" && cfg.allowCompletePayment === false) {
    throw makeError("Complete payment is disabled for this landing page", 409, "COMPLETE_PAYMENT_DISABLED");
  }

  const rawIndex = selection.installmentIndex ?? selection.instalmentIndex ?? selection.selectedInstallmentIndex;
  const fallbackIndex = Number.isFinite(Number(cfg.payment.defaultInstallmentIndex))
    ? Number(cfg.payment.defaultInstallmentIndex)
    : 0;
  const parsedIndex = Number.isFinite(Number(rawIndex)) ? Number(rawIndex) : fallbackIndex;
  const selectedInstallment = cfg.installments.find((row) => row.index === parsedIndex) || cfg.installments[0];
  if (!selectedInstallment) {
    throw makeError("Unable to determine a payment instalment", 409, "PAYMENT_SELECTION_FAILED");
  }

  const selectedInstallments = mode === "complete"
    ? cfg.installments.slice()
    : [selectedInstallment];

  const amountMajor = selectedInstallments.reduce((sum, row) => sum + Number(row.amountMajor || 0), 0);
  const amountPaise = selectedInstallments.reduce((sum, row) => sum + Number(row.amountPaise || 0), 0);

  return {
    ...cfg,
    mode,
    installmentIndex: selectedInstallment.index,
    installmentIndexes: selectedInstallments.map((row) => row.index),
    selectedInstallment,
    selectedInstallments,
    amountMajor,
    amountPaise,
    buttonLabel: mode === "complete" ? cfg.completeLabel : cfg.buttonLabel,
    paymentTitle: mode === "complete" ? cfg.completeLabel : selectedInstallment.label,
  };
}

async function applyLandingPagePaymentToTrip({
  db = prisma,
  tripId,
  participantId,
  amountMajor,
  mode,
  installmentIndex = null,
  capturedAt = new Date(),
}) {
  const numericTripId = parseInt(tripId, 10);
  const numericParticipantId = parseInt(participantId, 10);
  if (!Number.isFinite(numericTripId)) {
    throw makeError("tripId must be a number", 400, "INVALID_TRIP_ID");
  }
  if (!Number.isFinite(numericParticipantId)) {
    throw makeError("participantId must be a number", 400, "INVALID_PARTICIPANT_ID");
  }

  const paymentMajor = Number(amountMajor);
  if (!(paymentMajor > 0)) {
    throw makeError("Payment amount must be greater than zero", 400, "INVALID_AMOUNT");
  }

  await materializeTripInstalmentsFromPlan({
    db,
    tripId: numericTripId,
    participantIds: [numericParticipantId],
  });

  const rows = await db.tripInstalmentPayment.findMany({
    where: { tripId: numericTripId, participantId: numericParticipantId },
    orderBy: { instalmentIndex: "asc" },
  });

  if (!rows.length) {
    throw makeError("Trip instalments could not be loaded for this participant", 409, "NO_INSTALMENTS");
  }

  const byPaise = (row) => {
    const amount = toPaise(row.amount);
    const paid = toPaise(row.paidAmount || 0) || 0;
    return {
      amount: amount == null ? 0 : amount,
      paid,
      due: Math.max(0, (amount == null ? 0 : amount) - paid),
    };
  };

  const targetRows = mode === "complete"
    ? rows.filter((row) => byPaise(row).due > 0)
    : rows.filter((row) => row.instalmentIndex === installmentIndex);

  if (!targetRows.length) {
    throw makeError("No matching instalment found for the payment choice", 409, "INSTALMENT_NOT_FOUND");
  }

  let remainingPaise = Math.round(paymentMajor * 100);
  const allocations = [];

  for (const row of targetRows) {
    const { amount, paid, due } = byPaise(row);
    if (due <= 0) continue;
    const applied = Math.min(remainingPaise, due);
    if (applied <= 0) continue;

    const updatedPaidPaise = paid + applied;
    const updatedPaidMajor = updatedPaidPaise / 100;
    const newStatus = updatedPaidPaise >= amount ? "paid" : "partial";

    const updated = await db.tripInstalmentPayment.update({
      where: { id: row.id },
      data: {
        paidAmount: updatedPaidMajor,
        paidAt: capturedAt,
        status: newStatus,
      },
    });

    allocations.push({
      id: updated.id,
      instalmentIndex: updated.instalmentIndex,
      amountMajor: amount / 100,
      paidMajor: updatedPaidMajor,
      appliedMajor: applied / 100,
      status: updated.status,
    });

    remainingPaise -= applied;
    if (remainingPaise <= 0) break;
  }

  if (remainingPaise > 0) {
    throw makeError("Payment amount does not match the selected instalment(s)", 409, "AMOUNT_MISMATCH");
  }

  return {
    tripId: numericTripId,
    participantId: numericParticipantId,
    paidMajor: paymentMajor,
    allocations,
    mode,
    installmentIndex,
  };
}

module.exports = {
  applyLandingPagePaymentToTrip,
  getLandingPagePaymentConfig,
  parseMoneyAmount,
  parsePageContent,
  resolveLandingPagePaymentSelection,
};
