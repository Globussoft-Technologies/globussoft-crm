// @ts-check
/**
 * Travel CRM — Sightseeing Master CRUD (#907 slice 2/N).
 *
 * Ships the operator-facing CRUD against the TravelSightseeing model that
 * landed in slice 1 (commit 0d24d3f1). This is the "Sightseeing master:
 * destination -> POIs (description, image, duration, price reference)"
 * requirement from #907 (Tier P2 — Itinerary upgrades).
 *
 * Five endpoints, all mounted at /api/travel/sightseeing:
 *   GET    /            list, paginated (limit clamped to [1, 200]),
 *                       tenant-scoped + sub-brand narrowing + filter by
 *                       ?destinationName / ?category / ?subBrand / ?isActive
 *   POST   /            create (ADMIN+MANAGER) — destinationName + name
 *                       required; currency validated as 3-letter ISO
 *   GET    /:id         fetch one, tenant-scoped + sub-brand gate
 *   PATCH  /:id         update (ADMIN+MANAGER), tenant-scoped + sub-brand
 *                       gate, currency validated when supplied
 *   DELETE /:id         soft-delete via isActive=false (ADMIN only)
 *
 * Sub-brand semantics mirror brand_kits.js + travel_suppliers.js — admins
 * get unrestricted access; non-admins with a non-empty subBrandAccess[]
 * are narrowed to that set. Rows with subBrand=null are tenant-wide and
 * visible to everyone in the tenant (consistent with the rest of
 * /api/travel/*).
 *
 * No admin UI yet — that's slice 3.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

// Whitelist of fields a caller may set on POST / PATCH. tenantId / id /
// createdAt / updatedAt are intentionally absent (also stripped by the
// global stripDangerous middleware, but defence-in-depth at the route).
const MUTABLE_FIELDS = [
  "destinationName",
  "name",
  "description",
  "imageUrl",
  "durationMinutes",
  "priceReferenceMinor",
  "currency",
  "category",
  "subBrand",
  "notes",
  "isActive",
];

function pickMutable(body) {
  const out = {};
  for (const f of MUTABLE_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

function validateCurrency(currency) {
  if (currency == null) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    const err = new Error("currency must be a 3-letter ISO code (uppercase)");
    err.status = 400;
    err.code = "INVALID_CURRENCY";
    throw err;
  }
  return currency;
}

// GET /api/travel/sightseeing — list
router.get("/", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    if (req.query.destinationName) {
      where.destinationName = String(req.query.destinationName);
    }
    if (req.query.category) {
      where.category = String(req.query.category);
    }
    if (req.query.isActive !== undefined) {
      where.isActive = String(req.query.isActive) === "true";
    }

    // Clamp pagination: limit ∈ [1, 200]; offset ≥ 0.
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
    const offsetRaw = parseInt(req.query.offset, 10);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    // Sub-brand narrowing. Sightseeing.subBrand is NULLABLE — tenant-wide
    // rows (subBrand=null) are visible to everyone; named-subBrand rows
    // are intersected with the caller's allowed set.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({ items: [], total: 0, limit, offset });
    }
    if (allowed instanceof Set) {
      if (req.query.subBrand) {
        if (!canAccessSubBrand(allowed, String(req.query.subBrand))) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
        where.subBrand = String(req.query.subBrand);
      } else {
        where.OR = [
          { subBrand: null },
          { subBrand: { in: [...allowed] } },
        ];
      }
    } else if (req.query.subBrand) {
      where.subBrand = String(req.query.subBrand);
    }

    const [items, total] = await Promise.all([
      prisma.travelSightseeing.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.travelSightseeing.count({ where }),
    ]);
    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error("[travel/sightseeing] List error:", err.message);
    res.status(500).json({
      error: "Failed to fetch sightseeing list",
      code: "SIGHTSEEING_LIST_FAILED",
    });
  }
});

// POST /api/travel/sightseeing — create (ADMIN + MANAGER)
router.post(
  "/",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const body = pickMutable(req.body || {});

      if (!body.destinationName || typeof body.destinationName !== "string") {
        return res.status(400).json({
          error: "destinationName is required",
          code: "MISSING_DESTINATION",
        });
      }
      if (!body.name || typeof body.name !== "string") {
        return res.status(400).json({
          error: "name is required",
          code: "MISSING_NAME",
        });
      }

      validateCurrency(body.currency);

      // Sub-brand gate: when a subBrand is supplied, the caller must be
      // able to act on it. Tenant-wide (subBrand=null / undefined) is
      // always allowed.
      if (body.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, body.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      const created = await prisma.travelSightseeing.create({
        data: {
          tenantId: req.travelTenant.id,
          destinationName: body.destinationName,
          name: body.name,
          description: body.description ?? null,
          imageUrl: body.imageUrl ?? null,
          durationMinutes:
            body.durationMinutes != null ? Number(body.durationMinutes) : null,
          priceReferenceMinor:
            body.priceReferenceMinor != null
              ? Number(body.priceReferenceMinor)
              : null,
          currency: body.currency ?? null,
          category: body.category ?? null,
          subBrand: body.subBrand ?? null,
          notes: body.notes ?? null,
          isActive: body.isActive === false ? false : true,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/sightseeing] Create error:", err.message);
      res.status(500).json({
        error: "Failed to create sightseeing entry",
        code: "SIGHTSEEING_CREATE_FAILED",
      });
    }
  },
);

// GET /api/travel/sightseeing/stats — tenant-wide aggregate envelope.
// MUST be declared BEFORE GET /:id so Express doesn't try to parse "stats"
// as a numeric :id and 400.
//
// Envelope shape mirrors travel_itineraries /stats (commit 2a4a62d4) but
// adapted to TravelSightseeing (no status enum → group by category +
// isActive instead). Sub-brand narrowing per #976 fix — empty allow-set
// yields a zeroed envelope, NOT 403.
router.get("/stats", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    // Optional ISO date bounds on createdAt.
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    // Canonical zeroed envelope — returned when caller has no sub-brand
    // access OR when zero rows match. Single source of truth so the
    // empty-set + empty-result paths can't drift.
    const zeroed = {
      total: 0,
      activeCount: 0,
      inactiveCount: 0,
      byCategory: {},
      bySubBrand: {},
      grandPriceReferenceValue: 0,
      averageDurationMinutes: null,
      topDestinations: [],
      lastUpdatedAt: null,
    };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. Sightseeing.subBrand is NULLABLE; tenant-wide rows
    // (subBrand=null) are visible to everyone, named-subBrand rows are
    // intersected with the caller's allowed set.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const items = await prisma.travelSightseeing.findMany({
      where,
      select: {
        id: true,
        destinationName: true,
        subBrand: true,
        category: true,
        isActive: true,
        durationMinutes: true,
        priceReferenceMinor: true,
        updatedAt: true,
      },
    });

    if (items.length === 0) {
      return res.json(zeroed);
    }

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    let activeCount = 0;
    let inactiveCount = 0;
    const byCategory = {};
    const bySubBrand = {};
    const byDestination = {};
    let grandPriceReferenceValue = 0;
    let durationSum = 0;
    let durationCount = 0;
    let lastUpdatedAt = null;

    for (const it of items) {
      if (it.isActive) activeCount += 1;
      else inactiveCount += 1;

      const catKey = it.category ? String(it.category) : "_uncategorized";
      if (!byCategory[catKey]) byCategory[catKey] = 0;
      byCategory[catKey] += 1;

      // bySubBrand: coalesce null → "_tenant" matching itineraries /stats
      // convention.
      const sbKey = it.subBrand ? String(it.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
      bySubBrand[sbKey].count += 1;

      const destKey = it.destinationName ? String(it.destinationName) : "_unknown";
      if (!byDestination[destKey]) byDestination[destKey] = 0;
      byDestination[destKey] += 1;

      const price = Number(it.priceReferenceMinor);
      if (Number.isFinite(price)) grandPriceReferenceValue += price;

      const dur = Number(it.durationMinutes);
      if (Number.isFinite(dur)) {
        durationSum += dur;
        durationCount += 1;
      }

      const ts = it.updatedAt instanceof Date ? it.updatedAt : new Date(it.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
    }

    // Top 5 destinations by count, sorted desc.
    const topDestinations = Object.entries(byDestination)
      .map(([destinationName, count]) => ({ destinationName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const averageDurationMinutes = durationCount > 0
      ? round2(durationSum / durationCount)
      : null;

    res.json({
      total: items.length,
      activeCount,
      inactiveCount,
      byCategory,
      bySubBrand,
      grandPriceReferenceValue: round2(grandPriceReferenceValue),
      averageDurationMinutes,
      topDestinations,
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/sightseeing] Stats error:", err.message);
    res.status(500).json({
      error: "Failed to fetch sightseeing stats",
      code: "SIGHTSEEING_STATS_FAILED",
    });
  }
});

// GET /api/travel/sightseeing/:id
router.get("/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    const item = await prisma.travelSightseeing.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!item) {
      return res.status(404).json({
        error: "Sightseeing entry not found",
        code: "SIGHTSEEING_NOT_FOUND",
      });
    }
    if (item.subBrand) {
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, item.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }
    }
    res.json(item);
  } catch (err) {
    console.error("[travel/sightseeing] Get error:", err.message);
    res.status(500).json({
      error: "Failed to fetch sightseeing entry",
      code: "SIGHTSEEING_GET_FAILED",
    });
  }
});

// PATCH /api/travel/sightseeing/:id (ADMIN + MANAGER)
router.patch(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }

      const existing = await prisma.travelSightseeing.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Sightseeing entry not found",
          code: "SIGHTSEEING_NOT_FOUND",
        });
      }

      // Sub-brand gate against the EXISTING row's subBrand.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Forbidden sub-brand",
          code: "FORBIDDEN_SUB_BRAND",
        });
      }

      const body = pickMutable(req.body || {});
      if (Object.keys(body).length === 0) {
        return res.status(400).json({
          error: "No updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      if (body.currency !== undefined) {
        validateCurrency(body.currency);
      }

      // If the caller is trying to MOVE this row to a different sub-brand,
      // re-gate against the new value too.
      if (body.subBrand !== undefined && body.subBrand !== existing.subBrand) {
        if (body.subBrand && !canAccessSubBrand(allowed, body.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      // Coerce numeric fields when they're present.
      const data = { ...body };
      if (data.durationMinutes !== undefined && data.durationMinutes !== null) {
        data.durationMinutes = Number(data.durationMinutes);
      }
      if (
        data.priceReferenceMinor !== undefined
        && data.priceReferenceMinor !== null
      ) {
        data.priceReferenceMinor = Number(data.priceReferenceMinor);
      }

      const updated = await prisma.travelSightseeing.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/sightseeing] Patch error:", err.message);
      res.status(500).json({
        error: "Failed to update sightseeing entry",
        code: "SIGHTSEEING_PATCH_FAILED",
      });
    }
  },
);

// DELETE /api/travel/sightseeing/:id (ADMIN only) — soft delete.
router.delete(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
      }

      const existing = await prisma.travelSightseeing.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Sightseeing entry not found",
          code: "SIGHTSEEING_NOT_FOUND",
        });
      }
      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Forbidden sub-brand",
            code: "FORBIDDEN_SUB_BRAND",
          });
        }
      }

      const updated = await prisma.travelSightseeing.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (err) {
      console.error("[travel/sightseeing] Delete error:", err.message);
      res.status(500).json({
        error: "Failed to delete sightseeing entry",
        code: "SIGHTSEEING_DELETE_FAILED",
      });
    }
  },
);

module.exports = router;
