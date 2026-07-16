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
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
} = require("../middleware/travelGuards");

const VALID_CATEGORIES = ["hotel", "flight", "transport", "visa", "insurance"];

// ============================================================================
// Hotel preference attributes (PRD §4.3 RFU preference filters — gap A7).
//
// Canonical vocabulary for the structured attributes stored in
// TravelCostMaster.attributesJson (String? @db.Text, JSON-stringified at the
// call site per lib/sanitizeJson.js conventions):
//   - view:         haram_facing | kaaba_facing | city_view | standard
//   - floorLevel:   low | mid | high
//   - roomCategory: free string (e.g. "Deluxe", "Suite")
//
// The structured `attributes` body field is the supported write path; the
// legacy raw `attributesJson` string passthrough is kept for the CSV
// import/export round-trip (travel_csv_io.js) and pre-existing rows.
// ============================================================================
const HOTEL_ATTRIBUTES = Object.freeze({
  view: Object.freeze(["haram_facing", "kaaba_facing", "city_view", "standard"]),
  floorLevel: Object.freeze(["low", "mid", "high"]),
});

function attributesError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = "INVALID_ATTRIBUTES";
  return err;
}

// Validates + normalises a structured `attributes` body object against the
// canonical vocabulary. Unknown view/floorLevel values → 400
// INVALID_ATTRIBUTES. Unknown keys are dropped so the stored shape stays
// canonical (view/floorLevel/roomCategory only). Returns the normalised
// object, or null when nothing usable was provided.
function assertValidAttributes(attrs) {
  if (attrs == null) return null;
  if (typeof attrs !== "object" || Array.isArray(attrs)) {
    throw attributesError("attributes must be an object");
  }
  const out = {};
  if (attrs.view != null && attrs.view !== "") {
    const v = String(attrs.view);
    if (!HOTEL_ATTRIBUTES.view.includes(v)) {
      throw attributesError(`attributes.view must be one of: ${HOTEL_ATTRIBUTES.view.join(", ")}`);
    }
    out.view = v;
  }
  if (attrs.floorLevel != null && attrs.floorLevel !== "") {
    const f = String(attrs.floorLevel);
    if (!HOTEL_ATTRIBUTES.floorLevel.includes(f)) {
      throw attributesError(`attributes.floorLevel must be one of: ${HOTEL_ATTRIBUTES.floorLevel.join(", ")}`);
    }
    out.floorLevel = f;
  }
  if (attrs.roomCategory != null && attrs.roomCategory !== "") {
    if (typeof attrs.roomCategory !== "string") {
      throw attributesError("attributes.roomCategory must be a string");
    }
    const rc = attrs.roomCategory.trim();
    if (rc) out.roomCategory = rc;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Defensive parse of the stored attributesJson column → plain object or null
// (null on garbage / non-object JSON, never throws).
function parseAttributes(attributesJson) {
  if (!attributesJson) return null;
  try {
    const parsed = JSON.parse(attributesJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (_e) {
    return null;
  }
}

// Response decorator — every read surface echoes the parsed `attributes`
// object alongside the raw attributesJson column.
function withAttributes(row) {
  return { ...row, attributes: parseAttributes(row.attributesJson) };
}

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

    // Hotel preference filters (PRD §4.3 — gap A7): ?view= / ?floorLevel= /
    // ?roomCategory=. view + floorLevel are validated against the canonical
    // vocabulary (400 INVALID_ATTRIBUTES on unknown values); roomCategory is
    // a case-insensitive substring match on the stored free string.
    const viewFilter = req.query.view ? String(req.query.view) : null;
    const floorFilter = req.query.floorLevel ? String(req.query.floorLevel) : null;
    const roomCategoryFilter = req.query.roomCategory ? String(req.query.roomCategory) : null;
    if (viewFilter && !HOTEL_ATTRIBUTES.view.includes(viewFilter)) {
      throw attributesError(`view must be one of: ${HOTEL_ATTRIBUTES.view.join(", ")}`);
    }
    if (floorFilter && !HOTEL_ATTRIBUTES.floorLevel.includes(floorFilter)) {
      throw attributesError(`floorLevel must be one of: ${HOTEL_ATTRIBUTES.floorLevel.join(", ")}`);
    }
    const hasAttrFilter = !!(viewFilter || floorFilter || roomCategoryFilter);

    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    if (hasAttrFilter) {
      // Attribute filters live inside the attributesJson text column, so a
      // SQL where can't apply them reliably (JSON LIKE is key-order/whitespace
      // fragile). Honest approach at current rate-book sizes (hundreds of
      // rows/tenant): fetch the tenant-scoped where, post-filter in JS, then
      // paginate AFTER filtering — same discipline as /cost-master/by-month's
      // JS-side aggregation. Revisit with a native Json column if the rate
      // book grows past ~10k rows/tenant.
      const all = await prisma.travelCostMaster.findMany({
        where,
        orderBy: [{ category: "asc" }, { routeOrSku: "asc" }],
      });
      const matched = all.filter((r) => {
        const attrs = parseAttributes(r.attributesJson);
        if (!attrs) return false;
        if (viewFilter && attrs.view !== viewFilter) return false;
        if (floorFilter && attrs.floorLevel !== floorFilter) return false;
        if (roomCategoryFilter) {
          const rc = typeof attrs.roomCategory === "string" ? attrs.roomCategory : "";
          if (!rc.toLowerCase().includes(roomCategoryFilter.toLowerCase())) return false;
        }
        return true;
      });
      const paged = matched.slice(skip, skip + take).map(withAttributes);
      return res.json({ rates: paged, total: matched.length, limit: take, offset: skip });
    }

    const [rates, total] = await Promise.all([
      prisma.travelCostMaster.findMany({
        where,
        orderBy: [{ category: "asc" }, { routeOrSku: "asc" }],
        take,
        skip,
      }),
      prisma.travelCostMaster.count({ where }),
    ]);
    res.json({ rates: rates.map(withAttributes), total, limit: take, offset: skip });
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
  requireTravelTenant,
  requirePermission("cost_master", "write"),
  async (req, res) => {
    try {
      const {
        subBrand, category, routeOrSku, baseRate,
        supplierId, attributesJson, attributes, currency,
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

      // Structured `attributes` (view/floorLevel/roomCategory) wins over the
      // legacy raw attributesJson passthrough when both are present. The
      // column is String? @db.Text, so the object is sanitized + stringified
      // at the call site (lib/sanitizeJson.js conventions).
      const normalizedAttrs = assertValidAttributes(attributes);
      const storedAttributesJson = normalizedAttrs
        ? sanitizeJsonForStringColumn(normalizedAttrs)
        : (attributesJson ? String(attributesJson) : null);

      const created = await prisma.travelCostMaster.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand,
          category,
          routeOrSku: String(routeOrSku),
          baseRate: rate,
          supplierId: supplierId ? parseInt(supplierId, 10) : null,
          attributesJson: storedAttributesJson,
          currency: currency || "INR",
          seasonId: seasonId ? parseInt(seasonId, 10) : null,
          validFrom: validFrom ? new Date(validFrom) : null,
          validTo: validTo ? new Date(validTo) : null,
          isActive: isActive !== false,
        },
      });
      res.status(201).json(withAttributes(created));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-cost] create error:", e.message);
      res.status(500).json({ error: "Failed to create cost-master row" });
    }
  },
);

// ============================================================================
// GET /api/travel/cost-master/stats — tenant-wide cost-library rollup
// (PRD_TRAVEL cost-master — first analytical surface for the admin-curated
// supplier rate book).
//
// Mirrors /suppliers/stats + /commission-profiles/stats + /religious-packets
// /stats posture. USER-readable anodyne aggregate. Extends what
// TravelDashboard already shows (costMaster.activeRows + costMaster
// .bySubBrand) by adding total + bySupplier + lastCreatedAt so the operator
// dashboard can fire one request instead of four.
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' rows in the counts. Same gate as the
//     /cost-master list endpoint (narrowWhereBySubBrand). TravelCostMaster
//     .subBrand is NON-nullable in the schema, but the bucketing code
//     defensively coalesces falsy → '_tenant' for forward-compat.
//   - ?from / ?to (ISO date bounds) filter createdAt before aggregation;
//     invalid → 400 INVALID_DATE.
//   - Response envelope:
//       total         — count of all matching rows
//       active        — count where isActive=true
//       bySubBrand    — { <sb|_tenant>: <count> }
//       bySupplier    — { <supplierId>: <count> } (rows with null supplierId omitted)
//       lastCreatedAt — ISO of most-recent createdAt, null when empty
//
// USER-readable: anodyne aggregate (counts + timestamps); safe.
// No audit row: read-only meta surface, mirrors /suppliers/stats.
//
// Express route ordering: literal-path /cost-master/stats MUST be declared
// BEFORE the /cost-master/:id family or `:id="stats"` would 400 INVALID_ID
// before reaching this handler.
// ============================================================================
router.get("/cost-master/stats", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const tenantId = req.travelTenant.id;
    const where = { tenantId };

    // Optional ISO date bounds on createdAt — invalid → 400 INVALID_DATE.
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

    // Sub-brand narrowing — same gate as the list endpoint.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const rows = await prisma.travelCostMaster.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        supplierId: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) {
      return res.json({
        total: 0,
        active: 0,
        bySubBrand: {},
        bySupplier: {},
        lastCreatedAt: null,
      });
    }

    let active = 0;
    let lastCreatedAt = null;
    const bySubBrand = {};
    const bySupplier = {};

    for (const r of rows) {
      if (r.isActive) active += 1;

      // Defensive: null/invalid createdAt rows still counted in total but
      // skipped for the lastCreatedAt max calculation.
      if (r.createdAt) {
        const ts = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastCreatedAt || ts > lastCreatedAt) lastCreatedAt = ts;
        }
      }

      // Coalesce falsy subBrand → '_tenant' bucket.
      const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
      bySubBrand[sbKey] = (bySubBrand[sbKey] || 0) + 1;

      // bySupplier — only count rows with a non-null supplierId.
      if (r.supplierId != null) {
        const supKey = String(r.supplierId);
        bySupplier[supKey] = (bySupplier[supKey] || 0) + 1;
      }
    }

    res.json({
      total: rows.length,
      active,
      bySubBrand,
      bySupplier,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-cost] stats error:", e.message);
    res.status(500).json({ error: "Failed to summarise cost-master" });
  }
});

// ============================================================================
// GET /api/travel/cost-master/by-month — tenant-wide cost-library monthly rollup
// (PRD_TRAVEL cost-master — sibling to /cost-master/stats slice).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket for the
// tenant-scoped (and sub-brand-narrowed) TravelCostMaster population. Each
// row carries count + per-bucket bySubBrand breakdown so the operator dashboard
// can render a "cost-library rows added over time" trend chart without N
// round-trips per month.
//
// Mirrors /suppliers/by-month + /diagnostics/by-month family — same UTC
// YYYY-MM bucketing template, same defensive math (null/invalid createdAt →
// "unknown" bucket; excluded when ?from / ?to is set), same orderBy
// semantics. Distinct from /cost-master/stats: /stats is a single
// point-in-time KPI tile (total / active / bySubBrand / bySupplier /
// lastCreatedAt); /by-month is the per-month time series across the same
// population.
//
// Sub-brand restriction: MATCHES /cost-master/stats EXACTLY via
// narrowWhereBySubBrand(where, allowed) — subBrand: { in: [...allowed] }.
// TravelCostMaster.subBrand is NON-nullable in the schema, but bucketing
// code defensively coalesces falsy → '_tenant' for forward-compat.
//
// Query params:
//   - ?from / ?to       — optional inclusive YYYY-MM bounds; invalid →
//                         400 INVALID_MONTH_FORMAT
//   - ?orderBy          — default month:asc; accepts month:{asc|desc},
//                         count:{asc|desc}; unknown tokens degrade
//                         silently to the default
//   - ?limit / ?offset  — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - JS-side aggregation over a light findMany projection
//     ({ subBrand, createdAt }) — tenant-bounded population.
//   - "unknown" bucket for rows with null/invalid createdAt; excluded
//     when ?from / ?to is set, included otherwise.
//   - Per-bucket bySubBrand: falsy subBrand → "_tenant".
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches /cost-master/stats.
//
// Express route ordering: literal-path /cost-master/by-month MUST be declared
// BEFORE the /cost-master/:id family or `:id="by-month"` would 400 INVALID_ID
// before reaching this handler. Same convention as /cost-master/stats.
// ============================================================================
router.get("/cost-master/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    // YYYY-MM validation.
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

    // Sub-brand narrowing — mirrors /cost-master/stats exactly.
    const where = { tenantId: req.travelTenant.id };
    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    // Light projection — subBrand + createdAt is enough for bucket totals
    // and per-bucket sub-brand breakdown.
    const rows = await prisma.travelCostMaster.findMany({
      where,
      select: { subBrand: true, createdAt: true },
    });

    // Aggregate per-UTC-month. Map "YYYY-MM" → { month, count, bySubBrand }.
    // Null/invalid createdAt rows land in "unknown".
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
        bucket = { month: monthKey, count: 0, bySubBrand: {} };
        byMonth.set(monthKey, bucket);
      }
      bucket.count += 1;

      // Per-bucket bySubBrand — falsy coerces to "_tenant".
      const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
      bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;
    }

    let months = [...byMonth.values()];

    // Apply ?from / ?to bucket filter. "unknown" excluded when either
    // bound is set (no comparable token); kept otherwise so count surface
    // remains complete.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" lexicographic on YYYY-MM is also chronological.
    // "unknown" sorts last in asc / first in desc (lex > "9999-12").
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

    const total = months.length;

    // Pagination AFTER aggregation + sort + filter.
    const paged = months.slice(skip, skip + take);

    res.json({
      total,
      rows: paged,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-cost] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// GET /api/travel/cost-master/suggest-from-itineraries
// Returns distinct (subBrand, itemType→category, description→routeOrSku, avg unitCost)
// from ItineraryItem rows so the operator can promote real itinerary line-items
// into the rate book without manual re-entry. Excludes items whose
// (subBrand, category, description) triple already exists in TravelCostMaster.
// Must be declared BEFORE /cost-master/:id or "suggest-from-itineraries"
// would be treated as the :id param.
router.get("/cost-master/suggest-from-itineraries", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const tenantId = req.travelTenant.id;
    const ITEM_TYPE_TO_CATEGORY = {
      flight: "flight", hotel: "hotel", transfer: "transport",
      transport: "transport", visa: "visa", insurance: "insurance",
      activity: "transport", // closest bucket for non-flight/hotel activity costs
    };

    // Fetch distinct itinerary items with a unitCost across this tenant's itineraries.
    const items = await prisma.itineraryItem.findMany({
      where: {
        unitCost: { not: null },
        itinerary: { tenantId },
      },
      select: {
        itemType: true,
        description: true,
        unitCost: true,
        itinerary: { select: { subBrand: true, currency: true } },
      },
    });

    // Fetch existing cost-master routeOrSku keys to exclude duplicates.
    const existing = await prisma.travelCostMaster.findMany({
      where: { tenantId },
      select: { subBrand: true, category: true, routeOrSku: true },
    });
    const existingSet = new Set(
      existing.map((r) => `${r.subBrand}|${r.category}|${r.routeOrSku}`),
    );

    // Aggregate: group by (subBrand, category, description), average the unitCost.
    const map = new Map();
    for (const item of items) {
      const subBrand = item.itinerary?.subBrand;
      if (!subBrand) continue;
      const category = ITEM_TYPE_TO_CATEGORY[item.itemType] || "transport";
      const routeOrSku = (item.description || "").trim();
      if (!routeOrSku) continue;
      const key = `${subBrand}|${category}|${routeOrSku}`;
      if (existingSet.has(key)) continue; // already in rate book
      if (!map.has(key)) {
        map.set(key, {
          subBrand,
          category,
          routeOrSku,
          currency: item.itinerary?.currency || "INR",
          costs: [],
        });
      }
      map.get(key).costs.push(Number(item.unitCost));
    }

    const suggestions = Array.from(map.values()).map((s) => ({
      subBrand: s.subBrand,
      category: s.category,
      routeOrSku: s.routeOrSku,
      currency: s.currency,
      avgUnitCost: Math.round(s.costs.reduce((a, b) => a + b, 0) / s.costs.length),
      occurrences: s.costs.length,
    }));

    // Sort: most-used first, then alphabetical.
    suggestions.sort((a, b) => b.occurrences - a.occurrences || a.routeOrSku.localeCompare(b.routeOrSku));

    res.json({ suggestions, total: suggestions.length });
  } catch (e) {
    console.error("[travel-cost] suggest error:", e.message);
    res.status(500).json({ error: "Failed to load suggestions" });
  }
});

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
    res.json(withAttributes(row));
  } catch (e) {
    console.error("[travel-cost] get error:", e.message);
    res.status(500).json({ error: "Failed to get rate" });
  }
});

// PATCH /api/travel/cost-master/:id — ADMIN+MANAGER
router.patch(
  "/cost-master/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("cost_master", "update"),
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
      if (body.attributes !== undefined) {
        // Structured attributes win over raw attributesJson when both sent.
        // attributes:null clears the column.
        const normalizedAttrs = assertValidAttributes(body.attributes);
        data.attributesJson = normalizedAttrs ? sanitizeJsonForStringColumn(normalizedAttrs) : null;
      }
      if (body.currency !== undefined) data.currency = body.currency || "INR";
      if (body.seasonId !== undefined) data.seasonId = body.seasonId ? parseInt(body.seasonId, 10) : null;
      if (body.validFrom !== undefined) data.validFrom = body.validFrom ? new Date(body.validFrom) : null;
      if (body.validTo !== undefined) data.validTo = body.validTo ? new Date(body.validTo) : null;
      if (body.isActive !== undefined) data.isActive = !!body.isActive;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelCostMaster.update({ where: { id }, data });
      res.json(withAttributes(updated));
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
  requireTravelTenant,
  requirePermission("cost_master", "delete"),
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
// Canonical hotel-preference vocabulary (PRD §4.3 gap A7) — exported so the
// quote/search layers + tests share one source of truth.
module.exports.HOTEL_ATTRIBUTES = HOTEL_ATTRIBUTES;
module.exports.parseAttributes = parseAttributes;
