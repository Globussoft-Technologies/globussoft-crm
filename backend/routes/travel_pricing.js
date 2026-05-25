// Travel CRM — pricing engine routes (Phase 1).
//
// Mounts:
//   GET    /api/travel/seasons                          — list active seasons
//   POST   /api/travel/seasons                          ADMIN+MGR create
//   PATCH  /api/travel/seasons/:id                      ADMIN+MGR
//   DELETE /api/travel/seasons/:id                      ADMIN
//
//   GET    /api/travel/markup-rules                     — list active rules
//   POST   /api/travel/markup-rules                     ADMIN+MGR create
//   PATCH  /api/travel/markup-rules/:id                 ADMIN+MGR
//   DELETE /api/travel/markup-rules/:id                 ADMIN
//
//   POST   /api/travel/pricing/quote                    — compose a quote
//
// /pricing/quote takes (subBrand, category, routeOrSku, tripDate,
// supplierId?, ownerUserId?) and returns the QuoteResult from
// lib/travelPricing.js. Pure pricing math + Prisma row lookups.

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { quote } = require("../lib/travelPricing");

const VALID_SCOPES = ["flight", "hotel", "transport", "package"];

function assertValidScope(s) {
  if (!VALID_SCOPES.includes(s)) {
    const err = new Error(`scope must be one of: ${VALID_SCOPES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_SCOPE";
    throw err;
  }
}

// ─── Seasons ─────────────────────────────────────────────────────────

router.get("/seasons", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    const rows = await prisma.travelSeasonCalendar.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { startDate: "asc" }],
      take: 200,
    });
    res.json({ seasons: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-pricing] seasons list error:", e.message);
    res.status(500).json({ error: "Failed to list seasons" });
  }
});

router.post(
  "/seasons",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { subBrand, seasonName, startDate, endDate, multiplier } = req.body || {};
      if (!subBrand || !seasonName || !startDate || !endDate) {
        return res.status(400).json({
          error: "subBrand, seasonName, startDate, endDate required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSubBrand(subBrand);

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const s = new Date(startDate);
      const e = new Date(endDate);
      if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) {
        return res.status(400).json({ error: "invalid date", code: "INVALID_DATE" });
      }
      if (e < s) {
        return res.status(400).json({ error: "endDate must be on or after startDate", code: "INVERTED_DATES" });
      }
      if (multiplier != null) {
        const m = Number(multiplier);
        if (!Number.isFinite(m) || m < 0) {
          return res.status(400).json({ error: "multiplier must be a non-negative number", code: "INVALID_MULTIPLIER" });
        }
      }

      const created = await prisma.travelSeasonCalendar.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          seasonName: String(seasonName),
          startDate: s,
          endDate: e,
          multiplier: multiplier != null ? Number(multiplier) : null,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-pricing] season create error:", err.message);
      res.status(500).json({ error: "Failed to create season" });
    }
  },
);

router.patch(
  "/seasons/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.travelSeasonCalendar.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Season not found", code: "NOT_FOUND" });

      const data = {};
      const { seasonName, startDate, endDate, multiplier } = req.body || {};
      if (seasonName !== undefined) data.seasonName = String(seasonName);
      if (startDate !== undefined) {
        const s = new Date(startDate);
        if (!Number.isFinite(s.getTime())) return res.status(400).json({ error: "invalid startDate", code: "INVALID_DATE" });
        data.startDate = s;
      }
      if (endDate !== undefined) {
        const e = new Date(endDate);
        if (!Number.isFinite(e.getTime())) return res.status(400).json({ error: "invalid endDate", code: "INVALID_DATE" });
        data.endDate = e;
      }
      if (multiplier !== undefined) {
        if (multiplier == null) {
          data.multiplier = null;
        } else {
          const m = Number(multiplier);
          if (!Number.isFinite(m) || m < 0) {
            return res.status(400).json({ error: "multiplier must be a non-negative number", code: "INVALID_MULTIPLIER" });
          }
          data.multiplier = m;
        }
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      if (data.startDate && data.endDate && data.endDate < data.startDate) {
        return res.status(400).json({ error: "endDate must be on or after startDate", code: "INVERTED_DATES" });
      }
      const updated = await prisma.travelSeasonCalendar.update({ where: { id }, data });
      res.json(updated);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-pricing] season patch error:", err.message);
      res.status(500).json({ error: "Failed to update season" });
    }
  },
);

router.delete(
  "/seasons/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.travelSeasonCalendar.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Season not found", code: "NOT_FOUND" });
      await prisma.travelSeasonCalendar.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (err) {
      console.error("[travel-pricing] season delete error:", err.message);
      res.status(500).json({ error: "Failed to delete season" });
    }
  },
);

// ─── Markup rules ─────────────────────────────────────────────────────

router.get("/markup-rules", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.scope) {
      assertValidScope(String(req.query.scope));
      where.scope = String(req.query.scope);
    }
    if (req.query.active === "true") where.isActive = true;
    if (req.query.active === "false") where.isActive = false;

    const rows = await prisma.travelMarkupRule.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { priority: "asc" }],
      take: 200,
    });
    res.json({ rules: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-pricing] rules list error:", e.message);
    res.status(500).json({ error: "Failed to list markup rules" });
  }
});

router.post(
  "/markup-rules",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { subBrand, scope, matchKeyJson, markupPct, markupFlat, ownerUserId, priority } = req.body || {};
      if (!subBrand || !scope || !matchKeyJson) {
        return res.status(400).json({
          error: "subBrand, scope, matchKeyJson required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSubBrand(subBrand);
      assertValidScope(scope);

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if ((markupPct == null) === (markupFlat == null)) {
        // Both null OR both set — must be exactly one.
        return res.status(400).json({
          error: "exactly one of markupPct / markupFlat must be set",
          code: "EXACTLY_ONE_MARKUP_TYPE",
        });
      }
      if (markupPct != null) {
        const p = Number(markupPct);
        if (!Number.isFinite(p) || p < 0) {
          return res.status(400).json({ error: "markupPct must be a non-negative number", code: "INVALID_MARKUP" });
        }
      }
      if (markupFlat != null) {
        const f = Number(markupFlat);
        if (!Number.isFinite(f) || f < 0) {
          return res.status(400).json({ error: "markupFlat must be a non-negative number", code: "INVALID_MARKUP" });
        }
      }

      const created = await prisma.travelMarkupRule.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          scope,
          matchKeyJson: String(matchKeyJson),
          markupPct: markupPct != null ? Number(markupPct) : null,
          markupFlat: markupFlat != null ? Number(markupFlat) : null,
          ownerUserId: ownerUserId ? parseInt(ownerUserId, 10) : null,
          priority: priority != null ? parseInt(priority, 10) : 100,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-pricing] rule create error:", err.message);
      res.status(500).json({ error: "Failed to create markup rule" });
    }
  },
);

router.patch(
  "/markup-rules/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.travelMarkupRule.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Rule not found", code: "NOT_FOUND" });

      const data = {};
      const { scope, matchKeyJson, markupPct, markupFlat, priority, isActive } = req.body || {};
      if (scope !== undefined) { assertValidScope(scope); data.scope = scope; }
      if (matchKeyJson !== undefined) data.matchKeyJson = String(matchKeyJson);
      if (markupPct !== undefined) {
        if (markupPct == null) data.markupPct = null;
        else {
          const p = Number(markupPct);
          if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: "markupPct must be a non-negative number", code: "INVALID_MARKUP" });
          data.markupPct = p;
        }
      }
      if (markupFlat !== undefined) {
        if (markupFlat == null) data.markupFlat = null;
        else {
          const f = Number(markupFlat);
          if (!Number.isFinite(f) || f < 0) return res.status(400).json({ error: "markupFlat must be a non-negative number", code: "INVALID_MARKUP" });
          data.markupFlat = f;
        }
      }
      if (priority !== undefined) data.priority = parseInt(priority, 10);
      if (isActive !== undefined) data.isActive = !!isActive;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelMarkupRule.update({ where: { id }, data });
      res.json(updated);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error("[travel-pricing] rule patch error:", err.message);
      res.status(500).json({ error: "Failed to update markup rule" });
    }
  },
);

router.delete(
  "/markup-rules/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      const existing = await prisma.travelMarkupRule.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Rule not found", code: "NOT_FOUND" });
      await prisma.travelMarkupRule.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (err) {
      console.error("[travel-pricing] rule delete error:", err.message);
      res.status(500).json({ error: "Failed to delete markup rule" });
    }
  },
);

// ─── /pricing/quote ──────────────────────────────────────────────────

// POST /api/travel/pricing/quote
//
// Composes a quote from existing cost-master + season + markup rows.
// Returns a QuoteResult per lib/travelPricing.js (baseRate, season
// multiplier, markup amount, subtotal, grandTotal, warnings).
router.post("/pricing/quote", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { subBrand, category, routeOrSku, tripDate, supplierId, ownerUserId } = req.body || {};
    if (!subBrand || !category || !routeOrSku || !tripDate) {
      return res.status(400).json({
        error: "subBrand, category, routeOrSku, tripDate required",
        code: "MISSING_FIELDS",
      });
    }
    assertValidSubBrand(subBrand);

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const tripDateParsed = new Date(tripDate);
    if (!Number.isFinite(tripDateParsed.getTime())) {
      return res.status(400).json({ error: "invalid tripDate", code: "INVALID_DATE" });
    }

    // Find matching cost-master row. Prefer the row whose validFrom/validTo
    // brackets the tripDate, falling back to "no date guard" rows when none
    // match. supplierId narrowing is optional.
    const costWhere = {
      tenantId: req.travelTenant.id,
      subBrand,
      category,
      routeOrSku,
      isActive: true,
    };
    if (supplierId) costWhere.supplierId = parseInt(supplierId, 10);

    const costRows = await prisma.travelCostMaster.findMany({
      where: costWhere,
      orderBy: { id: "desc" },
      take: 20,
    });
    const cost = costRows.find((r) => {
      const validFrom = r.validFrom ? new Date(r.validFrom) : null;
      const validTo = r.validTo ? new Date(r.validTo) : null;
      const afterFrom = !validFrom || tripDateParsed >= validFrom;
      const beforeTo = !validTo || tripDateParsed <= validTo;
      return afterFrom && beforeTo;
    }) || costRows[0]; // fallback to most-recent row

    if (!cost) {
      return res.status(404).json({
        error: "No cost-master row matches the given subBrand+category+routeOrSku",
        code: "COST_NOT_FOUND",
      });
    }

    const seasons = await prisma.travelSeasonCalendar.findMany({
      where: { tenantId: req.travelTenant.id, subBrand },
      orderBy: { id: "asc" },
    });
    const rules = await prisma.travelMarkupRule.findMany({
      where: { tenantId: req.travelTenant.id, subBrand, isActive: true },
      orderBy: { priority: "asc" },
    });

    const result = quote({
      cost: {
        baseRate: Number(cost.baseRate),
        category: cost.category,
        subBrand: cost.subBrand,
        routeOrSku: cost.routeOrSku,
      },
      seasons,
      rules,
      subBrand,
      tripDate: tripDateParsed,
      ownerUserId: ownerUserId ? parseInt(ownerUserId, 10) : null,
    });

    res.json({
      ...result,
      cost: { id: cost.id, currency: cost.currency },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("[travel-pricing] quote error:", err.message);
    res.status(500).json({ error: "Failed to compute quote" });
  }
});

module.exports = router;
