// Wave 2 Agent JJ -- Staff Attendance + Biometric webhook (Google Doc audit, 8 May 2026).
//
// Surfaces:
//   POST /api/attendance/clock-in                -- self-service Punch In
//   POST /api/attendance/clock-out               -- self-service Punch Out
//   GET  /api/attendance/me?from&to              -- own attendance history
//   GET  /api/attendance/staff/:userId?from&to   -- manager/admin: another user's history
//   GET  /api/attendance/summary?from&to&userId  -- manager/admin: aggregate stats
//   POST /api/attendance/biometric/webhook       -- X-API-Key auth via BiometricDevice.apiKey
//   GET  /api/attendance/devices                 -- admin: list registered biometric devices
//   POST /api/attendance/devices                 -- admin: register a new device
//   PUT  /api/attendance/devices/:id             -- admin: edit (name/isActive)
//   DELETE /api/attendance/devices/:id           -- admin: deregister
//
// /summary response shape (extended for #802 + #804 — additive, back-compat):
//   {
//     totalRows, present, halfDay, late, absent, holiday, totalMinutes,
//     early,         // #802 — clock-in strictly before (start - tolerance)
//     onTime,        // #802 — clock-in within ±tolerance of scheduled start
//     policy: { shiftStartHour, shiftStartMinute, onTimeToleranceMin },
//     byUser: { [userId]: { userId, days, minutes, present, halfDay,
//                            late, absent, leaves, early?, onTime? } }
//   }
// `leaves` is the count of APPROVED LeaveRequest rows overlapping the
// period for the user (the LeaveRequest model exists in schema.prisma).
//
// Security:
//   - All routes except /biometric/webhook require verifyToken (mounted under /api).
//   - Manager-only routes use verifyRole(["ADMIN", "MANAGER"]).
//   - Biometric webhook is the only OPEN path -- it auths via X-API-Key matched
//     against BiometricDevice.apiKey. The route is added to server.js openPaths so
//     the global JWT guard skips it. This is the same pattern used by /sms/webhook.
//
// Tenant scope: every query filters by req.user.tenantId. The biometric webhook
// derives tenantId from the matched BiometricDevice row (cross-tenant device
// keys are impossible because @@unique([apiKey]) makes the key globally unique).

const express = require("express");
const prisma = require("../lib/prisma");
const crypto = require("crypto");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
// #665: shared inverted-date-range guard — see lib/validateDateRange.js. Pre-this
// the three history endpoints (/me /staff/:id /summary) silently returned empty
// rows when the operator passed to < from.
const { validateDateRange } = require("../lib/validateDateRange");
// Geo-tagged attendance (wellness only) — see lib/attendanceGeofence.js for
// the full design rationale (multi-location, unenforced-when-unassigned,
// accuracy threshold, per-Location radius).
const { evaluatePunchGeofence } = require("../lib/attendanceGeofence");

const router = express.Router();

// Resolve the punching user's tenant vertical + assigned clinics in one
// round trip. Returns { vertical, assignedLocations } — assignedLocations
// is [] for non-wellness tenants (never queried) or wellness users with no
// UserLocation rows (evaluatePunchGeofence treats [] as "not enforced").
async function resolveGeofenceContext(tenantId, userId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  const vertical = tenant ? tenant.vertical : null;
  if (vertical !== "wellness") return { vertical, assignedLocations: [] };

  // userId is always req.user.userId (the caller's own JWT-derived id, never
  // attacker-supplied) so this can't leak another user's assignments — the
  // location.tenantId filter is defense-in-depth against a UserLocation row
  // ever pointing at a Location outside the caller's own tenant.
  const rows = await prisma.userLocation.findMany({
    where: { userId, location: { tenantId } },
    select: { location: { select: { id: true, name: true, latitude: true, longitude: true, geofenceRadiusM: true } } },
  });
  return { vertical, assignedLocations: rows.map((r) => r.location) };
}

// Body coords are sent as strings/numbers by fetch/JSON — coerce once here
// so lib/attendanceGeofence.js can assume real numbers or undefined.
function parseCoords(body) {
  const lat = Number(body && body.latitude);
  const lng = Number(body && body.longitude);
  const acc = Number(body && body.accuracy);
  return {
    latitude: Number.isFinite(lat) ? lat : undefined,
    longitude: Number.isFinite(lng) ? lng : undefined,
    accuracy: Number.isFinite(acc) ? acc : undefined,
  };
}

// Standard tenant-where helper -- mirrors the pattern used by routes/wellness.js
// and routes/inventory.js. Routes that need cross-tenant lookups (the biometric
// webhook) build their where-clauses manually.
const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// Anchor a JS Date to 00:00 UTC of its calendar day. Used for the
// Attendance.date column so two different clock-in timestamps within the same
// shift day collapse onto a single attendance row (the @@unique constraint
// dedupes via tenantId+userId+date).
function anchorDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

// Validate ISO date strings on inbound query params. Returns Date or null.
function parseISO(s) {
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// #802 — Early / On-Time derivation for the /summary aggregator.
//
// No ShiftPolicy model exists yet, so we apply a single tenant-wide default
// scheduled-start (09:00 UTC) and a tolerance window. The constants are
// env-overridable so demo / production operators can tune them without a
// schema migration:
//   - ATTENDANCE_SHIFT_START_HOUR (0-23, default 9)        -- the scheduled
//     clock-in hour, UTC. Attendance.date is anchored to 00:00 UTC of the
//     calendar day, so we apply this hour to that anchor for the comparison.
//   - ATTENDANCE_SHIFT_START_MINUTE (0-59, default 0)
//   - ATTENDANCE_ON_TIME_TOLERANCE_MIN (default 15)        -- a clock-in
//     within ±tolerance of the scheduled start counts as ON_TIME. Earlier
//     than (start - tolerance) counts as EARLY. Later than (start +
//     tolerance) counts as neither (and the LATE flag is set elsewhere; we
//     don't re-derive it here, we just count rows where status === 'LATE').
//
// These three counters (`early`, `onTime`) are derived purely from
// clockInAt — they're orthogonal to the Attendance.status enum and don't
// need schema changes. Rows with no clockInAt (ABSENT / HOLIDAY) contribute
// to neither bucket.
const SHIFT_START_HOUR = (() => {
  const v = parseInt(process.env.ATTENDANCE_SHIFT_START_HOUR, 10);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : 9;
})();
const SHIFT_START_MINUTE = (() => {
  const v = parseInt(process.env.ATTENDANCE_SHIFT_START_MINUTE, 10);
  return Number.isFinite(v) && v >= 0 && v <= 59 ? v : 0;
})();
const ON_TIME_TOLERANCE_MIN = (() => {
  const v = parseInt(process.env.ATTENDANCE_ON_TIME_TOLERANCE_MIN, 10);
  return Number.isFinite(v) && v >= 0 ? v : 15;
})();

// Shift-end policy — mirrors the start-side constants so /summary can compute
// Early / On-Time / Late Departure KPIs from clockOutAt. Defaults to 18:00 UTC
// (6 PM). Operators can tune via ATTENDANCE_SHIFT_END_HOUR / _MINUTE.
const SHIFT_END_HOUR = (() => {
  const v = parseInt(process.env.ATTENDANCE_SHIFT_END_HOUR, 10);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : 18;
})();
const SHIFT_END_MINUTE = (() => {
  const v = parseInt(process.env.ATTENDANCE_SHIFT_END_MINUTE, 10);
  return Number.isFinite(v) && v >= 0 && v <= 59 ? v : 0;
})();

// Returns "EARLY" | "ON_TIME" | "AFTER" | null. null means the row has no
// clockInAt (ABSENT / HOLIDAY / un-punched-in).
function classifyPunctuality(row) {
  if (!row || !row.clockInAt) return null;
  const dayAnchor = row.date instanceof Date ? row.date : new Date(row.date);
  const scheduled = new Date(Date.UTC(
    dayAnchor.getUTCFullYear(),
    dayAnchor.getUTCMonth(),
    dayAnchor.getUTCDate(),
    SHIFT_START_HOUR,
    SHIFT_START_MINUTE,
    0,
    0
  ));
  const clockIn = row.clockInAt instanceof Date ? row.clockInAt : new Date(row.clockInAt);
  const deltaMin = (clockIn.getTime() - scheduled.getTime()) / 60000;
  if (deltaMin < -ON_TIME_TOLERANCE_MIN) return "EARLY";
  if (deltaMin <= ON_TIME_TOLERANCE_MIN) return "ON_TIME";
  return "AFTER";
}

// Mirror of classifyPunctuality for the clock-out side. Returns
// "EARLY" | "ON_TIME" | "LATE" | null. null means no clockOutAt yet.
//   EARLY    — left before (shiftEnd - tolerance) — left early
//   ON_TIME  — within ±tolerance of shiftEnd
//   LATE     — left after (shiftEnd + tolerance) — worked overtime / late departure
function classifyDeparture(row) {
  if (!row || !row.clockOutAt) return null;
  const dayAnchor = row.date instanceof Date ? row.date : new Date(row.date);
  const scheduled = new Date(Date.UTC(
    dayAnchor.getUTCFullYear(),
    dayAnchor.getUTCMonth(),
    dayAnchor.getUTCDate(),
    SHIFT_END_HOUR,
    SHIFT_END_MINUTE,
    0,
    0
  ));
  const clockOut = row.clockOutAt instanceof Date ? row.clockOutAt : new Date(row.clockOutAt);
  const deltaMin = (clockOut.getTime() - scheduled.getTime()) / 60000;
  if (deltaMin < -ON_TIME_TOLERANCE_MIN) return "EARLY";
  if (deltaMin <= ON_TIME_TOLERANCE_MIN) return "ON_TIME";
  return "LATE";
}

// ==============================================================
// Self-service: clock-in / clock-out
// ==============================================================

router.post("/clock-in", verifyToken, async (req, res) => {
  try {
    const now = new Date();
    const day = anchorDay(now);
    const userId = req.user.userId;
    const tenantId = req.user.tenantId;

    // Look for an existing row for today. If present, refuse a duplicate
    // clock-in (the user already started a shift). This is the most common
    // operator mistake and surfaces a stable code so the SPA can show a
    // useful toast instead of "Server error".
    const existing = await prisma.attendance.findUnique({
      where: { tenantId_userId_date: { tenantId, userId, date: day } },
    });
    if (existing && existing.clockInAt) {
      return res.status(409).json({
        error: "Already clocked in for today",
        code: "ALREADY_CLOCKED_IN",
        attendance: existing,
      });
    }

    // Geo-tagged attendance (wellness only) — see lib/attendanceGeofence.js.
    // Not enforced for non-wellness tenants or users with no assigned clinic.
    const coords = parseCoords(req.body);
    const { vertical, assignedLocations } = await resolveGeofenceContext(tenantId, userId);
    const geofence = evaluatePunchGeofence({ vertical, assignedLocations, coords });
    if (geofence.enforced && !geofence.ok) {
      return res.status(403).json({ error: geofence.error, code: geofence.code });
    }

    const data = {
      tenantId,
      userId,
      date: day,
      clockInAt: now,
      clockInLocationId: req.body.locationId ? parseInt(req.body.locationId) : null,
      clockInLat: coords.latitude ?? null,
      clockInLng: coords.longitude ?? null,
      clockInAccuracyM: coords.accuracy != null ? Math.round(coords.accuracy) : null,
      source: "MANUAL",
    };

    let row;
    if (existing) {
      // Edge case: clockOutAt was set but clockInAt is null (shouldn't happen
      // through this flow, but the schema permits it). Update in place.
      row = await prisma.attendance.update({
        where: { id: existing.id },
        data: {
          clockInAt: now,
          clockInLocationId: data.clockInLocationId,
          clockInLat: data.clockInLat,
          clockInLng: data.clockInLng,
          clockInAccuracyM: data.clockInAccuracyM,
          source: "MANUAL",
        },
      });
    } else {
      row = await prisma.attendance.create({ data });
    }

    await writeAudit("Attendance", "CLOCK_IN", row.id, userId, tenantId, {
      clockInAt: now.toISOString(),
      source: "MANUAL",
    });
    // PRD Gap §13 wave-6a — emit attendance.checked_in so workflow rules can
    // react (Slack ping for late arrivals, daily standup notification trigger).
    // Wrapped: workflow failures must NEVER fail the punch-in flow.
    try {
      require("../lib/eventBus").emitEvent(
        "attendance.checked_in",
        {
          attendanceId: row.id,
          userId,
          date: row.date,
          clockInAt: row.clockInAt,
          source: "MANUAL",
          locationId: row.clockInLocationId,
        },
        tenantId,
        req.io
      );
    } catch (_e) {}

    res.status(201).json(row);
  } catch (e) {
    console.error("[attendance] clock-in error:", e.message);
    res.status(500).json({ error: "Failed to clock in" });
  }
});

router.post("/clock-out", verifyToken, async (req, res) => {
  try {
    const now = new Date();
    const day = anchorDay(now);
    const userId = req.user.userId;
    const tenantId = req.user.tenantId;

    const existing = await prisma.attendance.findUnique({
      where: { tenantId_userId_date: { tenantId, userId, date: day } },
    });

    if (!existing || !existing.clockInAt) {
      return res.status(409).json({
        error: "No open clock-in for today. Punch In first.",
        code: "NO_OPEN_CLOCK_IN",
      });
    }
    if (existing.clockOutAt) {
      return res.status(409).json({
        error: "Already clocked out for today",
        code: "ALREADY_CLOCKED_OUT",
        attendance: existing,
      });
    }

    // Geo-tagged attendance (wellness only) — see lib/attendanceGeofence.js.
    const coords = parseCoords(req.body);
    const { vertical, assignedLocations } = await resolveGeofenceContext(tenantId, userId);
    const geofence = evaluatePunchGeofence({ vertical, assignedLocations, coords });
    if (geofence.enforced && !geofence.ok) {
      return res.status(403).json({ error: geofence.error, code: geofence.code });
    }

    const totalMinutes = Math.max(0, Math.round((now.getTime() - existing.clockInAt.getTime()) / 60000));

    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        clockOutAt: now,
        clockOutLocationId: req.body.locationId ? parseInt(req.body.locationId) : null,
        clockOutLat: coords.latitude ?? null,
        clockOutLng: coords.longitude ?? null,
        clockOutAccuracyM: coords.accuracy != null ? Math.round(coords.accuracy) : null,
        totalMinutes,
        // Status semantics:
        //   - HALF_DAY if shift was shorter than 4 hours (240 minutes)
        //   - PRESENT otherwise (LATE flagged separately via cron when grace
        //     window violated; we don't compute LATE inline because the policy
        //     start-time is operator config that doesn't yet exist).
        status: totalMinutes < 240 ? "HALF_DAY" : "PRESENT",
      },
    });

    await writeAudit("Attendance", "CLOCK_OUT", row.id, userId, tenantId, {
      clockOutAt: now.toISOString(),
      totalMinutes,
    });
    // PRD Gap §13 wave-6a — emit attendance.checked_out so workflow rules can
    // react (auto-create timesheet adjustment if HALF_DAY, notify manager on
    // overtime threshold). Wrapped: workflow failures don't block punch-out.
    try {
      require("../lib/eventBus").emitEvent(
        "attendance.checked_out",
        {
          attendanceId: row.id,
          userId,
          date: row.date,
          clockInAt: row.clockInAt,
          clockOutAt: row.clockOutAt,
          totalMinutes,
          status: row.status,
          source: "MANUAL",
          locationId: row.clockOutLocationId,
        },
        tenantId,
        req.io
      );
    } catch (_e) {}

    res.json(row);
  } catch (e) {
    console.error("[attendance] clock-out error:", e.message);
    res.status(500).json({ error: "Failed to clock out" });
  }
});

// ==============================================================
// History: own + staff
// ==============================================================

router.get("/me", verifyToken, async (req, res) => {
  try {
    // #665: reject inverted / invalid date ranges with a 400 instead of silently
    // returning an empty result.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const from = parseISO(req.query.from);
    const to = parseISO(req.query.to);
    const where = tenantWhere(req, { userId: req.user.userId });
    if (from && to) where.date = { gte: from, lte: to };
    else if (from) where.date = { gte: from };
    else if (to) where.date = { lte: to };

    const rows = await prisma.attendance.findMany({
      where,
      orderBy: { date: "desc" },
      take: 365,
    });
    res.json(rows);
  } catch (e) {
    console.error("[attendance] me history error:", e.message);
    res.status(500).json({ error: "Failed to load attendance history" });
  }
});

router.get("/staff/:userId", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "userId must be a number", code: "INVALID_USER_ID" });
    }

    // Ensure target user belongs to caller's tenant. Without this an admin in
    // tenant A could read attendance rows for a userId belonging to tenant B
    // (the userId existed; the rows would just be empty -- but the leak is
    // existence-of-user metadata).
    const targetUser = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
      select: { id: true, name: true, email: true },
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found in this tenant", code: "USER_NOT_FOUND" });
    }

    // #665: reject inverted / invalid date ranges.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const from = parseISO(req.query.from);
    const to = parseISO(req.query.to);
    const where = { tenantId: req.user.tenantId, userId };
    if (from && to) where.date = { gte: from, lte: to };
    else if (from) where.date = { gte: from };
    else if (to) where.date = { lte: to };

    const rows = await prisma.attendance.findMany({
      where,
      orderBy: { date: "desc" },
      take: 365,
    });
    res.json({ user: targetUser, attendance: rows });
  } catch (e) {
    console.error("[attendance] staff history error:", e.message);
    res.status(500).json({ error: "Failed to load staff attendance" });
  }
});

router.get("/summary", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    // #665: reject inverted / invalid date ranges (this endpoint already requires
    // both from + to, but the existing DATE_RANGE_REQUIRED check below catches
    // the absent case; INVERTED_DATE_RANGE is the new behaviour for reversed input).
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const from = parseISO(req.query.from);
    const to = parseISO(req.query.to);
    if (!from || !to) {
      return res.status(400).json({
        error: "from and to query params are required (ISO dates)",
        code: "DATE_RANGE_REQUIRED",
      });
    }
    const where = { tenantId: req.user.tenantId, date: { gte: from, lte: to } };
    if (req.query.userId) {
      const uid = parseInt(req.query.userId);
      if (Number.isFinite(uid)) where.userId = uid;
    }

    const rows = await prisma.attendance.findMany({ where });

    // #804 — fetch approved leave-requests overlapping the period so the
    // per-user breakdown can surface a leaves count. Filter to APPROVED only
    // (PENDING / REJECTED don't count against the staff member's payroll).
    // Overlap rule: leave.startDate <= period.to AND leave.endDate >= period.from
    // (any leave that intersects the period at all). We don't try to clip the
    // count to days-inside-the-period — `days` on LeaveRequest is authoritative
    // for the request as a whole, and the count we surface is "number of
    // approved leave-requests overlapping the period," matching how the
    // payroll-CSV row consumer wants to enumerate them. If the operator wants
    // day-clipped sums later, that's an additive field, not a breaking change.
    const leaveWhere = {
      tenantId: req.user.tenantId,
      status: "APPROVED",
      startDate: { lte: to },
      endDate: { gte: from },
    };
    if (req.query.userId) {
      const uid = parseInt(req.query.userId);
      if (Number.isFinite(uid)) leaveWhere.userId = uid;
    }
    let leaves = [];
    try {
      leaves = await prisma.leaveRequest.findMany({
        where: leaveWhere,
        select: { userId: true, days: true },
      });
    } catch (_e) {
      // LeaveRequest model exists in schema but if the table is missing in a
      // tenant-stripped environment, fall back to empty rather than 500.
      leaves = [];
    }

    // #802 — punctuality buckets derived from clockInAt vs a tenant-wide
    // scheduled-start (env-tunable). Independent of Attendance.status — a
    // PRESENT row can be EARLY, ON_TIME, or neither; an ABSENT row (no
    // clockInAt) is classified as null and contributes to neither counter.
    let earlyCount = 0;
    let onTimeCount = 0;
    // Departure-side mirror: Early / On-Time / Late Departure (from clockOutAt).
    let earlyDepartureCount = 0;
    let onTimeDepartureCount = 0;
    let lateDepartureCount = 0;
    const punctualityByUser = new Map(); // userId -> { early, onTime, earlyDeparture, onTimeDeparture, lateDeparture }
    for (const r of rows) {
      const bucket = classifyPunctuality(r);
      if (bucket === "EARLY") earlyCount += 1;
      else if (bucket === "ON_TIME") onTimeCount += 1;
      const dep = classifyDeparture(r);
      if (dep === "EARLY") earlyDepartureCount += 1;
      else if (dep === "ON_TIME") onTimeDepartureCount += 1;
      else if (dep === "LATE") lateDepartureCount += 1;
      if (bucket || dep) {
        const k = r.userId;
        const acc = punctualityByUser.get(k) || { early: 0, onTime: 0, earlyDeparture: 0, onTimeDeparture: 0, lateDeparture: 0 };
        if (bucket === "EARLY") acc.early += 1;
        else if (bucket === "ON_TIME") acc.onTime += 1;
        if (dep === "EARLY") acc.earlyDeparture += 1;
        else if (dep === "ON_TIME") acc.onTimeDeparture += 1;
        else if (dep === "LATE") acc.lateDeparture += 1;
        punctualityByUser.set(k, acc);
      }
    }

    const summary = {
      totalRows: rows.length,
      present: rows.filter((r) => r.status === "PRESENT").length,
      halfDay: rows.filter((r) => r.status === "HALF_DAY").length,
      late: rows.filter((r) => r.status === "LATE").length,
      absent: rows.filter((r) => r.status === "ABSENT").length,
      holiday: rows.filter((r) => r.status === "HOLIDAY").length,
      // #802 — Early / On-Time KPI tiles. Derived from clockInAt; see
      // classifyPunctuality + the SHIFT_START_HOUR/_MINUTE/_TOLERANCE
      // env-tunable constants at the top of this file.
      early: earlyCount,
      onTime: onTimeCount,
      // Departure-side KPIs (Early / On-Time / Late Departure). Mirror the
      // arrival counters but derived from clockOutAt vs SHIFT_END_HOUR/_MINUTE.
      earlyDeparture: earlyDepartureCount,
      onTimeDeparture: onTimeDepartureCount,
      lateDeparture: lateDepartureCount,
      totalMinutes: rows.reduce((acc, r) => acc + (r.totalMinutes || 0), 0),
      // #802 — surface the policy values used so a frontend tooltip can
      // explain why a particular row was bucketed the way it was. Cheap
      // additive metadata — clients that don't read these are unaffected.
      policy: {
        shiftStartHour: SHIFT_START_HOUR,
        shiftStartMinute: SHIFT_START_MINUTE,
        shiftEndHour: SHIFT_END_HOUR,
        shiftEndMinute: SHIFT_END_MINUTE,
        onTimeToleranceMin: ON_TIME_TOLERANCE_MIN,
      },
      byUser: {},
    };
    for (const r of rows) {
      const k = String(r.userId);
      if (!summary.byUser[k]) summary.byUser[k] = {
        userId: r.userId,
        days: 0,
        minutes: 0,
        present: 0,
        halfDay: 0,
        // #804 — additive per-user counters for the payroll CSV.
        late: 0,
        absent: 0,
        leaves: 0,
      };
      summary.byUser[k].days += 1;
      summary.byUser[k].minutes += r.totalMinutes || 0;
      if (r.status === "PRESENT") summary.byUser[k].present += 1;
      if (r.status === "HALF_DAY") summary.byUser[k].halfDay += 1;
      if (r.status === "LATE") summary.byUser[k].late += 1;
      if (r.status === "ABSENT") summary.byUser[k].absent += 1;
    }
    // #804 — overlay approved leaves onto the per-user buckets. A user with
    // an approved leave but no attendance row in the period still gets a row
    // in byUser (so payroll CSV emits them with leaves > 0). days/minutes
    // remain 0 for these synthetic rows — leaves are NOT counted as days
    // present.
    for (const lr of leaves) {
      const k = String(lr.userId);
      if (!summary.byUser[k]) summary.byUser[k] = {
        userId: lr.userId,
        days: 0,
        minutes: 0,
        present: 0,
        halfDay: 0,
        late: 0,
        absent: 0,
        leaves: 0,
      };
      summary.byUser[k].leaves += 1;
    }
    // #802 — overlay per-user punctuality counters (early / onTime) so the
    // payroll-CSV consumer (and any future per-user KPI grid) gets the same
    // breakdown the top-level counters surface.
    for (const [userId, p] of punctualityByUser.entries()) {
      const k = String(userId);
      if (!summary.byUser[k]) summary.byUser[k] = {
        userId,
        days: 0,
        minutes: 0,
        present: 0,
        halfDay: 0,
        late: 0,
        absent: 0,
        leaves: 0,
      };
      summary.byUser[k].early = p.early;
      summary.byUser[k].onTime = p.onTime;
      summary.byUser[k].earlyDeparture = p.earlyDeparture;
      summary.byUser[k].onTimeDeparture = p.onTimeDeparture;
      summary.byUser[k].lateDeparture = p.lateDeparture;
    }
    res.json(summary);
  } catch (e) {
    console.error("[attendance] summary error:", e.message);
    res.status(500).json({ error: "Failed to compute attendance summary" });
  }
});

// ==============================================================
// Admin / Manager: all-staff list + per-row edit/delete
// ==============================================================

// GET /api/attendance/list?from&to&userId — all-staff rows joined with the
// employee name + arrival/departure punctuality labels (derived server-side
// so the UI doesn't have to re-implement classifyPunctuality / classifyDeparture).
// Used by the Attendance Dashboard table.
router.get("/list", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const from = parseISO(req.query.from);
    const to = parseISO(req.query.to);
    const where = { tenantId: req.user.tenantId };
    if (from && to) where.date = { gte: from, lte: to };
    else if (from) where.date = { gte: from };
    else if (to) where.date = { lte: to };
    if (req.query.userId) {
      const uid = parseInt(req.query.userId);
      if (Number.isFinite(uid)) where.userId = uid;
    }

    const rows = await prisma.attendance.findMany({
      where,
      orderBy: [{ date: "desc" }, { clockInAt: "desc" }],
      take: 500,
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    // Decorate each row with the punctuality + departure label + recorded-via
    // channel so the table can render without re-deriving anything.
    const items = rows.map((r) => ({
      ...r,
      arrivalStatus: classifyPunctuality(r),     // "EARLY" | "ON_TIME" | "AFTER" | null
      departureStatus: classifyDeparture(r),     // "EARLY" | "ON_TIME" | "LATE" | null
      // `source` on the row reflects the LAST write. We surface a coarse
      // "recordedVia" for both legs based on which leg has a location ID
      // attached — biometric punches carry locationId from the device, manual
      // UI punches don't. Best-effort signal for the table column.
      checkInRecordedVia: r.clockInLocationId ? "biometric" : "manual",
      checkOutRecordedVia: r.clockOutLocationId ? "biometric" : "manual",
    }));

    res.json({ items, count: items.length });
  } catch (e) {
    console.error("[attendance] list error:", e.message);
    res.status(500).json({ error: "Failed to list attendance rows" });
  }
});

// ==============================================================
// GET /api/attendance/by-month — HRMS polish (merged from staging_crm).
//
// Tenant-wide monthly rollup of Attendance entries. Sibling to /summary
// (a single point-in-time aggregate over an ISO date window); /by-month
// is the per-month time series that powers the HR dashboard's
// attendance-trend chart without N round-trips per month.
//
// UTC YYYY-MM bucketing, JS-side aggregation over a light findMany
// projection, "unknown" bucket for null/invalid createdAt (excluded when
// ?from / ?to is set, kept otherwise so count surface stays accurate),
// pagination AFTER aggregation + sort + filter, NO audit row written.
//
// Declared BEFORE the /:id family below so :id="by-month" cannot reach
// them. Same convention as /summary.
// ==============================================================
router.get("/by-month", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    // YYYY-MM validation — mirrors /suppliers/by-month slice 24.
    const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }
    if (toRaw !== null && !MONTH_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "month:asc",
      "month:desc",
      "count:asc",
      "count:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    // Tenant-scoped where + optional per-user narrowing.
    const where = { tenantId: req.user.tenantId };
    if (req.query.userId) {
      const uid = parseInt(req.query.userId, 10);
      if (Number.isFinite(uid)) where.userId = uid;
    }

    // Light projection — status + totalMinutes + createdAt is enough for
    // the bucket totals. No relation pulls.
    const rows = await prisma.attendance.findMany({
      where,
      select: { status: true, totalMinutes: true, createdAt: true },
    });

    // Half-up round to 2dp — matches sibling /by-month aggregators.
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-month. Map "YYYY-MM" → bucket. Null/invalid
    // createdAt rows land in "unknown".
    const byMonth = new Map();
    for (const r of rows) {
      let monthKey = "unknown";
      if (r.createdAt) {
        const dt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
          monthKey = `${yyyy}-${mm}`;
        }
      }

      let bucket = byMonth.get(monthKey);
      if (!bucket) {
        bucket = {
          month: monthKey,
          count: 0,
          byStatus: {},
          totalMinutes: 0,
          lateCount: 0,
        };
        byMonth.set(monthKey, bucket);
      }
      bucket.count += 1;
      const status = r.status || "PRESENT";
      bucket.byStatus[status] = (bucket.byStatus[status] || 0) + 1;
      const mins = Number(r.totalMinutes);
      if (Number.isFinite(mins)) bucket.totalMinutes += mins;
      if (status === "LATE") bucket.lateCount += 1;
    }

    let months = [...byMonth.values()];

    // Apply ?from / ?to bucket filter. "unknown" excluded when either
    // bound is set (no comparable token); kept otherwise so the count
    // surface remains complete. Mirrors slice 24.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM (also
    // chronological). "unknown" sorts last in asc / first in desc
    // (lexicographically > "9999-12").
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    months.sort((a, b) => {
      if (field === "month") {
        if (a.month < b.month) return -1 * mult;
        if (a.month > b.month) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    // Convert totalMinutes -> totalHoursWorked (half-up 2dp) for the
    // wire shape. We aggregate in minutes (integer-safe) and convert
    // once at the boundary so floating-point drift can't accumulate
    // across buckets.
    const totalBuckets = months.length;
    const projected = months.slice(skip, skip + take).map((b) => ({
      month: b.month,
      count: b.count,
      byStatus: b.byStatus,
      totalHoursWorked: round2(b.totalMinutes / 60),
      lateCount: b.lateCount,
    }));

    res.json({
      total: totalBuckets,
      rows: projected,
    });
  } catch (e) {
    console.error("[attendance] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly attendance rollup" });
  }
});

// PUT /api/attendance/:id — ADMIN-only edit. Whitelisted fields: clockInAt,
// clockOutAt, status, notes. totalMinutes is recomputed if both timestamps
// are present.
router.put("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const existing = await prisma.attendance.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Attendance row not found" });

    const data = {};
    if (req.body.clockInAt !== undefined) {
      data.clockInAt = req.body.clockInAt ? new Date(req.body.clockInAt) : null;
    }
    if (req.body.clockOutAt !== undefined) {
      data.clockOutAt = req.body.clockOutAt ? new Date(req.body.clockOutAt) : null;
    }
    if (req.body.status !== undefined) {
      const allowed = ["PRESENT", "HALF_DAY", "LATE", "ABSENT", "HOLIDAY"];
      if (!allowed.includes(req.body.status)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      data.status = req.body.status;
    }
    if (req.body.notes !== undefined) {
      data.notes = req.body.notes ? String(req.body.notes).slice(0, 2000) : null;
    }

    // Recompute totalMinutes when both timestamps land.
    const finalIn = data.clockInAt !== undefined ? data.clockInAt : existing.clockInAt;
    const finalOut = data.clockOutAt !== undefined ? data.clockOutAt : existing.clockOutAt;
    if (finalIn && finalOut) {
      data.totalMinutes = Math.max(0, Math.round((finalOut.getTime() - finalIn.getTime()) / 60000));
    } else if (data.clockOutAt === null) {
      data.totalMinutes = null;
    }

    const row = await prisma.attendance.update({ where: { id }, data });
    await writeAudit("Attendance", "ADMIN_EDIT", row.id, req.user.userId, req.user.tenantId, {
      changedFields: Object.keys(data),
    });
    res.json(row);
  } catch (e) {
    console.error("[attendance] admin-edit error:", e.message);
    res.status(500).json({ error: "Failed to update attendance row" });
  }
});

// DELETE /api/attendance/:id — ADMIN-only hard delete. Audit-logged.
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const existing = await prisma.attendance.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Attendance row not found" });

    await prisma.attendance.delete({ where: { id } });
    await writeAudit("Attendance", "ADMIN_DELETE", id, req.user.userId, req.user.tenantId, {
      userId: existing.userId,
      date: existing.date,
    });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error("[attendance] admin-delete error:", e.message);
    res.status(500).json({ error: "Failed to delete attendance row" });
  }
});

// ==============================================================
// Biometric devices: admin CRUD + webhook
// ==============================================================

router.get("/devices", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const items = await prisma.biometricDevice.findMany({
      where: tenantWhere(req),
      orderBy: { createdAt: "desc" },
      // Don't leak apiKey to managers/non-admins. Admins get it back from
      // POST (create) once; subsequent GETs hide it. Rotation = destroy +
      // re-register.
      select: {
        id: true, tenantId: true, locationId: true, deviceId: true,
        vendor: true, lastSyncAt: true, isActive: true, createdAt: true,
        // apiKey deliberately omitted
      },
    });
    res.json(items);
  } catch (e) {
    console.error("[attendance] list devices error:", e.message);
    res.status(500).json({ error: "Failed to list biometric devices" });
  }
});

router.post("/devices", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { deviceId, vendor, locationId, isActive } = req.body;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
      return res.status(400).json({ error: "deviceId is required", code: "DEVICE_ID_REQUIRED" });
    }
    if (!vendor || typeof vendor !== "string" || !vendor.trim()) {
      return res.status(400).json({ error: "vendor is required", code: "VENDOR_REQUIRED" });
    }

    // Generate a 32-byte random API key, hex-encoded (64 chars). The plaintext
    // is returned exactly once -- in this POST response. On subsequent reads
    // the apiKey is omitted from the select.
    const apiKey = "bio_" + crypto.randomBytes(24).toString("hex");

    const device = await prisma.biometricDevice.create({
      data: {
        tenantId: req.user.tenantId,
        deviceId: deviceId.trim(),
        vendor: vendor.trim(),
        locationId: locationId ? parseInt(locationId) : null,
        isActive: isActive !== false,
        apiKey,
      },
    });

    await writeAudit("BiometricDevice", "CREATE", device.id, req.user.userId, req.user.tenantId, {
      deviceId: device.deviceId,
      vendor: device.vendor,
    });

    // Return the apiKey ONCE so the operator can paste it into the device.
    res.status(201).json(device);
  } catch (e) {
    if (e && e.code === "P2002") {
      return res.status(409).json({
        error: "deviceId already registered for this tenant",
        code: "DEVICE_ID_DUPLICATE",
      });
    }
    console.error("[attendance] create device error:", e.message);
    res.status(500).json({ error: "Failed to register biometric device" });
  }
});

router.put("/devices/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.biometricDevice.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Biometric device not found" });

    const data = {};
    if (req.body.vendor !== undefined) data.vendor = String(req.body.vendor).trim();
    if (req.body.locationId !== undefined) {
      data.locationId = req.body.locationId === null ? null : parseInt(req.body.locationId);
    }
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;

    const updated = await prisma.biometricDevice.update({
      where: { id },
      data,
      select: {
        id: true, tenantId: true, locationId: true, deviceId: true,
        vendor: true, lastSyncAt: true, isActive: true, createdAt: true,
      },
    });
    await writeAudit("BiometricDevice", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: Object.keys(data) });
    res.json(updated);
  } catch (e) {
    console.error("[attendance] update device error:", e.message);
    res.status(500).json({ error: "Failed to update biometric device" });
  }
});

router.delete("/devices/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.biometricDevice.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Biometric device not found" });

    await prisma.biometricDevice.delete({ where: { id } });
    await writeAudit("BiometricDevice", "DELETE", id, req.user.userId, req.user.tenantId, {
      deviceId: existing.deviceId, vendor: existing.vendor,
    });
    res.status(204).send();
  } catch (e) {
    console.error("[attendance] delete device error:", e.message);
    res.status(500).json({ error: "Failed to delete biometric device" });
  }
});

// ==============================================================
// Biometric webhook -- public path (added to server.js openPaths)
// ==============================================================
//
// Body: { deviceId, userExternalId, eventType: 'clock_in'|'clock_out', timestamp }
//
// Auth: X-API-Key header matches BiometricDevice.apiKey. The device's
// tenantId is derived from the matched row -- a webhook with a key from
// tenant A cannot influence tenant B's attendance even if the body claims
// a userId from B (we require the user to be in the device's tenant).
//
// Idempotency: if a clock_in event arrives with a timestamp matching an
// existing row's clockInAt (to the second), we return 200 with the existing
// row -- biometric vendors retry on network blips and we shouldn't double-
// stamp.
router.post("/biometric/webhook", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "X-API-Key header required", code: "API_KEY_REQUIRED" });
    }

    const device = await prisma.biometricDevice.findUnique({ where: { apiKey } });
    if (!device || !device.isActive) {
      return res.status(401).json({ error: "Invalid or inactive device key", code: "INVALID_DEVICE_KEY" });
    }

    const { deviceId, userExternalId, eventType, timestamp } = req.body || {};
    if (deviceId && device.deviceId !== deviceId) {
      // Mismatched body deviceId vs the key's device -- almost certainly a
      // misconfiguration. Reject so the operator notices.
      return res.status(400).json({ error: "Body deviceId does not match X-API-Key device", code: "DEVICE_MISMATCH" });
    }
    if (!userExternalId) {
      return res.status(400).json({ error: "userExternalId is required", code: "USER_EXTERNAL_ID_REQUIRED" });
    }
    if (!["clock_in", "clock_out"].includes(eventType)) {
      return res.status(400).json({ error: "eventType must be clock_in or clock_out", code: "INVALID_EVENT_TYPE" });
    }
    const ts = parseISO(timestamp) || new Date();

    // Map userExternalId -> User. Convention: the device sends the User.id
    // (Int) as a string. If the operator wants to map by email or a custom
    // employeeId column instead, that's a follow-up (queued for the next
    // hardening pass).
    const userId = parseInt(userExternalId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "userExternalId must be a numeric User id", code: "INVALID_USER_EXTERNAL_ID" });
    }
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId: device.tenantId },
      select: { id: true },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found in device's tenant", code: "USER_NOT_FOUND" });
    }

    const day = anchorDay(ts);
    const existing = await prisma.attendance.findUnique({
      where: { tenantId_userId_date: { tenantId: device.tenantId, userId, date: day } },
    });

    if (eventType === "clock_in") {
      if (existing && existing.clockInAt) {
        // Idempotent: same-second retry returns the existing row.
        if (Math.abs(existing.clockInAt.getTime() - ts.getTime()) < 1000) {
          return res.status(200).json({ attendance: existing, dedup: true });
        }
        return res.status(409).json({
          error: "User already clocked in today via another channel",
          code: "ALREADY_CLOCKED_IN",
        });
      }
      const row = existing
        ? await prisma.attendance.update({
            where: { id: existing.id },
            data: { clockInAt: ts, source: "BIOMETRIC", biometricDeviceId: device.id, clockInLocationId: device.locationId },
          })
        : await prisma.attendance.create({
            data: {
              tenantId: device.tenantId, userId, date: day,
              clockInAt: ts, source: "BIOMETRIC", biometricDeviceId: device.id, clockInLocationId: device.locationId,
            },
          });
      await prisma.biometricDevice.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
      await writeAudit("Attendance", "CLOCK_IN", row.id, null, device.tenantId, {
        source: "BIOMETRIC", deviceId: device.deviceId, ts: ts.toISOString(),
      });
      // PRD Gap §13 wave-6a — emit attendance.checked_in for biometric path
      // too so the same workflow rules fire regardless of channel.
      try {
        require("../lib/eventBus").emitEvent(
          "attendance.checked_in",
          {
            attendanceId: row.id,
            userId,
            date: row.date,
            clockInAt: row.clockInAt,
            source: "BIOMETRIC",
            biometricDeviceId: device.id,
            locationId: row.clockInLocationId,
          },
          device.tenantId,
          req.io
        );
      } catch (_e) {}
      return res.status(201).json({ attendance: row, dedup: false });
    }

    // clock_out
    if (!existing || !existing.clockInAt) {
      return res.status(409).json({
        error: "No open clock-in to close",
        code: "NO_OPEN_CLOCK_IN",
      });
    }
    if (existing.clockOutAt && Math.abs(existing.clockOutAt.getTime() - ts.getTime()) < 1000) {
      return res.status(200).json({ attendance: existing, dedup: true });
    }
    if (existing.clockOutAt) {
      return res.status(409).json({ error: "Already clocked out today", code: "ALREADY_CLOCKED_OUT" });
    }
    const totalMinutes = Math.max(0, Math.round((ts.getTime() - existing.clockInAt.getTime()) / 60000));
    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        clockOutAt: ts,
        clockOutLocationId: device.locationId,
        totalMinutes,
        source: "BIOMETRIC",
        biometricDeviceId: device.id,
        status: totalMinutes < 240 ? "HALF_DAY" : "PRESENT",
      },
    });
    await prisma.biometricDevice.update({ where: { id: device.id }, data: { lastSyncAt: new Date() } });
    await writeAudit("Attendance", "CLOCK_OUT", row.id, null, device.tenantId, {
      source: "BIOMETRIC", deviceId: device.deviceId, ts: ts.toISOString(), totalMinutes,
    });
    // PRD Gap §13 wave-6a — emit attendance.checked_out for biometric path.
    try {
      require("../lib/eventBus").emitEvent(
        "attendance.checked_out",
        {
          attendanceId: row.id,
          userId,
          date: row.date,
          clockInAt: row.clockInAt,
          clockOutAt: row.clockOutAt,
          totalMinutes,
          status: row.status,
          source: "BIOMETRIC",
          biometricDeviceId: device.id,
          locationId: row.clockOutLocationId,
        },
        device.tenantId,
        req.io
      );
    } catch (_e) {}
    return res.json({ attendance: row, dedup: false });
  } catch (e) {
    console.error("[attendance] webhook error:", e.message);
    res.status(500).json({ error: "Failed to process biometric event" });
  }
});

module.exports = router;
