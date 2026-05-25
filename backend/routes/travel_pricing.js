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
//   GET    /api/travel/pricing/stats                    — tenant-wide rollup
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

// ─── /pricing/stats ──────────────────────────────────────────────────

// GET /api/travel/pricing/stats — tenant-wide pricing-config rollup.
//
// Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
// /commission-profiles/stats + #908 slice 19 /flyer-templates/global-stats.
// USER-readable anodyne aggregate that powers the Pricing Config library
// page header summary strip ("12 seasons · 4 active · 18 markup rules ·
// 15 active · 8 flight · 5 hotel · last edit 2h ago"). Without this,
// the frontend has to fire {seasons list, markupRules list, count by
// scope×4, count by subBrand×4, max(updatedAt) probe} — N+1 round-trips
// for a single visual surface.
//
// Aggregates across BOTH TravelSeasonCalendar AND TravelMarkupRule rows.
// "Active" semantics differ per model:
//   - seasons: startDate <= now <= endDate (no isActive field on schema)
//   - markupRules: isActive=true (explicit column)
//
// PRD anchors:
//   - PRD_TRAVEL_PRICING §3 — operator-facing pricing-config dashboard
//     surfaces "how many seasons and markup rules do I have, of what
//     shape, currently active vs scheduled" — this endpoint feeds those
//     KPI tiles in one round-trip.
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' rows in the counts. Same gate as the
//     sibling /seasons + /markup-rules list endpoints.
//   - Season rollup (from prisma.travelSeasonCalendar.findMany):
//       total, active, bySubBrand: { <sb>: { count } }
//   - Markup rollup (from prisma.travelMarkupRule.findMany):
//       total, active, bySubBrand: { <sb>: { count } },
//       byScope: { flight|hotel|transport|package: { count } }
//   - lastUpdatedAt: max(updatedAt) across both findMany result sets.
//   - ?from / ?to (ISO date bounds) filter createdAt on both models
//     before aggregation.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe.
// No audit row: read-only meta surface, mirrors sibling stats endpoints.
//
// Express route ordering: this literal-path route lives in the same file
// as /seasons/:id + /markup-rules/:id but doesn't collide because the
// path is fully distinct (/pricing/stats, not /seasons/stats or /markup-rules/stats).
router.get("/pricing/stats", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const tenantId = req.travelTenant.id;

    // Optional ISO date bounds on createdAt — applied to both models.
    const dateFilter = {};
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
      dateFilter.gte = d;
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      dateFilter.lte = d;
    }

    // Sub-brand narrowing — same gate as sibling list endpoints.
    // MANAGER subBrandAccess restricts the visible-set BEFORE counting.
    const allowed = await getSubBrandAccessSet(req.user.userId);

    const seasonWhere = { tenantId };
    const ruleWhere = { tenantId };
    if (Object.keys(dateFilter).length > 0) {
      seasonWhere.createdAt = { ...dateFilter };
      ruleWhere.createdAt = { ...dateFilter };
    }
    if (allowed) {
      if (allowed.size > 0) {
        const brandList = [...allowed];
        seasonWhere.subBrand = { in: brandList };
        ruleWhere.subBrand = { in: brandList };
      } else {
        // Empty allowed set = deny everything; force-empty query.
        seasonWhere.subBrand = "__none__";
        ruleWhere.subBrand = "__none__";
      }
    }

    const [seasons, rules] = await Promise.all([
      prisma.travelSeasonCalendar.findMany({
        where: seasonWhere,
        select: {
          id: true,
          subBrand: true,
          startDate: true,
          endDate: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: 2000,
      }),
      prisma.travelMarkupRule.findMany({
        where: ruleWhere,
        select: {
          id: true,
          subBrand: true,
          scope: true,
          isActive: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: 2000,
      }),
    ]);

    const now = new Date();
    let lastUpdatedAt = null;

    // Seasons rollup.
    let seasonsActive = 0;
    const seasonsBySubBrand = {};
    for (const s of seasons) {
      const start = s.startDate instanceof Date ? s.startDate : new Date(s.startDate);
      const end = s.endDate instanceof Date ? s.endDate : new Date(s.endDate);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        if (start <= now && now <= end) seasonsActive += 1;
      }

      const sbKey = s.subBrand ? String(s.subBrand) : "_tenant";
      if (!seasonsBySubBrand[sbKey]) seasonsBySubBrand[sbKey] = { count: 0 };
      seasonsBySubBrand[sbKey].count += 1;

      const ts = s.updatedAt instanceof Date ? s.updatedAt : new Date(s.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
    }

    // Markup rules rollup.
    let rulesActive = 0;
    const rulesBySubBrand = {};
    const rulesByScope = {};
    for (const r of rules) {
      if (r.isActive) rulesActive += 1;

      const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
      if (!rulesBySubBrand[sbKey]) rulesBySubBrand[sbKey] = { count: 0 };
      rulesBySubBrand[sbKey].count += 1;

      const scopeKey = r.scope ? String(r.scope) : "other";
      if (!rulesByScope[scopeKey]) rulesByScope[scopeKey] = { count: 0 };
      rulesByScope[scopeKey].count += 1;

      const ts = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
      }
    }

    res.json({
      seasons: {
        total: seasons.length,
        active: seasonsActive,
        bySubBrand: seasonsBySubBrand,
      },
      markupRules: {
        total: rules.length,
        active: rulesActive,
        bySubBrand: rulesBySubBrand,
        byScope: rulesByScope,
      },
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-pricing] stats error:", e.message);
    res.status(500).json({ error: "Failed to summarise pricing config" });
  }
});

// ─── /pricing/by-month ───────────────────────────────────────────────

// GET /api/travel/pricing/by-month — tenant-wide monthly rollup.
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket
// for the tenant-scoped (and sub-brand-narrowed) pricing-config
// population, bucketing BOTH TravelSeasonCalendar AND TravelMarkupRule
// rows by createdAt into the same month buckets. Each row carries
// seasonCount + markupCount + totalCount so the operator dashboard can
// render a "pricing-config changes over time" trend chart without N
// round-trips per month.
//
// Pairs with /pricing/stats (`5feca84c`) — that surface gives the
// current-state aggregate, this one gives the temporal distribution.
//
// Mirrors #908 slice 21 (/flyer-templates/by-month) + #900 slice 16
// (/quotes/by-month) — same UTC YYYY-MM bucketing template, same
// pagination semantics, same defensive math (null/invalid createdAt →
// "unknown" bucket; excluded when ?from / ?to is set, kept otherwise so
// the count surface stays accurate).
//
// PRD anchors:
//   - PRD_TRAVEL_PRICING §3 — operator-facing pricing-config dashboard
//     surfaces "when did we last touch our pricing config; how busy is
//     each month" — this endpoint feeds that trend chart in one
//     round-trip.
//
// Query params:
//   - ?from / ?to     — optional inclusive YYYY-MM bounds; invalid →
//                       400 INVALID_MONTH_FORMAT
//   - ?orderBy        — default month:asc; accepts month:{asc|desc},
//                       seasonCount:{asc|desc}, markupCount:{asc|desc};
//                       unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' rows in the rollup. Same gate as the
//     sibling /pricing/stats endpoint (TravelSeasonCalendar +
//     TravelMarkupRule rows are always sub-brand-tagged; no NULL
//     subBrand rows exist on these tables, so no OR-with-NULL needed).
//     Empty access set → all-zeros envelope (not 403) so the dashboard
//     tile renders cleanly for not-yet-onboarded operators.
//   - JS-side aggregation over light findMany projections
//     ({ subBrand, createdAt }) — population is bounded by tenant scale
//     (low thousands), matches the rationale on /pricing/stats.
//   - "unknown" bucket: rows with null/invalid createdAt land here so
//     the count surface stays accurate. Excluded when ?from / ?to is
//     set; included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface.
//
// Express route ordering: literal-path /pricing/by-month doesn't
// collide with /seasons/:id or /markup-rules/:id (distinct path
// prefix). Declared BEFORE /pricing/quote for consistency with sibling
// by-month endpoints, though no functional ordering requirement.
router.get(
  "/pricing/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors slice 16 /quotes/by-month.
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
        "seasonCount:asc",
        "seasonCount:desc",
        "markupCount:asc",
        "markupCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Sub-brand narrowing — same gate as /pricing/stats. Empty allowed
      // set returns the zero-envelope (not 403).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json({
          months: [],
          totalMonths: 0,
          grandSeasonCount: 0,
          grandMarkupCount: 0,
          grandTotalCount: 0,
          limit: take,
          offset: skip,
        });
      }

      const seasonWhere = { tenantId: req.travelTenant.id };
      const ruleWhere = { tenantId: req.travelTenant.id };
      if (allowed instanceof Set) {
        const brandList = [...allowed];
        seasonWhere.subBrand = { in: brandList };
        ruleWhere.subBrand = { in: brandList };
      }

      const [seasons, rules] = await Promise.all([
        prisma.travelSeasonCalendar.findMany({
          where: seasonWhere,
          select: { createdAt: true },
        }),
        prisma.travelMarkupRule.findMany({
          where: ruleWhere,
          select: { createdAt: true },
        }),
      ]);

      // Aggregate per-UTC-month. Map "YYYY-MM" → { month, seasonCount,
      // markupCount, totalCount }. Null/invalid createdAt → "unknown".
      const byMonth = new Map();

      function bucketFor(monthKey) {
        let b = byMonth.get(monthKey);
        if (!b) {
          b = {
            month: monthKey,
            seasonCount: 0,
            markupCount: 0,
            totalCount: 0,
          };
          byMonth.set(monthKey, b);
        }
        return b;
      }

      function monthKeyFor(createdAt) {
        if (!createdAt) return "unknown";
        const dt = createdAt instanceof Date ? createdAt : new Date(createdAt);
        if (Number.isNaN(dt.getTime())) return "unknown";
        const yyyy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        return `${yyyy}-${mm}`;
      }

      for (const s of seasons) {
        const b = bucketFor(monthKeyFor(s.createdAt));
        b.seasonCount += 1;
        b.totalCount += 1;
      }
      for (const r of rules) {
        const b = bucketFor(monthKeyFor(r.createdAt));
        b.markupCount += 1;
        b.totalCount += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token).
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (chronological).
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

      const totalMonths = months.length;
      const grandSeasonCount = months.reduce(
        (acc, r) => acc + (Number(r.seasonCount) || 0),
        0,
      );
      const grandMarkupCount = months.reduce(
        (acc, r) => acc + (Number(r.markupCount) || 0),
        0,
      );
      const grandTotalCount = grandSeasonCount + grandMarkupCount;

      // Pagination AFTER aggregation + sort + filter.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandSeasonCount,
        grandMarkupCount,
        grandTotalCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-pricing] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ─── /pricing/by-year ────────────────────────────────────────────────

// GET /api/travel/pricing/by-year — tenant-wide annual rollup.
//
// Calendar-year complement to /pricing/by-month. Pricing config tends
// to move on a yearly cadence (season calendars are re-published per
// trip year; markup-rule cohorts get refreshed annually), so this
// surface is the natural unit for the "last decade of pricing changes"
// trend the dashboard renders alongside the monthly view.
//
// Buckets BOTH TravelSeasonCalendar AND TravelMarkupRule rows by
// createdAt UTC calendar year. Each row carries seasonCount +
// markupCount + totalCount, plus grand-totals for the page header.
//
// Pairs with /pricing/by-month (same commit family) — identical
// bucketing template, identical pagination + sort + sub-brand semantics,
// just swap YYYY-MM → YYYY.
//
// PRD anchors:
//   - PRD_TRAVEL_PRICING §3 — operator-facing pricing-config dashboard
//     surfaces "year-over-year pricing-config churn" via this endpoint.
//
// Query params:
//   - ?from / ?to     — optional inclusive YYYY bounds; invalid →
//                       400 INVALID_YEAR_FORMAT
//   - ?orderBy        — default year:asc; accepts year:{asc|desc},
//                       seasonCount:{asc|desc}, markupCount:{asc|desc};
//                       unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 10 / 0; limit caps at 30 (≈3 decades)
//
// Behaviour:
//   - Sub-brand-scoped: MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' rows in the rollup. Same gate as
//     /pricing/by-month + /pricing/stats. Empty access set → all-zeros
//     envelope (not 403) so the dashboard tile renders cleanly for
//     not-yet-onboarded operators.
//   - JS-side aggregation over light findMany projections
//     ({ createdAt }) — population is bounded by tenant scale.
//   - "unknown" bucket: rows with null/invalid createdAt land here so
//     the count surface stays accurate. Excluded when ?from / ?to is
//     set; included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface.
router.get(
  "/pricing/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation — 4-digit calendar year.
      const YEAR_RE = /^\d{4}$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }
      if (toRaw !== null && !YEAR_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "year:asc",
        "year:desc",
        "seasonCount:asc",
        "seasonCount:desc",
        "markupCount:asc",
        "markupCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Sub-brand narrowing — mirrors /pricing/by-month.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json({
          years: [],
          totalYears: 0,
          grandSeasonCount: 0,
          grandMarkupCount: 0,
          grandTotalCount: 0,
          limit: take,
          offset: skip,
        });
      }

      const seasonWhere = { tenantId: req.travelTenant.id };
      const ruleWhere = { tenantId: req.travelTenant.id };
      if (allowed instanceof Set) {
        const brandList = [...allowed];
        seasonWhere.subBrand = { in: brandList };
        ruleWhere.subBrand = { in: brandList };
      }

      const [seasons, rules] = await Promise.all([
        prisma.travelSeasonCalendar.findMany({
          where: seasonWhere,
          select: { createdAt: true },
        }),
        prisma.travelMarkupRule.findMany({
          where: ruleWhere,
          select: { createdAt: true },
        }),
      ]);

      // Aggregate per-UTC-year. Map "YYYY" → bucket. Null/invalid
      // createdAt → "unknown" bucket (kept unless ?from / ?to set).
      const byYear = new Map();

      function bucketFor(yearKey) {
        let b = byYear.get(yearKey);
        if (!b) {
          b = {
            year: yearKey,
            seasonCount: 0,
            markupCount: 0,
            totalCount: 0,
          };
          byYear.set(yearKey, b);
        }
        return b;
      }

      function yearKeyFor(createdAt) {
        if (!createdAt) return "unknown";
        const dt = createdAt instanceof Date ? createdAt : new Date(createdAt);
        if (Number.isNaN(dt.getTime())) return "unknown";
        return String(dt.getUTCFullYear());
      }

      for (const s of seasons) {
        const b = bucketFor(yearKeyFor(s.createdAt));
        b.seasonCount += 1;
        b.totalCount += 1;
      }
      for (const r of rules) {
        const b = bucketFor(yearKeyFor(r.createdAt));
        b.markupCount += 1;
        b.totalCount += 1;
      }

      let years = [...byYear.values()];

      // ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token).
      if (fromRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
      }
      if (toRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
      }

      // Sort. "year" sorts lexicographically on YYYY (chronological).
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      years.sort((a, b) => {
        if (field === "year") {
          if (a.year < b.year) return -1 * mult;
          if (a.year > b.year) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalYears = years.length;
      const grandSeasonCount = years.reduce(
        (acc, r) => acc + (Number(r.seasonCount) || 0),
        0,
      );
      const grandMarkupCount = years.reduce(
        (acc, r) => acc + (Number(r.markupCount) || 0),
        0,
      );
      const grandTotalCount = grandSeasonCount + grandMarkupCount;

      // Pagination AFTER aggregation + sort + filter.
      const paged = years.slice(skip, skip + take);

      res.json({
        years: paged,
        totalYears,
        grandSeasonCount,
        grandMarkupCount,
        grandTotalCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-pricing] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute annual rollup" });
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
