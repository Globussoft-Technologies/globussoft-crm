/**
 * /api/travel/pois — POI catalog read path + inline rep-suggested POI
 * flow + ADMIN approval queue.
 *
 * Wave 18 slices S12 (suggest + approve/reject) and S93 (catalog list).
 * Depends on slice S11 (`TravelPoi` Prisma model shipped commit
 * `5a03e3be`). Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6 (catalog
 * read path consumed by the itinerary editor + Inline Add-POI modal)
 * and FR-3.7 (suggest + approve).
 *
 * Endpoints (mount point `/api/travel/pois`, wired in server.js
 * line 946 — `app.use("/api/travel/pois", require("./routes/travel_pois"))`):
 *
 *   GET    /                Catalog list for the itinerary editor's
 *                           PoiPicker. USER+ allowed (every Travel rep
 *                           builds itineraries). Query params:
 *                             destinationSlug (REQUIRED)
 *                             category (optional exact match)
 *                             q (optional fuzzy LIKE on `name` /
 *                               `nameLocal`, case-insensitive)
 *                             limit (default 50, cap 200)
 *                             offset (default 0)
 *                           Tenant scope: returns rows where
 *                           `tenantId = req.user.tenantId` OR
 *                           `tenantId IS NULL` (catalog-wide rows seeded
 *                           by S11's OpenTripMap importer). Hides
 *                           `pendingApproval = true` rows — those live
 *                           in the operator's approval queue, not the
 *                           picker. Sort by `name ASC` (deterministic +
 *                           good UX for a typeahead). 200 + `{ pois,
 *                           total, limit, offset }`.
 *
 *   POST   /                Rep (USER+) suggests a new POI. Body:
 *                           { name, nameLocal?, category, latitude,
 *                             longitude, country?, destinationSlug,
 *                             imageUrl?, descriptionShort? }
 *                           Creates row with `pendingApproval = true`,
 *                           `externalSource = 'operator'`,
 *                           `externalId = crypto.randomUUID()`,
 *                           `tenantId = req.user.tenantId`. Audit-logs
 *                           `poi.suggested`. 201 + the created row.
 *
 *   GET    /pending         ADMIN+MANAGER list of pendingApproval rows for
 *                           the caller's tenant, sorted createdAt desc.
 *                           Paging: ?limit= (default 50, cap 200) +
 *                           ?offset= (default 0). 200 + { pending, total }.
 *
 *   POST   /:id/approve     ADMIN only. Flips `pendingApproval` to false.
 *                           Cross-tenant access returns 404 (deliberate —
 *                           leaking 403 would expose existence). Audit-logs
 *                           `poi.approved`. 200 + the updated row.
 *
 *   POST   /:id/reject      ADMIN only. Hard-deletes the row (soft-delete
 *                           via a `rejectedAt` column would need a schema
 *                           change which is out of scope for this slice).
 *                           Audit-logs `poi.rejected`. 200 + { ok: true,
 *                           id }.
 *
 * Auth chain:
 *   GET  /                  verifyToken (USER+ — picker is for every rep)
 *   POST /                  verifyToken (USER+)
 *   GET  /pending           verifyToken → verifyRole(['ADMIN','MANAGER'])
 *   POST /:id/approve       verifyToken → verifyRole(['ADMIN'])
 *   POST /:id/reject        verifyToken → verifyRole(['ADMIN'])
 *
 * Tenant scoping:
 *   - tenantId always comes from `req.user.tenantId`. Never read from body
 *     (the global `stripDangerous` middleware deletes body.tenantId anyway;
 *     this handler also never references body.tenantId per the project's
 *     ESLint rule that blocks `req.body.{id,userId,tenantId,createdAt,
 *     updatedAt}` reads).
 *   - All reads + writes filter on `tenantId: req.user.tenantId`. The POI
 *     model permits `tenantId = NULL` for catalog-wide rows (the S11
 *     OpenTripMap seed uses that); operator-suggested rows always carry a
 *     concrete tenantId so the approval queue is per-tenant.
 *
 * Failure-path codes:
 *   400 MISSING_FIELDS    — name or category absent on POST; or
 *                           destinationSlug absent on GET /
 *   400 INVALID_COORD     — latitude / longitude not a finite number in
 *                           lat ∈ [-90, 90], lng ∈ [-180, 180]
 *   400 INVALID_ID        — :id is not a positive integer
 *   401                   — verifyToken (missing Authorization)
 *   403 RBAC_DENIED       — verifyRole gate (USER → /pending, USER+MANAGER
 *                           → /approve+/reject)
 *   404 POI_NOT_FOUND     — POI not in caller's tenant (cross-tenant
 *                           collapses to 404 to avoid existence leak)
 *   409 POI_DUPLICATE_NEARBY — POST / found an APPROVED POI within
 *                           50 metres of the requested (lat, lng) in the
 *                           caller's tenant scope. Body includes
 *                           { existingId, distance } so the UI can deep-link
 *                           to the existing row. Caller can pass
 *                           `?force=true` to bypass (Mughal-complex case
 *                           — multiple monuments genuinely <50m apart).
 *                           Slice G055, PRD FR-3.2.f.
 *
 * Test surface:
 *   - backend/test/routes/travel-pois-api.test.js — vitest contract pin
 *     (≥18 cases). Patches the prisma singleton with vi.fn() shapes BEFORE
 *     requiring the router so the router's CJS require binds to the spies.
 *     Mirrors travel-engine-weights.test.js pattern.
 *   - e2e/tests/travel-pois-api.spec.js — Playwright API spec (≥10 cases)
 *     with probe-skip pattern so the spec auto-skips when the route is
 *     not yet mounted in server.js.
 *
 * Audit boundary:
 *   The `writeAudit` payload deliberately carries field NAMES + tenant
 *   scope only — never lat/lng raw values inside the audit row. The POI
 *   record itself is the canonical store for those.
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { findNearbyPoi } = require("../lib/poiDedup");

const EXTERNAL_SOURCE_OPERATOR = "operator";
const POI_DEDUP_RADIUS_METERS = 50;

// ───────────────────────────────────────────────────────────────────
// Validation helpers
// ───────────────────────────────────────────────────────────────────

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  throw err;
}

function parseIdParam(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== String(raw)) {
    badRequest("id must be a positive integer", "INVALID_ID");
  }
  return n;
}

function validateLatLng(rawLat, rawLng) {
  const lat = typeof rawLat === "number" ? rawLat : Number(rawLat);
  const lng = typeof rawLng === "number" ? rawLng : Number(rawLng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    badRequest("latitude must be a number in [-90, 90]", "INVALID_COORD");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    badRequest("longitude must be a number in [-180, 180]", "INVALID_COORD");
  }
  return { lat, lng };
}

function pickString(raw, max = 255) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}

// ───────────────────────────────────────────────────────────────────
// GET / — catalog list for the itinerary editor's PoiPicker (S93)
// ───────────────────────────────────────────────────────────────────
// USER+ allowed. Required query: destinationSlug. Optional: category,
// q (fuzzy match on name + nameLocal), limit (default 50, max 200),
// offset (default 0). Tenant scope: returns rows where
// tenantId = req.user.tenantId OR tenantId IS NULL (S11 OpenTripMap
// seed uses null for catalog-wide rows). Hides pendingApproval rows
// — those live in the approval queue, not the picker.
router.get("/", verifyToken, async (req, res) => {
  try {
    const destinationSlug = pickString(req.query.destinationSlug, 80);
    if (!destinationSlug) {
      return res
        .status(400)
        .json({ error: "destinationSlug required", code: "MISSING_FIELDS" });
    }

    const category = pickString(req.query.category, 80);
    const q = pickString(req.query.q, 200);

    const rawLimit = parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    // Catalog rows: own tenant's approved rows + catalog-wide null-tenant
    // rows. Hide pendingApproval=true.
    const where = {
      destinationSlug,
      pendingApproval: false,
      OR: [{ tenantId: req.user.tenantId }, { tenantId: null }],
    };
    if (category) where.category = category;
    if (q) {
      // MySQL collation is case-insensitive by default (utf8mb4_unicode_ci).
      // Prisma's `contains` translates to LIKE '%q%'.
      where.AND = [
        {
          OR: [
            { name: { contains: q } },
            { nameLocal: { contains: q } },
          ],
        },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.travelPoi.findMany({
        where,
        orderBy: { name: "asc" },
        take: limit,
        skip: offset,
      }),
      prisma.travelPoi.count({ where }),
    ]);

    res.json({ pois: rows, total, limit, offset });
  } catch (e) {
    console.error("[travel-pois] list error:", e.message);
    res.status(500).json({ error: "Failed to load POI catalog" });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST / — rep suggests a POI (USER+ allowed; queue lives at /pending)
// ───────────────────────────────────────────────────────────────────
router.post("/", verifyToken, async (req, res) => {
  try {
    const body = req.body || {};

    const name = pickString(body.name, 200);
    if (!name) badRequest("name required", "MISSING_FIELDS");

    const category = pickString(body.category, 80);
    if (!category) badRequest("category required", "MISSING_FIELDS");

    const { lat, lng } = validateLatLng(body.latitude, body.longitude);

    const destinationSlug = pickString(body.destinationSlug, 80);
    if (!destinationSlug) badRequest("destinationSlug required", "MISSING_FIELDS");

    // ── G055 / PRD FR-3.2.f — ±50m POI dedup gate ────────────────────
    // Block on an APPROVED nearby match unless the caller explicitly
    // opts out via ?force=true. Approved-only on purpose; see
    // lib/poiDedup.js header for the rationale.
    const force =
      req.query.force === "true" || req.query.force === "1" || req.query.force === true;
    if (!force) {
      const nearby = await findNearbyPoi(prisma, {
        tenantId: req.user.tenantId,
        lat,
        lng,
        radiusMeters: POI_DEDUP_RADIUS_METERS,
      });
      if (nearby) {
        return res.status(409).json({
          error: "An approved POI already exists within 50 metres",
          code: "POI_DUPLICATE_NEARBY",
          existingId: nearby.id,
          distance: Math.round(nearby.distance * 10) / 10,
        });
      }
    }

    const data = {
      tenantId: req.user.tenantId,
      externalSource: EXTERNAL_SOURCE_OPERATOR,
      externalId: crypto.randomUUID(),
      name,
      nameLocal: pickString(body.nameLocal, 200),
      category,
      latitude: lat,
      longitude: lng,
      country: pickString(body.country, 8),
      destinationSlug,
      imageUrl: pickString(body.imageUrl, 500),
      descriptionShort: pickString(body.descriptionShort, 2000),
      pendingApproval: true,
    };

    const created = await prisma.travelPoi.create({ data });

    // Audit: capture field NAMES + tenant scope, not raw coords.
    writeAudit(
      "TravelPoi",
      "poi.suggested",
      created.id,
      req.user.userId,
      req.user.tenantId,
      {
        name: created.name,
        category: created.category,
        destinationSlug: created.destinationSlug,
        externalSource: EXTERNAL_SOURCE_OPERATOR,
      },
    ).catch(() => {});

    return res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-pois] suggest error:", e.message);
    return res.status(500).json({ error: "Failed to suggest POI" });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /pending — ADMIN+MANAGER review queue, tenant-scoped
// ───────────────────────────────────────────────────────────────────
router.get(
  "/pending",
  verifyToken,
  requirePermission("pois", "read"),
  async (req, res) => {
    try {
      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const rawOffset = parseInt(req.query.offset, 10);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const where = {
        pendingApproval: true,
        tenantId: req.user.tenantId,
      };

      const [rows, total] = await Promise.all([
        prisma.travelPoi.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.travelPoi.count({ where }),
      ]);

      res.json({ pending: rows, total, limit, offset });
    } catch (e) {
      console.error("[travel-pois] queue error:", e.message);
      res.status(500).json({ error: "Failed to load pending POI queue" });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// POST /:id/approve — ADMIN only; flips pendingApproval to false
// ───────────────────────────────────────────────────────────────────
router.post(
  "/:id/approve",
  verifyToken,
  requirePermission("pois", "manage"),
  async (req, res) => {
    try {
      const id = parseIdParam(req.params.id);

      const existing = await prisma.travelPoi.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "POI not found", code: "POI_NOT_FOUND" });
      }

      const updated = await prisma.travelPoi.update({
        where: { id },
        data: { pendingApproval: false },
      });

      writeAudit(
        "TravelPoi",
        "poi.approved",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          name: existing.name,
          category: existing.category,
          destinationSlug: existing.destinationSlug,
        },
      ).catch(() => {});

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-pois] approve error:", e.message);
      res.status(500).json({ error: "Failed to approve POI" });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// POST /:id/reject — ADMIN only; hard-deletes the row
// ───────────────────────────────────────────────────────────────────
router.post(
  "/:id/reject",
  verifyToken,
  requirePermission("pois", "manage"),
  async (req, res) => {
    try {
      const id = parseIdParam(req.params.id);

      const existing = await prisma.travelPoi.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "POI not found", code: "POI_NOT_FOUND" });
      }

      await prisma.travelPoi.delete({ where: { id } });

      writeAudit(
        "TravelPoi",
        "poi.rejected",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          name: existing.name,
          category: existing.category,
          destinationSlug: existing.destinationSlug,
        },
      ).catch(() => {});

      res.json({ ok: true, id });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-pois] reject error:", e.message);
      res.status(500).json({ error: "Failed to reject POI" });
    }
  },
);

module.exports = router;
