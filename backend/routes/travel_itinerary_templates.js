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
// caller-controlled). G049 — `acceptedCount`, `avgFinalPrice`, `lastUsedAt`
// are also engine-bumped (by routes/travel_itineraries.js on clone-from-
// template + on /accept), NEVER caller-controlled. They flow through GET
// responses automatically (no `select` clause on the list/detail handlers)
// so the ItineraryTemplates.jsx library grid can display them.
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

// ---------------------------------------------------------------------------
// Brand-kit-aware template defaults — S13 (#920 slice, PRD_TRAVEL_ITINERARY_
// UPGRADES.md "Brand-kit-aware itinerary template defaults from
// subBrandConfigJson").
//
// On POST, when the caller does NOT supply a `thumbnailUrl` or doesn't embed
// a `branding` block in `templateJson`, we read `tenant.subBrandConfigJson`
// (legacy admin-curated per-sub-brand kit) and seed deterministic defaults
// for the template's `subBrand` (or top-level / generic fall-through).
//
// Q22 (Yasin brand pack) is the content-blocker for the actual asset URLs +
// hex codes; until then `subBrandConfigJson` is typically empty/null in
// production, so this slice falls back to a hard-coded sensible-default
// palette per sub-brand. The point of wiring it now is that when Yasin's
// brand pack lands, an ADMIN PATCH of the tenant's subBrandConfigJson
// (single POST) cascades into every NEW template's defaults — no per-route
// edit needed.
//
// JSON shape consumed (one of):
//   { tmc:        { thumbnailUrl?, primaryColor?, accentColor?,
//                   headerColor?, fontFamily? },
//     rfu:        { ... }, travelstall: { ... }, visasure: { ... },
//     // optional top-level fallback used when template has no subBrand
//     thumbnailUrl?, primaryColor?, accentColor?, headerColor?, fontFamily?
//   }
//
// Output mapping (deterministic):
//   - thumbnailUrl  (top-level template field)         ← cfg.thumbnailUrl
//   - templateJson.branding.primaryColor               ← cfg.primaryColor
//   - templateJson.branding.accentColor                ← cfg.accentColor
//   - templateJson.branding.headerColor                ← cfg.headerColor
//   - templateJson.branding.fontFamily                 ← cfg.fontFamily
//   - templateJson.branding._source                    ← "subBrandConfig" |
//                                                       "fallback"
//
// Caller precedence (highest first):
//   1. Explicit body field (e.g. body.thumbnailUrl, body.templateJson.branding.*)
//   2. Per-sub-brand block in subBrandConfigJson[subBrand]
//   3. Top-level block in subBrandConfigJson (when template has no subBrand
//      OR sub-brand block is empty)
//   4. Hard-coded fallback per sub-brand (BRAND_KIT_FALLBACKS below)
//
// Branding fields are namespaced under templateJson.branding so the day-by-
// day item list (the original templateJson contract) is unaffected. Existing
// templates with no branding block continue to load correctly.
const BRAND_KIT_FIELDS = [
  "thumbnailUrl",
  "primaryColor",
  "accentColor",
  "headerColor",
  "fontFamily",
];

// Per-sub-brand fallback defaults — used when subBrandConfigJson is
// null/empty/missing. Colors are WCAG-AA on white. Fonts default to "Inter,
// sans-serif" (the same family Marketing Flyer Studio + main app use).
// thumbnailUrl fallback is null (operator picks one on save) — we don't ship
// a default image asset because Q22 hasn't landed.
const BRAND_KIT_FALLBACKS = {
  tmc:         { thumbnailUrl: null, primaryColor: "#1F4E79", accentColor: "#F2B544", headerColor: "#1F4E79", fontFamily: "Inter, sans-serif" },
  rfu:         { thumbnailUrl: null, primaryColor: "#0B5345", accentColor: "#D4AC0D", headerColor: "#0B5345", fontFamily: "Inter, sans-serif" },
  travelstall: { thumbnailUrl: null, primaryColor: "#C0392B", accentColor: "#F39C12", headerColor: "#922B21", fontFamily: "Inter, sans-serif" },
  visasure:    { thumbnailUrl: null, primaryColor: "#283747", accentColor: "#5DADE2", headerColor: "#283747", fontFamily: "Inter, sans-serif" },
  _generic:    { thumbnailUrl: null, primaryColor: "#1F4E79", accentColor: "#F2B544", headerColor: "#1F4E79", fontFamily: "Inter, sans-serif" },
};

function parseSubBrandConfig(jsonString) {
  if (!jsonString || typeof jsonString !== "string") return {};
  try {
    const obj = JSON.parse(jsonString);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj;
  } catch (_e) {
    // Malformed JSON → return empty so we fall through to hard-coded
    // fallback. Don't throw — a bad admin-saved blob shouldn't kill
    // template creation.
    return {};
  }
}

// Pick brand-kit fields for a given sub-brand from the parsed config blob.
// Sub-brand block first, then top-level fallback, then hard-coded
// per-sub-brand defaults. Returns { fields: {...}, source: "..." } where
// source ∈ {"subBrandConfig" | "fallback"} for downstream callers + tests
// that want to assert the resolution path.
function resolveBrandKitDefaults(cfg, subBrand) {
  const out = {};
  let usedConfig = false;
  const subBlock = subBrand && cfg && typeof cfg[subBrand] === "object" && !Array.isArray(cfg[subBrand])
    ? cfg[subBrand]
    : null;

  for (const f of BRAND_KIT_FIELDS) {
    if (subBlock && subBlock[f] !== undefined && subBlock[f] !== null && subBlock[f] !== "") {
      out[f] = subBlock[f];
      usedConfig = true;
    } else if (cfg && cfg[f] !== undefined && cfg[f] !== null && cfg[f] !== "") {
      out[f] = cfg[f];
      usedConfig = true;
    }
  }

  // Backfill missing fields from the hard-coded fallback so the returned
  // object is always shape-complete. Source remains "subBrandConfig" if at
  // least one field came from config; "fallback" only when ZERO fields came
  // from config.
  const fallbackKey = subBrand && BRAND_KIT_FALLBACKS[subBrand] ? subBrand : "_generic";
  const fallback = BRAND_KIT_FALLBACKS[fallbackKey];
  for (const f of BRAND_KIT_FIELDS) {
    if (out[f] === undefined) out[f] = fallback[f];
  }

  return { fields: out, source: usedConfig ? "subBrandConfig" : "fallback" };
}

// Apply brand-kit defaults onto the prisma-bound create-data object. Mutates
// `data` in place. Caller-supplied values win (precedence layer 1) — we only
// fill blanks. The templateJson column is String? @db.LongText, so the
// branding block is merged with any caller-supplied template payload then
// re-stringified before write.
function applyBrandKitDefaults(data, tenant, subBrand) {
  const cfg = parseSubBrandConfig(tenant && tenant.subBrandConfigJson);
  const { fields, source } = resolveBrandKitDefaults(cfg, subBrand);

  // thumbnailUrl: top-level template column. Only fill if caller didn't
  // supply one. null/undefined/empty-string from the caller all count as
  // "not supplied" — operator deferred to defaults.
  if (
    (data.thumbnailUrl === undefined || data.thumbnailUrl === null || data.thumbnailUrl === "")
    && fields.thumbnailUrl
  ) {
    data.thumbnailUrl = fields.thumbnailUrl;
  }

  // templateJson: parse caller-supplied JSON (or start fresh). Merge our
  // branding block in WITHOUT clobbering caller's day-by-day items[] or any
  // caller-supplied branding.* keys. Caller's templateJson.branding.* wins
  // per precedence layer 1.
  let existing = {};
  if (typeof data.templateJson === "string" && data.templateJson.trim() !== "") {
    try {
      const parsed = JSON.parse(data.templateJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch (_e) {
      // Caller's templateJson was non-JSON (e.g. plain text). Leave it alone
      // — don't risk corrupting their day-by-day payload. Skip branding
      // injection for this template.
      return;
    }
  } else if (data.templateJson && typeof data.templateJson === "object") {
    // Some callers pass an object directly (we re-stringify on write).
    existing = data.templateJson;
  }

  const callerBranding = (existing.branding && typeof existing.branding === "object")
    ? existing.branding
    : {};
  const mergedBranding = { ...fields, ...callerBranding };
  // Stamp the resolution source for observability. Caller can override.
  if (!callerBranding._source) mergedBranding._source = source;

  const merged = { ...existing, branding: mergedBranding };
  // Persist back as a string (templateJson is String? @db.LongText).
  data.templateJson = JSON.stringify(merged);
}
// ---------------------------------------------------------------------------

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

      // S13 — brand-kit-aware defaults from tenant.subBrandConfigJson.
      // Build the create-data dict FIRST so applyBrandKitDefaults can fill
      // any blanks (thumbnailUrl, templateJson.branding.*) before the
      // prisma.create call. requireTravelTenant projects only id/vertical/
      // name/slug onto req.travelTenant — refetch with subBrandConfigJson
      // here since it's the brand-kit input. Failure to fetch (e.g.
      // tenant deleted concurrently) is non-fatal — applyBrandKitDefaults
      // safely falls through to hard-coded fallbacks per BRAND_KIT_FALLBACKS.
      let brandKitTenant = req.travelTenant;
      try {
        const t = await prisma.tenant.findUnique({
          where: { id: req.travelTenant.id },
          select: { subBrandConfigJson: true },
        });
        if (t) brandKitTenant = { ...req.travelTenant, subBrandConfigJson: t.subBrandConfigJson };
      } catch (_e) {
        // Swallow — fallback path handles missing config.
      }

      const createData = {
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
      };
      applyBrandKitDefaults(createData, brandKitTenant, createData.subBrand);

      const created = await prisma.itineraryTemplate.create({ data: createData });
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

// GET /api/travel/itinerary-templates/stats — tenant-wide aggregate envelope.
// MUST be declared BEFORE GET /:id so Express doesn't try to parse "stats"
// as a numeric :id and 400.
//
// Envelope shape mirrors travel_sightseeing /stats (commit b0f702f5) but
// adapted to ItineraryTemplate (no status enum → group by category +
// isActive instead; adds averageDurationDays, averageBasePriceMinor,
// averageDefaultMarkupPercent, totalUsageCount, topByUsage). Sub-brand
// narrowing per #976 fix — empty allow-set yields a zeroed envelope,
// NOT 403.
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
      averageDurationDays: null,
      averageBasePriceMinor: null,
      averageDefaultMarkupPercent: null,
      totalUsageCount: 0,
      topDestinations: [],
      topByUsage: [],
      lastUpdatedAt: null,
    };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. ItineraryTemplate.subBrand is NULLABLE; tenant-wide rows
    // (subBrand=null) are visible to everyone, named-subBrand rows are
    // intersected with the caller's allowed set.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const items = await prisma.itineraryTemplate.findMany({
      where,
      select: {
        id: true,
        name: true,
        destinationName: true,
        subBrand: true,
        category: true,
        isActive: true,
        durationDays: true,
        basePriceMinor: true,
        defaultMarkupPercent: true,
        usageCount: true,
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
    let durationSum = 0;
    let durationCount = 0;
    let basePriceSum = 0;
    let basePriceCount = 0;
    let markupSum = 0;
    let markupCount = 0;
    let totalUsageCount = 0;
    let lastUpdatedAt = null;

    for (const it of items) {
      if (it.isActive) activeCount += 1;
      else inactiveCount += 1;

      const catKey = it.category ? String(it.category) : "_uncategorized";
      if (!byCategory[catKey]) byCategory[catKey] = 0;
      byCategory[catKey] += 1;

      // bySubBrand: coalesce null → "_tenant" matching sightseeing /stats
      // convention.
      const sbKey = it.subBrand ? String(it.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
      bySubBrand[sbKey].count += 1;

      const destKey = it.destinationName ? String(it.destinationName) : "_unknown";
      if (!byDestination[destKey]) byDestination[destKey] = 0;
      byDestination[destKey] += 1;

      const dur = Number(it.durationDays);
      if (Number.isFinite(dur)) {
        durationSum += dur;
        durationCount += 1;
      }

      const price = Number(it.basePriceMinor);
      if (Number.isFinite(price)) {
        basePriceSum += price;
        basePriceCount += 1;
      }

      const markup = Number(it.defaultMarkupPercent);
      if (Number.isFinite(markup)) {
        markupSum += markup;
        markupCount += 1;
      }

      const usage = Number(it.usageCount);
      if (Number.isFinite(usage)) totalUsageCount += usage;

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

    // Top 5 templates by usageCount, sorted desc.
    const topByUsage = items
      .map((it) => ({
        id: it.id,
        name: it.name,
        usageCount: Number.isFinite(Number(it.usageCount)) ? Number(it.usageCount) : 0,
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 5);

    const averageDurationDays = durationCount > 0
      ? round2(durationSum / durationCount)
      : null;
    const averageBasePriceMinor = basePriceCount > 0
      ? round2(basePriceSum / basePriceCount)
      : null;
    const averageDefaultMarkupPercent = markupCount > 0
      ? round2(markupSum / markupCount)
      : null;

    res.json({
      total: items.length,
      activeCount,
      inactiveCount,
      byCategory,
      bySubBrand,
      averageDurationDays,
      averageBasePriceMinor,
      averageDefaultMarkupPercent,
      totalUsageCount,
      topDestinations,
      topByUsage,
      lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/itinerary-templates] Stats error:", err.message);
    res.status(500).json({
      error: "Failed to fetch itinerary template stats",
      code: "ITINERARY_TEMPLATE_STATS_FAILED",
    });
  }
});

// GET /api/travel/itinerary-templates/by-year — annual rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-year" as
// a numeric :id and 400.
//
// Mirrors travel_sightseeing /by-year (commit 327c0693) but adapted to
// ItineraryTemplate — adds usageCount accumulation per YYYY bucket so
// callers see template-usage drift over calendar years. Sub-brand
// narrowing per #976 fix — empty allow-set yields all-zeros / empty (NOT
// 403). First of the eventual rollup triplet (by-month + by-quarter
// follow in later slices).
//
// Envelope shape:
//   {
//     years: [{ year: "YYYY", count, totalBasePriceValue, totalUsageCount }],
//     totalYears, grandCount, grandTotalValue, grandUsageCount,
//     limit, offset
//   }
//
// Query params:
//   - limit  (default 10, clamped to [1, 30])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY format, filters buckets to >= from)
//   - to     (YYYY format, filters buckets to <= to)
//   - orderBy (year:asc|year:desc|count:asc|count:desc|
//              totalBasePriceValue:asc|totalBasePriceValue:desc|
//              totalUsageCount:asc|totalUsageCount:desc)
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
      "totalBasePriceValue:asc",
      "totalBasePriceValue:desc",
      "totalUsageCount:asc",
      "totalUsageCount:desc",
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
      grandUsageCount: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. ItineraryTemplate.subBrand is NULLABLE; mirror /stats
    // handler posture (which scopes to where.subBrand = { in: [...] }
    // when the access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY.
    const items = await prisma.itineraryTemplate.findMany({
      where,
      select: {
        id: true,
        basePriceMinor: true,
        usageCount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-year. Map "YYYY" → { count, totalBasePriceValue,
    // totalUsageCount }. Rows with null/invalid createdAt go into
    // "unknown" so counts stay accurate. Null/invalid basePriceMinor +
    // usageCount contribute 0.
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
        row = {
          year: yearKey,
          count: 0,
          totalBasePriceValue: 0,
          totalUsageCount: 0,
        };
        byYear.set(yearKey, row);
      }

      row.count += 1;
      const price = Number(it.basePriceMinor);
      if (Number.isFinite(price)) row.totalBasePriceValue += price;
      const usage = Number(it.usageCount);
      if (Number.isFinite(usage)) row.totalUsageCount += usage;
    }

    let years = [...byYear.values()].map((r) => ({
      year: r.year,
      count: r.count,
      totalBasePriceValue: round2(r.totalBasePriceValue),
      totalUsageCount: r.totalUsageCount,
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
      years.reduce((acc, r) => acc + (Number(r.totalBasePriceValue) || 0), 0),
    );
    const grandUsageCount = years.reduce(
      (acc, r) => acc + (Number(r.totalUsageCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandCount,
      grandTotalValue,
      grandUsageCount,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/itinerary-templates] by-year error:", err.message);
    res.status(500).json({
      error: "Failed to compute annual rollup",
      code: "ITINERARY_TEMPLATE_BY_YEAR_FAILED",
    });
  }
});

// GET /api/travel/itinerary-templates/by-month — monthly rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-month" as
// a numeric :id and 400.
//
// Pairs with /by-year (commit f79c395b). Mirrors travel_sightseeing
// /by-month envelope shape (commit 9d406d55) but adapted to
// ItineraryTemplate — adds usageCount accumulation per YYYY-MM bucket so
// callers see template-usage drift over calendar months. Sub-brand
// narrowing per #976 fix — empty allow-set yields all-zeros / empty (NOT
// 403). Second of the eventual rollup triplet (by-quarter follows in a
// later slice).
//
// Envelope shape:
//   {
//     months: [{ month: "YYYY-MM", count, totalBasePriceValue, totalUsageCount }],
//     totalMonths, grandCount, grandTotalValue, grandUsageCount,
//     limit, offset
//   }
//
// Query params:
//   - limit  (default 12, clamped to [1, 60])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY-MM format, filters buckets to >= from)
//   - to     (YYYY-MM format, filters buckets to <= to)
//   - orderBy (month:asc|month:desc|count:asc|count:desc|
//              totalBasePriceValue:asc|totalBasePriceValue:desc|
//              totalUsageCount:asc|totalUsageCount:desc)
router.get("/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    // YYYY-MM validation — same regex travel_sightseeing /by-month uses.
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
      "totalBasePriceValue:asc",
      "totalBasePriceValue:desc",
      "totalUsageCount:asc",
      "totalUsageCount:desc",
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
      grandUsageCount: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. ItineraryTemplate.subBrand is NULLABLE; mirror /by-year
    // handler posture (which scopes to where.subBrand = { in: [...] }
    // when the access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-MM.
    const items = await prisma.itineraryTemplate.findMany({
      where,
      select: {
        id: true,
        basePriceMinor: true,
        usageCount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-month. Map "YYYY-MM" → { count, totalBasePriceValue,
    // totalUsageCount }. Rows with null/invalid createdAt go into "unknown"
    // so counts stay accurate. Null/invalid basePriceMinor + usageCount
    // contribute 0.
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
        row = {
          month: monthKey,
          count: 0,
          totalBasePriceValue: 0,
          totalUsageCount: 0,
        };
        byMonth.set(monthKey, row);
      }

      row.count += 1;
      const price = Number(it.basePriceMinor);
      if (Number.isFinite(price)) row.totalBasePriceValue += price;
      const usage = Number(it.usageCount);
      if (Number.isFinite(usage)) row.totalUsageCount += usage;
    }

    let months = [...byMonth.values()].map((r) => ({
      month: r.month,
      count: r.count,
      totalBasePriceValue: round2(r.totalBasePriceValue),
      totalUsageCount: r.totalUsageCount,
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
      months.reduce((acc, r) => acc + (Number(r.totalBasePriceValue) || 0), 0),
    );
    const grandUsageCount = months.reduce(
      (acc, r) => acc + (Number(r.totalUsageCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandCount,
      grandTotalValue,
      grandUsageCount,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/itinerary-templates] by-month error:", err.message);
    res.status(500).json({
      error: "Failed to compute monthly rollup",
      code: "ITINERARY_TEMPLATE_BY_MONTH_FAILED",
    });
  }
});

// GET /api/travel/itinerary-templates/by-quarter — quarterly rollup envelope.
// MUST be declared BEFORE GET /:id so Express doesn't parse "by-quarter" as
// a numeric :id and 400.
//
// Completes the itinerary-templates rollup triplet — /by-year (f79c395b) +
// /by-month (388380bd) + this /by-quarter. Mirrors travel_sightseeing
// /by-quarter envelope shape but adapted to ItineraryTemplate — adds
// usageCount accumulation per YYYY-Q[1-4] bucket so callers see
// template-usage drift over calendar quarters. Sub-brand narrowing per
// #976 fix — empty allow-set yields all-zeros / empty (NOT 403).
//
// Envelope shape:
//   {
//     quarters: [{ quarter: "YYYY-Q[1-4]", count, totalBasePriceValue, totalUsageCount }],
//     totalQuarters, grandCount, grandTotalValue, grandUsageCount,
//     limit, offset
//   }
//
// Query params:
//   - limit  (default 8, clamped to [1, 40])
//   - offset (default 0, applied AFTER aggregation/sort/filter)
//   - from   (YYYY-Q[1-4] format, filters buckets to >= from)
//   - to     (YYYY-Q[1-4] format, filters buckets to <= to)
//   - orderBy (quarter:asc|quarter:desc|count:asc|count:desc|
//              totalBasePriceValue:asc|totalBasePriceValue:desc|
//              totalUsageCount:asc|totalUsageCount:desc)
router.get("/by-quarter", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 8, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    // YYYY-Q[1-4] validation — bucket labels we emit follow this exact
    // shape. Only Q1..Q4 valid; Q0 and Q5+ rejected.
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
      "totalBasePriceValue:asc",
      "totalBasePriceValue:desc",
      "totalUsageCount:asc",
      "totalUsageCount:desc",
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
      grandUsageCount: 0,
      limit: take,
      offset: skip,
    };

    const where = { tenantId: req.travelTenant.id };

    // Sub-brand narrowing — empty access set → zeroed shape (#976 fix),
    // NOT 403. ItineraryTemplate.subBrand is NULLABLE; mirror /by-month
    // handler posture (which scopes to where.subBrand = { in: [...] }
    // when the access set is non-empty).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-Q[1-4].
    const items = await prisma.itineraryTemplate.findMany({
      where,
      select: {
        id: true,
        basePriceMinor: true,
        usageCount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-quarter. Map "YYYY-Q[1-4]" → { count,
    // totalBasePriceValue, totalUsageCount }. Rows with null/invalid
    // createdAt go into "unknown" so counts stay accurate. Null/invalid
    // basePriceMinor + usageCount contribute 0. Quarter derivation:
    // month 1-3 → Q1, 4-6 → Q2, 7-9 → Q3, 10-12 → Q4.
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
        row = {
          quarter: quarterKey,
          count: 0,
          totalBasePriceValue: 0,
          totalUsageCount: 0,
        };
        byQuarter.set(quarterKey, row);
      }

      row.count += 1;
      const price = Number(it.basePriceMinor);
      if (Number.isFinite(price)) row.totalBasePriceValue += price;
      const usage = Number(it.usageCount);
      if (Number.isFinite(usage)) row.totalUsageCount += usage;
    }

    let quarters = [...byQuarter.values()].map((r) => ({
      quarter: r.quarter,
      count: r.count,
      totalBasePriceValue: round2(r.totalBasePriceValue),
      totalUsageCount: r.totalUsageCount,
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
      quarters.reduce((acc, r) => acc + (Number(r.totalBasePriceValue) || 0), 0),
    );
    const grandUsageCount = quarters.reduce(
      (acc, r) => acc + (Number(r.totalUsageCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandCount,
      grandTotalValue,
      grandUsageCount,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("[travel/itinerary-templates] by-quarter error:", err.message);
    res.status(500).json({
      error: "Failed to compute quarterly rollup",
      code: "ITINERARY_TEMPLATE_BY_QUARTER_FAILED",
    });
  }
});

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
