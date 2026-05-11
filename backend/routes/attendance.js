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

const router = express.Router();

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

    const data = {
      tenantId,
      userId,
      date: day,
      clockInAt: now,
      clockInLocationId: req.body.locationId ? parseInt(req.body.locationId) : null,
      source: "MANUAL",
    };

    let row;
    if (existing) {
      // Edge case: clockOutAt was set but clockInAt is null (shouldn't happen
      // through this flow, but the schema permits it). Update in place.
      row = await prisma.attendance.update({
        where: { id: existing.id },
        data: { clockInAt: now, clockInLocationId: data.clockInLocationId, source: "MANUAL" },
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

    const totalMinutes = Math.max(0, Math.round((now.getTime() - existing.clockInAt.getTime()) / 60000));

    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        clockOutAt: now,
        clockOutLocationId: req.body.locationId ? parseInt(req.body.locationId) : null,
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

    const summary = {
      totalRows: rows.length,
      present: rows.filter((r) => r.status === "PRESENT").length,
      halfDay: rows.filter((r) => r.status === "HALF_DAY").length,
      late: rows.filter((r) => r.status === "LATE").length,
      absent: rows.filter((r) => r.status === "ABSENT").length,
      holiday: rows.filter((r) => r.status === "HOLIDAY").length,
      totalMinutes: rows.reduce((acc, r) => acc + (r.totalMinutes || 0), 0),
      byUser: {},
    };
    for (const r of rows) {
      const k = String(r.userId);
      if (!summary.byUser[k]) summary.byUser[k] = { userId: r.userId, days: 0, minutes: 0, present: 0, halfDay: 0 };
      summary.byUser[k].days += 1;
      summary.byUser[k].minutes += r.totalMinutes || 0;
      if (r.status === "PRESENT") summary.byUser[k].present += 1;
      if (r.status === "HALF_DAY") summary.byUser[k].halfDay += 1;
    }
    res.json(summary);
  } catch (e) {
    console.error("[attendance] summary error:", e.message);
    res.status(500).json({ error: "Failed to compute attendance summary" });
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
