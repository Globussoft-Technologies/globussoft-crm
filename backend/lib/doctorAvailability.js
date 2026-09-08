/**
 * Doctor double-booking prevention — one source of truth.
 *
 * A practitioner must never hold two appointments that overlap in time, no
 * matter which door the booking came through: staff booking form, patient app,
 * public widget, calendar drag, or an admin assigning a doctor after the fact.
 *
 * WHY THIS MODULE EXISTS
 *   The conflict rules were previously duplicated in two places and applied
 *   inconsistently:
 *
 *   1. `appointmentService.findSlotConflict` guarded reschedule and
 *      assign-doctor — but NOT `bookAppointment`, which is the front door for
 *      both the staff form and the patient app. Booking straight into an
 *      occupied slot was simply never checked.
 *
 *   2. Both that helper and `bookingAvailability`'s DOCTOR_DOUBLE_BOOKED class
 *      bucketed by clock hour using `setMinutes(0, 0, 0)` — which truncates in
 *      the SERVER's timezone. Clinics run on IST while servers run on UTC, so
 *      the buckets landed on :30 boundaries in local terms: 14:00 IST falls in
 *      [08:00,09:00) UTC and 14:30 IST in [09:00,10:00) UTC. Two appointments
 *      half an hour apart were therefore never seen as colliding, even when the
 *      service takes 50 minutes.
 *
 * HOW THIS ONE WORKS
 *   Overlap is computed on INSTANTS, never on local hour components. A visit
 *   occupies [visitDate, visitDate + service.durationMin). Two visits collide
 *   when `aStart < bEnd && bStart < aEnd` — the standard half-open interval
 *   test, which correctly treats back-to-back appointments (one ending exactly
 *   as the next begins) as NOT colliding.
 *
 *   Because visitDate is already stored as a true UTC instant (see
 *   appointmentService.parseIstVisitDate, which pins an IST wall-clock time to
 *   UTC), this math needs no timezone handling at all. Timezones only matter
 *   for choosing the day window to read, which callers pass in.
 */

const prisma = require("./prisma");

// Statuses that OCCUPY a doctor's time. Cancelled / completed / no-show
// release the slot: a cancelled 14:00 must not block a fresh 14:00 booking,
// and a visit that already happened cannot collide with a future one.
const OCCUPYING_STATUSES = ["booked", "confirmed", "arrived", "in-treatment"];

// Fallback when a visit has no service (or a service with no duration set).
// Matches Service.durationMin's own schema default so an unlinked visit still
// reserves a realistic block rather than a zero-length instant that collides
// with nothing.
const DEFAULT_DURATION_MIN = 30;

const MINUTE_MS = 60_000;

/** Minutes a visit occupies, falling back to the schema default. */
function durationOf(visit) {
  const raw = visit?.service?.durationMin ?? visit?.durationMin;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION_MIN;
  return n;
}

/**
 * Half-open interval overlap on instants.
 *
 * Half-open on purpose: an appointment ending at 14:00 and the next starting at
 * 14:00 do NOT collide. Treating that as a conflict would make back-to-back
 * scheduling impossible, which is how clinics actually run.
 */
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** [start, end) for a visit, as epoch milliseconds. */
function visitInterval(visit) {
  const start = visit.visitDate instanceof Date ? visit.visitDate : new Date(visit.visitDate);
  const startMs = start.getTime();
  return { startMs, endMs: startMs + durationOf(visit) * MINUTE_MS };
}

/**
 * Every appointment a doctor already holds that could overlap a window.
 *
 * Reads a padded day window rather than an exact range so a long appointment
 * starting before the window can still be seen to run into it. The padding is
 * generous (12h either side) because it costs one indexed range scan and the
 * alternative — missing a long-running visit — is a double booking.
 */
async function loadDoctorVisits({ tenantId, doctorId, aroundMs, excludeVisitId = null }) {
  const PAD_MS = 12 * 60 * MINUTE_MS;
  const where = {
    tenantId,
    doctorId,
    status: { in: OCCUPYING_STATUSES },
    visitDate: {
      gte: new Date(aroundMs - PAD_MS),
      lte: new Date(aroundMs + PAD_MS),
    },
  };
  if (excludeVisitId) where.id = { not: Number(excludeVisitId) };

  return prisma.visit.findMany({
    where,
    select: {
      id: true,
      visitDate: true,
      status: true,
      // The existing visit's OWN duration decides how far it reaches.
      service: { select: { id: true, name: true, durationMin: true } },
    },
  });
}

/**
 * Does this doctor already have something overlapping [startsAt, +durationMin)?
 *
 * @returns {Promise<null | { id, visitDate, endsAt, serviceName }>} the first
 *   colliding visit, or null when the doctor is free.
 */
async function findDoctorConflict({
  tenantId,
  doctorId,
  startsAt,
  durationMin,
  excludeVisitId = null,
}) {
  // No doctor means no doctor to double-book. An unassigned appointment is a
  // scheduling to-do, not a conflict.
  if (!doctorId || !tenantId || !startsAt) return null;

  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;

  const startMs = start.getTime();
  const endMs = startMs + (Number(durationMin) > 0 ? Number(durationMin) : DEFAULT_DURATION_MIN) * MINUTE_MS;

  const existing =
    (await loadDoctorVisits({
      tenantId,
      doctorId: Number(doctorId),
      aroundMs: startMs,
      excludeVisitId,
    })) || [];

  for (const v of existing) {
    const iv = visitInterval(v);
    if (intervalsOverlap(startMs, endMs, iv.startMs, iv.endMs)) {
      return {
        id: v.id,
        visitDate: v.visitDate,
        endsAt: new Date(iv.endMs),
        serviceName: v.service?.name || null,
      };
    }
  }
  return null;
}

/**
 * Which of these doctors are free for a given slot.
 *
 * One query for all of them rather than N — the Assign Doctor dropdown asks
 * about every practitioner at once, and a per-doctor round trip would make the
 * dropdown visibly slow on a busy day.
 *
 * @returns {Promise<Map<number, null | object>>} doctorId → conflicting visit,
 *   or null when that doctor is free.
 */
async function findConflictsForDoctors({
  tenantId,
  doctorIds,
  startsAt,
  durationMin,
  excludeVisitId = null,
}) {
  const result = new Map();
  const ids = (doctorIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 || !startsAt) return result;
  for (const id of ids) result.set(id, null);

  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(start.getTime())) return result;

  const startMs = start.getTime();
  const endMs = startMs + (Number(durationMin) > 0 ? Number(durationMin) : DEFAULT_DURATION_MIN) * MINUTE_MS;
  const PAD_MS = 12 * 60 * MINUTE_MS;

  const where = {
    tenantId,
    doctorId: { in: ids },
    status: { in: OCCUPYING_STATUSES },
    visitDate: { gte: new Date(startMs - PAD_MS), lte: new Date(startMs + PAD_MS) },
  };
  if (excludeVisitId) where.id = { not: Number(excludeVisitId) };

  const existing =
    (await prisma.visit.findMany({
      where,
      select: {
        id: true,
        doctorId: true,
        visitDate: true,
        service: { select: { name: true, durationMin: true } },
      },
    })) || [];

  for (const v of existing) {
    if (result.get(v.doctorId)) continue; // already found one for this doctor
    const iv = visitInterval(v);
    if (intervalsOverlap(startMs, endMs, iv.startMs, iv.endMs)) {
      result.set(v.doctorId, {
        id: v.id,
        visitDate: v.visitDate,
        endsAt: new Date(iv.endMs),
        serviceName: v.service?.name || null,
      });
    }
  }
  return result;
}

/**
 * Mark up a grid of candidate slots with whether the doctor is free.
 *
 * Takes the doctor's existing appointments ONCE and tests each candidate
 * against them, so a day's grid costs a single query.
 *
 * Critically, a slot is unavailable when it OVERLAPS an appointment — not only
 * when it starts at exactly the same minute. The previous implementation
 * compared start times alone, so a 50-minute visit at 14:00 left 14:30 looking
 * bookable and the doctor got double-booked by a patient following the UI.
 *
 * @param {object[]} slots     [{ startsAt: Date|string }]
 * @param {object[]} visits    existing visits (with service.durationMin)
 * @param {number} durationMin length of the slot being offered
 * @returns {object[]} the same slots with `available` and, when taken,
 *   `conflictVisitId`
 */
function markSlotAvailability(slots, visits, durationMin) {
  const busy = (visits || []).map((v) => ({ id: v.id, ...visitInterval(v) }));
  const slotMs = (Number(durationMin) > 0 ? Number(durationMin) : DEFAULT_DURATION_MIN) * MINUTE_MS;

  return (slots || []).map((slot) => {
    const s = slot.startsAt instanceof Date ? slot.startsAt : new Date(slot.startsAt);
    const startMs = s.getTime();
    const endMs = startMs + slotMs;
    const hit = busy.find((b) => intervalsOverlap(startMs, endMs, b.startMs, b.endMs));
    return {
      ...slot,
      available: !hit,
      ...(hit ? { conflictVisitId: hit.id } : {}),
    };
  });
}

/** Human-readable reason, reused by every caller's 409 body. */
function conflictMessage(conflict) {
  if (!conflict) return null;
  const svc = conflict.serviceName ? ` (${conflict.serviceName})` : "";
  return `This practitioner already has an appointment at that time${svc}.`;
}

module.exports = {
  OCCUPYING_STATUSES,
  DEFAULT_DURATION_MIN,
  durationOf,
  intervalsOverlap,
  visitInterval,
  loadDoctorVisits,
  findDoctorConflict,
  findConflictsForDoctors,
  markSlotAvailability,
  conflictMessage,
};
