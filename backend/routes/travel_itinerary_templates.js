// @ts-check
/**
 * Travel CRM — Itinerary Template Library CRUD.
 *
 * #907 slice 6/N. The "Pre-loaded itinerary template library (start with
 * ~50, expand over time)" requirement. The ItineraryTemplate model landed
 * in slice 4 (commit 1c01111a). This file ships the 5-endpoint CRUD +
 * tenant + sub-brand scoping.
 *
 * Mounted at /api/travel/itinerary-templates in server.js.
 *
 * Five endpoints:
 *   GET    /            list, paginated (limit clamped to [1, 200]),
 *                       tenant-scoped + sub-brand narrowing + filter by
 *                       ?destinationName / ?category / ?subBrand / ?isActive
 *   POST   /            create (ADMIN+MANAGER) — name + destinationName +
 *                       durationDays required; durationDays must be a
 *                       positive integer; currency validated as 3-letter
 *                       ISO when supplied
 *   GET    /:id         fetch one, tenant-scoped + sub-brand gate
 *   PATCH  /:id         update (ADMIN+MANAGER), tenant-scoped + sub-brand
 *                       gate, durationDays + currency revalidated when
 *                       supplied
 *   DELETE /:id         soft-delete via isActive=false (ADMIN only)
 *
 * Sub-brand semantics mirror travel_sightseeing.js — admins get unrestricted
 * access; non-admins with a non-empty subBrandAccess[] are narrowed to that
 * set. Rows with subBrand=null are tenant-wide and visible to everyone in
 * the tenant.
 *
 * Next slices: admin UI library page + "Create itinerary from template"
 * hook on the Itinerary builder + seed ~50 starter templates.
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
// createdAt / updatedAt / usageCount are intentionally absent (usageCount is
// engine-bumped when an itinerary is created from a template, never
// caller-controlled).
const MUTABLE_FIELDS = [
  "name",
  "destinationName",
  "durationDays",
  "description",
  "thumbnailUrl",
  "category",
  "subBrand",
  "defaultMarkupPercent",
  "basePriceMinor",
  "currency",
  "templateJson",
  "llmGeneratedBy",
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

function validateDurationDays(durationDays) {
  const n = Number(durationDays);
  if (!Number.isInteger(n) || n < 1) {
    const err = new Error("durationDays must be a positive integer");
    err.status = 400;
    err.code = "INVALID_DURATION";
    throw err;
  }
  return n;
}

// GET /api/travel/itinerary-templates — list
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

    // Sub-brand narrowing. ItineraryTemplate.subBrand is NULLABLE — tenant-
    // wide rows (subBrand=null) are visible to everyone; named-subBrand
    // rows are intersected with the caller's allowed set.
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
      prisma.itineraryTemplate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.itineraryTemplate.count({ where }),
    ]);
    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error("[travel/itinerary-templates] List error:", err.message);
    res.status(500).json({
      error: "Failed to fetch itinerary template list",
      code: "ITINERARY_TEMPLATE_LIST_FAILED",
    });
  }
});

// POST /api/travel/itinerary-templates — create (ADMIN + MANAGER)
router.post(
  "/",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const body = pickMutable(req.body || {});

      if (!body.name || typeof body.name !== "string") {
        return res.status(400).json({
          error: "name is required",
          code: "MISSING_NAME",
        });
      }
      if (!body.destinationName || typeof body.destinationName !== "string") {
        return res.status(400).json({
          error: "destinationName is required",
          code: "MISSING_DESTINATION",
        });
      }
      if (body.durationDays === undefined || body.durationDays === null) {
        return res.status(400).json({
          error: "durationDays is required",
          code: "MISSING_DURATION",
        });
      }
      const durationDays = validateDurationDays(body.durationDays);

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

      const created = await prisma.itineraryTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: body.name,
          destinationName: body.destinationName,
          durationDays,
          description: body.description ?? null,
          thumbnailUrl: body.thumbnailUrl ?? null,
          category: body.category ?? null,
          subBrand: body.subBrand ?? null,
          defaultMarkupPercent:
            body.defaultMarkupPercent != null
              ? Number(body.defaultMarkupPercent)
              : null,
          basePriceMinor:
            body.basePriceMinor != null ? Number(body.basePriceMinor) : null,
          currency: body.currency ?? null,
          templateJson: body.templateJson ?? null,
          llmGeneratedBy: body.llmGeneratedBy ?? null,
          isActive: body.isActive === false ? false : true,
          usageCount: 0,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/itinerary-templates] Create error:", err.message);
      res.status(500).json({
        error: "Failed to create itinerary template",
        code: "ITINERARY_TEMPLATE_CREATE_FAILED",
      });
    }
  },
);

// GET /api/travel/itinerary-templates/:id
router.get("/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
    }
    const item = await prisma.itineraryTemplate.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!item) {
      return res.status(404).json({
        error: "Itinerary template not found",
        code: "ITINERARY_TEMPLATE_NOT_FOUND",
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
    console.error("[travel/itinerary-templates] Get error:", err.message);
    res.status(500).json({
      error: "Failed to fetch itinerary template",
      code: "ITINERARY_TEMPLATE_GET_FAILED",
    });
  }
});

// PATCH /api/travel/itinerary-templates/:id (ADMIN + MANAGER)
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

      const existing = await prisma.itineraryTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Itinerary template not found",
          code: "ITINERARY_TEMPLATE_NOT_FOUND",
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
      if (body.durationDays !== undefined) {
        body.durationDays = validateDurationDays(body.durationDays);
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
      if (
        data.defaultMarkupPercent !== undefined
        && data.defaultMarkupPercent !== null
      ) {
        data.defaultMarkupPercent = Number(data.defaultMarkupPercent);
      }
      if (data.basePriceMinor !== undefined && data.basePriceMinor !== null) {
        data.basePriceMinor = Number(data.basePriceMinor);
      }

      const updated = await prisma.itineraryTemplate.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error("[travel/itinerary-templates] Patch error:", err.message);
      res.status(500).json({
        error: "Failed to update itinerary template",
        code: "ITINERARY_TEMPLATE_PATCH_FAILED",
      });
    }
  },
);

// DELETE /api/travel/itinerary-templates/:id (ADMIN only) — soft delete.
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

      const existing = await prisma.itineraryTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Itinerary template not found",
          code: "ITINERARY_TEMPLATE_NOT_FOUND",
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

      const updated = await prisma.itineraryTemplate.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (err) {
      console.error("[travel/itinerary-templates] Delete error:", err.message);
      res.status(500).json({
        error: "Failed to delete itinerary template",
        code: "ITINERARY_TEMPLATE_DELETE_FAILED",
      });
    }
  },
);

module.exports = router;
