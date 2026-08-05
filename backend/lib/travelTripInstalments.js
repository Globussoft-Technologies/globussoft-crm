const prisma = require("./prisma");

function makeError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function normalizeParticipantIds(participantIds) {
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    return null;
  }

  return [...new Set(
    participantIds
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isFinite(value)),
  )];
}

function parsePlanInstalments(instalmentsJson) {
  let template;
  try {
    template = JSON.parse(instalmentsJson);
  } catch (_error) {
    throw makeError("instalmentsJson is not valid JSON", 400, "INVALID_JSON");
  }

  if (!Array.isArray(template) || template.length === 0) {
    throw makeError("instalmentsJson must be a non-empty array", 400, "EMPTY_INSTALMENTS");
  }

  return template.map((entry, index) => {
    const due = new Date(entry?.dueDate);
    if (!Number.isFinite(due.getTime())) {
      throw makeError(`instalment[${index}].dueDate is invalid`, 400, "INVALID_DATE");
    }

    const amount = Number(entry?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw makeError(`instalment[${index}].amount is invalid`, 400, "INVALID_AMOUNT");
    }

    return { instalmentIndex: index, dueDate: due, amount };
  });
}

async function materializeTripInstalmentsFromPlan({
  db = prisma,
  tripId,
  participantIds = null,
  allowMissingPlan = false,
} = {}) {
  const numericTripId = parseInt(tripId, 10);
  if (!Number.isFinite(numericTripId)) {
    throw makeError("tripId must be a number", 400, "INVALID_ID");
  }

  const plan = await db.tripPaymentPlan.findUnique({ where: { tripId: numericTripId } });
  if (!plan) {
    if (allowMissingPlan) {
      return {
        materialised: 0,
        skipped: 0,
        participants: 0,
        instalmentsPerParticipant: 0,
        planFound: false,
      };
    }
    throw makeError("Payment plan not found", 404, "NO_PLAN");
  }

  const normalised = parsePlanInstalments(plan.instalmentsJson);
  const selectedParticipantIds = normalizeParticipantIds(participantIds);

  const participantWhere = { tripId: numericTripId };
  if (selectedParticipantIds?.length) {
    participantWhere.id = { in: selectedParticipantIds };
  }

  const participants = await db.tripParticipant.findMany({
    where: participantWhere,
    select: { id: true },
  });

  if (participants.length === 0) {
    if (allowMissingPlan) {
      return {
        materialised: 0,
        skipped: 0,
        participants: 0,
        instalmentsPerParticipant: normalised.length,
        planFound: true,
      };
    }
    throw makeError("Trip has no participants to materialise instalments for", 400, "EMPTY_ROSTER");
  }

  const existingWhere = { tripId: numericTripId };
  if (selectedParticipantIds?.length) {
    existingWhere.participantId = { in: selectedParticipantIds };
  }

  const existing = await db.tripInstalmentPayment.findMany({
    where: existingWhere,
    select: { participantId: true, instalmentIndex: true },
  });

  const existingKeys = new Set(existing.map((row) => `${row.participantId}:${row.instalmentIndex}`));

  const toCreate = [];
  let skipped = 0;
  for (const participant of participants) {
    for (const instalment of normalised) {
      const key = `${participant.id}:${instalment.instalmentIndex}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      toCreate.push({
        tripId: numericTripId,
        participantId: participant.id,
        instalmentIndex: instalment.instalmentIndex,
        dueDate: instalment.dueDate,
        amount: instalment.amount,
        paidAmount: 0,
        paidAt: null,
        status: "pending",
      });
    }
  }

  let materialised = 0;
  if (toCreate.length > 0) {
    const result = await db.tripInstalmentPayment.createMany({ data: toCreate });
    materialised = result?.count ?? toCreate.length;
  }

  return {
    materialised,
    skipped,
    participants: participants.length,
    instalmentsPerParticipant: normalised.length,
    planFound: true,
  };
}

module.exports = {
  materializeTripInstalmentsFromPlan,
};
