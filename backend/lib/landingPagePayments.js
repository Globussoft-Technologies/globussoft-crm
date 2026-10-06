const prisma = require("./prisma");
const { materializeTripInstalmentsFromPlan } = require("./travelTripInstalments");
const { createDraftInvoiceForParticipant } = require("./tmcParticipantInvoice");

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

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function cleanRegistrationValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function isParticipantLinkConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = Array.isArray(error.meta?.target)
    ? error.meta.target.join(",")
    : String(error.meta?.target || "");
  return /convertedToParticipantId|PendingTripRegistration_convertedToParticipantId_key/i.test(
    `${target} ${error.message || ""}`,
  );
}

async function markParticipantConfirmedAfterPayment(db, participantId) {
  if (!db.tripParticipant?.update) return;
  await db.tripParticipant.update({
    where: { id: Number(participantId) },
    data: { applicationStatus: "approved" },
  });
}

async function rejectDuplicatePendingRegistration(db, draft, participantId) {
  if (!db.pendingTripRegistration?.update || !draft?.id) return;
  await db.pendingTripRegistration.update({
    where: { id: draft.id },
    data: {
      status: "REJECTED",
      reviewNotes: `Duplicate registration; participant #${participantId} is already linked to another registration.`,
    },
  });
}

async function finalizePendingRegistration(db, draft, participant) {
  if (!draft || Number(draft.convertedToParticipantId) === Number(participant.id)) return;
  if (!db.pendingTripRegistration?.update) return;

  const duplicateWhere = {
    id: { not: draft.id },
    convertedToParticipantId: participant.id,
  };
  if (draft.tenantId != null) duplicateWhere.tenantId = draft.tenantId;
  if (draft.tripId != null) duplicateWhere.tripId = draft.tripId;

  const existingLink = db.pendingTripRegistration.findFirst
    ? await db.pendingTripRegistration.findFirst({
        where: duplicateWhere,
        select: { id: true, status: true, convertedToParticipantId: true },
      })
    : null;
  if (existingLink) {
    await rejectDuplicatePendingRegistration(db, draft, participant.id);
    return;
  }

  try {
    await db.pendingTripRegistration.update({
      where: { id: draft.id },
      data: {
        status: "CONVERTED",
        convertedToParticipantId: participant.id,
        reviewNotes: "Payment received; registration converted to a TMC participant.",
      },
    });
  } catch (error) {
    // Two callbacks can reconcile the same hosted payment concurrently. If
    // another callback won the one-to-one link race, preserve both rows and
    // close this duplicate without failing payment reconciliation.
    if (!isParticipantLinkConflict(error)) throw error;
    await rejectDuplicatePendingRegistration(db, draft, participant.id);
  }
}

function registrationValuesFromPayment({ draft, metadata }) {
  const registration = metadata.registration && typeof metadata.registration === "object"
    ? metadata.registration
    : {};
  const fields = metadata.registrationFields && typeof metadata.registrationFields === "object"
    ? metadata.registrationFields
    : {};
  const value = (...keys) => {
    for (const key of keys) {
      const candidate = draft?.[key]
        ?? registration[key]
        ?? fields[key]
        ?? metadata[key];
      const cleaned = cleanRegistrationValue(candidate);
      if (cleaned) return cleaned;
    }
    return "";
  };

  const explicitStudentName = value("studentName", "student_name");
  const explicitParentName = value("parentName", "parent_name");
  const contactName = value("name", "fullName", "parentName", "parent_name");
  const studentName = explicitStudentName || contactName;
  const parentName = explicitParentName || (explicitStudentName ? contactName : "") || contactName;

  return {
    studentName,
    studentSchool: value("studentSchool", "student_school", "school"),
    studentClass: value("studentClass", "student_class", "grade"),
    parentName,
    parentEmail: value("parentEmail", "parent_email", "email").toLowerCase(),
    parentPhone: value("parentPhone", "parent_phone", "phone"),
    passportNumber: value("passportNumber", "passport_number"),
  };
}

/**
 * Make a successful landing-page registration complete even when the browser
 * never reaches the final submit callback after Razorpay redirects back.
 *
 * This is intentionally kept beside the landing-page payment allocator so
 * the public callback, gateway webhook, Finance, and the TMC payment-plan
 * read path all use the same idempotent conversion/linkage behavior.
 */
async function ensureLandingPagePaymentRegistration({
  db = prisma,
  payment,
  metadata = parseJsonObject(payment?.metadata),
  tenantId = null,
} = {}) {
  if (!payment || metadata.kind !== "landing-page-registration") return null;

  const tripId = Number(metadata.tripId);
  const effectiveTenantId = Number(tenantId || metadata.tenantId);
  if (!Number.isInteger(tripId) || tripId <= 0 || !Number.isInteger(effectiveTenantId) || effectiveTenantId <= 0) return null;
  if (!db.tmcTrip?.findFirst || !db.tripParticipant?.findFirst || !db.tripParticipant?.create) return null;

  const trip = await db.tmcTrip.findFirst({
    where: { id: tripId, tenantId: effectiveTenantId },
    select: { id: true, tenantId: true, destination: true, tripCode: true },
  });
  if (!trip) return null;

  const draftToken = cleanRegistrationValue(metadata.draftToken);
  let draft = null;
  if (draftToken && db.pendingTripRegistration?.findUnique) {
    draft = await db.pendingTripRegistration.findUnique({ where: { draftToken } });
    if (draft && (Number(draft.tenantId) !== effectiveTenantId || Number(draft.tripId) !== tripId)) return null;
  }

  let values = registrationValuesFromPayment({ draft, metadata });
  // Older payment rows can have a Contact relation even though their
  // registration metadata did not include the parent fields. Use that
  // tenant-scoped Contact as a payer fallback so participant ownership and
  // Finance customer display can still be repaired without losing data.
  let payerContact = null;
  const paymentContactId = Number(payment.contactId || metadata.contactId);
  if (Number.isInteger(paymentContactId) && paymentContactId > 0 && db.contact?.findFirst) {
    payerContact = await db.contact.findFirst({
      where: { id: paymentContactId, tenantId: effectiveTenantId, deletedAt: null },
    });
    if (payerContact) {
      values = {
        ...values,
        parentName: values.parentName || cleanRegistrationValue(payerContact.name),
        parentEmail: values.parentEmail || cleanRegistrationValue(payerContact.email).toLowerCase(),
        parentPhone: values.parentPhone || cleanRegistrationValue(payerContact.phone),
      };
    }
  }
  let participant = null;
  const linkedParticipantId = Number(draft?.convertedToParticipantId || metadata.participantId);
  if (Number.isInteger(linkedParticipantId) && linkedParticipantId > 0) {
    participant = await db.tripParticipant.findFirst({
      where: { id: linkedParticipantId, tripId },
    });
  }

  // Older payment rows may already carry participantId but predate the
  // contact linkage fields. Use the participant as the authoritative source
  // for the payer details before resolving/creating the CRM Contact.
  if (participant) {
    values = {
      ...values,
      studentName: values.studentName || cleanRegistrationValue(participant.fullName),
      parentName: values.parentName || cleanRegistrationValue(participant.parentName),
      parentEmail: values.parentEmail || cleanRegistrationValue(participant.parentEmail).toLowerCase(),
      parentPhone: values.parentPhone || cleanRegistrationValue(participant.parentPhone),
    };
  }

  if (!participant && values.studentName) {
    const existingWhere = { tripId, fullName: values.studentName };
    const or = [];
    if (values.parentEmail) or.push({ parentEmail: values.parentEmail });
    if (values.parentPhone) or.push({ parentPhone: values.parentPhone });
    if (or.length) existingWhere.OR = or;
    participant = await db.tripParticipant.findFirst({
      where: existingWhere,
      orderBy: { id: "desc" },
    });
    if (participant) {
      participant = await (db.tripParticipant.update
        ? db.tripParticipant.update({
            where: { id: participant.id },
            data: {
              parentName: values.parentName || participant.parentName || null,
              parentEmail: values.parentEmail || participant.parentEmail || null,
              parentPhone: values.parentPhone || participant.parentPhone || null,
              passportNumber: values.passportNumber || participant.passportNumber || null,
              applicationStatus: "approved",
            },
          })
        : participant);
    }
  }

  if (!participant && values.studentName) {
    participant = await db.tripParticipant.create({
      data: {
        tripId,
        fullName: values.studentName,
        parentName: values.parentName || null,
        parentEmail: values.parentEmail || null,
        parentPhone: values.parentPhone || null,
        passportNumber: values.passportNumber || null,
        applicationStatus: "approved",
        consentCapturedAt: new Date(),
      },
    });
  }

  if (!participant) return null;

  if (participant.applicationStatus !== "approved") {
    await markParticipantConfirmedAfterPayment(db, participant.id);
    participant = { ...participant, applicationStatus: "approved" };
  }

  let contact = payerContact;
  if (db.contact?.findFirst && (values.parentEmail || values.parentPhone)) {
    const contactWhere = values.parentEmail
      ? { tenantId: effectiveTenantId, email: values.parentEmail, deletedAt: null }
      : { tenantId: effectiveTenantId, phone: values.parentPhone, deletedAt: null };
    contact = await db.contact.findFirst({ where: contactWhere });
    if (contact && db.contact.update) {
      contact = await db.contact.update({
        where: { id: contact.id },
        data: {
          name: values.parentName || contact.name || participant.parentName || participant.fullName,
          email: values.parentEmail || contact.email || null,
          phone: values.parentPhone || contact.phone || null,
          company: values.studentSchool || contact.company || null,
          source: contact.source || "tmc_registration",
          subBrand: contact.subBrand || "tmc",
        },
      });
    }
  }
  if (!contact && db.contact?.create && (values.parentEmail || values.parentPhone)) {
    contact = await db.contact.create({
      data: {
        tenantId: effectiveTenantId,
        name: values.parentName || participant.parentName || participant.fullName,
        email: values.parentEmail || null,
        phone: values.parentPhone || null,
        company: values.studentSchool || null,
        status: "Lead",
        source: "tmc_registration",
        subBrand: "tmc",
        aiScore: 30,
      },
    });
  }

  if (contact && db.deal?.findFirst && db.deal?.create) {
    const pageTitle = cleanRegistrationValue(metadata.pageTitle) || trip.destination || trip.tripCode || "TMC trip";
    const title = `LP Inbound: ${pageTitle}`;
    const existingDeal = await db.deal.findFirst({
      where: { tenantId: effectiveTenantId, contactId: contact.id, title },
      select: { id: true },
    });
    if (!existingDeal) {
      await db.deal.create({
        data: { title, amount: 0, stage: "lead", contactId: contact.id, tenantId: effectiveTenantId },
      });
    }
  }

  await finalizePendingRegistration(db, draft, participant);

  let linkedPayment = payment;
  if (db.payment?.update && payment.id) {
    const linkedMetadata = {
      ...metadata,
      participantId: participant.id,
      ...(contact ? { contactId: contact.id } : {}),
      registrationLinkedAt: metadata.registrationLinkedAt || new Date().toISOString(),
    };
    linkedPayment = await db.payment.update({
      where: { id: payment.id },
      data: {
        ...(contact ? { contactId: contact.id } : {}),
        metadata: JSON.stringify(linkedMetadata),
      },
    });
  }

  return {
    participant,
    participantId: participant.id,
    contact,
    contactId: contact?.id || null,
    payment: linkedPayment,
    draft,
    metadata: parseJsonObject(linkedPayment?.metadata || payment.metadata),
  };
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
  paymentId = null,
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

  // Gateway metadata commonly serializes the selected index as a string.
  const selectedIndex = installmentIndex == null ? null : Number(installmentIndex);
  if (mode !== "complete" && !Number.isInteger(selectedIndex)) {
    throw makeError("A valid payment instalment is required", 400, "INVALID_INSTALMENT_INDEX");
  }

  await materializeTripInstalmentsFromPlan({
    db,
    tripId: numericTripId,
    participantIds: [numericParticipantId],
  });

  // A participant must always have one customer invoice before payment is
  // applied. The helper is idempotent and also finds invoices that already
  // moved from Draft to Partial/Paid.
  const trip = await db.tmcTrip.findFirst({
    where: { id: numericTripId },
    select: { tenantId: true },
  });
  const invoice = trip
    ? await createDraftInvoiceForParticipant({
        db,
        tenantId: trip.tenantId,
        tripId: numericTripId,
        participantId: numericParticipantId,
      })
    : null;

  // Persist the travel-invoice link in metadata. Payment.invoiceId is the
  // legacy generic-Invoice identifier used throughout payments.js; storing a
  // TravelInvoice id there makes equal numeric ids resolve to the wrong
  // customer/invoice. Keep the two id domains explicit.
  if (paymentId && invoice && db.payment?.update) {
    try {
      const current = db.payment.findUnique
        ? await db.payment.findUnique({ where: { id: Number(paymentId) }, select: { metadata: true } })
        : null;
      let metadata = {};
      try { metadata = JSON.parse(current?.metadata || "{}"); } catch (_) {}
      await db.payment.update({
        where: { id: Number(paymentId) },
        data: {
          metadata: JSON.stringify({
            ...metadata,
            travelInvoiceId: invoice.id,
            tripId: numericTripId,
            participantId: numericParticipantId,
          }),
        },
      });
    } catch (_) { /* payment-link enrichment is best-effort */ }
  }

  const syncInvoiceStatus = async () => {
    if (!invoice) return;
    const paidRows = await db.tripInstalmentPayment.findMany({
      where: { tripId: numericTripId, participantId: numericParticipantId },
      select: { paidAmount: true },
    });
    const paidTotal = paidRows.reduce((sum, row) => sum + (Number(row.paidAmount) || 0), 0);
    const invoiceTotal = Number(invoice.totalAmount) || 0;
    await db.travelInvoice.update({
      where: { id: invoice.id },
      data: {
        status: paidTotal >= invoiceTotal && invoiceTotal > 0 ? "Paid" : paidTotal > 0 ? "Partial" : "Draft",
        paidAt: paidTotal >= invoiceTotal && invoiceTotal > 0 ? capturedAt : null,
      },
    });
  };

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

  let effectiveSelectedIndex = selectedIndex;
  let selectedRows = mode === "complete"
    ? rows
    : rows.filter((row) => row.instalmentIndex === selectedIndex);
  if (mode !== "complete" && !selectedRows.length) {
    const amountMatches = rows.filter((row) => {
      const rowState = byPaise(row);
      return rowState.due > 0 && rowState.due === Math.round(paymentMajor * 100);
    });
    // A stale gateway index can be recovered safely only when the payment
    // amount identifies one and only one unpaid installment. Never guess
    // between equal-valued installments.
    if (amountMatches.length === 1) {
      selectedRows = amountMatches;
      effectiveSelectedIndex = amountMatches[0].instalmentIndex;
    }
  }
  const targetRows = mode === "complete"
    ? selectedRows.filter((row) => byPaise(row).due > 0)
    : selectedRows;

  if (!targetRows.length) {
    // A repeated complete-payment callback after every installment has been
    // settled is an idempotent replay, not a missing installment. Do not
    // allocate again, but do make sure the participant is confirmed.
    if (selectedRows.length && selectedRows.every((row) => byPaise(row).due <= 0)) {
      await syncInvoiceStatus();
      await markParticipantConfirmedAfterPayment(db, numericParticipantId);
      return {
        tripId: numericTripId,
        participantId: numericParticipantId,
        paidMajor: 0,
        allocations: selectedRows.map((row) => ({ id: row.id, instalmentIndex: row.instalmentIndex, amountMajor: Number(row.amount || 0), paidMajor: Number(row.paidAmount || 0), appliedMajor: 0, status: row.status })),
        mode,
        installmentIndex: effectiveSelectedIndex,
      };
    }
    throw makeError("No matching instalment found for the payment choice", 409, "INSTALMENT_NOT_FOUND");
  }

  // Razorpay webhooks and the browser callback can both deliver the same
  // payment. Treat an already-paid target as an idempotent replay.
  if (targetRows.every((row) => byPaise(row).due <= 0)) {
    await syncInvoiceStatus();
    await markParticipantConfirmedAfterPayment(db, numericParticipantId);
    return {
      tripId: numericTripId,
      participantId: numericParticipantId,
      paidMajor: 0,
      allocations: targetRows.map((row) => ({ id: row.id, instalmentIndex: row.instalmentIndex, amountMajor: Number(row.amount || 0), paidMajor: Number(row.paidAmount || 0), appliedMajor: 0, status: row.status })),
      mode,
      installmentIndex: effectiveSelectedIndex,
    };
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

  await syncInvoiceStatus();
  await markParticipantConfirmedAfterPayment(db, numericParticipantId);

  return {
    tripId: numericTripId,
    participantId: numericParticipantId,
    paidMajor: paymentMajor,
    allocations,
    mode,
    installmentIndex: effectiveSelectedIndex,
  };
}

module.exports = {
  applyLandingPagePaymentToTrip,
  ensureLandingPagePaymentRegistration,
  getLandingPagePaymentConfig,
  parseMoneyAmount,
  parsePageContent,
  resolveLandingPagePaymentSelection,
};
