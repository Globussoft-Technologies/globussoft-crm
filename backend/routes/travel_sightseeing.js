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
const { requirePermission } = require("../middleware/requirePermission");
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
  requirePermission("sightseeing", "write"),
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

// GET /api/travel/sightseeing/by-year — annual rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-year" as
// a numeric :id and 400.
//
// Mirrors travel_invoices /invoices/by-year (commit 57bf25ea) but adapted
// to TravelSightseeing (no status enum → simpler envelope with just count
// + totalPriceReferenceValue per YYYY bucket). Sub-brand narrowing per
// #976 fix — empty allow-set yields all-zeros / empty (NOT 403). First of
// the eventual rollup triplet (by-month + by-quarter follow in later
// slices).
//
// Envelope shape:
//   {
//     years: [{ year: "YYYY", count, totalPriceReferenceValue }],
//     totalYears, grandCount, grandTotalValue, limit, offset
//   }
//
// Query params:
//   - limit  (default 10, clamped to [1, 30])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY format, filters buckets to >= from)
//   - to     (YYYY format, filters buckets to <= to)
//   - orderBy (year:asc|year:desc|count:asc|count:desc|
//              totalPriceReferenceValue:asc|totalPriceReferenceValue:desc)
router.get("/by-year", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

    // YYYY validation — bucket labels we emit follow this exact shape so
    // callers passing year-tokens to from/to should already be using it.
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
      "count:asc",
      "count:desc",
      "totalPriceReferenceValue:asc",
      "totalPriceReferenceValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

    // Canonical zeroed envelope — returned when caller has no sub-brand
    // access. Single source of truth so empty-set + empty-result paths
    // can't drift.
    const zeroed = {
      years: [],
      totalYears: 0,
      grandCount: 0,
      grandTotalValue: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. Sightseeing.subBrand is NULLABLE; mirror /stats handler
    // posture (which scopes to where.subBrand = { in: [...] } when the
    // access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY.
    const items = await prisma.travelSightseeing.findMany({
      where,
      select: {
        id: true,
        priceReferenceMinor: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-year. Map "YYYY" → { count, totalPriceReferenceValue }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid priceReferenceMinor contributes 0.
    const byYear = new Map();
    for (const it of items) {
      let yearKey = "unknown";
      if (it.createdAt) {
        const dt = new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }

      let row = byYear.get(yearKey);
      if (!row) {
        row = { year: yearKey, count: 0, totalPriceReferenceValue: 0 };
        byYear.set(yearKey, row);
      }

      row.count += 1;
      const price = Number(it.priceReferenceMinor);
      if (Number.isFinite(price)) row.totalPriceReferenceValue += price;
    }

    let years = [...byYear.values()].map((r) => ({
      year: r.year,
      count: r.count,
      totalPriceReferenceValue: round2(r.totalPriceReferenceValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set; when no bounds are set, "unknown" stays so the
    // count surface remains complete.
    if (fromRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
    }
    if (toRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
    }

    // Sort. "year" sorts lexicographically on YYYY which is also
    // chronological (4-digit zero-padded years sort correctly as ASCII).
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
    const grandCount = years.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      years.reduce((acc, r) => acc + (Number(r.totalPriceReferenceValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandCount,
      grandTotalValue,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/sightseeing] by-year error:", err.message);
    res.status(500).json({
      error: "Failed to compute annual rollup",
      code: "SIGHTSEEING_BY_YEAR_FAILED",
    });
  }
});

// GET /api/travel/sightseeing/by-month — monthly rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-month" as
// a numeric :id and 400.
//
// Pairs with /by-year (commit 327c0693). Mirrors travel_invoices
// /invoices/by-month envelope shape (commit 5c96a28e) but adapted to
// TravelSightseeing — no status enum → simpler envelope with just count +
// totalPriceReferenceValue per YYYY-MM bucket. Sub-brand narrowing per
// #976 fix — empty allow-set yields all-zeros / empty (NOT 403). Second of
// the eventual rollup triplet (by-quarter follows in a later slice).
//
// Envelope shape:
//   {
//     months: [{ month: "YYYY-MM", count, totalPriceReferenceValue }],
//     totalMonths, grandCount, grandTotalValue, limit, offset
//   }
//
// Query params:
//   - limit  (default 12, clamped to [1, 60])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY-MM format, filters buckets to >= from)
//   - to     (YYYY-MM format, filters buckets to <= to)
//   - orderBy (month:asc|month:desc|count:asc|count:desc|
//              totalPriceReferenceValue:asc|totalPriceReferenceValue:desc)
router.get("/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    // YYYY-MM validation — same regex travel_invoices /by-month uses.
    // Bucket labels we emit follow this exact shape so callers passing
    // month-tokens to from/to should already be using it.
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
      "totalPriceReferenceValue:asc",
      "totalPriceReferenceValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    // Canonical zeroed envelope — returned when caller has no sub-brand
    // access. Single source of truth so empty-set + empty-result paths
    // can't drift.
    const zeroed = {
      months: [],
      totalMonths: 0,
      grandCount: 0,
      grandTotalValue: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. Sightseeing.subBrand is NULLABLE; mirror /by-year handler
    // posture (which scopes to where.subBrand = { in: [...] } when the
    // access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-MM.
    const items = await prisma.travelSightseeing.findMany({
      where,
      select: {
        id: true,
        priceReferenceMinor: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-month. Map "YYYY-MM" → { count, totalPriceReferenceValue }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid priceReferenceMinor contributes 0.
    const byMonth = new Map();
    for (const it of items) {
      let monthKey = "unknown";
      if (it.createdAt) {
        const dt = new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
          monthKey = `${yyyy}-${mm}`;
        }
      }

      let row = byMonth.get(monthKey);
      if (!row) {
        row = { month: monthKey, count: 0, totalPriceReferenceValue: 0 };
        byMonth.set(monthKey, row);
      }

      row.count += 1;
      const price = Number(it.priceReferenceMinor);
      if (Number.isFinite(price)) row.totalPriceReferenceValue += price;
    }

    let months = [...byMonth.values()].map((r) => ({
      month: r.month,
      count: r.count,
      totalPriceReferenceValue: round2(r.totalPriceReferenceValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set; when no bounds are set, "unknown" stays so the
    // count surface remains complete.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM which is also
    // chronological.
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
    const grandCount = months.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      months.reduce((acc, r) => acc + (Number(r.totalPriceReferenceValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandCount,
      grandTotalValue,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/sightseeing] by-month error:", err.message);
    res.status(500).json({
      error: "Failed to compute monthly rollup",
      code: "SIGHTSEEING_BY_MONTH_FAILED",
    });
  }
});

// GET /api/travel/sightseeing/by-quarter — quarterly rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-quarter"
// as a numeric :id and 400.
//
// Completes the sightseeing rollup triplet — /by-year (327c0693) +
// /by-month (9d406d55) + this /by-quarter. Mirrors travel_invoices
// /invoices/by-quarter envelope shape but adapted to TravelSightseeing —
// no status enum → simpler envelope with just count + totalPriceReferenceValue
// per YYYY-Q[1-4] bucket. Sub-brand narrowing per #976 fix — empty
// allow-set yields all-zeros / empty (NOT 403).
//
// Envelope shape:
//   {
//     quarters: [{ quarter: "YYYY-Q[1-4]", count, totalPriceReferenceValue }],
//     totalQuarters, grandCount, grandTotalValue, limit, offset
//   }
//
// Query params:
//   - limit  (default 8, clamped to [1, 40])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY-Q[1-4] format, filters buckets to >= from)
//   - to     (YYYY-Q[1-4] format, filters buckets to <= to)
//   - orderBy (quarter:asc|quarter:desc|count:asc|count:desc|
//              totalPriceReferenceValue:asc|totalPriceReferenceValue:desc)
router.get("/by-quarter", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 8, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    // YYYY-Q[1-4] validation — bucket labels we emit follow this exact
    // shape. Only Q1..Q4 valid.
    const QUARTER_RE = /^\d{4}-Q[1-4]$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-Q[1-4] format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }
    if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-Q[1-4] format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "quarter:asc",
      "quarter:desc",
      "count:asc",
      "count:desc",
      "totalPriceReferenceValue:asc",
      "totalPriceReferenceValue:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    // Canonical zeroed envelope — returned when caller has no sub-brand
    // access. Single source of truth so empty-set + empty-result paths
    // can't drift.
    const zeroed = {
      quarters: [],
      totalQuarters: 0,
      grandCount: 0,
      grandTotalValue: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. Sightseeing.subBrand is NULLABLE; mirror /by-month handler
    // posture (which scopes to where.subBrand = { in: [...] } when the
    // access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-Q[1-4].
    const items = await prisma.travelSightseeing.findMany({
      where,
      select: {
        id: true,
        priceReferenceMinor: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-quarter. Map "YYYY-Q[1-4]" → { count, totalPriceReferenceValue }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate. Null/invalid priceReferenceMinor contributes 0.
    // Quarter derivation: month 1-3 → Q1, 4-6 → Q2, 7-9 → Q3, 10-12 → Q4.
    const byQuarter = new Map();
    for (const it of items) {
      let quarterKey = "unknown";
      if (it.createdAt) {
        const dt = new Date(it.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const month = dt.getUTCMonth() + 1; // 1..12
          const q = Math.floor((month - 1) / 3) + 1; // 1..4
          quarterKey = `${yyyy}-Q${q}`;
        }
      }

      let row = byQuarter.get(quarterKey);
      if (!row) {
        row = { quarter: quarterKey, count: 0, totalPriceReferenceValue: 0 };
        byQuarter.set(quarterKey, row);
      }

      row.count += 1;
      const price = Number(it.priceReferenceMinor);
      if (Number.isFinite(price)) row.totalPriceReferenceValue += price;
    }

    let quarters = [...byQuarter.values()].map((r) => ({
      quarter: r.quarter,
      count: r.count,
      totalPriceReferenceValue: round2(r.totalPriceReferenceValue),
    }));

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set; when no bounds are set, "unknown" stays so the
    // count surface remains complete.
    if (fromRaw !== null) {
      quarters = quarters.filter(
        (r) => r.quarter !== "unknown" && r.quarter >= fromRaw,
      );
    }
    if (toRaw !== null) {
      quarters = quarters.filter(
        (r) => r.quarter !== "unknown" && r.quarter <= toRaw,
      );
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Q[1-4] which is also
    // chronological (4-digit year + Q1..Q4 token sort correctly as ASCII).
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    quarters.sort((a, b) => {
      if (field === "quarter") {
        if (a.quarter < b.quarter) return -1 * mult;
        if (a.quarter > b.quarter) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalQuarters = quarters.length;
    const grandCount = quarters.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandTotalValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.totalPriceReferenceValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandCount,
      grandTotalValue,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/sightseeing] by-quarter error:", err.message);
    res.status(500).json({
      error: "Failed to compute quarterly rollup",
      code: "SIGHTSEEING_BY_QUARTER_FAILED",
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
  requirePermission("sightseeing", "update"),
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
  requirePermission("sightseeing", "delete"),
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
