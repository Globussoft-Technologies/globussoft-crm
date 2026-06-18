// Travel CRM — TMC trip CRUD routes (Phase 1 MVP).
//
// Endpoints:
//   GET    /api/travel/trips                                   — list trips
//   POST   /api/travel/trips                                   — create trip
//   GET    /api/travel/trips/by-month                          — tenant-wide monthly rollup
//   GET    /api/travel/trips/by-quarter                        — tenant-wide quarterly rollup
//   GET    /api/travel/trips/:id                               — fetch with children
//   PATCH  /api/travel/trips/:id                               — amend trip
//   DELETE /api/travel/trips/:id                               — ADMIN only (cascades)
//   GET    /api/travel/trips/:id/ops-dashboard                 — PRD §4.9 operational rollup (ADMIN/MANAGER)
//
//   GET    /api/travel/trips/:id/participants                  — list participants
//   POST   /api/travel/trips/:id/participants                  — add participant
//   PATCH  /api/travel/trips/:id/participants/:pid             — amend participant
//   DELETE /api/travel/trips/:id/participants/:pid             — remove participant
//
//   POST   /api/travel/trips/:tripId/participants/:participantId/digilocker/initiate
//                                                              — start DigiLocker OAuth (stub-mode, PRD §4.5)
//   POST   /api/travel/trips/:tripId/participants/:participantId/digilocker/callback
//                                                              — exchange state+code, persist Aadhaar last-4 + token
//
//   GET    /api/travel/trips/:id/documents                     — list required docs
//   POST   /api/travel/trips/:id/documents                     — add required doc
//   DELETE /api/travel/trips/:id/documents/:docId              — remove required doc
//
// DEFERRED to Phase 1.5 (schema is in place; routes pending):
//   - RoomingAssignment (depends on participant assignment UX)
//   - TripPaymentPlan + TripInstalmentPayment (billing flow + reminder cron)
//
// All trips are subBrand="tmc" implicitly (the model only exists for TMC).
// Sub-brand access for ADMINs is full; non-admins need "tmc" in
// User.subBrandAccess[].
//
// tripCode is unique per-tenant via the @unique constraint. Duplicate
// codes return 409 DUPLICATE_TRIP_CODE.
//
// PII: TripParticipant carries passport + Aadhaar token (encrypted). The
// route stores aadhaarTokenId as-is (encrypted at the application layer
// before submit, never by this route); raw Aadhaar numbers MUST NOT be
// stored (Q14 + Aadhaar Act §29 — see TRAVEL_CRM_RISKS.md R8).

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const digilockerClient = require("../services/digilockerClient");
const googleDriveClient = require("../services/googleDriveClient");
const listProjection = require("../lib/listProjection");
const { toE164 } = require("../utils/deduplication");

const VALID_TRIP_STATUSES = ["confirmed", "in-trip", "completed", "cancelled"];

// TMC-only access guard. Trips ARE tmc-only, so we just check that "tmc"
// is in the allowed set (or that the user has full access).
async function requireTmcAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-trips] tmc-access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ─── Trip CRUD ────────────────────────────────────────────────────────

// GET /api/travel/trips
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction). Default
// shape unchanged (full TmcTrip row + _count include) — every existing
// caller (frontend Trips.jsx + TripDetail.jsx + e2e specs) keeps working.
// Callers can opt into the slim summary projection (id + tripCode +
// destination + status + dates + createdAt; NO microsite URL, drive
// folder id, or pricePerStudent) by passing `?fields=summary`. The slim
// path also skips the `_count` include — slim-shape pickers don't need
// per-trip child counts. The projection lookup is centralized in
// backend/lib/listProjection.js so future routes adopt the same shape
// via a single require() instead of cargo-culting the literal `select`.
router.get("/trips", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.status) {
      if (!VALID_TRIP_STATUSES.includes(String(req.query.status))) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      where.status = String(req.query.status);
    }
    if (req.query.schoolContactId) {
      const sid = parseInt(req.query.schoolContactId, 10);
      if (Number.isFinite(sid)) where.schoolContactId = sid;
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: { departDate: "asc" },
      take,
      skip,
    };
    if (isSummary) {
      // Slim path: SQL-level field drop via Prisma `select` — keeps the
      // route handler the only enforcement layer required. The `_count`
      // include is skipped (picker callers don't need per-trip child
      // counts).
      findManyArgs.select = listProjection("TmcTrip", false);
    } else {
      findManyArgs.include = { _count: { select: { participants: true, documentRequirements: true } } };
    }
    const [trips, total] = await Promise.all([
      prisma.tmcTrip.findMany(findManyArgs),
      prisma.tmcTrip.count({ where }),
    ]);
    res.json({ trips, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-trips] list error:", e.message);
    res.status(500).json({ error: "Failed to list trips" });
  }
});

// POST /api/travel/trips
router.post("/trips", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const {
      tripCode, schoolContactId, destination, departDate, returnDate,
      legalEntity, pricePerStudent, status, micrositeUrl, driveFolderId,
    } = req.body || {};

    if (!tripCode || !schoolContactId || !destination || !departDate || !returnDate) {
      return res.status(400).json({
        error: "tripCode, schoolContactId, destination, departDate, returnDate required",
        code: "MISSING_FIELDS",
      });
    }
    const sid = parseInt(schoolContactId, 10);
    if (!Number.isFinite(sid)) {
      return res.status(400).json({ error: "schoolContactId must be a number", code: "INVALID_CONTACT_ID" });
    }
    if (status && !VALID_TRIP_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }
    const depart = new Date(departDate);
    const ret = new Date(returnDate);
    if (!Number.isFinite(depart.getTime()) || !Number.isFinite(ret.getTime())) {
      return res.status(400).json({ error: "invalid date", code: "INVALID_DATE" });
    }
    if (ret < depart) {
      return res.status(400).json({ error: "returnDate must be on or after departDate", code: "INVERTED_DATES" });
    }

    // PRD §4.8 — Drive folder auto-create on confirmed-trip trigger.
    // If the operator explicitly supplied driveFolderId in the body,
    // HONOUR it (manual override). Otherwise, when the new row's
    // status is "confirmed", call the stub Drive client to mint a
    // folder. Best-effort: a stub failure logs but never blocks trip
    // creation — the trip's primary contract is its own row, not the
    // optional Drive linkage. Pending Q1 (Workspace admin creds).
    const finalStatus = status || "confirmed";
    let resolvedDriveFolderId = driveFolderId || null;
    if (!resolvedDriveFolderId && finalStatus === "confirmed") {
      try {
        const folder = await googleDriveClient.createTripFolder({
          tripCode: String(tripCode),
          destination: String(destination),
          departDate: depart,
        });
        resolvedDriveFolderId = folder.folderId;
      } catch (driveErr) {
        console.warn(`[travel-trips] drive auto-create failed for tripCode=${tripCode}: ${driveErr.message} — persisting NULL`);
      }
    }

    const created = await prisma.tmcTrip.create({
      data: {
        tenantId: req.travelTenant.id,
        tripCode: String(tripCode),
        schoolContactId: sid,
        destination: String(destination),
        departDate: depart,
        returnDate: ret,
        legalEntity: legalEntity || "tmc_nexus",
        pricePerStudent: pricePerStudent != null ? Number(pricePerStudent) : null,
        status: finalStatus,
        micrositeUrl: micrositeUrl || null,
        driveFolderId: resolvedDriveFolderId,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "tripCode already in use", code: "DUPLICATE_TRIP_CODE" });
    }
    console.error("[travel-trips] create error:", e.message);
    res.status(500).json({ error: "Failed to create trip" });
  }
});

// ─── Tenant-wide monthly rollup ───────────────────────────────────────

// GET /api/travel/trips/by-month — TMC-only, tenant + sub-brand scoped.
//
// Mirrors the Travel arc's established by-month pattern (#900 slice 16
// /quotes/by-month, #901 slice 29 /invoices/by-month, #907 slice 16
// /itineraries/by-month, #908 slice 21 /flyer-templates/by-month) —
// same UTC YYYY-MM bucketing template, same defensive math (null/invalid
// createdAt → "unknown" bucket, excluded when ?from/?to is set), same
// orderBy semantics. One row per UTC-month present in the scoped trip
// set, summarising count + 4-status splits for that month.
//
// 4-status TMC envelope:
//   confirmed / in-trip / completed / cancelled
//
// Read-only; consumed by the operator-facing "trips trend" chart on the
// Travel dashboard and the per-month drill-down picker into the
// underlying /trips list.
//
// Scope rules:
//   - Tenant-scoped on TmcTrip.tenantId.
//   - TMC-only: requireTmcAccess guard already ensures the caller has
//     "tmc" in subBrandAccess[] (or full access via ADMIN).
//   - Any verified token; no further RBAC narrowing — operator-readable
//     read.
//
// Query string:
//   status   optional TmcTrip.status filter (one of VALID_TRIP_STATUSES);
//            invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY-MM); rows
//            with month < from are excluded.
//   to       optional inclusive upper bound on bucket (YYYY-MM); rows
//            with month > to are excluded.
//   orderBy  default "month:asc" (chronological); also accepts
//            "month:desc", "count:asc|desc", "completedCount:asc|desc".
//            Unknown tokens degrade silently to the default.
//   limit    default 12 (one year of months), max 60 (5 years).
//   offset   default 0
//
// Response shape:
//   {
//     months: [ {
//       month: "2026-05",
//       count,
//       confirmedCount, inTripCount, completedCount, cancelledCount,
//     } ],
//     totalMonths,
//     grandCount,
//     grandCompletedCount,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /trips/:id so Express doesn't try
// to parse "by-month" as a numeric :id (which would 400 INVALID_ID).
router.get("/trips/by-month", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    if (statusFilter && !VALID_TRIP_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // YYYY-MM validation — same regex slice 16 / 29 / 21 use.
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
      "completedCount:asc",
      "completedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-MM.
    const trips = await prisma.tmcTrip.findMany({
      where,
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    // Aggregate per-UTC-month. Map "YYYY-MM" → { ...row counts }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate.
    const byMonth = new Map();
    for (const t of trips) {
      let monthKey = "unknown";
      if (t.createdAt) {
        const dt = t.createdAt instanceof Date
          ? t.createdAt
          : new Date(t.createdAt);
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
          confirmedCount: 0,
          inTripCount: 0,
          completedCount: 0,
          cancelledCount: 0,
        };
        byMonth.set(monthKey, row);
      }

      row.count += 1;
      switch (t.status) {
        case "confirmed": row.confirmedCount += 1; break;
        case "in-trip": row.inTripCount += 1; break;
        case "completed": row.completedCount += 1; break;
        case "cancelled": row.cancelledCount += 1; break;
        default: break;
      }
    }

    let months = [...byMonth.values()];

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable month token); when no
    // bounds are set, "unknown" stays so the count surface remains
    // complete.
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
    const grandCount = months.reduce(
      (acc, r) => acc + (Number(r.count) || 0),
      0,
    );
    const grandCompletedCount = months.reduce(
      (acc, r) => acc + (Number(r.completedCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandCount,
      grandCompletedCount,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    console.error("[travel-trips] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// ─── Tenant-wide quarterly rollup ─────────────────────────────────────

// GET /api/travel/trips/by-quarter — TMC-only, tenant + sub-brand scoped.
//
// Quarter-resolution sibling of GET /trips/by-month above (commit
// 4b0f7e36). Same UTC bucketing template, same defensive math
// (null/invalid createdAt → "unknown" bucket, excluded when ?from/?to
// is set), same orderBy semantics. One row per UTC-calendar-quarter
// present in the scoped trip set, summarising count + 4-status splits
// for that quarter.
//
// Calendar-quarter derivation: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep,
// Q4=Oct-Dec — `Math.floor(month/3)+1` over UTC months [0..11].
//
// 4-status TMC envelope:
//   confirmed / in-trip / completed / cancelled
//
// Read-only; consumed by the operator-facing "trips by quarter" chart
// on the Travel dashboard (quarterly trends, seasonality view).
//
// Scope rules:
//   - Tenant-scoped on TmcTrip.tenantId.
//   - TMC-only: requireTmcAccess guard already ensures the caller has
//     "tmc" in subBrandAccess[] (or full access via ADMIN).
//   - Any verified token; no further RBAC narrowing — operator-readable
//     read.
//
// Query string:
//   status   optional TmcTrip.status filter (one of VALID_TRIP_STATUSES);
//            invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY-Qn); rows
//            with quarter < from are excluded.
//   to       optional inclusive upper bound on bucket (YYYY-Qn); rows
//            with quarter > to are excluded.
//   orderBy  default "quarter:asc" (chronological); also accepts
//            "quarter:desc", "count:asc|desc", "completedCount:asc|desc".
//            Unknown tokens degrade silently to the default.
//   limit    default 12 (3 years of quarters), max 40 (10 years).
//   offset   default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       count,
//       confirmedCount, inTripCount, completedCount, cancelledCount,
//     } ],
//     totalQuarters,
//     grandCount,
//     grandCompletedCount,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /trips/:id so Express doesn't try
// to parse "by-quarter" as a numeric :id (which would 400 INVALID_ID).
router.get("/trips/by-quarter", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    if (statusFilter && !VALID_TRIP_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // YYYY-Qn validation — n ∈ {1,2,3,4}.
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
      "count:asc",
      "count:desc",
      "completedCount:asc",
      "completedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-Qn.
    const trips = await prisma.tmcTrip.findMany({
      where,
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { ...row counts }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate.
    const byQuarter = new Map();
    for (const t of trips) {
      let quarterKey = "unknown";
      if (t.createdAt) {
        const dt = t.createdAt instanceof Date
          ? t.createdAt
          : new Date(t.createdAt);
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
          count: 0,
          confirmedCount: 0,
          inTripCount: 0,
          completedCount: 0,
          cancelledCount: 0,
        };
        byQuarter.set(quarterKey, row);
      }

      row.count += 1;
      switch (t.status) {
        case "confirmed": row.confirmedCount += 1; break;
        case "in-trip": row.inTripCount += 1; break;
        case "completed": row.completedCount += 1; break;
        case "cancelled": row.cancelledCount += 1; break;
        default: break;
      }
    }

    let quarters = [...byQuarter.values()];

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable quarter token); when
    // no bounds are set, "unknown" stays so the count surface remains
    // complete. YYYY-Qn sorts lexicographically AND chronologically
    // (Q1 < Q2 < Q3 < Q4 within the same year).
    if (fromRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
    }
    if (toRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
    // chronological. "unknown" sorts last in asc / first in desc by
    // virtue of being lexicographically > "9999-Q4".
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
    const grandCompletedCount = quarters.reduce(
      (acc, r) => acc + (Number(r.completedCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandCount,
      grandCompletedCount,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    console.error("[travel-trips] by-quarter error:", e.message);
    res.status(500).json({ error: "Failed to compute quarterly rollup" });
  }
});

// ─── Tenant-wide yearly rollup ────────────────────────────────────────

// GET /api/travel/trips/by-year — TMC-only, tenant + sub-brand scoped.
//
// Year-resolution sibling of GET /trips/by-month + /trips/by-quarter
// above. Same UTC bucketing template, same defensive math
// (null/invalid createdAt → "unknown" bucket, excluded when ?from/?to
// is set), same orderBy semantics. One row per UTC-calendar-year
// present in the scoped trip set, summarising count + 4-status splits
// for that year.
//
// Calendar-year derivation: `dt.getUTCFullYear()` over UTC instants.
//
// 4-status TMC envelope:
//   confirmed / in-trip / completed / cancelled
//
// Read-only; consumed by the operator-facing "trips by year" chart
// on the Travel dashboard (annual trends, year-on-year comparison).
//
// Scope rules:
//   - Tenant-scoped on TmcTrip.tenantId.
//   - TMC-only: requireTmcAccess guard already ensures the caller has
//     "tmc" in subBrandAccess[] (or full access via ADMIN).
//   - Any verified token; no further RBAC narrowing — operator-readable
//     read.
//
// Query string:
//   status   optional TmcTrip.status filter (one of VALID_TRIP_STATUSES);
//            invalid → 400 INVALID_STATUS.
//   from     optional inclusive lower bound on bucket (YYYY); rows
//            with year < from are excluded.
//   to       optional inclusive upper bound on bucket (YYYY); rows
//            with year > to are excluded.
//   orderBy  default "year:asc" (chronological); also accepts
//            "year:desc", "count:asc|desc", "completedCount:asc|desc".
//            Unknown tokens degrade silently to the default.
//   limit    default 10 (10 years of history), max 30.
//   offset   default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       count,
//       confirmedCount, inTripCount, completedCount, cancelledCount,
//     } ],
//     totalYears,
//     grandCount,
//     grandCompletedCount,
//     limit, offset
//   }
//
// Route ordering: declared BEFORE GET /trips/:id so Express doesn't try
// to parse "by-year" as a numeric :id (which would 400 INVALID_ID).
router.get("/trips/by-year", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

    if (statusFilter && !VALID_TRIP_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

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
      "count:asc",
      "count:desc",
      "completedCount:asc",
      "completedCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY.
    const trips = await prisma.tmcTrip.findMany({
      where,
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    // Aggregate per-UTC-year. Map "YYYY" → { ...row counts }.
    // Rows with null/invalid createdAt go into "unknown" so counts stay
    // accurate.
    const byYear = new Map();
    for (const t of trips) {
      let yearKey = "unknown";
      if (t.createdAt) {
        const dt = t.createdAt instanceof Date
          ? t.createdAt
          : new Date(t.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }

      let row = byYear.get(yearKey);
      if (!row) {
        row = {
          year: yearKey,
          count: 0,
          confirmedCount: 0,
          inTripCount: 0,
          completedCount: 0,
          cancelledCount: 0,
        };
        byYear.set(yearKey, row);
      }

      row.count += 1;
      switch (t.status) {
        case "confirmed": row.confirmedCount += 1; break;
        case "in-trip": row.inTripCount += 1; break;
        case "completed": row.completedCount += 1; break;
        case "cancelled": row.cancelledCount += 1; break;
        default: break;
      }
    }

    let years = [...byYear.values()];

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable year token); when
    // no bounds are set, "unknown" stays so the count surface remains
    // complete. YYYY sorts lexicographically AND chronologically.
    if (fromRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
    }
    if (toRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
    }

    // Sort. "year" sorts lexicographically on YYYY which is also
    // chronological. "unknown" sorts last in asc / first in desc by
    // virtue of being lexicographically > "9999".
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
    const grandCompletedCount = years.reduce(
      (acc, r) => acc + (Number(r.completedCount) || 0),
      0,
    );

    // Pagination applied AFTER aggregation + sort + filter.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandCount,
      grandCompletedCount,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    console.error("[travel-trips] by-year error:", e.message);
    res.status(500).json({ error: "Failed to compute yearly rollup" });
  }
});

// GET /api/travel/trips/:id
router.get("/trips/:id", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const trip = await prisma.tmcTrip.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      include: {
        // PII payload reduction (same rationale as the #920 FR-3.5
        // ?fields=summary projection on GET /:id/participants): a bare
        // include ships passportNumber / passportExtractionJson (MRZ,
        // DOB) / aadhaar / medical columns to every role with trip
        // access, bypassing the ADMIN+MANAGER gate the passport routes
        // enforce. The detail page only needs identity + parent contact
        // + the three passport status timestamps for its badges.
        participants: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            fullName: true,
            parentName: true,
            parentPhone: true,
            passportExtractedAt: true,
            passportVerifiedAt: true,
            passportRejectedAt: true,
          },
        },
        documentRequirements: { orderBy: { id: "asc" } },
        paymentPlan: true,
        microsite: true,
      },
    });
    if (!trip) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });
    res.json(trip);
  } catch (e) {
    console.error("[travel-trips] get error:", e.message);
    res.status(500).json({ error: "Failed to get trip" });
  }
});

// GET /api/travel/trips/:id/ops-dashboard — PRD §4.9 operational rollup.
//
// Single-shot rollup endpoint that aggregates the 5 sources of truth a
// trip operator needs at-a-glance for a confirmed trip:
//   - TmcTrip                  (header)
//   - TripParticipant          (count + consent capture)
//   - TripInstalmentPayment    (expected vs received + status buckets)
//   - TripDocumentRequirement  (required-doc count)
//   - RoomingAssignment        (rooms + roomed-vs-unroomed)
//
// Computes a departureReadiness score (0–100) as a weighted average:
//   30% consent capture · 30% documents · 30% payment · 10% rooming.
// Returns score=null when a denominator is zero (zero participants OR
// zero expected payments) so the UI can show "Insufficient data"
// rather than rendering a fabricated percentage.
//
// Notes on schema realities (do NOT assume from the PRD prose):
//   - TripDocumentRequirement has { tripId, docType, required } only —
//     it has no `status` or `participantId`. The model lists what docs
//     the trip REQUIRES, not which participant has submitted. With no
//     submitted-tracking on this model we conservatively count
//     submittedCount as 0 (departure readiness should undercount
//     rather than fabricate progress per the PRD's caution).
//   - RoomingAssignment.participantIds is a JSON-stringified array;
//     parse-failures are tolerated and counted as zero for that row.
//   - TmcTrip has no targetStudentCount column, so participants.target
//     is always null today (UI surfaces "no target set" gracefully).
//
// ADMIN + MANAGER only (operational dashboard is for trip operators,
// not end-users). Sub-brand gate inherited from requireTmcAccess.
router.get(
  "/trips/:id/ops-dashboard",
  verifyToken,
  requireTravelTenant,
  requirePermission("trips", "read"),
  requireTmcAccess,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Header fetch is sequential because the parallel children only
      // make sense if the trip exists + belongs to this tenant.
      const trip = await prisma.tmcTrip.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: {
          id: true,
          tripCode: true,
          destination: true,
          departDate: true,
          returnDate: true,
          status: true,
          legalEntity: true,
          pricePerStudent: true,
        },
      });
      if (!trip) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });

      // Parallel-fetch the 4 child collections. TMC trips have tens of
      // participants, not thousands — no pagination needed; aggregate
      // in JS (simpler than Prisma groupBy with parsed JSON columns).
      const [participants, payments, docs, roomings] = await Promise.all([
        prisma.tripParticipant.findMany({
          where: { tripId: trip.id },
          select: { id: true, consentCapturedAt: true },
        }),
        prisma.tripInstalmentPayment.findMany({
          where: { tripId: trip.id },
          select: { amount: true, paidAmount: true, status: true },
        }),
        prisma.tripDocumentRequirement.findMany({
          where: { tripId: trip.id },
          select: { required: true },
        }),
        prisma.roomingAssignment.findMany({
          where: { tripId: trip.id },
          select: { participantIds: true },
        }),
      ]);

      // Participants
      const participantsCount = participants.length;
      const capturedConsent = participants.filter((p) => p.consentCapturedAt != null).length;

      // Payments — Decimal columns come back as Prisma.Decimal; coerce
      // with Number(). Demo amounts are well within Number-safe range.
      let expectedTotalRupees = 0;
      let receivedRupees = 0;
      let pendingCount = 0;
      let partialCount = 0;
      let paidCount = 0;
      let overdueCount = 0;
      for (const p of payments) {
        expectedTotalRupees += Number(p.amount) || 0;
        receivedRupees += Number(p.paidAmount) || 0;
        switch (p.status) {
          case "paid": paidCount++; break;
          case "partial": partialCount++; break;
          case "overdue": overdueCount++; break;
          case "pending":
          default: pendingCount++; break;
        }
      }
      // Round to 2 dp to avoid IEEE-754 trailing noise in JSON.
      expectedTotalRupees = Math.round(expectedTotalRupees * 100) / 100;
      receivedRupees = Math.round(receivedRupees * 100) / 100;

      // Documents — only the `required: true` rows count toward the
      // denominator. No submitted-tracking exists on this model today,
      // so submittedCount = 0 / missingCount = requirementCount. When
      // a submission tracking column lands, flip this to count rows
      // whose status is the most-restrictive "actually-done" bucket.
      const requirementCount = docs.filter((d) => d.required).length;
      const submittedCount = 0;
      const missingCount = requirementCount - submittedCount;

      // Rooming — participantIds is a JSON-string array. Parse-failure
      // is tolerated (counts as 0 for that row, never throws).
      let participantsRoomed = 0;
      let assignmentCount = 0;
      for (const r of roomings) {
        assignmentCount++;
        try {
          const arr = JSON.parse(r.participantIds || "[]");
          if (Array.isArray(arr)) participantsRoomed += arr.length;
        } catch (_e) {
          // Tolerate malformed JSON — counted as 0 for this row.
        }
      }
      // Clamp roomed at participants count — an over-assigned room
      // (participant in two rooms) shouldn't push the rooming
      // percentage above 100%.
      if (participantsCount > 0 && participantsRoomed > participantsCount) {
        participantsRoomed = participantsCount;
      }
      const participantsUnroomed = Math.max(0, participantsCount - participantsRoomed);

      // Departure-readiness score. Each component is a 0-1 fraction;
      // weighted average; final * 100 rounded to integer. Score is
      // null when the data is too thin to make sense of:
      //   - 0 participants (consent + rooming are degenerate)
      //   - 0 expected payments (payment % is degenerate)
      let consentPct = null;
      let docsPct = null;
      let paymentPct = null;
      let roomingPct = null;
      let score = null;
      if (participantsCount > 0 && expectedTotalRupees > 0) {
        const consentFrac = clampFrac(capturedConsent / participantsCount);
        const docsFrac = requirementCount > 0
          ? clampFrac(submittedCount / requirementCount)
          : 1; // No docs required → component is 100% (don't penalise)
        const paymentFrac = clampFrac(receivedRupees / expectedTotalRupees);
        const roomingFrac = clampFrac(participantsRoomed / participantsCount);
        const weighted = (consentFrac * 0.3) + (docsFrac * 0.3) + (paymentFrac * 0.3) + (roomingFrac * 0.1);
        consentPct = Math.round(consentFrac * 100);
        docsPct = Math.round(docsFrac * 100);
        paymentPct = Math.round(paymentFrac * 100);
        roomingPct = Math.round(roomingFrac * 100);
        score = Math.round(weighted * 100);
      }

      res.json({
        trip: {
          id: trip.id,
          tripCode: trip.tripCode,
          destination: trip.destination,
          departDate: trip.departDate,
          returnDate: trip.returnDate,
          status: trip.status,
          legalEntity: trip.legalEntity,
          pricePerStudent: trip.pricePerStudent != null ? Number(trip.pricePerStudent) : null,
        },
        participants: {
          count: participantsCount,
          target: null, // TmcTrip has no targetStudentCount column (deferred — see route header)
          capturedConsent,
        },
        payments: {
          expectedTotalRupees,
          receivedRupees,
          pendingCount,
          partialCount,
          paidCount,
          overdueCount,
        },
        documents: {
          requirementCount,
          submittedCount,
          missingCount,
        },
        rooming: {
          assignmentCount,
          participantsRoomed,
          participantsUnroomed,
        },
        departureReadiness: {
          score,
          components: {
            consentPct,
            docsPct,
            paymentPct,
            roomingPct,
          },
        },
        computedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error("[travel-trips] ops-dashboard error:", e.message);
      res.status(500).json({ error: "Failed to compute ops dashboard" });
    }
  },
);

// Clamp a fraction to [0, 1]. NaN / Infinity from a zero-denominator
// degenerate computation defaults to 0. Hoisted as a module-local
// helper so the ops-dashboard handler reads cleanly.
function clampFrac(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// PATCH /api/travel/trips/:id
router.patch("/trips/:id", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.tmcTrip.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      select: {
        id: true,
        status: true,
        driveFolderId: true,
        tripCode: true,
        destination: true,
        departDate: true,
      },
    });
    if (!existing) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });

    const data = {};
    const {
      destination, departDate, returnDate, legalEntity,
      pricePerStudent, status, micrositeUrl, driveFolderId,
    } = req.body || {};

    if (destination !== undefined) data.destination = String(destination);
    if (departDate !== undefined) {
      const d = new Date(departDate);
      if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: "invalid departDate", code: "INVALID_DATE" });
      data.departDate = d;
    }
    if (returnDate !== undefined) {
      const d = new Date(returnDate);
      if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: "invalid returnDate", code: "INVALID_DATE" });
      data.returnDate = d;
    }
    if (legalEntity !== undefined) data.legalEntity = String(legalEntity);
    if (pricePerStudent !== undefined) data.pricePerStudent = pricePerStudent != null ? Number(pricePerStudent) : null;
    if (status !== undefined) {
      if (!VALID_TRIP_STATUSES.includes(status)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      data.status = status;
    }
    if (micrositeUrl !== undefined) data.micrositeUrl = micrositeUrl || null;
    if (driveFolderId !== undefined) data.driveFolderId = driveFolderId || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    // Cross-field check: if both dates being amended, verify ordering.
    if (data.departDate && data.returnDate && data.returnDate < data.departDate) {
      return res.status(400).json({ error: "returnDate must be on or after departDate", code: "INVERTED_DATES" });
    }

    // PRD §4.8 — Drive folder auto-create on confirmed-trip trigger.
    // Fire when the operator flips status from non-confirmed to
    // "confirmed" AND the existing row has no driveFolderId AND the
    // body did not explicitly supply one (operator override always
    // wins). Trip that already has a folder keeps it (no re-create
    // on status churn). Best-effort: a stub failure logs but does
    // NOT block the PATCH. Pending Q1 (Workspace admin creds).
    const flippingToConfirmed =
      data.status === "confirmed" && existing.status !== "confirmed";

    // PRD_TRAVEL_SUPPLIER_MASTER G042 — credit-limit hard-block.
    // When the trip flips to "confirmed" AND req.body carries a supplierId
    // + a totalAmount (the booking value being projected against the
    // supplier's outstanding A/P), call the credit-check helper. If the
    // projected total exceeds the supplier's configured creditLimit,
    // return 409 CREDIT_LIMIT_EXCEEDED. ADMIN may override via
    // req.body.overrideCreditLimit=true (operator escalation path —
    // logged at write time so the override is auditable).
    if (flippingToConfirmed) {
      const { supplierId: sIdRaw, totalAmount, overrideCreditLimit } = req.body || {};
      const sId = sIdRaw != null ? parseInt(sIdRaw, 10) : null;
      const addAmount = totalAmount != null ? Number(totalAmount) : 0;
      if (Number.isFinite(sId) && Number.isFinite(addAmount) && addAmount > 0) {
        // Look up the caller's role from the DB (verifyToken populates
        // req.user with {userId, tenantId, role}). ADMIN can override.
        const isAdmin = req.user && req.user.role === "ADMIN";
        const overrideRequested = overrideCreditLimit === true || overrideCreditLimit === "true";
        if (!(overrideRequested && isAdmin)) {
          const { checkCreditLimit } = require("../lib/supplierCreditCheck");
          const check = await checkCreditLimit({
            prisma,
            tenantId: req.travelTenant.id,
            supplierId: sId,
            addAmount,
          });
          if (!check.allowed) {
            return res.status(409).json({
              error: "Booking would exceed supplier credit limit",
              code: "CREDIT_LIMIT_EXCEEDED",
              supplierId: sId,
              current: check.current,
              limit: check.limit,
              projected: check.projected,
            });
          }
        }
      }
    }
    if (
      flippingToConfirmed &&
      !existing.driveFolderId &&
      driveFolderId === undefined
    ) {
      try {
        const folder = await googleDriveClient.createTripFolder({
          tripCode: existing.tripCode,
          destination: data.destination ?? existing.destination,
          departDate: data.departDate ?? existing.departDate,
        });
        data.driveFolderId = folder.folderId;
      } catch (driveErr) {
        console.warn(`[travel-trips] drive auto-create failed for tripCode=${existing.tripCode}: ${driveErr.message} — leaving driveFolderId unchanged`);
      }
    }

    const updated = await prisma.tmcTrip.update({ where: { id }, data });

    // PRD_TRAVEL_SUPPLIER_MASTER FR-3.2.a (G037) — auto-create draft PO on
    // booking-confirm. TmcTrip does NOT carry a supplierId column today;
    // the booking-confirm flow accepts an OPTIONAL `supplierId` body field
    // that, when present AND the trip flips to confirmed, fires the auto-PO.
    // Best-effort: any failure (missing supplier, sub-brand mismatch, PO
    // sequence collision) logs but does NOT block the PATCH — the trip's
    // status flip is the load-bearing op. Without supplierId, trip-confirm
    // just doesn't spawn a PO (operator can still manually create one via
    // POST /api/travel/purchase-orders).
    const { supplierId: autoPoSupplierId } = req.body || {};
    if (flippingToConfirmed && autoPoSupplierId) {
      const sid = parseInt(autoPoSupplierId, 10);
      if (Number.isFinite(sid)) {
        try {
          const supplier = await prisma.travelSupplier.findFirst({
            where: { id: sid, tenantId: req.travelTenant.id },
            select: { id: true },
          });
          if (supplier) {
            const poRoute = require("./travel_purchase_orders");
            const poNumber = await poRoute.nextPoNumber(req.travelTenant.id);
            await prisma.travelPurchaseOrder.create({
              data: {
                tenantId: req.travelTenant.id,
                supplierId: sid,
                poNumber,
                status: "draft",
                currency: "INR",
                createdBy: req.user.userId,
                notes: `Auto-generated for trip ${existing.tripCode} on confirmation`,
              },
            });
          }
        } catch (poErr) {
          console.warn(`[travel-trips] auto-PO failed for tripCode=${existing.tripCode}: ${poErr.message}`);
        }
      }
    }

    res.json(updated);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "tripCode already in use", code: "DUPLICATE_TRIP_CODE" });
    }
    console.error("[travel-trips] patch error:", e.message);
    res.status(500).json({ error: "Failed to update trip" });
  }
});

// DELETE /api/travel/trips/:id — ADMIN only, cascades through children.
router.delete(
  "/trips/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("trips", "delete"),
  requireTmcAccess,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.tmcTrip.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Trip not found", code: "NOT_FOUND" });
      await prisma.tmcTrip.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-trips] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete trip" });
    }
  },
);

// ─── Participants ─────────────────────────────────────────────────────

async function loadTrip(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    select: { id: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "NOT_FOUND"; throw err;
  }
  return trip;
}

// GET /api/travel/trips/:id/participants
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction).
// **High-value PII target.** Default shape ships the full TripParticipant
// row including passportNumber, passportExtractionJson (raw vendor
// envelope), aadhaarLast4 + aadhaarTokenId (DigiLocker), parentName /
// parentPhone / parentEmail, and medicalNotes — every field on the
// model is regulated PII / sensitive data. Callers that just need the
// roster picker (fullName + tripId + id) can opt into the slim
// projection via `?fields=summary`; the SQL-level `select` drops every
// PII column at the Prisma layer, so the route handler is the only
// enforcement boundary needed. Detail endpoint (PATCH /participants/:pid
// reads the full row through `findFirst` separately, audited per-row.
router.get("/trips/:id/participants", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tripId: trip.id },
      orderBy: { id: "asc" },
    };
    if (isSummary) {
      findManyArgs.select = listProjection("TripParticipant", false);
    }
    const rows = await prisma.tripParticipant.findMany(findManyArgs);
    res.json({ participants: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participants list error:", e.message);
    res.status(500).json({ error: "Failed to list participants" });
  }
});

router.post("/trips/:id/participants", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const {
      fullName, passportNumber, passportExpiry, passportDocId,
      aadhaarLast4, aadhaarTokenId, parentName, parentPhone, parentEmail,
      medicalNotes, consentCapturedAt,
    } = req.body || {};
    if (!fullName) {
      return res.status(400).json({ error: "fullName required", code: "MISSING_FIELDS" });
    }
    // Aadhaar Act §29 safety — refuse if caller submits a raw 12-digit
    // Aadhaar number. Only `aadhaarLast4` (display) + `aadhaarTokenId`
    // (DigiLocker token) are allowed in storage.
    if (aadhaarLast4 && !/^\d{4}$/.test(String(aadhaarLast4))) {
      return res.status(400).json({
        error: "aadhaarLast4 must be exactly 4 digits (don't submit full Aadhaar number)",
        code: "INVALID_AADHAAR_LAST4",
      });
    }
    // Bare 10-digit Indian mobiles get +91 auto-prepended (Travel Stall is
    // Indian-only). E.164 (`+919876543210`) and 12-digit `91XXXXXXXXXX` are
    // also accepted. Returns null on garbage like `abcde` → 400.
    let normalizedPhone = null;
    if (parentPhone) {
      normalizedPhone = toE164(parentPhone);
      if (!normalizedPhone) {
        return res.status(400).json({
          error: "parentPhone must be a 10-digit Indian mobile (6-9 prefix) or E.164 international number",
          code: "INVALID_PHONE",
        });
      }
    }

    const created = await prisma.tripParticipant.create({
      data: {
        tripId: trip.id,
        fullName: String(fullName),
        passportNumber: passportNumber || null,
        passportExpiry: passportExpiry ? new Date(passportExpiry) : null,
        passportDocId: passportDocId ? parseInt(passportDocId, 10) : null,
        aadhaarLast4: aadhaarLast4 || null,
        aadhaarTokenId: aadhaarTokenId || null,
        parentName: parentName || null,
        parentPhone: normalizedPhone,
        parentEmail: parentEmail || null,
        medicalNotes: medicalNotes || null,
        consentCapturedAt: consentCapturedAt ? new Date(consentCapturedAt) : null,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant create error:", e.message);
    res.status(500).json({ error: "Failed to create participant" });
  }
});

router.patch("/trips/:id/participants/:pid", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid)) {
      return res.status(400).json({ error: "pid must be a number", code: "INVALID_PARTICIPANT_ID" });
    }
    const existing = await prisma.tripParticipant.findFirst({
      where: { id: pid, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Participant not found", code: "PARTICIPANT_NOT_FOUND" });

    const data = {};
    const allowed = [
      "fullName", "passportNumber", "passportExpiry", "passportDocId",
      "aadhaarLast4", "aadhaarTokenId", "parentName", "parentPhone", "parentEmail",
      "medicalNotes", "consentCapturedAt",
    ];
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = req.body[k];
        if (k === "aadhaarLast4" && v && !/^\d{4}$/.test(String(v))) {
          return res.status(400).json({
            error: "aadhaarLast4 must be exactly 4 digits",
            code: "INVALID_AADHAAR_LAST4",
          });
        }
        if (k === "passportExpiry" || k === "consentCapturedAt") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "passportDocId") {
          data[k] = v ? parseInt(v, 10) : null;
        } else if (k === "parentPhone") {
          if (!v) {
            data[k] = null;
          } else {
            const normalized = toE164(v);
            if (!normalized) {
              return res.status(400).json({
                error: "parentPhone must be a 10-digit Indian mobile (6-9 prefix) or E.164 international number",
                code: "INVALID_PHONE",
              });
            }
            data[k] = normalized;
          }
        } else {
          data[k] = v ?? null;
        }
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }
    const updated = await prisma.tripParticipant.update({ where: { id: pid }, data });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant patch error:", e.message);
    res.status(500).json({ error: "Failed to update participant" });
  }
});

router.delete("/trips/:id/participants/:pid", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid)) {
      return res.status(400).json({ error: "pid must be a number", code: "INVALID_PARTICIPANT_ID" });
    }
    const existing = await prisma.tripParticipant.findFirst({
      where: { id: pid, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Participant not found", code: "PARTICIPANT_NOT_FOUND" });
    await prisma.tripParticipant.delete({ where: { id: pid } });
    res.json({ deleted: true, id: pid });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] participant delete error:", e.message);
    res.status(500).json({ error: "Failed to delete participant" });
  }
});

// ─── DigiLocker Aadhaar verification (stub-mode) ─────────────────────
//
// PRD §4.5 + §4.7. Currently uses the stub client in
// services/digilockerClient.js — real OAuth flow lands when the
// Travel Stall partner-registration creds (Q3) drop. Swap point is
// that single file; routes + DB shape stay identical.
//
// /initiate creates an OAuth-state-tracking row + returns the URL the
// browser would redirect to. /callback verifies the state, exchanges
// the (state, code) pair for an Aadhaar last-4 + opaque token, and
// writes those onto the TripParticipant. The token NEVER appears in
// any HTTP response — only persisted server-side (matches the existing
// `aadhaarTokenId` convention for opaque PII tokens).

async function loadTripAndParticipant(req) {
  const tripId = parseInt(req.params.tripId, 10);
  const participantId = parseInt(req.params.participantId, 10);
  if (!Number.isFinite(tripId)) {
    const err = new Error("tripId must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  if (!Number.isFinite(participantId)) {
    const err = new Error("participantId must be a number"); err.status = 400; err.code = "INVALID_PARTICIPANT_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id: tripId, tenantId: req.travelTenant.id },
    select: { id: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "NOT_FOUND"; throw err;
  }
  const participant = await prisma.tripParticipant.findFirst({
    where: { id: participantId, tripId: trip.id },
    select: { id: true, tripId: true },
  });
  if (!participant) {
    const err = new Error("Participant not found"); err.status = 404; err.code = "PARTICIPANT_NOT_FOUND"; throw err;
  }
  return { trip, participant };
}

// POST /api/travel/trips/:tripId/participants/:participantId/digilocker/initiate
router.post(
  "/trips/:tripId/participants/:participantId/digilocker/initiate",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const { participant } = await loadTripAndParticipant(req);
      const { redirectUri } = req.body || {};
      if (!redirectUri || typeof redirectUri !== "string") {
        return res.status(400).json({ error: "redirectUri required", code: "MISSING_FIELDS" });
      }
      const { state, oauthUrl } = await digilockerClient.initiateSession({
        participantId: participant.id,
        redirectUri,
      });
      const session = await prisma.digilockerSession.create({
        data: {
          tenantId: req.travelTenant.id,
          participantId: participant.id,
          state,
          status: "initiated",
          redirectUri,
        },
        select: { id: true, state: true },
      });
      res.status(200).json({ state: session.state, oauthUrl, sessionId: session.id });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trips] digilocker initiate error:", e.message);
      res.status(500).json({ error: "Failed to initiate DigiLocker session" });
    }
  },
);

// POST /api/travel/trips/:tripId/participants/:participantId/digilocker/callback
router.post(
  "/trips/:tripId/participants/:participantId/digilocker/callback",
  verifyToken,
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const { participant } = await loadTripAndParticipant(req);
      const { state, code } = req.body || {};
      if (!state || typeof state !== "string") {
        return res.status(400).json({ error: "state required", code: "MISSING_FIELDS" });
      }
      // Scope by tenant + participant so a state leaked from one tenant
      // can't be used to write Aadhaar onto another tenant's participant.
      const session = await prisma.digilockerSession.findFirst({
        where: { state, tenantId: req.travelTenant.id, participantId: participant.id },
      });
      if (!session) {
        return res.status(404).json({ error: "DigiLocker session not found", code: "SESSION_NOT_FOUND" });
      }
      if (session.status === "verified") {
        // Replay protection — the state has already been consumed.
        return res.status(409).json({ error: "DigiLocker session already verified", code: "INVALID_STATE" });
      }
      if (session.status === "expired" || session.status === "failed") {
        return res.status(410).json({ error: `DigiLocker session ${session.status}`, code: "SESSION_GONE" });
      }
      const { aadhaarLast4, aadhaarTokenId } = await digilockerClient.exchangeCallback({ state, code });

      await prisma.$transaction([
        prisma.digilockerSession.update({
          where: { id: session.id },
          data: {
            status: "verified",
            verifiedAt: new Date(),
            resultLast4: aadhaarLast4,
            resultTokenId: aadhaarTokenId,
          },
        }),
        prisma.tripParticipant.update({
          where: { id: participant.id },
          data: { aadhaarLast4, aadhaarTokenId },
        }),
      ]);

      // NOTE: never leak resultTokenId / aadhaarTokenId in the response —
      // token stays server-side per the route header convention.
      res.status(200).json({ verified: true, aadhaarLast4 });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-trips] digilocker callback error:", e.message);
      res.status(500).json({ error: "Failed to complete DigiLocker verification" });
    }
  },
);

// ─── Document requirements ────────────────────────────────────────────

router.get("/trips/:id/documents", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const rows = await prisma.tripDocumentRequirement.findMany({
      where: { tripId: trip.id },
      orderBy: { id: "asc" },
    });
    res.json({ documents: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] docs list error:", e.message);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

router.post("/trips/:id/documents", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const { docType, required } = req.body || {};
    if (!docType) {
      return res.status(400).json({ error: "docType required", code: "MISSING_FIELDS" });
    }
    const created = await prisma.tripDocumentRequirement.create({
      data: {
        tripId: trip.id,
        docType: String(docType),
        required: required !== false,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] doc create error:", e.message);
    res.status(500).json({ error: "Failed to create document requirement" });
  }
});

router.delete("/trips/:id/documents/:docId", verifyToken, requireTravelTenant, requireTmcAccess, async (req, res) => {
  try {
    const trip = await loadTrip(req);
    const docId = parseInt(req.params.docId, 10);
    if (!Number.isFinite(docId)) {
      return res.status(400).json({ error: "docId must be a number", code: "INVALID_DOC_ID" });
    }
    const existing = await prisma.tripDocumentRequirement.findFirst({
      where: { id: docId, tripId: trip.id },
    });
    if (!existing) return res.status(404).json({ error: "Document req not found", code: "DOC_NOT_FOUND" });
    await prisma.tripDocumentRequirement.delete({ where: { id: docId } });
    res.json({ deleted: true, id: docId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-trips] doc delete error:", e.message);
    res.status(500).json({ error: "Failed to delete document requirement" });
  }
});

module.exports = router;
