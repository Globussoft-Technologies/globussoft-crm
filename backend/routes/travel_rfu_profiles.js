// Travel CRM — RFU customer profile extension.
//
// One-to-one with Contact (schema @unique on contactId). Stores RFU-
// specific fields that don't belong on the generic Contact:
// passport, visa history, frequent-flyer programs, seat/meal pref,
// travel style, budget min/max, emergency contact, medical notes,
// past complaints, product tier (entry/primary/premium).
//
// PII handling: passport number sits on this row in plaintext per
// current schema (no field-level encryption on String columns
// without a schema change). Phase 1.5 will move passport to the
// fieldEncryption helper alongside the Aadhaar token pattern on
// TripParticipant. For now, retention policy (24m post-trip per Q14)
// is the primary control.
//
// Endpoints:
//   GET    /api/travel/rfu-profiles                            — list
//   POST   /api/travel/rfu-profiles                            — create
//   GET    /api/travel/rfu-profiles/by-contact/:contactId      — lookup
//   GET    /api/travel/rfu-profiles/:id                        — fetch
//   PATCH  /api/travel/rfu-profiles/:id                        — amend
//   DELETE /api/travel/rfu-profiles/:id                        — ADMIN

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const { findDuplicateContactFull } = require("../utils/deduplication");

const VALID_TIERS = ["entry", "primary", "premium"];

async function requireRfuAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-rfu] access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ─── List + create ────────────────────────────────────────────────────

router.get("/rfu-profiles", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.productTier) {
      if (!VALID_TIERS.includes(String(req.query.productTier))) {
        return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
      }
      where.productTier = String(req.query.productTier);
    }
    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;
    const [profiles, total] = await Promise.all([
      prisma.rfuLeadProfile.findMany({ where, orderBy: { id: "desc" }, take, skip }),
      prisma.rfuLeadProfile.count({ where }),
    ]);
    res.json({ profiles, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-rfu] list error:", e.message);
    res.status(500).json({ error: "Failed to list profiles" });
  }
});

router.post("/rfu-profiles", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const { contactId, productTier } = req.body || {};
    if (!contactId) {
      return res.status(400).json({ error: "contactId required", code: "MISSING_FIELDS" });
    }
    const cid = parseInt(contactId, 10);
    if (!Number.isFinite(cid)) {
      return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
    }
    if (productTier && !VALID_TIERS.includes(productTier)) {
      return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
    }

    // PRD §4.5 — passport-key duplicate check. If a passport number is
    // provided AND another profile in this tenant already has it (with a
    // different contactId), surface a 409 so the caller's pop-up flow
    // can offer "link to existing" / "edit existing" instead of silently
    // creating a parallel profile that splits the pilgrim's history.
    // Self-match (same contactId, e.g. accidental double-submit) is
    // allowed through — the @unique contactId catches it as DUPLICATE_PROFILE.
    if (req.body.passportNumber) {
      const collision = await prisma.rfuLeadProfile.findFirst({
        where: {
          tenantId: req.travelTenant.id,
          passportNumber: req.body.passportNumber,
          NOT: { contactId: cid },
        },
        select: { id: true, contactId: true },
      });
      if (collision) {
        return res.status(409).json({
          error: "Another contact already has this passport number",
          code: "DUPLICATE_PASSPORT",
          existingProfileId: collision.id,
          existingContactId: collision.contactId,
        });
      }
    }

    const data = {
      tenantId: req.travelTenant.id,
      contactId: cid,
    };
    const fields = [
      "passportNumber", "passportExpiry",
      "visaHistoryJson", "frequentFlyerJson",
      "seatPref", "mealPref", "travelStyle",
      "budgetMin", "budgetMax",
      "emergencyContactName", "emergencyContactPhone",
      "medicalNotes", "specialAssistance", "pastComplaintsJson",
      "productTier",
    ];
    for (const k of fields) {
      if (req.body[k] !== undefined) {
        const v = req.body[k];
        if (k === "passportExpiry") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "budgetMin" || k === "budgetMax") {
          data[k] = v != null ? Number(v) : null;
        } else {
          data[k] = v ?? null;
        }
      }
    }

    const created = await prisma.rfuLeadProfile.create({ data });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "Profile already exists for this contact", code: "DUPLICATE_PROFILE" });
    }
    console.error("[travel-rfu] create error:", e.message);
    res.status(500).json({ error: "Failed to create profile" });
  }
});

// ─── Stats — tenant-wide RFU profile rollup ──────────────────────────
//
// GET /api/travel/rfu-profiles/stats
// (PRD_TRAVEL_RFU §3 — operator-facing dashboard rollup).
//
// Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
// /commission-profiles/stats. USER-readable anodyne aggregate that powers
// the RFU pilgrim library page header summary strip ("47 RFU profiles ·
// 18 premium · 12 primary · 17 entry · 42 with passport · 4 passports
// expiring < 6mo · last activity 3h ago"). Without this, the frontend
// has to fire {list, count by tier×3, count where passportNumber non-null,
// count where passportExpiry < threshold} as separate round-trips.
//
// RFU is a single-sub-brand surface (requireRfuAccess gates everything
// in this file). No bySubBrand bucket — the route only ever sees rfu
// rows. The schema groups RfuLeadProfile around productTier (the only
// indexed categorical field, see schema.prisma @@index([tenantId,
// productTier])) so byProductTier is the load-bearing bucket.
//
// PRD anchors:
//   - §3.2.6 — pilgrim risk surface: passport expiry < 6 months tags
//     the profile for follow-up (renewal SOP)
//   - §4.5 — PII completeness — operators want to know how many of
//     their pilgrims have a passport on file (the rest can't be
//     ticketed)
//
// Behaviour:
//   - Tenant-scoped count of all RfuLeadProfile rows
//   - byProductTier: { entry: { count }, primary: { count }, premium: { count } }
//                    Tiers with zero rows still appear (pre-seeded).
//   - byTravelStyle: { <style|_unset>: { count } }   — free-text bucket
//                    with null/empty coalesced to '_unset'.
//   - withPassport: count where passportNumber is non-null + non-empty
//   - expiringPassports: count where passportExpiry < (now + 6 months)
//                        AND passportExpiry is non-null
//   - lastUpdatedAt: max(updatedAt) across the visible set; null if 0 rows
//   - ?from / ?to (ISO date bounds) filter rows on createdAt before aggregation.
//
// Safety cap: process at most 2000 profiles per call; if matching total >
// 2000, return counts but mark aggregateExceedsCap=true.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe. No audit
// row: read-only meta surface, mirrors /suppliers/stats +
// /commission-profiles/stats.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE
// the /:id family or `:id="stats"` would 400 INVALID_ID before reaching
// this handler. Same for the /by-contact/:contactId and /check-duplicate
// sub-routes (already mounted below).
const RFU_STATS_CAP = 2000;
const RFU_TIERS = ["entry", "primary", "premium"];
const PASSPORT_EXPIRY_WINDOW_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

router.get(
  "/rfu-profiles/stats",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on createdAt
      const where = { tenantId };
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

      // Bounded fetch + true total so callers know if aggregation is bounded.
      const profiles = await prisma.rfuLeadProfile.findMany({
        where,
        select: {
          id: true,
          productTier: true,
          travelStyle: true,
          passportNumber: true,
          passportExpiry: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: RFU_STATS_CAP,
      });
      const totalMatching = await prisma.rfuLeadProfile.count({ where });
      const aggregateExceedsCap = totalMatching > RFU_STATS_CAP;

      // Pre-seed tier buckets so the response shape is stable regardless
      // of how many rows landed.
      const byProductTier = {};
      for (const t of RFU_TIERS) byProductTier[t] = { count: 0 };

      if (profiles.length === 0) {
        return res.json({
          total: 0,
          byProductTier,
          byTravelStyle: {},
          withPassport: 0,
          expiringPassports: 0,
          lastUpdatedAt: null,
          aggregateExceedsCap: false,
        });
      }

      const byTravelStyle = {};
      let withPassport = 0;
      let expiringPassports = 0;
      let lastUpdatedAt = null;
      const expiryThreshold = new Date(Date.now() + PASSPORT_EXPIRY_WINDOW_MS);

      for (const p of profiles) {
        // Tier bucket — defensive: unknown/null tier → skip (don't pollute
        // the pre-seeded shape with random keys).
        const tier = p.productTier;
        if (tier && RFU_TIERS.includes(tier)) {
          byProductTier[tier].count += 1;
        }

        // travelStyle bucket — coalesce falsy → '_unset' so operators
        // see "how many profiles haven't picked a style yet".
        const styleKey = p.travelStyle ? String(p.travelStyle) : "_unset";
        if (!byTravelStyle[styleKey]) byTravelStyle[styleKey] = { count: 0 };
        byTravelStyle[styleKey].count += 1;

        // Passport-completeness counter.
        if (p.passportNumber && String(p.passportNumber).trim().length > 0) {
          withPassport += 1;
        }

        // Passport-expiry risk window (< 6 months from now).
        if (p.passportExpiry) {
          const exp = p.passportExpiry instanceof Date
            ? p.passportExpiry
            : new Date(p.passportExpiry);
          if (!Number.isNaN(exp.getTime()) && exp < expiryThreshold) {
            expiringPassports += 1;
          }
        }

        // lastUpdatedAt rollup.
        const ts = p.updatedAt instanceof Date ? p.updatedAt : new Date(p.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastUpdatedAt || ts > lastUpdatedAt) lastUpdatedAt = ts;
        }
      }

      res.json({
        total: profiles.length,
        byProductTier,
        byTravelStyle,
        withPassport,
        expiringPassports,
        lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      console.error("[travel-rfu] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise RFU profiles" });
    }
  },
);

// ─── By-month — tenant-wide RFU profile monthly rollup ──────────────
//
// GET /api/travel/rfu-profiles/by-month
// (PRD_TRAVEL_RFU §3 — operator-facing dashboard trend chart).
//
// USER-readable meta endpoint (within RFU-gated callers). Returns one
// row per UTC YYYY-MM bucket for the tenant-scoped RfuLeadProfile
// population so the operator dashboard can render a "pilgrims onboarded
// over time" trend chart without N round-trips per month.
//
// Mirrors #903 slice 24 (/suppliers/by-month) + #908 slice 21
// (/flyer-templates/by-month) + #900 slice 16 (/quotes/by-month) — same
// UTC YYYY-MM bucketing template, same defensive math (null/invalid
// createdAt → "unknown" bucket; excluded when ?from / ?to is set, kept
// otherwise so count surface stays accurate), same orderBy semantics.
//
// Distinct from /rfu-profiles/stats (sibling): /stats is a single
// point-in-time KPI tile (total + byProductTier + byTravelStyle +
// withPassport + expiringPassports + lastUpdatedAt). /by-month is the
// per-month time series across the same population — the two endpoints
// power the RFU pilgrim library page header (KPI strip + trend chart).
//
// Sub-brand handling: RFU is a SINGLE-SUB-BRAND surface
// (requireRfuAccess gates everything in this file). RfuLeadProfile has
// NO subBrand column (the model is RFU-exclusive by design — see
// schema.prisma:4752). The where-clause therefore needs NO additional
// subBrand narrowing — the middleware already gates access. No
// bySubBrand bucket emitted; matches /rfu-profiles/stats posture.
//
// PRD anchors:
//   - §3 — tenant-wide RFU analytics (trend chart for the RFU pilgrim
//          dashboard; per-month drill-down picker)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - JS-side aggregation over a light findMany projection
//     ({ createdAt }) — the population is bounded by tenant scale (low
//     thousands), and the mock-friendly JS aggregation matches the
//     rationale on /suppliers/by-month + /rfu-profiles/stats. No groupBy
//     for marginal efficiency.
//   - "unknown" bucket: rows with null/invalid createdAt land here so
//     the count surface stays accurate. Excluded when ?from / ?to is
//     set (no comparable month token); included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter —
//     same posture as /suppliers/by-month.
//
// No audit row written — read-only meta surface; matches
// /rfu-profiles/stats and /suppliers/by-month posture. USER-readable
// (within RFU-gated callers): anodyne (counts + month-string tokens).
//
// Express route ordering: literal-path /by-month MUST be declared
// BEFORE the /:id family (line 411+) or `:id="by-month"` would 400
// INVALID_ID before reaching this handler. Same convention as
// /rfu-profiles/stats, /rfu-profiles/check-duplicate,
// /rfu-profiles/by-contact/:contactId.
router.get(
  "/rfu-profiles/by-month",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors /suppliers/by-month.
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

      // Tenant-scoped where. NO sub-brand narrowing —
      // requireRfuAccess already gated this caller, and
      // RfuLeadProfile has no subBrand column.
      const where = { tenantId: req.travelTenant.id };

      // Light projection — createdAt is all we need for the bucket
      // totals. No JSON columns pulled.
      const rows = await prisma.rfuLeadProfile.findMany({
        where,
        select: { createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { month, count }.
      // Null/invalid createdAt rows land in "unknown".
      const byMonth = new Map();
      for (const r of rows) {
        let monthKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            monthKey = `${yyyy}-${mm}`;
          }
        }

        let bucket = byMonth.get(monthKey);
        if (!bucket) {
          bucket = { month: monthKey, count: 0 };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. Mirrors /suppliers/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also
      // chronological). "unknown" sorts last in asc / first in desc
      // (lexicographically > "9999-12") — acceptable for a defensive
      // fallback bucket that should rarely appear.
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
        limit: take,
        offset: skip,
      });
    } catch (e) {
      console.error("[travel-rfu] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ─── Phase 2 — preflight duplicate check (PRD §4.5) ──────────────────
//
// The Phase 2 "full pop-up flow with preferences" needs a check-without-
// creating endpoint so the frontend modal can surface the duplicate
// BEFORE the operator submits the form (and before any partial state
// lands in the DB). Returns one of:
//   { duplicate: false }
//   { duplicate: true, matchedBy: 'passport'|'email'|'phone', contact: {...} }
//
// Try-order is passport → email → phone (signal strength descending).
// Tenant-scoped + soft-delete filtered; same contract as the underlying
// findDuplicateContactFull helper.
//
// MUST mount before the `/:id` routes so parseInt("check-duplicate") →
// NaN doesn't capture it.
router.post(
  "/rfu-profiles/check-duplicate",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const { email, phone, passportNumber } = req.body || {};
      if (!email && !phone && !passportNumber) {
        return res
          .status(400)
          .json({ error: "at least one of email/phone/passportNumber required", code: "MISSING_FIELDS" });
      }
      const hit = await findDuplicateContactFull({
        email: email || null,
        phone: phone || null,
        passportNumber: passportNumber || null,
        tenantId: req.travelTenant.id,
      });
      if (!hit) return res.json({ duplicate: false });
      // Trim to a UX-safe contact projection — never leak fields the operator
      // doesn't need (territoryId, portalPasswordHash, etc.).
      const c = hit.contact;
      res.json({
        duplicate: true,
        matchedBy: hit.matchedBy,
        contact: {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          company: c.company,
          subBrand: c.subBrand,
          status: c.status,
        },
      });
    } catch (e) {
      console.error("[travel-rfu] check-duplicate error:", e.message);
      res.status(500).json({ error: "Failed to check duplicate" });
    }
  },
);

// ─── Lookup-by-contact ────────────────────────────────────────────────

router.get(
  "/rfu-profiles/by-contact/:contactId",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const cid = parseInt(req.params.contactId, 10);
      if (!Number.isFinite(cid)) {
        return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
      }
      const row = await prisma.rfuLeadProfile.findFirst({
        where: { contactId: cid, tenantId: req.travelTenant.id },
      });
      if (!row) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
      res.json(row);
    } catch (e) {
      console.error("[travel-rfu] by-contact error:", e.message);
      res.status(500).json({ error: "Failed to get profile" });
    }
  },
);

// ─── Get + patch + delete ────────────────────────────────────────────

router.get("/rfu-profiles/:id", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const row = await prisma.rfuLeadProfile.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!row) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
    res.json(row);
  } catch (e) {
    console.error("[travel-rfu] get error:", e.message);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

router.patch("/rfu-profiles/:id", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.rfuLeadProfile.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!existing) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });

    const data = {};
    const fields = [
      "passportNumber", "passportExpiry",
      "visaHistoryJson", "frequentFlyerJson",
      "seatPref", "mealPref", "travelStyle",
      "budgetMin", "budgetMax",
      "emergencyContactName", "emergencyContactPhone",
      "medicalNotes", "specialAssistance", "pastComplaintsJson",
      "productTier",
    ];
    for (const k of fields) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = req.body[k];
        if (k === "productTier" && v != null && !VALID_TIERS.includes(v)) {
          return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
        }
        if (k === "passportExpiry") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "budgetMin" || k === "budgetMax") {
          data[k] = v != null ? Number(v) : null;
        } else {
          data[k] = v ?? null;
        }
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }
    // PRD §4.5 — passport-key collision check on UPDATE. If the passport
    // is being changed to one already owned by a DIFFERENT contact in
    // this tenant, surface 409. Matches POST guard above.
    if (data.passportNumber) {
      const collision = await prisma.rfuLeadProfile.findFirst({
        where: {
          tenantId: req.travelTenant.id,
          passportNumber: data.passportNumber,
          NOT: { id: existing.id },
        },
        select: { id: true, contactId: true },
      });
      if (collision) {
        return res.status(409).json({
          error: "Another contact already has this passport number",
          code: "DUPLICATE_PASSPORT",
          existingProfileId: collision.id,
          existingContactId: collision.contactId,
        });
      }
    }
    const updated = await prisma.rfuLeadProfile.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[travel-rfu] patch error:", e.message);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.delete(
  "/rfu-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.rfuLeadProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
      await prisma.rfuLeadProfile.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-rfu] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete profile" });
    }
  },
);

module.exports = router;
