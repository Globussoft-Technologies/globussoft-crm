/**
 * Booking-conflict gate for the wellness Calendar (Wave 11 Agent GG).
 *
 * Why this module exists:
 *   The Google Doc audit (8 May 2026) flagged that wellness Calendar SYNC was
 *   complete (Google + Outlook integrations land in routes/calendar*.js) but
 *   resource AVAILABILITY was missing — there was no model for treatment
 *   rooms / machines / equipment, no holiday calendar, and no per-doctor
 *   working-hours guard. As a result POST /api/wellness/visits would happily
 *   double-book the same doctor at 14:00 on Diwali + 14:00 with the laser
 *   room booked at 13:30, with zero feedback to the receptionist.
 *
 *   This gate (assertVisitSlotAvailable) consumes the new Resource / Holiday /
 *   WorkingHours tables (see schema.prisma "Wave 11 Agent GG" block) and
 *   returns a 4-class conflict envelope. The envelope codes are stable —
 *   frontend / mobile clients will surface different copy per code.
 *
 * Conflict classes (checked in order — first hit wins):
 *   1. HOLIDAY_BLOCKED          — Holiday row matches the visit's IST date
 *      with scope = (tenant) | (location) | (doctor). Most-specific match
 *      always blocks; any one matching row trips this class.
 *   2. OUTSIDE_WORKING_HOURS    — visit has a doctorId, the doctor has
 *      WorkingHours rows for the visit's dayOfWeek, and the visit time falls
 *      outside the [startTime, endTime] window. If the doctor has NO rows for
 *      that day, we leave it un-checked (silent no-op rather than
 *      "everyone is off Sundays") — the operator must populate the schedule
 *      explicitly to opt in.
 *   3. RESOURCE_DOUBLE_BOOKED   — visit has a resourceId and another non-
 *      cancelled / non-completed visit overlaps the same resource at the
 *      same hour. Slot granularity = 1 hour (matches the calendar grid).
 *   4. DOCTOR_DOUBLE_BOOKED     — same shape as (3) but on doctorId. Same
 *      hour-bucket granularity.
 *
 * Why hour-bucket granularity (vs full duration math):
 *   The wellness Calendar UI renders a 1-hour-cell grid by practitioner.
 *   Two visits in the same hour cell with the same doctor / same resource
 *   stack vertically + are visually indistinguishable. The frontend booking
 *   modal ALWAYS posts on-the-hour times. A future enhancement (variable-
 *   length visits) will swap this for `[visitStart, visitStart+duration]`
 *   range overlap — tracked in TODOS.md as "advanced break-times / variable
 *   duration overlap".
 *
 * Returns shape:
 *   { ok: true }                          — slot is available
 *   { ok: false, code, detail }           — conflict — code is one of the 4
 *                                            class names above. detail is a
 *                                            short freeform string for the
 *                                            response body (used for the API
 *                                            error message).
 *
 * Error contract for callers:
 *   POST/PUT /visits should return 409 { error, code, detail } when ok=false.
 *   Status 409 (not 400) signals "request was valid, current state of the
 *   resource conflicts" — matches existing slot-collision handling in
 *   routes/booking_pages.js.
 *
 * Tenant TZ:
 *   Wellness clinics are India-only (product anchor). Day-boundary math uses
 *   Asia/Kolkata via the existing parseDateTimeLocalInTZ / formatInTenantTZ
 *   helpers from backend/lib/datetime.js. If a future tenant has a different
 *   TZ, swap WELLNESS_TZ for tenant.timezone — the helper already supports it.
 */

const prisma = require("./prisma");
const { formatInTenantTZ } = require("./datetime");

const WELLNESS_TZ = "Asia/Kolkata";

// Conflict-class codes — DO NOT reorder. Order is the load-bearing first-hit-
// wins precedence, and frontend clients have stable copy per code.
const CONFLICT_CODES = Object.freeze({
  HOLIDAY_BLOCKED: "HOLIDAY_BLOCKED",
  OUTSIDE_WORKING_HOURS: "OUTSIDE_WORKING_HOURS",
  RESOURCE_DOUBLE_BOOKED: "RESOURCE_DOUBLE_BOOKED",
  DOCTOR_DOUBLE_BOOKED: "DOCTOR_DOUBLE_BOOKED",
});

// Statuses that CONSUME a slot. cancelled + completed visits release the
// slot — a cancelled visit at 14:00 should not block a fresh booking at 14:00.
// 'completed' is included because the visit has already happened — the slot
// can't conflict with a future booking, and a duplicate completed-visit row
// at the same hour is a clinical-history concern, not a calendar concern.
const ACTIVE_STATUSES = ["booked", "arrived", "in-treatment", "no-show", "confirmed"];

/**
 * Render the visit's IST date as a "yyyy-MM-dd" string. Used to match
 * Holiday rows whose `date` is anchored at midnight IST.
 *
 * @param {Date} d
 * @returns {string}
 */
function istDateKey(d) {
  return formatInTenantTZ(d, WELLNESS_TZ, "yyyy-MM-dd");
}

/**
 * Render the visit's IST hour as "HH:mm" — used to compare against
 * WorkingHours.startTime / .endTime (string-comparison-safe for
 * zero-padded 24h times).
 *
 * @param {Date} d
 * @returns {string}
 */
function istTimeKey(d) {
  return formatInTenantTZ(d, WELLNESS_TZ, "HH:mm");
}

/**
 * Render the visit's IST day-of-week as a 0..6 int (0=Sunday).
 *
 * @param {Date} d
 * @returns {number}
 */
function istDayOfWeek(d) {
  // Compose an IST-localised Date by rendering then re-parsing — the
  // numeric weekday is stable since formatInTenantTZ returns wall-clock
  // local. Date.getDay() respects the local-VM-TZ but we re-anchor by
  // using a synthetic UTC midnight that exposes the IST weekday.
  const istIso = formatInTenantTZ(d, WELLNESS_TZ, "yyyy-MM-dd");
  // istIso is "2026-05-09"; new Date(istIso) parses as UTC midnight; UTC
  // midnight's getUTCDay() reflects the IST day correctly because the
  // input was already converted to IST date-only above.
  return new Date(istIso).getUTCDay();
}

/**
 * Compute the [start, end) of the visit's hour bucket in UTC. Used by the
 * resource + doctor overlap queries.
 *
 * @param {Date} d
 * @returns {{ hourStart: Date, hourEnd: Date }}
 */
function hourBucketUtc(d) {
  // Round DOWN to the start of the visit's UTC hour. Two visits in the same
  // 60-minute window share a bucket; a visit at 14:00 and one at 14:59 both
  // map to the 14:00..15:00 bucket and conflict.
  const hourStart = new Date(d);
  hourStart.setUTCMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
  return { hourStart, hourEnd };
}

/**
 * Gate POST/PUT /api/wellness/visits against booking conflicts.
 *
 * @param {object} visit
 * @param {number} visit.tenantId      — required
 * @param {Date|string} visit.visitDate — required
 * @param {number} [visit.id]          — when defined (PUT path), the
 *                                       overlap query excludes this visit
 *                                       (a PUT updating a row to its own
 *                                       slot must not self-conflict).
 * @param {number} [visit.doctorId]    — when set, doctor + working-hours
 *                                       checks are run; otherwise skipped.
 * @param {number} [visit.resourceId]  — when set, resource overlap is
 *                                       checked; otherwise skipped.
 * @param {number} [visit.locationId]  — narrows holiday-scope match; if
 *                                       null, only tenant-wide + doctor
 *                                       holidays apply.
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, detail: string }>}
 */
async function assertVisitSlotAvailable(visit) {
  const { tenantId, doctorId, resourceId, locationId, id: visitId } = visit;
  if (!tenantId) throw new Error("assertVisitSlotAvailable: tenantId required");
  if (!visit.visitDate) throw new Error("assertVisitSlotAvailable: visitDate required");

  const visitDateObj =
    visit.visitDate instanceof Date ? visit.visitDate : new Date(visit.visitDate);
  if (Number.isNaN(visitDateObj.getTime())) {
    throw new Error("assertVisitSlotAvailable: invalid visitDate");
  }

  // ── 1. HOLIDAY_BLOCKED ───────────────────────────────────────────────
  // Match Holiday rows where (tenantId match) AND (date == startOfIstDay).
  // Then filter in JS by scope precedence: tenant-wide always blocks;
  // location-scoped blocks if visit.locationId matches; doctor-scoped
  // blocks if visit.doctorId matches. Doing the OR-of-NULLs filter at the
  // Prisma query layer is clumsy; one round-trip + JS filter is simpler
  // and the row count for any one tenant on any one date is tiny (≤ 5).
  const dateKey = istDateKey(visitDateObj);
  const dayStart = new Date(`${dateKey}T00:00:00Z`);
  const dayEnd = new Date(`${dateKey}T23:59:59.999Z`);
  const holidays = await prisma.holiday.findMany({
    where: {
      tenantId,
      date: { gte: dayStart, lte: dayEnd },
    },
  });
  for (const h of holidays) {
    // Tenant-wide (no location, no doctor restriction)
    if (h.locationId == null && h.doctorId == null) {
      return {
        ok: false,
        code: CONFLICT_CODES.HOLIDAY_BLOCKED,
        detail: `Holiday: ${h.name}`,
      };
    }
    // Location-scoped — visit must have matching locationId
    if (h.locationId != null && h.locationId === locationId && h.doctorId == null) {
      return {
        ok: false,
        code: CONFLICT_CODES.HOLIDAY_BLOCKED,
        detail: `Holiday at this location: ${h.name}`,
      };
    }
    // Doctor-scoped — visit must have matching doctorId
    if (h.doctorId != null && h.doctorId === doctorId) {
      return {
        ok: false,
        code: CONFLICT_CODES.HOLIDAY_BLOCKED,
        detail: `Practitioner on leave: ${h.name}`,
      };
    }
  }

  // ── 2. OUTSIDE_WORKING_HOURS ─────────────────────────────────────────
  // Only relevant when the visit is assigned to a doctor. Look up the
  // doctor's WorkingHours for the visit's dayOfWeek; if zero rows, treat
  // as "no schedule configured" → silent no-op (operator opt-in).
  if (doctorId) {
    const dayOfWeek = istDayOfWeek(visitDateObj);
    const whRows = await prisma.workingHours.findMany({
      where: { tenantId, doctorId, dayOfWeek, isActive: true },
    });
    if (whRows.length > 0) {
      const visitTime = istTimeKey(visitDateObj);
      const inWindow = whRows.some(
        (wh) => visitTime >= wh.startTime && visitTime < wh.endTime
      );
      if (!inWindow) {
        const windowList = whRows
          .map((wh) => `${wh.startTime}–${wh.endTime}`)
          .join(", ");
        return {
          ok: false,
          code: CONFLICT_CODES.OUTSIDE_WORKING_HOURS,
          detail: `Practitioner works ${windowList} on this day`,
        };
      }
    }
  }

  // ── 3. RESOURCE_DOUBLE_BOOKED ────────────────────────────────────────
  if (resourceId) {
    const { hourStart, hourEnd } = hourBucketUtc(visitDateObj);
    const overlap = await prisma.visit.findFirst({
      where: {
        tenantId,
        resourceId,
        visitDate: { gte: hourStart, lt: hourEnd },
        status: { in: ACTIVE_STATUSES },
        // Exclude the visit being updated (PUT path)
        ...(visitId ? { id: { not: visitId } } : {}),
      },
      select: { id: true, visitDate: true },
    });
    if (overlap) {
      return {
        ok: false,
        code: CONFLICT_CODES.RESOURCE_DOUBLE_BOOKED,
        detail: `Resource already booked at this hour (visit #${overlap.id})`,
      };
    }
  }

  // ── 4. DOCTOR_DOUBLE_BOOKED ──────────────────────────────────────────
  if (doctorId) {
    const { hourStart, hourEnd } = hourBucketUtc(visitDateObj);
    const overlap = await prisma.visit.findFirst({
      where: {
        tenantId,
        doctorId,
        visitDate: { gte: hourStart, lt: hourEnd },
        status: { in: ACTIVE_STATUSES },
        ...(visitId ? { id: { not: visitId } } : {}),
      },
      select: { id: true, visitDate: true },
    });
    if (overlap) {
      return {
        ok: false,
        code: CONFLICT_CODES.DOCTOR_DOUBLE_BOOKED,
        detail: `Practitioner already booked at this hour (visit #${overlap.id})`,
      };
    }
  }

  return { ok: true };
}

module.exports = {
  assertVisitSlotAvailable,
  CONFLICT_CODES,
  // Exported for unit-test injection — NOT for route consumption.
  _internal: { istDateKey, istTimeKey, istDayOfWeek, hourBucketUtc, ACTIVE_STATUSES },
};
