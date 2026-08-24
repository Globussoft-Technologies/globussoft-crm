/**
 * Wellness ↔ standalone geofence zones (geo-tagged attendance).
 *
 * Mounted at /api/wellness (paths below are all namespaced under
 * /geofence-zones and /geofence-zone-assignments, which routes/wellness.js
 * does not own).
 *
 * WHAT THIS IS
 *   A geofenced check-in radius that is NOT a clinic. The existing
 *   Location model already carries geofenceRadiusM, but Location is a full
 *   business entity — address, patients, visits, resources all hang off it
 *   — so drawing a fence around "the warehouse" or a temporary pop-up camp
 *   meant inventing a fake clinic row just to get a lat/lng+radius. This
 *   file is the standalone alternative: a GeofenceZone is nothing but a
 *   pin and a radius, assignable to any staff member independent of which
 *   clinic (if any) they work at.
 *
 * OVERRIDE SEMANTICS (product decision — see GeofenceZone's schema comment)
 *   - A staff member with a SPECIFIC assignment — a clinic (UserLocation)
 *     or a zone (UserGeofenceZone), or both — is enforced against the union
 *     of those, exactly like today's multi-clinic "any one of them" rule.
 *   - A staff member with NO specific assignment falls back to the
 *     tenant's GLOBAL zone (GeofenceZone.isGlobal), if one is set.
 *   - At most one zone per tenant may be global at a time. Marking a new
 *     zone global here atomically un-marks whatever was global before —
 *     "the latest one set as global overrides it" falls out of that
 *     invariant for free, because there is only ever one to find.
 *   The actual fallback resolution lives in routes/attendance.js's
 *   resolveGeofenceContext; this file only owns CRUD + assignment.
 *
 * Endpoints (all admin/manager, settings.manage — same gate the clinic
 * Location + location-assignments endpoints use):
 *   GET    /geofence-zones                         list + assignedCount
 *   POST   /geofence-zones                          create
 *   PUT    /geofence-zones/:id                      update
 *   DELETE /geofence-zones/:id                       delete (cascades assignments)
 *   GET    /geofence-zone-assignments/counts                     badge every zone card
 *   GET    /geofence-zone-assignments/by-zone/:zoneId             roster for one zone
 *   POST   /geofence-zone-assignments/bulk                        add/replace/remove
 *
 * Route ordering: "counts" and "by-zone" are literal paths declared before
 * this file would ever need a parametric "/geofence-zone-assignments/:x" —
 * there is no such route here, but the convention (see
 * routes/wellness.js's own location-assignments family) is to keep literal
 * segments first regardless, so a future addition can't silently shadow
 * these two.
 */

const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const { writeAudit } = require("../lib/audit");

const zoneGate = verifyWellnessRole(["admin", "manager"], {
  anyOfPermissions: [{ module: "settings", action: "manage" }],
});

// Mirrors backend/lib/attendanceGeofence.js DEFAULT_RADIUS_M. A zone has no
// purpose other than being a geofence, so — unlike Location.geofenceRadiusM
// — this is never left null; every zone gets a real radius at creation.
const DEFAULT_RADIUS_M = 150;
const MIN_RADIUS_M = 10;
const MAX_RADIUS_M = 5000;

function parseIdParam(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function validateZoneBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) errors.push("name is required");
    else out.name = name;
  }

  if (!partial || body.latitude !== undefined) {
    const lat = Number(body.latitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      errors.push("latitude must be a number between -90 and 90");
    } else out.latitude = lat;
  }

  if (!partial || body.longitude !== undefined) {
    const lng = Number(body.longitude);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      errors.push("longitude must be a number between -180 and 180");
    } else out.longitude = lng;
  }

  if (body.radiusM !== undefined && body.radiusM !== null && body.radiusM !== "") {
    const r = Math.round(Number(body.radiusM));
    if (!Number.isFinite(r) || r < MIN_RADIUS_M || r > MAX_RADIUS_M) {
      errors.push(`radiusM must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M}`);
    } else out.radiusM = r;
  } else if (!partial) {
    out.radiusM = DEFAULT_RADIUS_M;
  }

  if (body.isGlobal !== undefined) out.isGlobal = !!body.isGlobal;
  if (body.isActive !== undefined) out.isActive = !!body.isActive;

  return { data: out, errors };
}

// ───────────────────────────────────────────────────────────────────
// Zone CRUD
// ───────────────────────────────────────────────────────────────────

router.get("/geofence-zones", zoneGate, async (req, res) => {
  try {
    const [zones, counts] = await Promise.all([
      prisma.geofenceZone.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: [{ isGlobal: "desc" }, { name: "asc" }],
      }),
      prisma.userGeofenceZone.groupBy({
        by: ["zoneId"],
        where: { zone: { tenantId: req.user.tenantId } },
        _count: { _all: true },
      }),
    ]);
    const countByZone = new Map(counts.map((c) => [c.zoneId, c._count._all]));
    res.json(zones.map((z) => ({ ...z, assignedCount: countByZone.get(z.id) || 0 })));
  } catch (e) {
    console.error("[wellness] geofence zones list error:", e.message);
    res.status(500).json({ error: "Failed to load geofence zones" });
  }
});

router.post("/geofence-zones", zoneGate, async (req, res) => {
  try {
    const { data, errors } = validateZoneBody(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], code: "VALIDATION_ERROR", errors });
    }

    // Flipping this zone global must atomically un-global whatever held
    // that spot before — the DB has no partial-unique constraint for it
    // (see the model's schema comment), so the transaction IS the
    // uniqueness guarantee. Without it, a race between two admins could
    // leave two zones simultaneously global, and resolveGeofenceContext's
    // findFirst would pick one arbitrarily.
    const zone = data.isGlobal
      ? await prisma.$transaction(async (tx) => {
          await tx.geofenceZone.updateMany({
            where: { tenantId: req.user.tenantId, isGlobal: true },
            data: { isGlobal: false },
          });
          return tx.geofenceZone.create({ data: { ...data, tenantId: req.user.tenantId } });
        })
      : await prisma.geofenceZone.create({ data: { ...data, tenantId: req.user.tenantId } });

    try {
      await writeAudit("GeofenceZone", "CREATE", zone.id, req.user.userId, req.user.tenantId, { name: zone.name, isGlobal: zone.isGlobal });
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }

    res.status(201).json({ ...zone, assignedCount: 0 });
  } catch (e) {
    console.error("[wellness] create geofence zone error:", e.message);
    res.status(500).json({ error: "Failed to create geofence zone" });
  }
});

router.put("/geofence-zones/:id", zoneGate, async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid zone id" });

    const existing = await prisma.geofenceZone.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Geofence zone not found", code: "ZONE_NOT_FOUND" });

    const { data, errors } = validateZoneBody(req.body || {}, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], code: "VALIDATION_ERROR", errors });
    }

    const zone = data.isGlobal === true
      ? await prisma.$transaction(async (tx) => {
          await tx.geofenceZone.updateMany({
            where: { tenantId: req.user.tenantId, isGlobal: true, id: { not: id } },
            data: { isGlobal: false },
          });
          return tx.geofenceZone.update({ where: { id }, data });
        })
      : await prisma.geofenceZone.update({ where: { id }, data });

    try {
      await writeAudit("GeofenceZone", "UPDATE", id, req.user.userId, req.user.tenantId, data);
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }

    const assignedCount = await prisma.userGeofenceZone.count({ where: { zoneId: id } });
    res.json({ ...zone, assignedCount });
  } catch (e) {
    console.error("[wellness] update geofence zone error:", e.message);
    res.status(500).json({ error: "Failed to update geofence zone" });
  }
});

router.delete("/geofence-zones/:id", zoneGate, async (req, res) => {
  try {
    const id = parseIdParam(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid zone id" });

    const existing = await prisma.geofenceZone.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true, name: true },
    });
    if (!existing) return res.status(404).json({ error: "Geofence zone not found", code: "ZONE_NOT_FOUND" });

    // No PatientVisit-style dependents to worry about — a zone carries
    // nothing but assignments, and UserGeofenceZone cascades on delete, so
    // (unlike deleting a clinic Location) there is no 409-in-use case here.
    // Deleting a zone that is currently everyone's Global fallback simply
    // returns those users to "not enforced" on their next punch, which is
    // the same fail-open behaviour an unconfigured tenant already has.
    await prisma.geofenceZone.delete({ where: { id } });

    try {
      await writeAudit("GeofenceZone", "DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[wellness] delete geofence zone error:", e.message);
    res.status(500).json({ error: "Failed to delete geofence zone" });
  }
});

// ───────────────────────────────────────────────────────────────────
// Bulk staff assignment — same shape as routes/wellness.js's
// /location-assignments/{counts,by-location,bulk} family, retargeted at
// zones. See LocationStaffAssignModal.jsx's frontend twin for why the
// roster is served here rather than reusing GET /api/staff (PII masking
// on that route can replace numeric ids with hashed tokens a picker can't
// post back).
// ───────────────────────────────────────────────────────────────────

router.get("/geofence-zone-assignments/counts", zoneGate, async (req, res) => {
  try {
    const grouped = await prisma.userGeofenceZone.groupBy({
      by: ["zoneId"],
      where: { zone: { tenantId: req.user.tenantId } },
      _count: { _all: true },
    });
    const counts = {};
    for (const row of grouped) counts[row.zoneId] = row._count._all;
    res.json({ counts });
  } catch (e) {
    console.error("[wellness] geofence zone assignment counts error:", e.message);
    res.status(500).json({ error: "Failed to load staff assignment counts" });
  }
});

router.get("/geofence-zone-assignments/by-zone/:zoneId", zoneGate, async (req, res) => {
  try {
    const zoneId = parseIdParam(req.params.zoneId);
    if (zoneId === null) return res.status(400).json({ error: "Invalid zone id", code: "INVALID_ZONE_ID" });

    const zone = await prisma.geofenceZone.findFirst({
      where: { id: zoneId, tenantId: req.user.tenantId },
    });
    if (!zone) return res.status(404).json({ error: "Geofence zone not found", code: "ZONE_NOT_FOUND" });

    const [staff, assignments] = await Promise.all([
      prisma.user.findMany({
        where: {
          tenantId: req.user.tenantId,
          userType: { in: ["STAFF", "OWNER"] },
          role: { not: "CUSTOMER" },
        },
        select: {
          id: true, name: true, email: true, role: true,
          wellnessRole: true, deactivatedAt: true,
        },
        orderBy: { name: "asc" },
      }),
      prisma.userGeofenceZone.findMany({
        where: { zone: { tenantId: req.user.tenantId } },
        select: { userId: true, zoneId: true },
      }),
    ]);

    const byUser = new Map();
    for (const a of assignments) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, []);
      byUser.get(a.userId).push(a.zoneId);
    }

    res.json({
      location: { id: zone.id, name: zone.name, geofenceRadiusM: zone.radiusM },
      geofenceActive: true, // a zone always has coordinates — see validateZoneBody
      isGlobal: zone.isGlobal,
      staff: staff.map((u) => {
        const mine = byUser.get(u.id) || [];
        return {
          ...u,
          assignedHere: mine.includes(zoneId),
          otherLocationCount: mine.filter((id) => id !== zoneId).length,
        };
      }),
    });
  } catch (e) {
    console.error("[wellness] geofence zone roster error:", e.message);
    res.status(500).json({ error: "Failed to load staff for this zone" });
  }
});

router.post("/geofence-zone-assignments/bulk", zoneGate, async (req, res) => {
  try {
    const { zoneId, userIds, mode = "add" } = req.body || {};

    if (!["add", "remove", "replace"].includes(mode)) {
      return res.status(400).json({
        error: 'mode must be one of "add", "remove", "replace"',
        code: "INVALID_MODE",
      });
    }
    const id = parseIdParam(zoneId);
    if (id === null) {
      return res.status(400).json({ error: "zoneId is required", code: "MISSING_FIELDS" });
    }
    if (!Array.isArray(userIds)) {
      return res.status(400).json({ error: "userIds must be an array", code: "MISSING_FIELDS" });
    }
    const ids = [...new Set(userIds.map((n) => parseInt(n, 10)))].filter(Number.isFinite);
    if (ids.length === 0) {
      return res.status(400).json({ error: "Select at least one staff member", code: "NO_STAFF_SELECTED" });
    }

    const zone = await prisma.geofenceZone.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true, name: true },
    });
    if (!zone) {
      return res.status(404).json({ error: "Geofence zone not found", code: "ZONE_NOT_FOUND" });
    }

    const owned = await prisma.user.findMany({
      where: {
        id: { in: ids },
        tenantId: req.user.tenantId,
        userType: { in: ["STAFF", "OWNER"] },
        role: { not: "CUSTOMER" },
      },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      return res.status(400).json({
        error: "One or more staff members not found in this tenant",
        code: "INVALID_USER_ID",
      });
    }

    // Tenant-safe by construction, not by a literal clause here: `id` (the
    // zone) was already confirmed to belong to req.user.tenantId by the
    // geofenceZone.findFirst 404-guard above, and every entry in `ids` was
    // just confirmed to belong to this tenant by the owned.length check
    // immediately above. A row matching BOTH userId IN ids AND zoneId = id
    // can therefore only ever belong to this tenant.
    /* eslint-disable gbscrm/tenant-scope-finder-heuristic */
    const existing = await prisma.userGeofenceZone.findMany({
      where: { userId: { in: ids }, zoneId: id },
      select: { userId: true },
    });
    /* eslint-enable gbscrm/tenant-scope-finder-heuristic */
    const alreadyHere = new Set(existing.map((r) => r.userId));

    let added = 0;
    let removed = 0;
    let clearedElsewhere = 0;

    if (mode === "remove") {
      const r = await prisma.userGeofenceZone.deleteMany({
        where: { userId: { in: ids }, zoneId: id },
      });
      removed = r.count;
    } else {
      const toAdd = ids.filter((uid) => !alreadyHere.has(uid));
      const ops = [];
      if (mode === "replace") {
        // "This is their ONLY zone" — only scoped to OTHER ZONES, not to
        // their clinic (UserLocation) assignments. Zones and clinics are
        // independent assignment types; this modal only owns zones, the
        // same way LocationStaffAssignModal's "replace" only owns clinics.
        clearedElsewhere = await prisma.userGeofenceZone.count({
          where: { userId: { in: ids }, zoneId: { not: id } },
        });
        ops.push(
          prisma.userGeofenceZone.deleteMany({
            where: { userId: { in: ids }, zoneId: { not: id } },
          }),
        );
      }
      for (const userId of toAdd) {
        ops.push(prisma.userGeofenceZone.create({ data: { userId, zoneId: id } }));
      }
      if (ops.length > 0) await prisma.$transaction(ops);
      added = toAdd.length;
    }

    try {
      await writeAudit(
        "UserGeofenceZone",
        "BULK_ASSIGN",
        id,
        req.user.userId,
        req.user.tenantId,
        { zoneName: zone.name, mode, userIds: ids, added, removed, clearedElsewhere },
      );
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }

    res.json({
      ok: true,
      mode,
      locationId: id,
      locationName: zone.name,
      requested: ids.length,
      added,
      removed,
      clearedElsewhere,
      unchanged: mode === "add" ? ids.length - added : 0,
      geofenceActive: true,
    });
  } catch (e) {
    console.error("[wellness] bulk geofence zone assign error:", e.message);
    res.status(500).json({ error: "Failed to assign staff to this zone" });
  }
});

module.exports = router;
