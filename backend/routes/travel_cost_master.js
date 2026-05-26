// Travel CRM — cost-master CRUD (Phase 1 supplier rate book).
//
// Endpoints:
//   GET    /api/travel/cost-master                  — list (filterable)
//   POST   /api/travel/cost-master                  — create rate row
//   GET    /api/travel/cost-master/:id              — fetch one
//   PATCH  /api/travel/cost-master/:id              — amend baseRate / supplier / etc
//   DELETE /api/travel/cost-master/:id              — ADMIN only
//
// Used by RFU + Travel Stall advisors to look up supplier rates when
// building an Itinerary's ItineraryItems. Phase 1.5 will add a /quote
// endpoint that pipes through season-multiplier + markup-rule (Day 9).
//
// All money fields use Decimal(15,2) per Q24.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
} = require("../middleware/travelGuards");

const VALID_CATEGORIES = ["hotel", "flight", "transport", "visa", "insurance"];

function assertValidCategory(c) {
  if (!VALID_CATEGORIES.includes(c)) {
    const err = new Error(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_CATEGORY";
    throw err;
  }
}

// GET /api/travel/cost-master
router.get("/cost-master", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.category) {
      assertValidCategory(String(req.query.category));
      where.category = String(req.query.category);
    }
    if (req.query.supplierId) {
      const sid = parseInt(req.query.supplierId, 10);
      if (Number.isFinite(sid)) where.supplierId = sid;
    }
    if (req.query.active === "true") where.isActive = true;
    if (req.query.active === "false") where.isActive = false;
    if (req.query.routeOrSku) {
      where.routeOrSku = { contains: String(req.query.routeOrSku) };
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [rates, total] = await Promise.all([
      prisma.travelCostMaster.findMany({
        where,
        orderBy: [{ category: "asc" }, { routeOrSku: "asc" }],
        take,
        skip,
      }),
      prisma.travelCostMaster.count({ where }),
    ]);
    res.json({ rates, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-cost] list error:", e.message);
    res.status(500).json({ error: "Failed to list cost-master rates" });
  }
});

// POST /api/travel/cost-master — ADMIN+MANAGER
router.post(
  "/cost-master",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        subBrand, category, routeOrSku, baseRate,
        supplierId, attributesJson, currency,
        seasonId, validFrom, validTo, isActive,
      } = req.body || {};

      if (!subBrand || !category || !routeOrSku || baseRate == null) {
        return res.status(400).json({
          error: "subBrand, category, routeOrSku, baseRate required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSubBrand(subBrand);
      assertValidCategory(category);

      const rate = Number(baseRate);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ error: "baseRate must be a non-negative number", code: "INVALID_BASE_RATE" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const created = await prisma.travelCostMaster.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          category,
          routeOrSku: String(routeOrSku),
          baseRate: rate,
          supplierId: supplierId ? parseInt(supplierId, 10) : null,
          attributesJson: attributesJson ? String(attributesJson) : null,
          currency: currency || "INR",
          seasonId: seasonId ? parseInt(seasonId, 10) : null,
          validFrom: validFrom ? new Date(validFrom) : null,
          validTo: validTo ? new Date(validTo) : null,
          isActive: isActive !== false,
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-cost] create error:", e.message);
      res.status(500).json({ error: "Failed to create cost-master row" });
    }
  },
);

// GET /api/travel/cost-master/:id
router.get("/cost-master/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const row = await prisma.travelCostMaster.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!row) return res.status(404).json({ error: "Rate not found", code: "NOT_FOUND" });
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, row.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(row);
  } catch (e) {
    console.error("[travel-cost] get error:", e.message);
    res.status(500).json({ error: "Failed to get rate" });
  }
});

// PATCH /api/travel/cost-master/:id — ADMIN+MANAGER
router.patch(
  "/cost-master/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCostMaster.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Rate not found", code: "NOT_FOUND" });

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const body = req.body || {};
      if (body.category !== undefined) {
        assertValidCategory(body.category);
        data.category = body.category;
      }
      if (body.routeOrSku !== undefined) data.routeOrSku = String(body.routeOrSku);
      if (body.baseRate !== undefined) {
        const rate = Number(body.baseRate);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(400).json({ error: "baseRate must be a non-negative number", code: "INVALID_BASE_RATE" });
        }
        data.baseRate = rate;
      }
      if (body.supplierId !== undefined) data.supplierId = body.supplierId ? parseInt(body.supplierId, 10) : null;
      if (body.attributesJson !== undefined) data.attributesJson = body.attributesJson ? String(body.attributesJson) : null;
      if (body.currency !== undefined) data.currency = body.currency || "INR";
      if (body.seasonId !== undefined) data.seasonId = body.seasonId ? parseInt(body.seasonId, 10) : null;
      if (body.validFrom !== undefined) data.validFrom = body.validFrom ? new Date(body.validFrom) : null;
      if (body.validTo !== undefined) data.validTo = body.validTo ? new Date(body.validTo) : null;
      if (body.isActive !== undefined) data.isActive = !!body.isActive;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelCostMaster.update({ where: { id }, data });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-cost] patch error:", e.message);
      res.status(500).json({ error: "Failed to update rate" });
    }
  },
);

// DELETE /api/travel/cost-master/:id — ADMIN only
router.delete(
  "/cost-master/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCostMaster.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Rate not found", code: "NOT_FOUND" });
      await prisma.travelCostMaster.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-cost] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete rate" });
    }
  },
);

module.exports = router;
