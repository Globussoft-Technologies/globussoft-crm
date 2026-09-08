/**
 * Prescription renewal / medicine request service.
 *
 * ONE place where the renewal workflow lives, so the patient-portal entry
 * point (routes/wellness.js — `/portal/prescription-requests`) and the staff
 * entry point (routes/wellness_prescription_requests.js) can never drift on
 * validation, status semantics, notification fan-out or response shape. Both
 * route layers are thin: token → tenant/patient/user context → call in here.
 *
 * WHAT THE FLOW IS
 *   The Android app shows a patient their issued prescriptions. They tap
 *   "request renewal" on one, optionally tick specific medicines and say for
 *   how long, and POST it. We create a PrescriptionRequest row, notify the
 *   tenant's admins AND the doctor who wrote the original Rx (deep-linked to
 *   the request), and it lands in the clinic's Prescription Requests queue.
 *   Staff review it — with the patient's chart, the original Rx and the
 *   existing Callified call buttons right there — and accept / reject /
 *   complete it. The patient sees each of those in their portal inbox.
 *
 * THE TRUST BOUNDARY (this is the load-bearing part)
 *   The client sends a prescription id and, at most, a medicine selection, a
 *   duration and a note. EVERYTHING else is derived server-side:
 *     • the prescription is re-read from the DB and must belong to the
 *       calling patient — a patient cannot request a renewal of someone
 *       else's Rx by guessing an id;
 *     • doctorId comes from Prescription.doctorId, never from the body, so a
 *       request cannot be mis-attributed to a doctor who never prescribed it;
 *     • tenantId comes from the resolved Patient row.
 *   `resolveRequestedDrugs` additionally refuses any medicine that is not on
 *   the source prescription, so the request can never widen into a drug the
 *   doctor never wrote.
 *
 * WHY REQUESTED MEDICINES ARE SNAPSHOTTED
 *   We store the matched drug objects, not just their names. Prescription
 *   .drugs is a JSON text column that an amendment (PUT /prescriptions/:id)
 *   can rewrite — if we stored names only, a later amendment would silently
 *   change what the patient is on record as having asked for. The snapshot
 *   keeps the request readable exactly as it was made.
 */

const prisma = require("./prisma");
const { normalizePrescriptionDrugs } = require("./prescriptionHelpers");
const { notifyMany } = require("./notificationService");
const { createPatientNotification } = require("./patientNotificationService");
const { writeAudit } = require("./audit");

// ── Status vocabulary ───────────────────────────────────────────────────
// String column, not an enum — same additive-safety rationale as
// Prescription.status. The set is small and closed here so every caller
// agrees on it.
const STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
};
const REQUEST_STATUSES = Object.values(STATUS);

// Terminal states. A rejected or completed request is history — reopening it
// would let staff rewrite an outcome the patient has already been told about.
// The patient raises a fresh request instead.
const TERMINAL_STATUSES = [STATUS.REJECTED, STATUS.COMPLETED];

// PENDING → anything. ACCEPTED → completed or rejected (the doctor may accept,
// then find a reason not to dispense). Terminal states go nowhere.
const ALLOWED_TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.ACCEPTED, STATUS.REJECTED, STATUS.COMPLETED],
  [STATUS.ACCEPTED]: [STATUS.COMPLETED, STATUS.REJECTED],
  [STATUS.REJECTED]: [],
  [STATUS.COMPLETED]: [],
};

// Caps. A renewal is "keep me on this for a while longer", not an open-ended
// supply — 365 days is already generous for a chronic-medication repeat.
const MAX_DURATION_DAYS = 365;
const MAX_NOTE_LENGTH = 2000;
const MAX_LIST_LIMIT = 200;

class RenewalRequestError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.name = "RenewalRequestError";
    this.status = status;
    this.code = code;
  }
}

const bad = (code, message) =>
  new RenewalRequestError({ status: 400, code, message });

// ── Parsing / validation helpers (pure — unit-tested directly) ──────────

/**
 * Prescription.drugs is `String @db.Text` holding a JSON array. Return it as
 * a real array, tolerating the already-parsed and the malformed cases the
 * same way normalizePrescriptionDrugs does (empty array, never a throw).
 */
function parseDrugList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Canonical comparison key for a drug: its name, case- and space-insensitive. */
function drugKey(drug) {
  if (!drug) return "";
  const name =
    typeof drug === "string" ? drug : drug.name || drug.drugName || "";
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Reconcile the medicines the client asked for against the ones actually on
 * the prescription.
 *
 * Accepts either bare strings (`["Amoxicillin"]`) or objects
 * (`[{ name: "Amoxicillin 500mg" }]`) — Android sends whichever is cheaper
 * for it, and either way we match on the drug NAME and return the source
 * prescription's own drug object, so the stored snapshot is the clinic's
 * data rather than the client's.
 *
 * @returns {Array|null} matched drug objects, or null for "renew everything"
 * @throws  {RenewalRequestError} when a requested medicine isn't on the Rx
 */
function resolveRequestedDrugs(prescriptionDrugs, requested) {
  // Absent, null, or an empty array all mean "renew the complete
  // prescription". Normalising to null here gives that case exactly one
  // representation in the DB.
  if (requested === undefined || requested === null) return null;
  if (!Array.isArray(requested)) {
    throw bad(
      "INVALID_MEDICINES",
      "medicines must be an array of medicine names or objects",
    );
  }
  if (requested.length === 0) return null;

  const available = parseDrugList(prescriptionDrugs);
  if (available.length === 0) {
    throw bad(
      "PRESCRIPTION_HAS_NO_DRUGS",
      "This prescription has no medicines recorded against it",
    );
  }

  const byKey = new Map();
  for (const drug of available) {
    const key = drugKey(drug);
    if (key && !byKey.has(key)) byKey.set(key, drug);
  }

  const matched = [];
  const unknown = [];
  const seen = new Set();
  for (const entry of requested) {
    const key = drugKey(entry);
    if (!key) {
      throw bad(
        "INVALID_MEDICINES",
        "Every requested medicine needs a name",
      );
    }
    if (seen.has(key)) continue; // idempotent — a double-tap isn't an error
    seen.add(key);
    const match = byKey.get(key);
    if (!match) {
      unknown.push(typeof entry === "string" ? entry : entry.name || entry.drugName);
      continue;
    }
    matched.push(match);
  }

  if (unknown.length > 0) {
    // Naming the offenders matters: the app can only fix its selection if it
    // knows which entry the server rejected.
    throw bad(
      "MEDICINE_NOT_ON_PRESCRIPTION",
      `Not on this prescription: ${unknown.join(", ")}`,
    );
  }

  // Every drug on the Rx was picked — that IS a full renewal, so collapse it
  // to null rather than storing a redundant snapshot the UI would then have
  // to render as a list identical to the prescription itself.
  if (matched.length === byKey.size) return null;

  return matched;
}

/** Parse a YYYY-MM-DD (or ISO) date to a UTC-midnight Date; null if unusable. */
function parseDateOnly(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
  if (!m) return undefined; // undefined = "supplied but unparseable"
  const d = new Date(
    Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)),
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Normalise the "how long do you want it for" half of the request. Duration
 * and an explicit from/to window are independent and both optional — the app
 * may collect either, and a patient who says nothing simply leaves the call
 * to the doctor.
 */
function parseRequestedWindow({ durationDays, from, to } = {}) {
  let requestedDurationDays = null;
  if (durationDays !== undefined && durationDays !== null && durationDays !== "") {
    const n = Number(durationDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw bad(
        "INVALID_DURATION",
        "durationDays must be a positive whole number of days",
      );
    }
    if (n > MAX_DURATION_DAYS) {
      throw bad(
        "DURATION_TOO_LONG",
        `durationDays cannot exceed ${MAX_DURATION_DAYS}`,
      );
    }
    requestedDurationDays = n;
  }

  const requestedFrom = parseDateOnly(from);
  if (requestedFrom === undefined) {
    throw bad("INVALID_DATE", "from must be a YYYY-MM-DD date");
  }
  const requestedTo = parseDateOnly(to);
  if (requestedTo === undefined) {
    throw bad("INVALID_DATE", "to must be a YYYY-MM-DD date");
  }
  if (requestedFrom && requestedTo && requestedTo < requestedFrom) {
    throw bad("INVALID_DATE_RANGE", "to must be on or after from");
  }

  return { requestedDurationDays, requestedFrom, requestedTo };
}

function normalizeNote(raw, field = "notes") {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > MAX_NOTE_LENGTH) {
    throw bad("NOTE_TOO_LONG", `${field} cannot exceed ${MAX_NOTE_LENGTH} characters`);
  }
  return s;
}

function normalizeStatus(raw) {
  const s = String(raw || "").trim().toUpperCase();
  return REQUEST_STATUSES.includes(s) ? s : null;
}

function isAllowedTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ── Response projection ─────────────────────────────────────────────────

/**
 * Shape a PrescriptionRequest row for the API.
 *
 * `requestedDrugs` goes out as a real array and `isFullPrescription` states
 * the whole-Rx case explicitly, so neither the Android app nor the admin
 * table has to re-derive "null means everything" for itself — the single
 * most likely place for the two clients to disagree.
 */
function toPublicRequest(row, { includePrescription = true } = {}) {
  if (!row) return row;
  const requestedDrugs = row.requestedDrugs
    ? parseDrugList(row.requestedDrugs)
    : null;
  const out = {
    id: row.id,
    status: row.status,
    prescriptionId: row.prescriptionId,
    patientId: row.patientId,
    doctorId: row.doctorId ?? null,
    doctorName: row.doctor?.name ?? null,
    patientName: row.patient?.name ?? null,
    patientPhone: row.patient?.phone ?? null,
    isFullPrescription: !requestedDrugs || requestedDrugs.length === 0,
    requestedDrugs,
    requestedDurationDays: row.requestedDurationDays ?? null,
    requestedFrom: row.requestedFrom ?? null,
    requestedTo: row.requestedTo ?? null,
    notes: row.notes ?? null,
    reviewedById: row.reviewedById ?? null,
    reviewedByName: row.reviewedBy?.name ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewNote: row.reviewNote ?? null,
    fulfilledPrescriptionId: row.fulfilledPrescriptionId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (includePrescription && row.prescription) {
    out.prescription = normalizePrescriptionDrugs({
      id: row.prescription.id,
      drugs: row.prescription.drugs,
      instructions: row.prescription.instructions ?? null,
      status: row.prescription.status ?? null,
      createdAt: row.prescription.createdAt,
      visitId: row.prescription.visitId ?? null,
      visitDate: row.prescription.visit?.visitDate ?? null,
      serviceName: row.prescription.visit?.service?.name ?? null,
    });
  }
  if (Array.isArray(row.events)) {
    out.history = row.events.map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      note: e.note ?? null,
      actorType: e.actorType,
      actorName: e.actor?.name ?? null,
      createdAt: e.createdAt,
    }));
  }
  return out;
}

/** Deep link the notification recipients follow straight to the request. */
function requestLink(requestId) {
  return `/wellness/prescription-requests?request=${requestId}`;
}

/** Human summary of what was asked for — reused in every notification body. */
function describeRequest(request) {
  const drugs = request.requestedDrugs
    ? parseDrugList(request.requestedDrugs)
    : null;
  const what =
    !drugs || drugs.length === 0
      ? "the complete prescription"
      : drugs
          .slice(0, 3)
          .map((d) => d?.name || d?.drugName)
          .filter(Boolean)
          .join(", ") + (drugs.length > 3 ? ` +${drugs.length - 3} more` : "");
  const forHowLong = request.requestedDurationDays
    ? ` for ${request.requestedDurationDays} day(s)`
    : "";
  return `${what}${forHowLong}`;
}

// ── Prisma include shapes ───────────────────────────────────────────────

const LIST_INCLUDE = {
  patient: { select: { id: true, name: true, phone: true } },
  doctor: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  prescription: {
    select: { id: true, drugs: true, createdAt: true, status: true },
  },
};

const DETAIL_INCLUDE = {
  patient: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      dob: true,
      gender: true,
      allergies: true,
      contactId: true,
    },
  },
  doctor: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
  prescription: {
    select: {
      id: true,
      drugs: true,
      instructions: true,
      status: true,
      createdAt: true,
      visitId: true,
      visit: {
        select: { id: true, visitDate: true, service: { select: { name: true } } },
      },
    },
  },
  events: {
    orderBy: { createdAt: "asc" },
    include: { actor: { select: { id: true, name: true } } },
  },
};

// ── Write paths ─────────────────────────────────────────────────────────

/**
 * Fan the new request out to the people who can act on it: every tenant
 * admin, plus the doctor who wrote the original Rx.
 *
 * Best-effort by design — a SendGrid hiccup or a socket that is not attached
 * must never lose the request itself, which is already committed by the time
 * we get here. Failures are logged, not thrown.
 */
async function notifyStaffOfNewRequest(request, { patientName, io }) {
  try {
    const admins = await prisma.user.findMany({
      where: { tenantId: request.tenantId, role: "ADMIN", deactivatedAt: null },
      select: { id: true },
      take: 25,
    });
    const recipientIds = new Set(admins.map((a) => a.id));
    // The prescribing doctor gets it even if they are not an admin — they are
    // the one clinical person who can judge the renewal.
    if (request.doctorId) recipientIds.add(request.doctorId);
    if (recipientIds.size === 0) return;

    await notifyMany({
      userIds: [...recipientIds],
      tenantId: request.tenantId,
      title: "Prescription renewal requested",
      message: `${patientName || "A patient"} requested a renewal of ${describeRequest(request)}.`,
      type: "prescription",
      priority: "high",
      link: requestLink(request.id),
      entityType: "prescription-request",
      entityId: request.id,
      io,
    });
  } catch (err) {
    console.warn(
      "[prescriptionRenewal] staff notification failed:",
      err.message,
    );
  }
}

/**
 * Patient-inbox counterpart. Also best-effort.
 *
 * The link lands on the patient's own prescriptions surface and carries the
 * request id. The web page ignores the query param today (it has no
 * request-detail view); the Android app reads PatientNotification.link and can
 * route on it once the renewal screen lands, so the id is worth carrying.
 */
async function notifyPatient(request, { title, message, type = "prescription" }) {
  try {
    await createPatientNotification({
      patientId: request.patientId,
      tenantId: request.tenantId,
      title,
      message,
      type,
      link: `/wellness/my-prescriptions?request=${request.id}`,
    });
  } catch (err) {
    console.warn(
      "[prescriptionRenewal] patient notification failed:",
      err.message,
    );
  }
}

/**
 * Create a renewal request on behalf of the signed-in patient.
 *
 * @param {object} args
 * @param {number} args.patientId   resolved from the portal token, never the body
 * @param {number} args.tenantId    resolved from the Patient row
 * @param {object} args.body        raw client payload
 * @param {object} [args.io]        socket.io server, for live staff notifications
 */
async function createRenewalRequest({ patientId, tenantId, body = {}, io }) {
  const prescriptionId = Number(
    body.prescriptionId ?? body.prescription_id ?? body.prescriptionID,
  );
  if (!Number.isInteger(prescriptionId) || prescriptionId <= 0) {
    throw bad("PRESCRIPTION_ID_REQUIRED", "prescriptionId is required");
  }

  // Re-read the Rx and pin it to THIS patient in THIS tenant. This single
  // query is the whole authorisation story for the create path.
  const prescription = await prisma.prescription.findFirst({
    where: { id: prescriptionId, patientId, tenantId },
    select: {
      id: true,
      drugs: true,
      doctorId: true,
      status: true,
      createdAt: true,
    },
  });
  if (!prescription) {
    // Deliberately the same 404 whether the Rx does not exist or belongs to
    // someone else — a probing client learns nothing either way.
    throw new RenewalRequestError({
      status: 404,
      code: "PRESCRIPTION_NOT_FOUND",
      message: "Prescription not found",
    });
  }
  if (prescription.status === "cancelled") {
    throw new RenewalRequestError({
      status: 409,
      code: "PRESCRIPTION_CANCELLED",
      message:
        "This prescription was cancelled and cannot be renewed. Please book a consultation.",
    });
  }

  const requestedDrugs = resolveRequestedDrugs(
    prescription.drugs,
    body.medicines ?? body.requestedDrugs ?? body.drugs,
  );
  const { requestedDurationDays, requestedFrom, requestedTo } =
    parseRequestedWindow({
      durationDays: body.durationDays ?? body.requestedDurationDays,
      from: body.from ?? body.requestedFrom,
      to: body.to ?? body.requestedTo,
    });
  const notes = normalizeNote(body.notes ?? body.note);

  // One open request per prescription. Without this, a patient tapping twice
  // (or an app retrying a timed-out POST) floods the clinic queue with
  // duplicates that all have to be dispositioned by hand.
  const existing = await prisma.prescriptionRequest.findFirst({
    where: {
      prescriptionId,
      patientId,
      tenantId,
      status: { in: [STATUS.PENDING, STATUS.ACCEPTED] },
    },
    select: { id: true },
  });
  if (existing) {
    throw new RenewalRequestError({
      status: 409,
      code: "REQUEST_ALREADY_OPEN",
      message:
        "You already have a renewal request open for this prescription. The clinic will get back to you.",
    });
  }

  const request = await prisma.prescriptionRequest.create({
    data: {
      prescriptionId,
      patientId,
      // Derived, never trusted from the client — see the header note.
      doctorId: prescription.doctorId ?? null,
      requestedDrugs: requestedDrugs ? JSON.stringify(requestedDrugs) : null,
      requestedDurationDays,
      requestedFrom,
      requestedTo,
      notes,
      status: STATUS.PENDING,
      tenantId,
      events: {
        create: {
          action: "CREATED",
          toStatus: STATUS.PENDING,
          note: notes,
          actorType: "patient",
          tenantId,
        },
      },
    },
    include: LIST_INCLUDE,
  });

  const patientName = request.patient?.name || null;

  await writeAudit(
    "PrescriptionRequest",
    "CREATE",
    request.id,
    null,
    tenantId,
    {
      prescriptionId,
      patientId,
      doctorId: request.doctorId,
      isFullPrescription: !requestedDrugs,
      drugCount: requestedDrugs ? requestedDrugs.length : null,
      requestedDurationDays,
    },
    { actorType: "patient", patientId },
  ).catch((err) => {
    console.warn("[prescriptionRenewal] audit CREATE failed:", err.message);
  });

  await notifyStaffOfNewRequest(request, { patientName, io });
  await notifyPatient(request, {
    title: "Renewal request received",
    message: `We've received your request to renew ${describeRequest(request)}. The clinic will review it shortly.`,
  });

  return request;
}

/**
 * Move a request to a new status. Staff-side; `user` is the acting staff row.
 *
 * The transition is guarded by ALLOWED_TRANSITIONS *and* by a conditional
 * updateMany on the current status, so two reviewers hitting Accept and
 * Reject at the same moment can't both win — the loser gets a 409 rather
 * than silently overwriting a decision the patient has already been told.
 */
async function transitionRequest({
  tenantId,
  id,
  toStatus,
  user,
  note,
  fulfilledPrescriptionId,
}) {
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new RenewalRequestError({
      status: 404,
      code: "REQUEST_NOT_FOUND",
      message: "Request not found",
    });
  }
  const next = normalizeStatus(toStatus);
  if (!next) {
    throw bad(
      "INVALID_STATUS",
      `status must be one of: ${REQUEST_STATUSES.join(", ")}`,
    );
  }
  const reviewNote = normalizeNote(note, "note");

  const current = await prisma.prescriptionRequest.findFirst({
    where: { id: requestId, tenantId },
    select: { id: true, status: true, patientId: true, tenantId: true, requestedDrugs: true, requestedDurationDays: true },
  });
  if (!current) {
    throw new RenewalRequestError({
      status: 404,
      code: "REQUEST_NOT_FOUND",
      message: "Request not found",
    });
  }
  if (current.status === next) {
    throw new RenewalRequestError({
      status: 409,
      code: "STATUS_UNCHANGED",
      message: `This request is already ${next.toLowerCase()}`,
    });
  }
  if (TERMINAL_STATUSES.includes(current.status)) {
    throw new RenewalRequestError({
      status: 409,
      code: "REQUEST_CLOSED",
      message: `This request was already ${current.status.toLowerCase()} and cannot be changed`,
    });
  }
  if (!isAllowedTransition(current.status, next)) {
    throw new RenewalRequestError({
      status: 409,
      code: "INVALID_TRANSITION",
      message: `Cannot move a ${current.status.toLowerCase()} request to ${next.toLowerCase()}`,
    });
  }
  // A rejection the patient can't understand is worse than no rejection.
  if (next === STATUS.REJECTED && !reviewNote) {
    throw bad(
      "REJECTION_REASON_REQUIRED",
      "A reason is required when rejecting a renewal request",
    );
  }

  let fulfilledId = null;
  if (fulfilledPrescriptionId !== undefined && fulfilledPrescriptionId !== null && fulfilledPrescriptionId !== "") {
    const n = Number(fulfilledPrescriptionId);
    if (!Number.isInteger(n) || n <= 0) {
      throw bad("INVALID_PRESCRIPTION_ID", "fulfilledPrescriptionId must be a prescription id");
    }
    // The fulfilling Rx must exist, be in this tenant, and be for this
    // patient — otherwise the link would point at another patient's record.
    const rx = await prisma.prescription.findFirst({
      where: { id: n, tenantId, patientId: current.patientId },
      select: { id: true },
    });
    if (!rx) {
      throw new RenewalRequestError({
        status: 404,
        code: "FULFILLING_PRESCRIPTION_NOT_FOUND",
        message: "The prescription you linked was not found for this patient",
      });
    }
    fulfilledId = n;
  }

  // Compare-and-set on status: only updates while the row is still in the
  // state we validated against.
  const updateData = {
    status: next,
    reviewedById: user?.userId ?? null,
    reviewedAt: new Date(),
  };
  if (reviewNote !== null) updateData.reviewNote = reviewNote;
  if (fulfilledId !== null) updateData.fulfilledPrescriptionId = fulfilledId;

  const result = await prisma.prescriptionRequest.updateMany({
    where: { id: requestId, tenantId, status: current.status },
    data: updateData,
  });
  if (result.count === 0) {
    throw new RenewalRequestError({
      status: 409,
      code: "CONCURRENT_UPDATE",
      message: "Someone else updated this request — reload and try again",
    });
  }

  await prisma.prescriptionRequestEvent.create({
    data: {
      requestId,
      action: next,
      fromStatus: current.status,
      toStatus: next,
      note: reviewNote,
      actorUserId: user?.userId ?? null,
      actorType: "user",
      tenantId,
    },
  });

  const updated = await prisma.prescriptionRequest.findFirst({
    where: { id: requestId, tenantId },
    include: DETAIL_INCLUDE,
  });

  await writeAudit(
    "PrescriptionRequest",
    next,
    requestId,
    user?.userId ?? null,
    tenantId,
    {
      fromStatus: current.status,
      toStatus: next,
      patientId: current.patientId,
      hasNote: Boolean(reviewNote),
      fulfilledPrescriptionId: fulfilledId,
    },
  ).catch((err) => {
    console.warn("[prescriptionRenewal] audit transition failed:", err.message);
  });

  const PATIENT_COPY = {
    [STATUS.ACCEPTED]: {
      title: "Renewal request accepted",
      message: `Your request to renew ${describeRequest(current)} has been accepted. We'll let you know when it's ready.`,
    },
    [STATUS.REJECTED]: {
      title: "Renewal request declined",
      message: `Your request to renew ${describeRequest(current)} was declined. ${reviewNote || ""}`.trim(),
    },
    [STATUS.COMPLETED]: {
      title: "Renewal request completed",
      message: `Your renewal of ${describeRequest(current)} is ready.${reviewNote ? ` ${reviewNote}` : ""}`,
    },
  };
  const copy = PATIENT_COPY[next];
  if (copy) await notifyPatient({ ...current, id: requestId }, copy);

  return updated;
}

// ── Read paths ──────────────────────────────────────────────────────────

function clampLimit(raw, fallback = 50) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

/** The signed-in patient's own requests, newest first. */
async function listRequestsForPatient(patientId, { limit, status } = {}) {
  const where = { patientId };
  const wanted = normalizeStatus(status);
  if (wanted) where.status = wanted;
  const items = await prisma.prescriptionRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: clampLimit(limit),
    include: LIST_INCLUDE,
  });
  return items;
}

/**
 * Staff queue. Filters mirror the admin table's controls: status tab, patient
 * or doctor drill-down, and a free-text search over patient name / phone.
 */
async function listRequestsForStaff({
  tenantId,
  status,
  patientId,
  doctorId,
  q,
  limit,
  skip,
} = {}) {
  const where = { tenantId };
  const wanted = normalizeStatus(status);
  if (wanted) where.status = wanted;
  if (patientId) {
    const n = Number(patientId);
    if (Number.isInteger(n) && n > 0) where.patientId = n;
  }
  if (doctorId) {
    const n = Number(doctorId);
    if (Number.isInteger(n) && n > 0) where.doctorId = n;
  }
  const term = String(q || "").trim();
  if (term) {
    where.patient = {
      is: {
        OR: [
          { name: { contains: term } },
          { phone: { contains: term } },
          { email: { contains: term } },
        ],
      },
    };
  }

  const take = clampLimit(limit);
  const skipN = Math.max(parseInt(skip, 10) || 0, 0);

  const [items, total, statusRows] = await Promise.all([
    prisma.prescriptionRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip: skipN,
      include: LIST_INCLUDE,
    }),
    prisma.prescriptionRequest.count({ where }),
    // Tab counts are computed over the tenant (minus the status filter
    // itself) so switching tabs doesn't make the other tabs' badges vanish.
    prisma.prescriptionRequest.groupBy({
      by: ["status"],
      where: { ...where, status: undefined },
      _count: { _all: true },
    }),
  ]);

  const counts = REQUEST_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  for (const row of statusRows || []) {
    if (row?.status in counts) counts[row.status] = row._count?._all ?? 0;
  }

  return { items, total, counts };
}

async function getRequestForStaff({ tenantId, id }) {
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  return prisma.prescriptionRequest.findFirst({
    where: { id: requestId, tenantId },
    include: DETAIL_INCLUDE,
  });
}

module.exports = {
  RenewalRequestError,
  STATUS,
  REQUEST_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  MAX_DURATION_DAYS,
  // pure helpers (unit-tested directly)
  parseDrugList,
  drugKey,
  resolveRequestedDrugs,
  parseRequestedWindow,
  normalizeNote,
  normalizeStatus,
  isAllowedTransition,
  toPublicRequest,
  describeRequest,
  requestLink,
  // orchestration
  createRenewalRequest,
  transitionRequest,
  listRequestsForPatient,
  listRequestsForStaff,
  getRequestForStaff,
};
