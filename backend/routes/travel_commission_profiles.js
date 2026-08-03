/**
 * /api/travel/commission-profiles â€” TravelCommissionProfile CRUD
 * (PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 2).
 *
 * Sibling to /api/travel/quotes + /api/travel/suppliers. Stores named
 * commission profiles consumed by lib/agentCommissionCalculator.js
 * (slice 1, commit cb284098). Each row is one operator-facing pricing
 * shape â€” flat_percent | tiered | per_pax_flat | hybrid â€” stored as a
 * JSON String column so future calculator extensions don't require
 * schema migrations.
 *
 * Endpoints:
 *   GET    /api/travel/commission-profiles                â€” list (tenant + sub-brand scoped)
 *   GET    /api/travel/commission-profiles/stats          â€” USER+ tenant-wide rollup (slice 18)
 *   GET    /api/travel/commission-profiles/by-month       â€” tenant-wide monthly rollup (slice 19)
 *   GET    /api/travel/commission-profiles/by-quarter     â€” tenant-wide quarterly rollup (slice 20)
 *   GET    /api/travel/commission-profiles/by-year        â€” tenant-wide annual rollup (slice 21)
 *   GET    /api/travel/commission-profiles/:id            â€” fetch one
 *   POST   /api/travel/commission-profiles                â€” ADMIN/MANAGER create
 *   PUT    /api/travel/commission-profiles/:id            â€” ADMIN/MANAGER partial update
 *   DELETE /api/travel/commission-profiles/:id            â€” ADMIN-only hard delete
 *   POST   /api/travel/commission-profiles/:id/assign     â€” ADMIN/MANAGER bulk-assign to Contact rows (slice 6)
 *   POST   /api/travel/commission-profiles/:id/preview    â€” what-if commission preview (slice 7)
 *   GET    /api/travel/commission-profiles/:id/ledger     â€” operator-view commission ledger (slice 9)
 *   GET    /api/travel/commission-profiles/:id/ledger.csv â€” operator CSV export of ledger (slice 11)
 *   POST   /api/travel/commission-profiles/:id/duplicate  â€” ADMIN/MANAGER clone (slice 13)
 *   GET    /api/travel/commission-profiles/:id/summary/by-contact â€” per-contact aggregation (slice 14)
 *   GET    /api/travel/commission-profiles/:id/summary/by-month â€” monthly time-series rollup (slice 15)
 *   GET    /api/travel/commission-profiles/:id/summary/by-quarter â€” quarterly time-series rollup (slice 16)
 *   GET    /api/travel/commission-profiles/:id/summary/by-year â€” annual time-series rollup (slice 17)
 *
 * Validation strictness (slice 2):
 *   - name required, non-empty trim                       â†’ 400 MISSING_FIELDS
 *   - profileType must match 4-item whitelist             â†’ 400 INVALID_PROFILE_TYPE
 *   - profileJson must JSON.parse                         â†’ 400 INVALID_PROFILE_JSON
 *   - subBrand (if provided) must match assertValidSubBrand â†’ 400 INVALID_SUB_BRAND
 *   - DEEP-SHAPE validation of parsed profileJson against profileType is
 *     INTENTIONALLY DEFERRED. The calculator returns commission=0 with a
 *     'unknown profile type X' breakdown on malformed shape â€” so a misconfigured
 *     row surfaces as an operator-visible $0 commission row at use-time
 *     rather than a 500 throw at edit-time. Tightening to per-type
 *     shape-validation is a future slice when the profile editor UI lands
 *     (the operator-facing editor will pin shape via form fields anyway).
 *
 * Sub-brand isolation: every list / get / write goes through
 * getSubBrandAccessSet + canAccessSubBrand. A MANAGER restricted to one
 * sub-brand cannot read or write profiles attached to other sub-brands;
 * profiles with NULL subBrand are tenant-wide and visible to everyone.
 *
 * Error codes (route-specific):
 *   INVALID_ID, MISSING_FIELDS, INVALID_PROFILE_TYPE, INVALID_PROFILE_JSON,
 *   INVALID_SUB_BRAND, PROFILE_NOT_FOUND, SUB_BRAND_DENIED, EMPTY_BODY.
 *
 * Mount in server.js is a SEPARATE slice (wire-in deferred).
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { computeCommission } = require("../lib/agentCommissionCalculator");

const VALID_PROFILE_TYPES = ["flat_percent", "tiered", "per_pax_flat", "hybrid"];
const VALID_RELEASE_MODES = ["on_booking", "on_trip_completion"];

function assertValidProfileType(t) {
  if (!VALID_PROFILE_TYPES.includes(t)) {
    const err = new Error(
      `profileType must be one of: ${VALID_PROFILE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_PROFILE_TYPE";
    throw err;
  }
}

/**
 * Light JSON parse-only validation. Accepts already-stringified JSON
 * (the canonical shape; column is @db.Text) OR a live object/array (the
 * route stringifies it for storage). Throws INVALID_PROFILE_JSON on
 * anything unparseable. Returns the canonical stringified form ready
 * for the column.
 *
 * Deep-shape validation against profileType is deferred (see file header).
 */
function assertValidReleaseMode(mode) {
  if (!VALID_RELEASE_MODES.includes(mode)) {
    const err = new Error(
      `releaseMode must be one of: ${VALID_RELEASE_MODES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_RELEASE_MODE";
    throw err;
  }
}

function normalizeProfileJson(input) {
  if (input == null || input === "") {
    const err = new Error("profileJson is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  if (typeof input === "string") {
    try {
      JSON.parse(input);
    } catch (_e) {
      const err = new Error("profileJson must be valid JSON");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
    return input;
  }
  if (typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch (_e) {
      const err = new Error("profileJson must be JSON-serializable");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
  }
  const err = new Error("profileJson must be a JSON object or string");
  err.status = 400;
  err.code = "INVALID_PROFILE_JSON";
  throw err;
}

function normalizeOptionalDate(input, fieldName) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) {
    const err = new Error(`${fieldName} must be a valid ISO date`);
    err.status = 400;
    err.code = "INVALID_DATE";
    throw err;
  }
  return value;
}

function normalizeOptionalInt(input, fieldName) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const value = parseInt(input, 10);
  if (!Number.isFinite(value)) {
    const err = new Error(`${fieldName} must be an integer`);
    err.status = 400;
    err.code = "INVALID_INTEGER";
    throw err;
  }
  return value;
}

function normalizeOptionalText(input) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const value = String(input).trim();
  return value || null;
}

function isReleasedOnBooking(deal) {
  const stage = String(deal?.stage || "").toLowerCase();
  return stage === "won" || stage === "booked" || stage === "accepted";
}

function normalizeOptionalQueryDate(input, fieldName) {
  if (input == null || input === "") return null;
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) {
    const err = new Error(`${fieldName} must be a valid ISO date`);
    err.status = 400;
    err.code = "INVALID_DATE";
    throw err;
  }
  return value;
}

function pushValidityClauses(andClauses, activeOn) {
  if (!activeOn) return;
  andClauses.push({ OR: [{ validFrom: null }, { validFrom: { lte: activeOn } }] });
  andClauses.push({ OR: [{ validTo: null }, { validTo: { gte: activeOn } }] });
}

async function loadCompletedItineraryContactIds(tenantId, contactIds) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) return new Set();
  const rows = await prisma.itinerary.findMany({
    where: {
      tenantId,
      contactId: { in: contactIds },
      status: { in: ["accepted", "advance_paid", "fully_paid"] },
      endDate: { not: null, lte: new Date() },
    },
    select: { contactId: true },
  });
  return new Set(rows.map((row) => row.contactId).filter(Boolean));
}

function buildReleaseDecision(profile, deal, completedContactIds) {
  const releaseMode = profile.releaseMode || "on_booking";
  if (releaseMode === "on_trip_completion") {
    if (!deal?.contact?.id) {
      return {
        releaseMode,
        released: false,
        releaseReason: "Waiting for a linked contact itinerary",
      };
    }
    const released = completedContactIds.has(deal.contact.id);
    return {
      releaseMode,
      released,
      releaseReason: released
        ? "Completed itinerary found for this contact"
        : "Waiting for itinerary completion",
    };
  }
  const released = isReleasedOnBooking(deal);
  return {
    releaseMode,
    released,
    releaseReason: released
      ? "Booking milestone reached"
      : "Waiting for booking confirmation",
  };
}

// GET /api/travel/commission-profiles
// Honors ?subBrand=tmc, ?profileType=flat_percent, ?isActive=true/false.
// Sub-brand-restricted callers see only their allowed sub-brands PLUS
// tenant-wide profiles (subBrand IS NULL).
router.get(
  "/commission-profiles",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      const andClauses = [];

      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.profileType) {
        assertValidProfileType(String(req.query.profileType));
        where.profileType = String(req.query.profileType);
      }
      if (req.query.category) {
        where.category = String(req.query.category).trim();
      }
      if (req.query.agentUserId) {
        where.agentUserId = normalizeOptionalInt(req.query.agentUserId, "agentUserId");
      }
      if (req.query.releaseMode) {
        const mode = String(req.query.releaseMode);
        assertValidReleaseMode(mode);
        where.releaseMode = mode;
      }
      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      const activeOn = normalizeOptionalQueryDate(req.query.activeOn, "activeOn");
      pushValidityClauses(andClauses, activeOn);

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__";
          }
        } else {
          andClauses.push({
            OR: [{ subBrand: { in: [...allowed] } }, { subBrand: null }],
          });
        }
      }

      if (andClauses.length > 0) where.AND = andClauses;

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [profiles, total] = await Promise.all([
        prisma.travelCommissionProfile.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          skip,
        }),
        prisma.travelCommissionProfile.count({ where }),
      ]);
      res.json({ profiles, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] list error:", e.message);
      res.status(500).json({ error: "Failed to list commission profiles" });
    }
  },
);

// GET /api/travel/commission-profiles/stats â€” tenant-wide commission profile rollup
// (PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 18).
//
// USER-readable meta endpoint. Powers the CommissionProfiles library page's
// header summary strip ("42 profiles Â· 35 active Â· 7 archived Â· 2 flat /
// 5 tiered ... Â· last activity 3h ago"). Without this, the frontend has to
// fire {list, count by profileTypeÃ—4, count by subBrandÃ—N, audit poll}
// just to render the header â€” N+ round-trips for a single visual surface.
//
// Distinct from /:id/summary/by-{month,quarter,year} (per-profile time series)
// and /:id/ledger (per-profile deal list). This is the tenant-wide aggregate
// across BOTH dimensions: profile-count summary (status + profileType +
// sub-brand) AND audit-derived activity (scoped deal count + lastActivityAt).
//
// PRD anchors:
//   - Â§3 â€” operator-facing commission dashboard surfaces "how many
//          profiles do I have, of what shape, attached to which deals" â€”
//          this endpoint feeds those KPI tiles
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' profiles in the counts, PLUS tenant-wide
//     (NULL subBrand) rows. Same gate as the list endpoint.
//   - Profile-count rollup (from prisma.travelCommissionProfile.findMany):
//       total, active, archived            â€” overall + by status
//       byProfileType: { <type>: { count, totalCommission } }
//       bySubBrand: { <sb|_tenant>: { count, totalCommission } }
//   - totalCommission per group: in-process sum of computeCommission()
//     over ALL Deals tied via Contact.commissionProfileId to each profile.
//     If profileJson is malformed for any profile, that profile
//     contributes totalCommission=0 (defensive â€” same posture as
//     /:id/summary/by-month).
//   - Audit-derived activity:
//       totalDealsScoped                   â€” count of Deals attached via
//                                            Contact.commissionProfileId to
//                                            ANY visible profile in this rollup
//       lastActivityAt                     â€” max(updatedAt) across all
//                                            matching profiles, or null
//   - ?from / ?to (ISO date bounds) filter profile.createdAt before aggregation.
//
// Safety cap: process at most 1000 profiles per call; if matching total >
// 1000, return counts but mark aggregateExceedsCap=true (totalCommission
// would be incomplete past the cap).
//
// USER-readable: anodyne aggregate (counts + sums + timestamps); safe.
// No audit row: read-only meta surface, mirrors /flyer-templates/global-stats.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would 400 INVALID_ID before reaching this
// handler.
const PROFILES_AGGREGATE_CAP = 1000;
router.get(
  "/commission-profiles/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on profile.createdAt
      const profileWhere = { tenantId };
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
        profileWhere.createdAt = Object.assign(profileWhere.createdAt || {}, { gte: d });
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        profileWhere.createdAt = Object.assign(profileWhere.createdAt || {}, { lte: d });
      }

      // Sub-brand narrowing â€” same gate as list endpoint.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        profileWhere.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Bounded fetch to keep in-process aggregation safe.
      const profiles = await prisma.travelCommissionProfile.findMany({
        where: profileWhere,
        orderBy: [{ id: "asc" }],
        take: PROFILES_AGGREGATE_CAP,
      });

      // Get the true total so callers know if aggregation is bounded.
      const totalMatching = await prisma.travelCommissionProfile.count({
        where: profileWhere,
      });
      const aggregateExceedsCap = totalMatching > PROFILES_AGGREGATE_CAP;

      // Empty short-circuit â€” return zeroed shape.
      if (profiles.length === 0) {
        return res.json({
          total: 0,
          active: 0,
          archived: 0,
          byProfileType: {},
          bySubBrand: {},
          totalDealsScoped: 0,
          lastActivityAt: null,
          aggregateExceedsCap: false,
        });
      }

      // Counts overall.
      let active = 0;
      let archived = 0;
      let lastActivityAt = null;
      for (const p of profiles) {
        if (p.isActive) active += 1;
        else archived += 1;
        const ts = p.updatedAt instanceof Date ? p.updatedAt : new Date(p.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
        }
      }

      // Pre-parse all profileJson once so the per-deal loop below is fast.
      // A profile that fails to parse contributes totalCommission=0 â€” its
      // count + status still register normally.
      const parsedById = new Map();
      for (const p of profiles) {
        try {
          parsedById.set(p.id, JSON.parse(p.profileJson));
        } catch (_e) {
          parsedById.set(p.id, null);
        }
      }

      // Fetch all Deals scoped to ANY contact pointing at any visible profile.
      // We pull amount + contact.commissionProfileId so we can attribute each
      // deal's computed commission back to its profile's groups.
      const profileIds = profiles.map((p) => p.id);
      const deals = await prisma.deal.findMany({
        where: {
          tenantId,
          deletedAt: null,
          contact: {
            commissionProfileId: { in: profileIds },
            tenantId,
          },
        },
        select: {
          id: true,
          amount: true,
          contact: { select: { commissionProfileId: true } },
        },
      });

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Initialise per-profileType + per-subBrand bucket maps. Pre-seed with
      // ALL profileTypes the existing population uses (so a type with zero
      // deals still appears with count + totalCommission=0). Same for
      // sub-brand (null â†’ '_tenant').
      const byProfileType = {};
      const bySubBrand = {};
      for (const p of profiles) {
        const pt = p.profileType || "unknown";
        if (!byProfileType[pt]) byProfileType[pt] = { count: 0, totalCommission: 0 };
        byProfileType[pt].count += 1;

        const sbKey = p.subBrand ? String(p.subBrand) : "_tenant";
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0, totalCommission: 0 };
        bySubBrand[sbKey].count += 1;
      }

      // Index profile metadata for the deal-attribution loop.
      const profileMetaById = new Map();
      for (const p of profiles) {
        profileMetaById.set(p.id, {
          profileType: p.profileType || "unknown",
          subBrandKey: p.subBrand ? String(p.subBrand) : "_tenant",
        });
      }

      // Attribute each deal's commission to its profile's two bucket-axes.
      // Deal whose contact's profileId isn't in our visible set (cross-tenant
      // / not-in-cap window / sub-brand-stripped) is skipped defensively.
      for (const d of deals) {
        const pid = d.contact && d.contact.commissionProfileId;
        if (!pid) continue;
        const meta = profileMetaById.get(pid);
        if (!meta) continue;
        const parsed = parsedById.get(pid);
        if (!parsed) continue; // malformed profile contributes 0

        const result = computeCommission({
          saleAmount: Number(d.amount) || 0,
          paxCount: 1,
          profile: parsed,
        });
        const commission = Number(result && result.commission) || 0;
        byProfileType[meta.profileType].totalCommission += commission;
        bySubBrand[meta.subBrandKey].totalCommission += commission;
      }

      // Finalise rounding on per-bucket sums.
      for (const k of Object.keys(byProfileType)) {
        byProfileType[k].totalCommission = round2(byProfileType[k].totalCommission);
      }
      for (const k of Object.keys(bySubBrand)) {
        bySubBrand[k].totalCommission = round2(bySubBrand[k].totalCommission);
      }

      res.json({
        total: profiles.length,
        active,
        archived,
        byProfileType,
        bySubBrand,
        totalDealsScoped: deals.length,
        lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise commission profiles" });
    }
  },
);

// GET /api/travel/commission-profiles/by-month â€” tenant-wide commission
// analytics rolled up by UTC YYYY-MM across ALL TravelCommissionProfile
// rows visible to the caller.
//
// Slice 19 of #905 (PRD_TRAVEL_B2B_AGENT_PORTAL Â§3 â€” operator-facing
// commission analytics surface). Mirrors #900 slice 16 (/quotes/by-month)
// + #901 slice 29 (/invoices/by-month) at the tenant level, and reuses
// the per-profile aggregation pattern from slice 15
// (/:id/summary/by-month) but lifted to tenant scope across every
// profile in the caller's visibility set. One row per UTC-month
// present in the scoped deal set, with counts + sums aggregated across
// every profile that produced commission that month.
//
// NOT to be confused with /:id/summary/by-month (slice 15) â€” that's
// the per-profile time-series; this is the tenant-wide rollup. Both
// can coexist (the per-profile endpoint drills into one chosen profile;
// this endpoint feeds the cross-profile trend chart on the library
// page).
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// Deal.createdAt's UTC year + month. UTC chosen deliberately so bucket
// labels stay stable across operator timezones â€” finance reconciliation
// works in calendar-month UTC for cross-border volume.
//
// Scope rules:
//   - Tenant-scoped on TravelCommissionProfile.tenantId AND Deal.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand + NULL tenant-wide;
//     ADMIN full access).
//   - Soft-deleted deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing â€” anodyne aggregate.
//
// Query string:
//   from      optional inclusive lower bound on bucket (YYYY-MM)
//   to        optional inclusive upper bound on bucket (YYYY-MM)
//   orderBy   default "month:asc"; also accepts "month:desc",
//             "totalCommission:asc|desc", "profileCount:asc|desc",
//             "dealCount:asc|desc". Unknown tokens degrade silently
//             to default.
//   limit     default 12 (one year of months), max 60 (5 years).
//   offset    default 0
//
// Response shape:
//   {
//     months: [ {
//       month: "2026-05",
//       profileCount, dealCount,
//       totalSale, totalCommission
//     } ],
//     totalMonths,
//     grandProfileCount,     // distinct across all months
//     grandDealCount,
//     grandTotalSale,
//     grandTotalCommission,
//     limit, offset,
//     aggregateExceedsCap,
//   }
//
// Safety cap (PROFILES_AGGREGATE_CAP=1000): process at most 1000 profiles
// per call; if matching total > cap, set aggregateExceedsCap=true so the
// dashboard tile can surface "showing first 1000 profiles" without
// silently presenting incomplete totals. Mirrors the slice 18 contract.
//
// Defensive behaviour: malformed stored profileJson on any profile â†’
// that profile contributes 0 commission (other profiles still aggregate
// correctly, no 500). Same posture as slice 15. Null/invalid
// Deal.amount or createdAt fall back to 0 / "unknown" bucket; "unknown"
// is excluded when ?from / ?to is set.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-month" as a numeric :id (which would 400 INVALID_ID).
router.get(
  "/commission-profiles/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation â€” same regex slices 15 + 16 use.
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
        "totalCommission:asc",
        "totalCommission:desc",
        "profileCount:asc",
        "profileCount:desc",
        "dealCount:asc",
        "dealCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Sub-brand narrowing â€” same gate as /stats endpoint. MANAGER sees
      // their allowed sub-brands PLUS tenant-wide (subBrand IS NULL).
      const profileWhere = { tenantId };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        profileWhere.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Bounded fetch to keep in-process aggregation safe.
      const profiles = await prisma.travelCommissionProfile.findMany({
        where: profileWhere,
        orderBy: [{ id: "asc" }],
        take: PROFILES_AGGREGATE_CAP,
      });

      // True total to flag whether aggregation is bounded.
      const totalMatching = await prisma.travelCommissionProfile.count({
        where: profileWhere,
      });
      const aggregateExceedsCap = totalMatching > PROFILES_AGGREGATE_CAP;

      // Empty short-circuit â€” return zeroed shape.
      if (profiles.length === 0) {
        return res.json({
          months: [],
          totalMonths: 0,
          grandProfileCount: 0,
          grandDealCount: 0,
          grandTotalSale: 0,
          grandTotalCommission: 0,
          limit: take,
          offset: skip,
          aggregateExceedsCap,
        });
      }

      // Pre-parse all profileJson once. A profile that fails to parse
      // contributes totalCommission=0 â€” its deals still register count
      // + totalSale in their respective month buckets.
      const parsedById = new Map();
      for (const p of profiles) {
        try {
          parsedById.set(p.id, JSON.parse(p.profileJson));
        } catch (_e) {
          parsedById.set(p.id, null);
        }
      }

      // Fetch all Deals scoped to ANY contact pointing at any visible
      // profile. Pulls amount + createdAt + contact.commissionProfileId so
      // we can attribute each deal's computed commission back to its
      // profile + bucket the deal by its createdAt month.
      const profileIds = profiles.map((p) => p.id);
      const deals = await prisma.deal.findMany({
        where: {
          tenantId,
          deletedAt: null,
          contact: {
            commissionProfileId: { in: profileIds },
            tenantId,
          },
        },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          contact: { select: { commissionProfileId: true } },
        },
      });

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-month. Map "YYYY-MM" â†’ { month, profileCount,
      // dealCount, totalSale, totalCommission } + a `profileIds` Set on
      // the row so we can compute the distinct profile count per bucket.
      const byMonth = new Map();
      for (const d of deals) {
        const pid = d.contact && d.contact.commissionProfileId;
        if (!pid) continue;
        const parsed = parsedById.get(pid);
        // parsed === undefined means the deal points at a profile that
        // isn't in our scoped/capped visible set â€” skip defensively.
        if (parsed === undefined) continue;

        let monthKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
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
            profileIds: new Set(),
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byMonth.set(monthKey, row);
        }
        row.profileIds.add(pid);
        row.dealCount += 1;
        const safeAmt = Number(d.amount) || 0;
        row.totalSale += safeAmt;

        let commission = 0;
        if (parsed !== null) {
          const result = computeCommission({
            saleAmount: safeAmt,
            paxCount: 1,
            profile: parsed,
          });
          commission = Number(result && result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Finalise per-row sums + materialise profileCount from the Set.
      let months = [...byMonth.values()].map((r) => ({
        month: r.month,
        profileCount: r.profileIds.size,
        dealCount: r.dealCount,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded
      // when either bound is set (no comparable month token); kept
      // otherwise so the count surface stays complete. Mirrors slice 15.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM which is also
      // chronological. "unknown" sorts last in asc / first in desc by
      // virtue of being lexicographically > "9999-12".
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

      // Distinct profiles across all months in the filtered set â€” compute
      // BEFORE pagination so the grand total reflects the full filtered
      // population, not just the page window. We have to re-derive this
      // from byMonth because the materialised rows above dropped the Set.
      const grandProfileSet = new Set();
      for (const r of byMonth.values()) {
        // Re-apply the from/to filter to this row's bucket.
        if (fromRaw !== null && (r.month === "unknown" || r.month < fromRaw)) continue;
        if (toRaw !== null && (r.month === "unknown" || r.month > toRaw)) continue;
        for (const pid of r.profileIds) grandProfileSet.add(pid);
      }
      const grandProfileCount = grandProfileSet.size;

      const grandDealCount = months.reduce(
        (acc, r) => acc + (Number(r.dealCount) || 0),
        0,
      );
      const grandTotalSale = round2(
        months.reduce((acc, r) => acc + (Number(r.totalSale) || 0), 0),
      );
      const grandTotalCommission = round2(
        months.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Pagination applied AFTER aggregation + sort + filter.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandProfileCount,
        grandDealCount,
        grandTotalSale,
        grandTotalCommission,
        limit: take,
        offset: skip,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly commission rollup" });
    }
  },
);

// GET /api/travel/commission-profiles/by-quarter â€” tenant-wide commission
// analytics rolled up by UTC YYYY-Qn across ALL TravelCommissionProfile
// rows visible to the caller.
//
// Slice 20 of #905 (PRD_TRAVEL_B2B_AGENT_PORTAL Â§3 â€” operator-facing
// commission analytics surface). Quarterly sibling of slice 19
// (/by-month tenant-wide) for the coarser-bucket trend chart. Same
// aggregation pattern lifted to UTC calendar quarters: Q1 = Jan-Mar,
// Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec â€” NOT Indian-FY April-March
// quarters. FY tooling is a future overlay on top of this primitive.
//
// NOT to be confused with /:id/summary/by-quarter (slice 16) â€” that's
// the per-profile quarterly time series; this is the tenant-wide rollup
// across every visible profile. Both coexist: per-profile drills into
// one chosen profile; this endpoint feeds the cross-profile quarterly
// trend chart on the library page.
//
// Bucket key shape: "YYYY-Qn" (e.g. "2026-Q2") derived from Deal.createdAt's
// UTC year + (Math.floor(month/3) + 1). UTC chosen deliberately so labels
// stay stable across operator timezones.
//
// Scope rules: identical to slice 19 â€” tenant on profile + deal,
// sub-brand narrowed for MANAGER, soft-deleted deals excluded, any
// verified token (no RBAC narrowing â€” anodyne aggregate).
//
// Query string:
//   from      optional inclusive lower bound (YYYY-Qn)
//   to        optional inclusive upper bound (YYYY-Qn)
//   orderBy   default "quarter:asc"; also accepts "quarter:desc",
//             "totalCommission:asc|desc", "profileCount:asc|desc",
//             "dealCount:asc|desc". Unknown tokens degrade silently to default.
//   limit     default 12 (3 years of quarters), max 40 (10 years).
//   offset    default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       profileCount, dealCount,
//       totalSale, totalCommission
//     } ],
//     totalQuarters,
//     grandProfileCount, grandDealCount, grandTotalSale, grandTotalCommission,
//     limit, offset,
//     aggregateExceedsCap,
//   }
//
// Safety cap (PROFILES_AGGREGATE_CAP=1000): process at most 1000 profiles
// per call; aggregateExceedsCap=true if more match the filter. Mirrors slice 19.
//
// Defensive: malformed stored profileJson on a profile â†’ that profile
// contributes 0 commission but its deals still register in count + totalSale.
// Null/invalid Deal.amount or createdAt â†’ 0 / "unknown" bucket; "unknown"
// is excluded when ?from / ?to is set.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-quarter" as a numeric :id (INVALID_ID).
router.get(
  "/commission-profiles/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

      // YYYY-Qn validation â€” same regex slice 16 uses.
      const QUARTER_RE = /^\d{4}-Q[1-4]$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }
      if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "quarter:asc",
        "quarter:desc",
        "totalCommission:asc",
        "totalCommission:desc",
        "profileCount:asc",
        "profileCount:desc",
        "dealCount:asc",
        "dealCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

      // Sub-brand narrowing â€” same gate as /stats endpoint. MANAGER sees
      // their allowed sub-brands PLUS tenant-wide (subBrand IS NULL).
      const profileWhere = { tenantId };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        profileWhere.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Bounded fetch.
      const profiles = await prisma.travelCommissionProfile.findMany({
        where: profileWhere,
        orderBy: [{ id: "asc" }],
        take: PROFILES_AGGREGATE_CAP,
      });

      const totalMatching = await prisma.travelCommissionProfile.count({
        where: profileWhere,
      });
      const aggregateExceedsCap = totalMatching > PROFILES_AGGREGATE_CAP;

      if (profiles.length === 0) {
        return res.json({
          quarters: [],
          totalQuarters: 0,
          grandProfileCount: 0,
          grandDealCount: 0,
          grandTotalSale: 0,
          grandTotalCommission: 0,
          limit: take,
          offset: skip,
          aggregateExceedsCap,
        });
      }

      // Pre-parse all profileJson once. Malformed profile â†’ null â†’ its
      // deals contribute 0 commission but still register in count + totalSale.
      const parsedById = new Map();
      for (const p of profiles) {
        try {
          parsedById.set(p.id, JSON.parse(p.profileJson));
        } catch (_e) {
          parsedById.set(p.id, null);
        }
      }

      const profileIds = profiles.map((p) => p.id);
      const deals = await prisma.deal.findMany({
        where: {
          tenantId,
          deletedAt: null,
          contact: {
            commissionProfileId: { in: profileIds },
            tenantId,
          },
        },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          contact: { select: { commissionProfileId: true } },
        },
      });

      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-quarter. Calendar quarters: Q1=Jan-Mar, Q2=Apr-Jun,
      // Q3=Jul-Sep, Q4=Oct-Dec via Math.floor(UTCMonth/3) + 1.
      const byQuarter = new Map();
      for (const d of deals) {
        const pid = d.contact && d.contact.commissionProfileId;
        if (!pid) continue;
        const parsed = parsedById.get(pid);
        if (parsed === undefined) continue;

        let quarterKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const q = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${q}`;
          }
        }

        let row = byQuarter.get(quarterKey);
        if (!row) {
          row = {
            quarter: quarterKey,
            profileIds: new Set(),
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byQuarter.set(quarterKey, row);
        }
        row.profileIds.add(pid);
        row.dealCount += 1;
        const safeAmt = Number(d.amount) || 0;
        row.totalSale += safeAmt;

        let commission = 0;
        if (parsed !== null) {
          const result = computeCommission({
            saleAmount: safeAmt,
            paxCount: 1,
            profile: parsed,
          });
          commission = Number(result && result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Materialise rows from the byQuarter Map.
      let quarters = [...byQuarter.values()].map((r) => ({
        quarter: r.quarter,
        profileCount: r.profileIds.size,
        dealCount: r.dealCount,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to filter. "unknown" rows excluded when either
      // bound is set (no comparable token); kept otherwise. Mirrors slice 19.
      if (fromRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
      }
      if (toRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
      // chronological (Q1..Q4 single-digit).
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

      // Distinct profiles across the filtered population â€” compute BEFORE
      // pagination so the grand total reflects the full filtered set.
      const grandProfileSet = new Set();
      for (const r of byQuarter.values()) {
        if (fromRaw !== null && (r.quarter === "unknown" || r.quarter < fromRaw)) continue;
        if (toRaw !== null && (r.quarter === "unknown" || r.quarter > toRaw)) continue;
        for (const pid of r.profileIds) grandProfileSet.add(pid);
      }
      const grandProfileCount = grandProfileSet.size;

      const grandDealCount = quarters.reduce(
        (acc, r) => acc + (Number(r.dealCount) || 0),
        0,
      );
      const grandTotalSale = round2(
        quarters.reduce((acc, r) => acc + (Number(r.totalSale) || 0), 0),
      );
      const grandTotalCommission = round2(
        quarters.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Paginate AFTER aggregation + sort + filter.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        quarters: paged,
        totalQuarters,
        grandProfileCount,
        grandDealCount,
        grandTotalSale,
        grandTotalCommission,
        limit: take,
        offset: skip,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly commission rollup" });
    }
  },
);

// GET /api/travel/commission-profiles/by-year â€” tenant-wide commission
// analytics rolled up by UTC YYYY across ALL TravelCommissionProfile rows
// visible to the caller.
//
// Slice 21 of #905 (PRD_TRAVEL_B2B_AGENT_PORTAL Â§3 â€” operator-facing
// commission analytics surface). Annual sibling of slice 19 (/by-month
// tenant-wide) + slice 20 (/by-quarter tenant-wide). Completes the
// by-month / by-quarter / by-year tenant-wide triplet at the coarsest
// bucket grain, intended for the year-over-year ("YoY") trend tile on
// the commission library page.
//
// NOT to be confused with /:id/summary/by-year (slice 17) â€” that's the
// per-profile annual time series; this is the tenant-wide rollup across
// every visible profile. Both coexist: per-profile drills into one chosen
// profile; this endpoint feeds the cross-profile annual trend tile.
//
// Bucket key shape: "YYYY" (e.g. "2026") derived from Deal.createdAt's
// UTC year via getUTCFullYear(). UTC chosen deliberately so labels stay
// stable across operator timezones. Calendar years â€” NOT Indian-FY
// April-March â€” FY tooling is a future overlay on top of this primitive.
//
// Scope rules: identical to slice 19 + 20 â€” tenant on profile + deal,
// sub-brand narrowed for MANAGER, soft-deleted deals excluded, any
// verified token (no RBAC narrowing â€” anodyne aggregate).
//
// Query string:
//   from      optional inclusive lower bound (YYYY)
//   to        optional inclusive upper bound (YYYY)
//   orderBy   default "year:asc"; also accepts "year:desc",
//             "totalCommission:asc|desc", "profileCount:asc|desc",
//             "dealCount:asc|desc". Unknown tokens degrade silently to default.
//   limit     default 10 (a decade), max 30.
//   offset    default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       profileCount, dealCount,
//       totalSale, totalCommission
//     } ],
//     totalYears,
//     grandProfileCount, grandDealCount, grandTotalSale, grandTotalCommission,
//     limit, offset,
//     aggregateExceedsCap,
//   }
//
// Safety cap (PROFILES_AGGREGATE_CAP=1000): process at most 1000 profiles
// per call; aggregateExceedsCap=true if more match the filter. Mirrors
// slices 19 + 20.
//
// Defensive: malformed stored profileJson on a profile â†’ that profile
// contributes 0 commission but its deals still register in count + totalSale.
// Null/invalid Deal.amount or createdAt â†’ 0 / "unknown" bucket; "unknown"
// is excluded when ?from / ?to is set.
//
// Route ordering: declared BEFORE GET /:id so Express doesn't try to
// parse "by-year" as a numeric :id (INVALID_ID).
router.get(
  "/commission-profiles/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation â€” strict 4-digit token. Same shape as Date's getUTCFullYear() string form.
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
        "totalCommission:asc",
        "totalCommission:desc",
        "profileCount:asc",
        "profileCount:desc",
        "dealCount:asc",
        "dealCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Sub-brand narrowing â€” same gate as /stats endpoint. MANAGER sees
      // their allowed sub-brands PLUS tenant-wide (subBrand IS NULL).
      const profileWhere = { tenantId };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        profileWhere.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Bounded fetch.
      const profiles = await prisma.travelCommissionProfile.findMany({
        where: profileWhere,
        orderBy: [{ id: "asc" }],
        take: PROFILES_AGGREGATE_CAP,
      });

      const totalMatching = await prisma.travelCommissionProfile.count({
        where: profileWhere,
      });
      const aggregateExceedsCap = totalMatching > PROFILES_AGGREGATE_CAP;

      if (profiles.length === 0) {
        return res.json({
          years: [],
          totalYears: 0,
          grandProfileCount: 0,
          grandDealCount: 0,
          grandTotalSale: 0,
          grandTotalCommission: 0,
          limit: take,
          offset: skip,
          aggregateExceedsCap,
        });
      }

      // Pre-parse all profileJson once. Malformed profile â†’ null â†’ its
      // deals contribute 0 commission but still register in count + totalSale.
      const parsedById = new Map();
      for (const p of profiles) {
        try {
          parsedById.set(p.id, JSON.parse(p.profileJson));
        } catch (_e) {
          parsedById.set(p.id, null);
        }
      }

      const profileIds = profiles.map((p) => p.id);
      const deals = await prisma.deal.findMany({
        where: {
          tenantId,
          deletedAt: null,
          contact: {
            commissionProfileId: { in: profileIds },
            tenantId,
          },
        },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          contact: { select: { commissionProfileId: true } },
        },
      });

      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-year via getUTCFullYear(). String-cast so the bucket
      // key matches the YYYY token shape consumers pass in ?from / ?to.
      const byYear = new Map();
      for (const d of deals) {
        const pid = d.contact && d.contact.commissionProfileId;
        if (!pid) continue;
        const parsed = parsedById.get(pid);
        if (parsed === undefined) continue;

        let yearKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let row = byYear.get(yearKey);
        if (!row) {
          row = {
            year: yearKey,
            profileIds: new Set(),
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byYear.set(yearKey, row);
        }
        row.profileIds.add(pid);
        row.dealCount += 1;
        const safeAmt = Number(d.amount) || 0;
        row.totalSale += safeAmt;

        let commission = 0;
        if (parsed !== null) {
          const result = computeCommission({
            saleAmount: safeAmt,
            paxCount: 1,
            profile: parsed,
          });
          commission = Number(result && result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Materialise rows from the byYear Map.
      let years = [...byYear.values()].map((r) => ({
        year: r.year,
        profileCount: r.profileIds.size,
        dealCount: r.dealCount,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to filter. "unknown" rows excluded when either
      // bound is set (no comparable token); kept otherwise. Mirrors slice 19 + 20.
      if (fromRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
      }
      if (toRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
      }

      // Sort. "year" sorts lexicographically on YYYY which is also chronological.
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

      // Distinct profiles across the filtered population â€” compute BEFORE
      // pagination so the grand total reflects the full filtered set.
      const grandProfileSet = new Set();
      for (const r of byYear.values()) {
        if (fromRaw !== null && (r.year === "unknown" || r.year < fromRaw)) continue;
        if (toRaw !== null && (r.year === "unknown" || r.year > toRaw)) continue;
        for (const pid of r.profileIds) grandProfileSet.add(pid);
      }
      const grandProfileCount = grandProfileSet.size;

      const grandDealCount = years.reduce(
        (acc, r) => acc + (Number(r.dealCount) || 0),
        0,
      );
      const grandTotalSale = round2(
        years.reduce((acc, r) => acc + (Number(r.totalSale) || 0), 0),
      );
      const grandTotalCommission = round2(
        years.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Paginate AFTER aggregation + sort + filter.
      const paged = years.slice(skip, skip + take);

      res.json({
        years: paged,
        totalYears,
        grandProfileCount,
        grandDealCount,
        grandTotalSale,
        grandTotalCommission,
        limit: take,
        offset: skip,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute annual commission rollup" });
    }
  },
);

// GET /api/travel/commission-profiles/:id
router.get(
  "/commission-profiles/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand access â€” NULL subBrand is tenant-wide and visible to all.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }
      res.json(profile);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] get error:", e.message);
      res.status(500).json({ error: "Failed to get commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles â€” ADMIN/MANAGER only.
// Required: name, profileType, profileJson.
// Optional: subBrand (null/omitted = tenant-wide), isActive (default true), notes.
router.post(
  "/commission-profiles",
  verifyToken,
  requirePermission("commission_profiles", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, profileType, profileJson,
        subBrand, category, agentUserId, validFrom, validTo, releaseMode, isActive, notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }
      if (!profileType) {
        return res.status(400).json({
          error: "profileType required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidProfileType(profileType);
      const normalizedReleaseMode = releaseMode == null || releaseMode === ""
        ? "on_booking"
        : String(releaseMode);
      assertValidReleaseMode(normalizedReleaseMode);
      const normalizedCategory = normalizeOptionalText(category);
      const normalizedAgentUserId = normalizeOptionalInt(agentUserId, "agentUserId");
      const normalizedValidFrom = normalizeOptionalDate(validFrom, "validFrom");
      const normalizedValidTo = normalizeOptionalDate(validTo, "validTo");
      if (normalizedValidFrom && normalizedValidTo && normalizedValidFrom > normalizedValidTo) {
        return res.status(400).json({
          error: "validFrom must be on or before validTo",
          code: "INVALID_DATE_RANGE",
        });
      }
      const profileJsonString = normalizeProfileJson(profileJson);

      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        // Sub-brand isolation: reject create that targets a sub-brand
        // the caller can't access. Tenant-wide (null subBrand) creates
        // are allowed for any authorised caller â€” the gate is the
        // ADMIN/MANAGER role check above.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const created = await prisma.travelCommissionProfile.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          profileType,
          profileJson: profileJsonString,
          subBrand: subBrand ? String(subBrand) : null,
          category: normalizedCategory,
          agentUserId: normalizedAgentUserId,
          validFrom: normalizedValidFrom,
          validTo: normalizedValidTo,
          releaseMode: normalizedReleaseMode,
          isActive: isActive === false ? false : true,
          notes: notes ? String(notes) : null,
        },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          profileType: created.profileType,
          subBrand: created.subBrand,
          category: created.category,
          agentUserId: created.agentUserId,
          releaseMode: created.releaseMode,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] create error:", e.message);
      res.status(500).json({ error: "Failed to create commission profile" });
    }
  },
);

// PUT /api/travel/commission-profiles/:id â€” ADMIN/MANAGER only.
// Partial update. Sub-brand reassignment requires access to both the
// existing AND the target sub-brand.
router.put(
  "/commission-profiles/:id",
  verifyToken,
  requirePermission("commission_profiles", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      // Caller must be able to access the existing sub-brand (NULL is
      // tenant-wide and accessible to any authorised role).
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const data = {};
      const {
        name, profileType, profileJson,
        subBrand, category, agentUserId, validFrom, validTo, releaseMode, isActive, notes,
      } = req.body || {};

      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          return res.status(400).json({
            error: "name must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.name = name.trim();
      }
      if (profileType !== undefined) {
        assertValidProfileType(profileType);
        data.profileType = profileType;
      }
      if (profileJson !== undefined) {
        data.profileJson = normalizeProfileJson(profileJson);
      }
      if (subBrand !== undefined) {
        if (subBrand === null || subBrand === "") {
          data.subBrand = null;
        } else {
          assertValidSubBrand(subBrand);
          if (!canAccessSubBrand(allowed, subBrand)) {
            return res.status(403).json({
              error: "Sub-brand access denied",
              code: "SUB_BRAND_DENIED",
            });
          }
          data.subBrand = String(subBrand);
        }
      }
      if (category !== undefined) data.category = normalizeOptionalText(category);
      if (agentUserId !== undefined) data.agentUserId = normalizeOptionalInt(agentUserId, "agentUserId");
      if (validFrom !== undefined) data.validFrom = normalizeOptionalDate(validFrom, "validFrom");
      if (validTo !== undefined) data.validTo = normalizeOptionalDate(validTo, "validTo");
      const nextValidFrom = data.validFrom !== undefined ? data.validFrom : existing.validFrom;
      const nextValidTo = data.validTo !== undefined ? data.validTo : existing.validTo;
      if (nextValidFrom && nextValidTo && nextValidFrom > nextValidTo) {
        return res.status(400).json({
          error: "validFrom must be on or before validTo",
          code: "INVALID_DATE_RANGE",
        });
      }
      if (releaseMode !== undefined) {
        const normalizedReleaseMode = releaseMode == null || releaseMode === "" ? "on_booking" : String(releaseMode);
        assertValidReleaseMode(normalizedReleaseMode);
        data.releaseMode = normalizedReleaseMode;
      }
      if (isActive !== undefined) data.isActive = Boolean(isActive);
      if (notes !== undefined) data.notes = notes ? String(notes) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.travelCommissionProfile.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelCommissionProfile",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] update error:", e.message);
      res.status(500).json({ error: "Failed to update commission profile" });
    }
  },
);

// DELETE /api/travel/commission-profiles/:id â€” ADMIN-only hard delete.
// Audit row written BEFORE the prisma.delete fires so the intent is
// captured even if the delete subsequently throws.
router.delete(
  "/commission-profiles/:id",
  verifyToken,
  requirePermission("commission_profiles", "delete"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // ADMINs always have full sub-brand access (getSubBrandAccessSet
      // returns null for ADMIN role), so no additional sub-brand gate
      // is strictly needed here. Keeping the check defensive in case
      // the role/access semantics evolve.
      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      await writeAudit(
        "TravelCommissionProfile",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          name: existing.name,
          profileType: existing.profileType,
          subBrand: existing.subBrand,
        },
      );

      await prisma.travelCommissionProfile.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles/:id/assign â€” ADMIN/MANAGER bulk-assign
// the profile to a list of Contact rows (B2B agents). Body: { contactIds: int[] }.
// Sub-brand-restricted callers must be able to access the profile's sub-brand.
//
// Partial-assignment semantics: when some of the requested contactIds don't
// belong to the tenant (cross-tenant probe, or already-deleted row), they're
// silently skipped â€” assignedCount < requestedCount surfaces the gap to the
// caller without throwing. This mirrors how prisma.updateMany naturally
// behaves with a tenant-scoped `where` clause: rows outside the tenant simply
// don't match, the call succeeds, and the count delta is the signal.
//
// Returns: { profileId, assignedCount, requestedCount }.
// Audit row: action='TRAVEL_COMMISSION_PROFILE_ASSIGNED' with the delta.
router.post(
  "/commission-profiles/:id/assign",
  verifyToken,
  requirePermission("commission_profiles", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { contactIds } = req.body || {};
      if (contactIds === undefined || contactIds === null) {
        return res.status(400).json({
          error: "contactIds required",
          code: "MISSING_FIELDS",
        });
      }
      if (!Array.isArray(contactIds)) {
        return res.status(400).json({
          error: "contactIds must be an array of integers",
          code: "INVALID_CONTACT_IDS",
        });
      }
      if (contactIds.length === 0) {
        return res.status(400).json({
          error: "contactIds must be non-empty",
          code: "MISSING_FIELDS",
        });
      }
      if (!contactIds.every((cid) => Number.isInteger(cid))) {
        return res.status(400).json({
          error: "contactIds entries must all be integers",
          code: "INVALID_CONTACT_IDS",
        });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide and
      // assignable by any authorised caller; sub-brand-scoped profiles
      // require the caller to have access to that sub-brand.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const updateResult = await prisma.contact.updateMany({
        where: {
          id: { in: contactIds },
          tenantId: req.travelTenant.id,
        },
        data: { commissionProfileId: id },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "TRAVEL_COMMISSION_PROFILE_ASSIGNED",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          profileId: id,
          assignedCount: updateResult.count,
          requestedCount: contactIds.length,
        },
      );

      res.json({
        profileId: id,
        assignedCount: updateResult.count,
        requestedCount: contactIds.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] assign error:", e.message);
      res.status(500).json({ error: "Failed to assign commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles/:id/preview â€” operator-facing what-if
// commission calculator. Given a profile id + sale amount (+ optional paxCount),
// parses the stored profileJson, calls lib/agentCommissionCalculator.js, and
// returns the commission that WOULD be paid out for this sale. Useful for UI
// preview before assigning a profile to a contact, or for ad-hoc finance
// sanity checks ("if I sell this Umrah package at â‚¹2.5L, what does the agent
// earn?"). No mutation â€” read-only. Any verified token; sub-brand-scoped.
//
// Body:
//   saleAmount  (required, positive number) â€” sale total in operator currency
//   paxCount    (optional, default 1)       â€” only matters for per_pax_flat
//
// Returns:
//   { profileId, profileName, profileType, saleAmount, paxCount,
//     commission, breakdown }
//
// Defensive behaviour: if the stored profileJson is malformed (parse throws,
// or parses to something the calculator can't interpret), the route still
// returns 200 with commission=0 and a breakdown string surfacing the issue.
// Same rationale as the deep-shape validation deferral at the file header â€”
// a misconfigured profile should be operator-visible at use-time, not a 500
// throw that the calling UI has to handle.
//
// Sub-brand gate: NULL subBrand profiles are tenant-wide and previewable by
// any authorised caller; sub-brand-scoped profiles require caller access to
// that sub-brand.
router.post(
  "/commission-profiles/:id/preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const { saleAmount, paxCount } = req.body || {};
      if (saleAmount === undefined || saleAmount === null) {
        return res.status(400).json({
          error: "saleAmount required",
          code: "MISSING_FIELDS",
        });
      }
      const saleNum = Number(saleAmount);
      if (!Number.isFinite(saleNum) || saleNum < 0) {
        return res.status(400).json({
          error: "saleAmount must be a non-negative number",
          code: "INVALID_SALE_AMOUNT",
        });
      }

      let paxNum = 1;
      if (paxCount !== undefined && paxCount !== null) {
        const p = Number(paxCount);
        if (!Number.isFinite(p) || p < 0 || !Number.isInteger(p)) {
          return res.status(400).json({
            error: "paxCount must be a non-negative integer",
            code: "INVALID_PAX_COUNT",
          });
        }
        paxNum = p;
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Parse stored profileJson defensively. If parse throws (rare â€” POST/PUT
      // validators reject unparseable JSON at write time, but legacy / hand-
      // edited rows may slip through), surface as commission=0 with a
      // diagnostic breakdown rather than a 500 throw.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      let result;
      if (parseError) {
        result = {
          commission: 0,
          breakdown: `malformed profileJson: ${parseError}`,
          profileType: profile.profileType,
        };
      } else {
        result = computeCommission({
          saleAmount: saleNum,
          paxCount: paxNum,
          profile: parsedProfile,
        });
      }

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        saleAmount: saleNum,
        paxCount: paxNum,
        commission: result.commission,
        breakdown: result.breakdown,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] preview error:", e.message);
      res.status(500).json({ error: "Failed to preview commission" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/ledger â€” operator-view commission
// ledger for one profile. Derives a per-Deal commission row for every Deal
// whose linked Contact carries this profile's id in commissionProfileId
// (slice 6's bulk-assign endpoint is what writes that link). For each Deal
// we run the same lib/agentCommissionCalculator.js logic the preview route
// uses (slice 7), so what an operator saw in "preview" becomes the same
// number that appears in the ledger row once the deal exists.
//
// Why this is "derived" not "stored": the dedicated SubAgentCommission table
// (PRD Â§3 FR-3.2.2) is Phase 1-3 work â€” multi-day, blocked on DD-5.3 (commission
// settlement timing) and the b2bCommissionEngine cron. Until that lands, the
// ledger is a pure read over Deal Ã— Contact joined on commissionProfileId.
// Frontend can be built against this contract today; the storage swap
// (Phase 1 lands) is a backend-only change that keeps the response shape.
//
// Scope rules:
//   - Tenant-scoped via Contact.tenantId AND Deal.tenantId (defence in depth).
//   - Sub-brand-restricted callers must be able to access the profile's sub-brand
//     (NULL subBrand is tenant-wide, accessible to all authorised roles).
//   - Soft-deleted Deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing â€” the ledger is operator-readable
//     for any role allowed to see the profile. Read-only endpoint.
//
// Query string:
//   limit   default 50, max 200 (smaller default than list â€” ledger rows
//           are richer; keeps UI table snappy by default)
//   offset  default 0 â€” standard pagination
//   stage   optional Deal.stage filter (e.g. "won" for settled-only view)
//
// Response shape:
//   {
//     profileId, profileName, profileType,
//     entries: [
//       { dealId, dealTitle, dealStage, dealAmount, dealCurrency,
//         contactId, contactName, commission, breakdown, createdAt }
//     ],
//     totalEntries,
//     totalCommission,   // sum of commission across the FILTERED page
//     limit, offset
//   }
//
// Defensive behaviour: if the stored profileJson is malformed (parse throws,
// or yields an uninterpretable shape), every ledger row reports commission=0
// with a diagnostic breakdown â€” same posture as the preview route. Operators
// see the misconfig at use-time rather than a 500 crashing the page.
router.get(
  "/commission-profiles/:id/ledger",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;

      const contactWhere = {
        commissionProfileId: id,
        tenantId: req.travelTenant.id,
      };
      if (profile.subBrand) contactWhere.subBrand = profile.subBrand;
      if (profile.agentUserId != null) contactWhere.assignedToId = profile.agentUserId;

      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: contactWhere,
      };
      if (profile.subBrand) dealWhere.subBrand = profile.subBrand;
      if (profile.validFrom || profile.validTo) {
        dealWhere.createdAt = {};
        if (profile.validFrom) dealWhere.createdAt.gte = profile.validFrom;
        if (profile.validTo) dealWhere.createdAt.lte = profile.validTo;
      }
      if (stageFilter) dealWhere.stage = stageFilter;

      const [deals, totalEntries] = await Promise.all([
        prisma.deal.findMany({
          where: dealWhere,
          include: {
            contact: { select: { id: true, name: true, assignedToId: true, subBrand: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.deal.count({ where: dealWhere }),
      ]);

      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      const completedContactIds = profile.releaseMode === "on_trip_completion"
        ? await loadCompletedItineraryContactIds(
          req.travelTenant.id,
          deals.map((deal) => deal.contact && deal.contact.id).filter(Boolean),
        )
        : new Set();

      const entries = deals.map((d) => {
        let result;
        if (parseError) {
          result = {
            commission: 0,
            breakdown: `malformed profileJson: ${parseError}`,
          };
        } else {
          result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
        }

        const release = buildReleaseDecision(profile, d, completedContactIds);
        const rawCommission = Number(result.commission) || 0;
        const releasedCommission = release.released ? rawCommission : 0;
        const pendingCommission = release.released ? 0 : rawCommission;

        return {
          dealId: d.id,
          dealTitle: d.title,
          dealStage: d.stage,
          dealAmount: d.amount,
          dealCurrency: d.currency,
          contactId: d.contact ? d.contact.id : null,
          contactName: d.contact ? d.contact.name : null,
          commission: rawCommission,
          releasedCommission,
          pendingCommission,
          releaseMode: release.releaseMode,
          released: release.released,
          releaseReason: release.releaseReason,
          breakdown: result.breakdown,
          createdAt: d.createdAt,
        };
      });

      const totalCommission = entries.reduce((acc, entry) => acc + (Number(entry.releasedCommission) || 0), 0);
      const pendingCommission = entries.reduce((acc, entry) => acc + (Number(entry.pendingCommission) || 0), 0);
      const totalCommissionRounded = Math.round((totalCommission + Number.EPSILON) * 100) / 100;
      const pendingCommissionRounded = Math.round((pendingCommission + Number.EPSILON) * 100) / 100;

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        releaseMode: profile.releaseMode || "on_booking",
        entries,
        totalEntries,
        totalCommission: totalCommissionRounded,
        pendingCommission: pendingCommissionRounded,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] ledger error:", e.message);
      res.status(500).json({ error: "Failed to load commission ledger" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/ledger.csv â€” CSV export of the same
// ledger payload the JSON endpoint (slice 9) emits, in operator-downloadable
// shape. Reuses the same Deal Ã— Contact query + agentCommissionCalculator
// computation so a row visible in the JSON ledger has the identical
// commission/breakdown values in the CSV. Mirrors the GSTR-1 export precedent
// (#902 slice 10): UTF-8 with BOM + CRLF line endings + double-quote escaping
// for commas / quotes / newlines, so Excel auto-detects encoding and the
// blob round-trips through any spreadsheet tool without mojibake.
//
// Columns (in order):
//   Deal ID, Deal Title, Stage, Amount, Currency, Contact ID, Contact Name,
//   Commission, Breakdown, Created At
//
// Sub-brand gate + tenant scope + soft-delete filter are identical to slice 9.
// Optional ?stage=<deal stage> filter mirrors the JSON endpoint. Pagination
// query params are intentionally NOT honored â€” operators downloading a CSV
// want the full dataset for that profile, not a paginated slice. This is the
// same posture as the GSTR-1 export: filing exports are always full-period.
//
// Response:
//   200 text/csv; charset=utf-8 with Content-Disposition: attachment;
//   filename="commission-ledger-<profileId>-<profileSlug>.csv" on success.
//   Standard error envelopes (404 PROFILE_NOT_FOUND, 403 SUB_BRAND_DENIED,
//   400 INVALID_ID) match slice 9 for callers that probe before downloading.
router.get(
  "/commission-profiles/:id/ledger.csv",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const stageFilter = req.query.stage ? String(req.query.stage) : null;
      const contactWhere = {
        commissionProfileId: id,
        tenantId: req.travelTenant.id,
      };
      if (profile.subBrand) contactWhere.subBrand = profile.subBrand;
      if (profile.agentUserId != null) contactWhere.assignedToId = profile.agentUserId;

      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: contactWhere,
      };
      if (profile.subBrand) dealWhere.subBrand = profile.subBrand;
      if (profile.validFrom || profile.validTo) {
        dealWhere.createdAt = {};
        if (profile.validFrom) dealWhere.createdAt.gte = profile.validFrom;
        if (profile.validTo) dealWhere.createdAt.lte = profile.validTo;
      }
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        include: { contact: { select: { id: true, name: true, assignedToId: true, subBrand: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      const completedContactIds = profile.releaseMode === "on_trip_completion"
        ? await loadCompletedItineraryContactIds(
          req.travelTenant.id,
          deals.map((deal) => deal.contact && deal.contact.id).filter(Boolean),
        )
        : new Set();

            const csvEscape = (s) => {
        if (s == null) return "";
        const str = String(s);
        if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
        return str;
      };

      const CRLF = "\r\n";
      const BOM = "\uFEFF";
      const header = [
        "Deal ID",
        "Deal Title",
        "Stage",
        "Release Mode",
        "Released",
        "Release Reason",
        "Amount",
        "Currency",
        "Contact ID",
        "Contact Name",
        "Commission",
        "Released Commission",
        "Pending Commission",
        "Breakdown",
        "Created At",
      ];

      const rows = [header.map(csvEscape).join(",")];
      for (const d of deals) {
        let result;
        if (parseError) {
          result = { commission: 0, breakdown: `malformed profileJson: ${parseError}` };
        } else {
          result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
        }
        const release = buildReleaseDecision(profile, d, completedContactIds);
        const rawCommission = Number(result.commission) || 0;
        const releasedCommission = release.released ? rawCommission : 0;
        const pendingCommission = release.released ? 0 : rawCommission;
        rows.push([
          d.id,
          d.title || "",
          d.stage || "",
          release.releaseMode,
          release.released ? "yes" : "no",
          release.releaseReason || "",
          d.amount == null ? "" : Number(d.amount),
          d.currency || "",
          d.contact ? d.contact.id : "",
          d.contact && d.contact.name ? d.contact.name : "",
          rawCommission,
          releasedCommission,
          pendingCommission,
          result.breakdown || "",
          d.createdAt ? new Date(d.createdAt).toISOString() : "",
        ].map(csvEscape).join(","));
      }

      const filenameSlug = String(profile.name || `profile-${profile.id}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `profile-${profile.id}`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="commission-ledger-${profile.id}-${filenameSlug}.csv"`,
      );
      res.status(200).send(BOM + rows.join(CRLF) + CRLF);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] ledger csv error:", e.message);
      res.status(500).json({ error: "Failed to export commission ledger" });
    }
  },
);

// POST /api/travel/commission-profiles/:id/duplicate â€” ADMIN/MANAGER only.
//
// Clones an existing TravelCommissionProfile row into a fresh row under the
// same tenant. Optional body fields { name, subBrand } let the operator
// override the copy's name + sub-brand assignment (e.g. cloning a TMC
// flat-percent profile across to RFU, or naming the variant "Festive 8%
// boost"). Mirrors #908 slice 6's flyer-template duplicate pattern, so
// operator UI affordances stay consistent across the travel admin surface.
//
// Source row is looked up tenant-scoped + sub-brand-scoped (same guard as
// GET/PUT/DELETE), so cross-tenant lookups yield 404 and cross-sub-brand
// reads yield 403. The duplicate inherits profileType / profileJson /
// notes verbatim from the source â€” duplicate is a starting point for
// percentage variations (seasonal tier tweak, sub-brand-specific rate),
// so the full computational shape comes with it. isActive is reset to
// true regardless of source state so the new copy enters the active list
// cleanly; source.isActive=false still duplicates fine (no INVALID_STATE
// gate â€” archiving a profile should not block authoring a variant of it).
//
// Name suffix convention: when no `name` override is supplied, the copy
// is named `"<source.name> (copy)"`. Operators routinely duplicate then
// immediately rename in the editor, so the suffix is a hint not a
// commitment; pin the verbatim string here so consumers (tests, UI
// chrome) can rely on it.
//
// Why no profileJson override on duplicate: the editor flow is "clone
// then edit"; mutating profileJson at duplicate-time would skip the
// validation path that PUT runs. Operators clone then call PUT to tweak
// the new row's rate/tiers, which keeps the deep-shape-validation
// deferral semantics consistent.
router.post(
  "/commission-profiles/:id/duplicate",
  verifyToken,
  requirePermission("commission_profiles", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (source.subBrand && !canAccessSubBrand(allowed, source.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const { name: nameOverride, subBrand: subBrandOverride } = req.body || {};

      let targetSubBrand = source.subBrand;
      if (subBrandOverride !== undefined) {
        if (subBrandOverride === null || subBrandOverride === "") {
          targetSubBrand = null;
        } else {
          assertValidSubBrand(subBrandOverride);
          if (!canAccessSubBrand(allowed, subBrandOverride)) {
            return res.status(403).json({
              error: "Sub-brand access denied",
              code: "SUB_BRAND_DENIED",
            });
          }
          targetSubBrand = String(subBrandOverride);
        }
      }

      let targetName;
      if (nameOverride !== undefined && nameOverride !== null && nameOverride !== "") {
        if (typeof nameOverride !== "string" || !nameOverride.trim()) {
          return res.status(400).json({
            error: "name must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        targetName = nameOverride.trim();
      } else {
        targetName = `${source.name} (copy)`;
      }

      const created = await prisma.travelCommissionProfile.create({
        data: {
          tenantId: req.travelTenant.id,
          name: targetName,
          profileType: source.profileType,
          profileJson: source.profileJson,
          subBrand: targetSubBrand,
          isActive: true,
          notes: source.notes,
        },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "TRAVEL_COMMISSION_PROFILE_DUPLICATED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          newId: created.id,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate commission profile" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/summary/by-contact â€” per-contact
// commission aggregation across the same Deal Ã— Contact join that powers the
// ledger (slice 9) + CSV export (slice 11). One row per Contact that holds this
// profile in commissionProfileId, summarising the number of deals, gross sale
// total, and total commission earned for that contact. This is the data shape
// the eventual monthly-statement cron (FR-3.2.4, b2bCommissionEngine â€” Phase 1-3
// of PRD Â§10) will iterate over: each row maps 1:1 to a sub-agent's monthly
// statement line item. Shipping the read endpoint now means the frontend
// "Top Agents by Commission" table + operator's per-agent settlement view can
// be built ahead of the stored-ledger swap, with no contract churn when the
// storage swap lands.
//
// Why a separate endpoint instead of extending /:id/ledger:
//   - Different aggregation granularity (per-Contact, not per-Deal).
//   - Different sort key surface (operators want to sort by total commission
//     desc, not by deal createdAt desc â€” which is the ledger's only order).
//   - Different pagination shape (typically a small N of agents â€” bounded by
//     the number of contacts on this profile, not the number of deals).
//   Keeping the two reads disjoint lets each evolve independently.
//
// Scope rules (mirror slice 9 ledger):
//   - Tenant-scoped on Contact.tenantId AND Deal.tenantId.
//   - Sub-brand-restricted callers must access the profile's sub-brand
//     (NULL subBrand = tenant-wide, accessible to all authorised roles).
//   - Soft-deleted deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing â€” operator-readable read.
//
// Query string:
//   stage   optional Deal.stage filter (e.g. "won" for settled-only summary)
//   limit   default 50, max 200 â€” smaller default than ledger; per-contact
//           rows are denser than per-deal rows
//   offset  default 0
//   orderBy default "totalCommission:desc"; also accepts "dealCount:desc",
//           "contactName:asc", "totalSale:desc" (all client-side sort over
//           the aggregated array â€” input size is bounded by Contact rows
//           on this profile, so an in-process sort is cheap)
//
// Response shape:
//   {
//     profileId, profileName, profileType,
//     contacts: [
//       { contactId, contactName, dealCount, totalSale, totalCommission }
//     ],
//     totalContacts,
//     grandTotalCommission,
//     limit, offset
//   }
//
// Defensive behaviour: malformed stored profileJson â†’ every per-contact row
// reports totalCommission=0 (each underlying deal contributed 0) with the
// per-row dealCount + totalSale still accurate. Mirrors the ledger posture â€”
// operator sees the misconfig at use-time without a 500 throw.
router.get(
  "/commission-profiles/:id/summary/by-contact",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "totalCommission:desc";

      // Whitelist orderBy to four supported tokens; anything else falls back
      // to the default. Done this way (vs throwing) so a stale frontend
      // sending an outdated token gracefully degrades rather than 400-ing.
      const VALID_ORDER_BY = new Set([
        "totalCommission:desc",
        "totalCommission:asc",
        "dealCount:desc",
        "dealCount:asc",
        "contactName:asc",
        "contactName:desc",
        "totalSale:desc",
        "totalSale:asc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "totalCommission:desc";

      // Pull every deal that joins this profile through its Contact. We pull
      // the full set (no DB-level pagination) because the aggregation is
      // per-Contact, not per-Deal â€” pagination is applied to the AGGREGATED
      // array below. Input size bound: number of deals across all contacts
      // on this one profile. For platinum-scale tenants this stays in the
      // low thousands at most; in-process aggregation is cheap.
      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        include: { contact: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      // Parse stored profileJson once; reuse across all rows. Malformed JSON
      // â†’ every per-deal contribution is 0 and we still report dealCount +
      // totalSale accurately.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-Contact. Map contactId â†’ { contactId, contactName,
      // dealCount, totalSale, totalCommission }. Deals whose Contact link
      // is missing (shouldn't happen given the where clause, but defensive)
      // are bucketed under a synthetic contactId=null entry so the count
      // surface stays accurate.
      const byContact = new Map();
      for (const d of deals) {
        const cid = d.contact ? d.contact.id : null;
        const cname = d.contact ? d.contact.name : null;
        let row = byContact.get(cid);
        if (!row) {
          row = {
            contactId: cid,
            contactName: cname,
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byContact.set(cid, row);
        }
        row.dealCount += 1;
        row.totalSale += Number(d.amount) || 0;

        let commission = 0;
        if (!parseError) {
          const result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
          commission = Number(result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Finalise rounding on per-row sums + sort.
      let contacts = [...byContact.values()].map((r) => ({
        ...r,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      contacts.sort((a, b) => {
        if (field === "contactName") {
          const an = a.contactName || "";
          const bn = b.contactName || "";
          return an.localeCompare(bn) * mult;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalContacts = contacts.length;
      const grandTotalCommission = round2(
        contacts.reduce((acc, c) => acc + (Number(c.totalCommission) || 0), 0),
      );

      // Apply pagination AFTER aggregation + sort.
      const paged = contacts.slice(skip, skip + take);

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        contacts: paged,
        totalContacts,
        grandTotalCommission,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] summary-by-contact error:", e.message);
      res.status(500).json({ error: "Failed to load commission summary" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/summary/by-month â€” monthly time-series
// rollup across the same Deal Ã— Contact join the slice 9 ledger emits. One row
// per YYYY-MM bucket present in the deal set, summarising the number of deals,
// gross sale total, and total commission earned for that month. This is the
// data shape the operator-facing "commission trend" chart consumes (per
// PRD Â§3 FR-3.6.3 â€” per-FY summary with month-over-month trend) and the
// month-input the eventual b2bCommissionEngine cron (FR-3.2.4, Phase 1-3)
// reads when generating the per-month PDF statement. Shipping the read
// endpoint now means UI chart + month-picker can be built ahead of the
// stored-ledger swap, with no contract churn when the storage swap lands.
//
// Why a separate endpoint instead of extending /:id/summary/by-contact:
//   - Different aggregation granularity (per-month, not per-Contact).
//   - Different natural sort (chronological, not by total commission).
//   - Pre-fills a different UI surface (time-series chart vs leaderboard
//     table). Keeping the two reads disjoint lets each evolve independently.
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// Deal.createdAt's UTC year + month. UTC chosen deliberately so the bucket
// labels stay stable across operator timezones â€” finance reconciliation
// works in calendar-month UTC for cross-border deal volume. If the FY
// rollup needs tenant-locale month boundaries later, that's an additive
// query param (?tz=Asia/Kolkata) on this same endpoint, no contract churn.
//
// Scope rules (mirror slices 9 + 14):
//   - Tenant-scoped on Contact.tenantId AND Deal.tenantId.
//   - Sub-brand-restricted callers must access the profile's sub-brand
//     (NULL subBrand = tenant-wide, accessible to all authorised roles).
//   - Soft-deleted deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing â€” operator-readable read.
//
// Query string:
//   stage     optional Deal.stage filter (e.g. "won" for settled-only trend)
//   from      optional inclusive lower bound on bucket (YYYY-MM); rows
//             with month < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY-MM)
//   orderBy   default "month:asc" (chronological); also accepts "month:desc",
//             "totalCommission:desc", "totalCommission:asc", "dealCount:desc",
//             "dealCount:asc", "totalSale:desc", "totalSale:asc". Unknown
//             tokens degrade silently to default â€” same graceful posture
//             slice 14 uses.
//   limit     default 36 (3 years of months), max 120 (10 years). Smaller
//             default than ledger because each bucket is one chart point.
//   offset    default 0
//
// Response shape:
//   {
//     profileId, profileName, profileType,
//     months: [
//       { month: "2026-05", dealCount, totalSale, totalCommission }
//     ],
//     totalMonths,
//     grandTotalCommission,
//     limit, offset
//   }
//
// Defensive behaviour: malformed stored profileJson â†’ every per-month row
// reports totalCommission=0 (each underlying deal contributed 0) with the
// per-row dealCount + totalSale still accurate. Mirrors slice 14 posture.
router.get(
  "/commission-profiles/:id/summary/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 36, 120);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation. Accept "YYYY-MM" form only; anything else is
      // a 400 INVALID_MONTH_FORMAT â€” the bucket labels we emit follow this
      // exact shape, so callers passing month-tokens to from/to should
      // already be using it.
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
        "totalCommission:desc",
        "totalCommission:asc",
        "dealCount:desc",
        "dealCount:asc",
        "totalSale:desc",
        "totalSale:asc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Same Deal Ã— Contact join as slices 9 + 14. No DB-level pagination â€”
      // aggregation runs in-process so we can bucket by UTC YYYY-MM. Input
      // size bound is the same as slice 14 (low thousands at platinum scale).
      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      // Parse stored profileJson once; reuse across all rows.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-month. Map "YYYY-MM" â†’ { month, dealCount,
      // totalSale, totalCommission }. Deals with a null/invalid createdAt
      // are bucketed under "unknown" so the count surface stays accurate.
      const byMonth = new Map();
      for (const d of deals) {
        let monthKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
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
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byMonth.set(monthKey, row);
        }
        row.dealCount += 1;
        row.totalSale += Number(d.amount) || 0;

        let commission = 0;
        if (!parseError) {
          const result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
          commission = Number(result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Finalise rounding on per-row sums.
      let months = [...byMonth.values()].map((r) => ({
        ...r,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set (they have no comparable month token); when no
      // bounds are set, "unknown" stays in the result so the deal-count
      // surface remains complete.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM which is also
      // chronological. "unknown" sorts last in asc / first in desc by
      // virtue of being lexicographically > "9999-12" â€” acceptable for
      // a defensive fallback bucket that should rarely appear.
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
      const grandTotalCommission = round2(
        months.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Pagination applied AFTER aggregation + sort + filter, same as slice 14.
      const paged = months.slice(skip, skip + take);

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        months: paged,
        totalMonths,
        grandTotalCommission,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] summary-by-month error:", e.message);
      res.status(500).json({ error: "Failed to load commission monthly summary" });
    }
  },
);

// GET /api/travel/commission-profiles/:id/summary/by-quarter â€” quarterly
// time-series rollup across the same Deal Ã— Contact join the slice 9 ledger
// emits. One row per YYYY-Qn bucket present in the deal set, summarising the
// number of deals, gross sale total, and total commission earned for that
// quarter. Mirrors slice 15's monthly endpoint but at the quarter granularity
// finance teams use for FY rollups (PRD Â§3 FR-3.6.3 â€” per-FY summary with
// month-over-month trend; quarter is the coarser-bucket sibling). Bucket key
// shape "YYYY-Qn" (e.g. "2026-Q2") derived from Deal.createdAt's UTC year +
// quarter. Same UTC rationale as slice 15 â€” finance reconciliation works in
// calendar quarters; if tenant-locale quarter boundaries are needed later,
// that's an additive ?tz= param on the same endpoint.
//
// Why a separate endpoint instead of an aggregate=quarter query param on
// by-month: callers expect different defaults (12 quarters = 3 years at
// quarter granularity is a sensible UI default; 36 months â‰  12 quarters in
// any meaningful sense). Different default sort + bucket validation regex.
// Keeping the two reads disjoint lets each evolve independently â€” same
// rationale slice 15 cites for not extending by-contact.
//
// Scope rules (identical to slices 9 + 14 + 15):
//   - Tenant-scoped on Contact.tenantId AND Deal.tenantId.
//   - Sub-brand-restricted callers must access the profile's sub-brand
//     (NULL subBrand = tenant-wide, accessible to all authorised roles).
//   - Soft-deleted deals (deletedAt != null) are excluded.
//   - Any verified token; no RBAC narrowing â€” operator-readable read.
//
// Query string:
//   stage     optional Deal.stage filter (e.g. "won" for settled-only trend)
//   from      optional inclusive lower bound on bucket (YYYY-Qn, e.g. 2026-Q1)
//   to        optional inclusive upper bound on bucket (YYYY-Qn)
//   orderBy   default "quarter:asc" (chronological); also accepts "quarter:desc",
//             "totalCommission:desc", "totalCommission:asc", "dealCount:desc",
//             "dealCount:asc", "totalSale:desc", "totalSale:asc". Unknown
//             tokens degrade silently to default â€” same graceful posture
//             slices 14 + 15 use.
//   limit     default 12 (3 years of quarters), max 40 (10 years). Smaller
//             default than by-month because the typical UI surface is one
//             quarterly-trend chart with ~12 bars.
//   offset    default 0
//
// Response shape:
//   {
//     profileId, profileName, profileType,
//     quarters: [
//       { quarter: "2026-Q2", dealCount, totalSale, totalCommission }
//     ],
//     totalQuarters,
//     grandTotalCommission,
//     limit, offset
//   }
//
// Defensive behaviour mirrors slice 15: malformed stored profileJson â†’ every
// per-quarter row reports totalCommission=0 with dealCount + totalSale still
// accurate. Operator sees the misconfig at use-time, not via a 500 throw.
router.get(
  "/commission-profiles/:id/summary/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

      // YYYY-Qn validation â€” accept "YYYY-Q1" through "YYYY-Q4" only. Bucket
      // labels we emit follow this shape so callers passing tokens to from/to
      // should already use it. Anything else is a 400 INVALID_QUARTER_FORMAT.
      const QUARTER_RE = /^\d{4}-Q[1-4]$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-Qn format (e.g. 2026-Q2)",
          code: "INVALID_QUARTER_FORMAT",
        });
      }
      if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-Qn format (e.g. 2026-Q2)",
          code: "INVALID_QUARTER_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "quarter:asc",
        "quarter:desc",
        "totalCommission:desc",
        "totalCommission:asc",
        "dealCount:desc",
        "dealCount:asc",
        "totalSale:desc",
        "totalSale:asc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

      // Same Deal Ã— Contact join as slices 9 + 14 + 15. No DB-level pagination â€”
      // aggregation runs in-process so we can bucket by UTC YYYY-Qn.
      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      // Parse stored profileJson once; reuse across all rows.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-quarter. Map "YYYY-Qn" â†’ { quarter, dealCount,
      // totalSale, totalCommission }. Deals with a null/invalid createdAt
      // are bucketed under "unknown" so the count surface stays accurate.
      // Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec â€” calendar quarters,
      // not Indian-FY April-March quarters. FY tooling is a future overlay
      // on top of this calendar-quarter primitive.
      const byQuarter = new Map();
      for (const d of deals) {
        let quarterKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const q = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${q}`;
          }
        }

        let row = byQuarter.get(quarterKey);
        if (!row) {
          row = {
            quarter: quarterKey,
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byQuarter.set(quarterKey, row);
        }
        row.dealCount += 1;
        row.totalSale += Number(d.amount) || 0;

        let commission = 0;
        if (!parseError) {
          const result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
          commission = Number(result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Finalise rounding on per-row sums.
      let quarters = [...byQuarter.values()].map((r) => ({
        ...r,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set (no comparable token); when no bounds are set,
      // "unknown" stays so the deal-count surface remains complete.
      if (fromRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
      }
      if (toRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
      // chronological (Q1<Q2<Q3<Q4 sorts correctly as ASCII). "unknown"
      // lexicographically > "9999-Q4" so it sorts last in asc / first in desc
      // â€” acceptable for a defensive fallback bucket.
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
      const grandTotalCommission = round2(
        quarters.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Pagination applied AFTER aggregation + sort + filter, same as slices 14+15.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        quarters: paged,
        totalQuarters,
        grandTotalCommission,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] summary-by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to load commission quarterly summary" });
    }
  },
);

// PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 17 â€” annual commission summary.
// Coarser-bucket sibling to slice 15 (by-month) + slice 16 (by-quarter). Same
// Deal Ã— Contact join, same defensive parseError branch, same unknown-bucket
// fallback. Buckets per calendar year (UTC YYYY string). Powers the
// operator-facing "year-over-year commission trend" view (PRD Â§3).
router.get(
  "/commission-profiles/:id/summary/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand gate â€” NULL subBrand profiles are tenant-wide.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Default 10 (a decade); max 30 (3 decades). Tighter ceiling than the
      // by-month / by-quarter siblings because year buckets are larger and a
      // single response rarely needs >30.
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const stageFilter = req.query.stage ? String(req.query.stage) : null;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation â€” accept four-digit year tokens only. Anything else
      // (two-digit "26", five-digit "20261", non-numeric) is a 400.
      const YEAR_RE = /^\d{4}$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY format (e.g. 2026)",
          code: "INVALID_YEAR_FORMAT",
        });
      }
      if (toRaw !== null && !YEAR_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY format (e.g. 2026)",
          code: "INVALID_YEAR_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "year:asc",
        "year:desc",
        "totalCommission:desc",
        "totalCommission:asc",
        "dealCount:desc",
        "dealCount:asc",
        "totalSale:desc",
        "totalSale:asc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Same Deal Ã— Contact join as slices 9 + 14 + 15 + 16. No DB-level
      // pagination â€” aggregation runs in-process so we can bucket by UTC YYYY.
      const dealWhere = {
        tenantId: req.travelTenant.id,
        deletedAt: null,
        contact: { commissionProfileId: id, tenantId: req.travelTenant.id },
      };
      if (stageFilter) dealWhere.stage = stageFilter;

      const deals = await prisma.deal.findMany({
        where: dealWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      // Parse stored profileJson once; reuse across all rows.
      let parsedProfile = null;
      let parseError = null;
      try {
        parsedProfile = JSON.parse(profile.profileJson);
      } catch (e) {
        parseError = e.message;
      }

      // Half-up round to 2dp â€” matches lib/agentCommissionCalculator.round2.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Aggregate per-UTC-year. Map "YYYY" â†’ { year, dealCount, totalSale,
      // totalCommission }. Deals with a null/invalid createdAt are bucketed
      // under "unknown" so the count surface stays accurate.
      const byYear = new Map();
      for (const d of deals) {
        let yearKey = "unknown";
        if (d.createdAt) {
          const dt = new Date(d.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let row = byYear.get(yearKey);
        if (!row) {
          row = {
            year: yearKey,
            dealCount: 0,
            totalSale: 0,
            totalCommission: 0,
          };
          byYear.set(yearKey, row);
        }
        row.dealCount += 1;
        row.totalSale += Number(d.amount) || 0;

        let commission = 0;
        if (!parseError) {
          const result = computeCommission({
            saleAmount: Number(d.amount) || 0,
            paxCount: 1,
            profile: parsedProfile,
          });
          commission = Number(result.commission) || 0;
        }
        row.totalCommission += commission;
      }

      // Finalise rounding on per-row sums.
      let years = [...byYear.values()].map((r) => ({
        ...r,
        totalSale: round2(r.totalSale),
        totalCommission: round2(r.totalCommission),
      }));

      // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
      // either bound is set (no comparable token); when no bounds are set,
      // "unknown" stays so the deal-count surface remains complete.
      if (fromRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
      }
      if (toRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
      }

      // Sort. "year" sorts lexicographically on YYYY which is also
      // chronological. "unknown" lexicographically > "9999" so it sorts last
      // in asc / first in desc â€” acceptable for a defensive fallback bucket.
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
      const grandTotalCommission = round2(
        years.reduce((acc, r) => acc + (Number(r.totalCommission) || 0), 0),
      );

      // Pagination applied AFTER aggregation + sort + filter, same as siblings.
      const paged = years.slice(skip, skip + take);

      res.json({
        profileId: profile.id,
        profileName: profile.name,
        profileType: profile.profileType,
        years: paged,
        totalYears,
        grandTotalCommission,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] summary-by-year error:", e.message);
      res.status(500).json({ error: "Failed to load commission annual summary" });
    }
  },
);

module.exports = router;

