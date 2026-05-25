// Travel CRM — WebCheckin CRUD route (PRD §4.6).
//
// Operator-facing CRUD over the WebCheckin model. The model has been
// shipped since the Phase 1 schema work (prisma/schema.prisma:4387)
// and the scheduler cron (cron/webCheckinScheduler.js) has been
// running over it — but the table was empty because nothing created
// rows. This route gives the cron something to scan AND closes the
// W4 exit gate "Web check-in tracking live for booked flights"
// without needing the P1B airline browser-automation work (that
// lands in a later commit per airline).
//
// Auto-create wiring lives in routes/travel_itineraries.js /accept:
// every flight ItineraryItem on an accepted itinerary fans out one
// WebCheckin row. This route is for manual creation, amendment,
// boarding-pass upload, and explicit "agent delivered the pass" marks.
//
// Endpoints:
//   GET    /api/travel/webcheckins                            — list
//   GET    /api/travel/webcheckins/upcoming                   — window opens ≤48h
//   GET    /api/travel/webcheckins/stats                      — tenant-wide rollup
//   GET    /api/travel/webcheckins/by-month                   — tenant-wide monthly creation rollup
//   GET    /api/travel/webcheckins/by-quarter                 — tenant-wide quarterly creation rollup
//   GET    /api/travel/webcheckins/:id                        — fetch one
//   POST   /api/travel/webcheckins                            — admin manual create
//   PATCH  /api/travel/webcheckins/:id                        — amend
//   POST   /api/travel/webcheckins/:id/upload-boarding-pass   — multer upload
//   POST   /api/travel/webcheckins/:id/deliver                — mark delivered (stub WA)
//   DELETE /api/travel/webcheckins/:id                        — ADMIN only
//
// Route-precedence note: /upcoming, /stats, /by-month AND /by-quarter
// MUST mount before /:id so the
// parseInt("upcoming"|"stats"|"by-month"|"by-quarter") → NaN trap
// doesn't capture them (CLAUDE.md standing rule).
//
// WhatsApp dispatch on /deliver is stub-mode (console.log) pending
// Wati BSP creds (Q9) — mirrors backend/cron/contactGreetingsEngine.js
// pattern. The DB-side state change (deliveredAt = now) happens for
// real; the message dispatch logs only.

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
} = require("../middleware/travelGuards");
const { computeWindowOpenAt } = require("../lib/webCheckinWindow");
const { resolveForSubBrand } = require("../lib/subBrandConfig");

const VALID_STATUSES = Object.freeze([
  "pending",
  "reminded",
  "in-progress",
  "done",
  "fallback-agent",
  "failed",
]);

// ─── Multer config: boarding-pass upload ─────────────────────────────
//
// Boarding passes are PDFs from airline portals (or screenshots from
// the agent's manual check-in). Accept application/pdf + image/* (png,
// jpeg, webp). 8MB cap — boarding passes are tiny but multi-segment
// itineraries can stitch into one larger PDF.
//
// Storage: backend/uploads/boarding-passes/ — matches the existing
// pdfRenderer outputs + microsites uploads pattern. Files are served
// via the /uploads static mount in server.js.

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "boarding-passes");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* best-effort */ }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = /^\.(pdf|png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : ".pdf";
      const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      cb(null, `bp-${stamp}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mt = file.mimetype || "";
    if (mt === "application/pdf") return cb(null, true);
    if (/^image\/(png|jpe?g|webp)$/i.test(mt)) return cb(null, true);
    return cb(new Error("Only PDF or PNG/JPEG/WebP image boarding passes are allowed"));
  },
});

// Wrap multer so its rejection paths land as structured 400 errors,
// matching the travel_microsites.js pattern.
function uploadBoardingPassOrReject(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 8MB)", code: "INVALID_FILE" });
    }
    if (/allowed|invalid|not an image/i.test(err.message || "")) {
      return res.status(400).json({ error: err.message, code: "INVALID_FILE" });
    }
    console.error("[travel-webcheckin] upload middleware error:", err.message);
    return res.status(500).json({ error: "Upload error", code: "UPLOAD_FAILED" });
  });
}

// ─── List + upcoming ─────────────────────────────────────────────────

// GET /api/travel/webcheckins — paginated list
router.get("/webcheckins", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.status) {
      const s = String(req.query.status);
      if (!VALID_STATUSES.includes(s)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      where.status = s;
    }
    if (req.query.contactId) {
      const cid = parseInt(req.query.contactId, 10);
      if (Number.isFinite(cid)) where.contactId = cid;
    }
    if (req.query.itineraryId) {
      const iid = parseInt(req.query.itineraryId, 10);
      if (Number.isFinite(iid)) where.itineraryId = iid;
    }
    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;
    const [webcheckins, total] = await Promise.all([
      prisma.webCheckin.findMany({
        where,
        orderBy: { windowOpenAt: "asc" },
        take,
        skip,
      }),
      prisma.webCheckin.count({ where }),
    ]);
    res.json({ webcheckins, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-webcheckin] list error:", e.message);
    res.status(500).json({ error: "Failed to list web check-ins" });
  }
});

// GET /api/travel/webcheckins/upcoming — windowOpenAt within next 48h,
// status in (pending, reminded). MUST mount before /:id.
router.get("/webcheckins/upcoming", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const rows = await prisma.webCheckin.findMany({
      where: {
        tenantId: req.travelTenant.id,
        status: { in: ["pending", "reminded"] },
        windowOpenAt: { gte: now, lte: horizon },
      },
      orderBy: { windowOpenAt: "asc" },
      take: 200,
    });
    res.json({ webcheckins: rows, total: rows.length });
  } catch (e) {
    console.error("[travel-webcheckin] upcoming error:", e.message);
    res.status(500).json({ error: "Failed to list upcoming check-ins" });
  }
});

// ─── Tenant-wide stats rollup ────────────────────────────────────────
//
// GET /api/travel/webcheckins/stats — tenant-wide WebCheckin rollup.
// Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
// /commission-profiles/stats + #908 slice 19 /flyer-templates/global-stats.
// USER-readable anodyne aggregate that powers a WebCheckin operations
// dashboard tile strip ("47 total · 12 delivered · 35 pending · 8 windows
// opening ≤48h · by-airline split · last delivered 2h ago"). Without
// this, the dashboard would have to fan out N count queries per airline
// and per sub-brand — N+1 round-trips for one visual surface.
//
// Behaviour:
//   - Tenant-scoped: WHERE tenantId = req.travelTenant.id.
//   - Sub-brand narrowing: WebCheckin has NO direct subBrand column —
//     the sub-brand lives on the parent Itinerary. When a MANAGER's
//     subBrandAccess set is restrictive, we resolve the visible
//     Itinerary id-set first, then narrow the WebCheckin query by
//     itineraryId IN. Defensive: WebCheckin rows whose itineraryId is
//     null (manual-create path) are KEPT when the caller is unrestricted
//     and DROPPED for a sub-brand-restricted MANAGER (no parent
//     itinerary → no sub-brand attribution → cannot prove access).
//   - Counts:
//       total                 — count of all matching rows
//       delivered             — count where deliveredAt IS NOT NULL
//       pending               — count where deliveredAt IS NULL
//       upcomingWindow        — count where windowOpenAt < now + 48h
//                               AND deliveredAt IS NULL (i.e. coming due
//                               but not yet handled)
//   - Bucketed maps:
//       byAirline: { [airlineCode]: { count } }    — defensive: missing
//                                                    airlineCode → "_unknown"
//       bySubBrand: { [sb]: { count }, _tenant: { count } }
//                                — derived via the WebCheckin's parent
//                                  Itinerary (one batched findMany on
//                                  Itinerary id-set). WebCheckins with
//                                  null itineraryId land in `_tenant`.
//   - lastDeliveredAt          — ISO max(deliveredAt) across delivered
//                                rows, or null when none are delivered.
//   - ?from / ?to (ISO date bounds) filter WebCheckin.createdAt BEFORE
//     aggregation. Invalid → 400 INVALID_DATE.
//
// Safety cap: process at most 2000 rows per call; if total > cap, return
// counts but mark aggregateExceedsCap=true (byAirline/bySubBrand splits
// would be incomplete past the cap).
//
// USER-readable: anodyne aggregate (counts + timestamps); same contract
// as sibling /stats endpoints. No audit row.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE
// the /:id family or `:id="stats"` would 400 INVALID_ID before reaching
// this handler — same trap as /upcoming above.
const WEBCHECKIN_STATS_CAP = 2000;

router.get(
  "/webcheckins/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

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

      // Sub-brand narrowing — WebCheckin lacks a subBrand column, so we
      // resolve the visible Itinerary id-set up front. Unrestricted callers
      // (allowed === null) skip this fetch entirely.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size === 0) {
          // Empty allowed set = deny everything; force-empty query.
          where.itineraryId = -1;
        } else {
          const visibleItins = await prisma.itinerary.findMany({
            where: { tenantId, subBrand: { in: [...allowed] } },
            select: { id: true },
            take: WEBCHECKIN_STATS_CAP,
          });
          if (visibleItins.length === 0) {
            where.itineraryId = -1;
          } else {
            where.itineraryId = { in: visibleItins.map((i) => i.id) };
          }
        }
      }

      const rows = await prisma.webCheckin.findMany({
        where,
        select: {
          id: true,
          airlineCode: true,
          itineraryId: true,
          deliveredAt: true,
          windowOpenAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: WEBCHECKIN_STATS_CAP,
      });

      const totalMatching = await prisma.webCheckin.count({ where });
      const aggregateExceedsCap = totalMatching > WEBCHECKIN_STATS_CAP;

      if (rows.length === 0) {
        return res.json({
          total: 0,
          delivered: 0,
          pending: 0,
          upcomingWindow: 0,
          byAirline: {},
          bySubBrand: {},
          lastDeliveredAt: null,
          aggregateExceedsCap: false,
        });
      }

      // Resolve sub-brand for the matched WebCheckin rows. One batched
      // Itinerary findMany over the distinct itineraryIds; rows with null
      // itineraryId land in the `_tenant` bucket.
      const itinIds = Array.from(
        new Set(rows.map((r) => r.itineraryId).filter((x) => Number.isFinite(x))),
      );
      const itinSubBrandById = new Map();
      if (itinIds.length > 0) {
        const itins = await prisma.itinerary.findMany({
          where: { tenantId, id: { in: itinIds } },
          select: { id: true, subBrand: true },
        });
        for (const it of itins) {
          itinSubBrandById.set(it.id, it.subBrand || null);
        }
      }

      const now = new Date();
      const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      let delivered = 0;
      let pending = 0;
      let upcomingWindow = 0;
      let lastDeliveredAt = null;
      const byAirline = {};
      const bySubBrand = {};

      for (const r of rows) {
        const isDelivered = r.deliveredAt != null;
        if (isDelivered) {
          delivered += 1;
          const ts =
            r.deliveredAt instanceof Date
              ? r.deliveredAt
              : new Date(r.deliveredAt);
          if (!Number.isNaN(ts.getTime())) {
            if (!lastDeliveredAt || ts > lastDeliveredAt) lastDeliveredAt = ts;
          }
        } else {
          pending += 1;
          const w =
            r.windowOpenAt instanceof Date
              ? r.windowOpenAt
              : new Date(r.windowOpenAt);
          if (!Number.isNaN(w.getTime()) && w < horizon) {
            upcomingWindow += 1;
          }
        }

        const aKey = r.airlineCode ? String(r.airlineCode) : "_unknown";
        if (!byAirline[aKey]) byAirline[aKey] = { count: 0 };
        byAirline[aKey].count += 1;

        let sbKey = "_tenant";
        if (r.itineraryId != null) {
          const sb = itinSubBrandById.get(r.itineraryId);
          if (sb) sbKey = sb;
        }
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
        bySubBrand[sbKey].count += 1;
      }

      res.json({
        total: rows.length,
        delivered,
        pending,
        upcomingWindow,
        byAirline,
        bySubBrand,
        lastDeliveredAt: lastDeliveredAt ? lastDeliveredAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-webcheckin] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise web check-ins" });
    }
  },
);

// ─── Tenant-wide monthly rollup ──────────────────────────────────────
//
// GET /api/travel/webcheckins/by-month — tenant-wide WebCheckin creation
// rollup, one row per UTC YYYY-MM bucket. Pairs with /webcheckins/stats
// (the at-a-glance snapshot) to surface the WebCheckin operations trend
// over time on the operator dashboard. Mirrors the by-month template
// shipped on /flyer-templates/by-month (slice 21) + /quotes/by-month
// (slice 16) + /invoices/by-month (slice 29) — same UTC YYYY-MM
// bucketing, same defensive "unknown" bucket math, same orderBy
// semantics, same pagination posture.
//
// Each row carries:
//   - month            — "YYYY-MM" UTC, or "unknown" for null/invalid
//                        createdAt (excluded when from/to is set so the
//                        comparable month-string token still works)
//   - count            — total WebCheckin rows created in this month
//   - deliveredCount   — subset where deliveredAt IS NOT NULL
//   - pendingCount     — remainder (count - deliveredCount)
//
// The delivered/pending split is the WebCheckin analogue of the flyer
// active/archived split — gives the dashboard a "creation cadence vs.
// follow-through cadence" delta at a glance.
//
// PRD §4.6 — WebCheckin tracking dashboard.
//
// Sub-brand narrowing: WebCheckin has NO direct subBrand column — the
// sub-brand lives on the parent Itinerary (same as /stats). When a
// MANAGER's subBrandAccess set is restrictive, we resolve the visible
// Itinerary id-set first, then narrow the WebCheckin query by
// itineraryId IN. Defensive: WebCheckin rows whose itineraryId is null
// (manual-create path) are KEPT when the caller is unrestricted and
// DROPPED for a sub-brand-restricted MANAGER (no parent itinerary →
// no sub-brand attribution → cannot prove access). Same posture as
// /webcheckins/stats above.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}, deliveredCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// USER-readable anodyne aggregate — counts + month-string tokens; no
// audit row written. Matches sibling by-month posture.
//
// Express route ordering: literal-path /by-month MUST be declared
// BEFORE the /:id family or `:id="by-month"` would 400 INVALID_ID
// before reaching this handler. Same trap as /upcoming and /stats above.
const WEBCHECKIN_BY_MONTH_CAP = 5000;

router.get(
  "/webcheckins/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors /flyer-templates/by-month slice 21.
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
        "deliveredCount:asc",
        "deliveredCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      const tenantId = req.travelTenant.id;
      const where = { tenantId };

      // Sub-brand narrowing — WebCheckin lacks a subBrand column, so we
      // resolve the visible Itinerary id-set up front (same as /stats).
      // Unrestricted callers (allowed === null) skip this fetch entirely.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set) {
        if (allowed.size === 0) {
          return res.json({
            months: [],
            totalMonths: 0,
            grandCount: 0,
            grandDeliveredCount: 0,
            limit: take,
            offset: skip,
          });
        }
        const visibleItins = await prisma.itinerary.findMany({
          where: { tenantId, subBrand: { in: [...allowed] } },
          select: { id: true },
          take: WEBCHECKIN_BY_MONTH_CAP,
        });
        if (visibleItins.length === 0) {
          where.itineraryId = -1;
        } else {
          where.itineraryId = { in: visibleItins.map((i) => i.id) };
        }
      }

      // Light projection — createdAt + deliveredAt is enough for the
      // bucket totals. No JSON columns pulled. Same posture as the
      // sibling by-month endpoints — the population is bounded by
      // tenant scale (low thousands of WebCheckins), and JS aggregation
      // matches the rationale on /flyer-templates/by-month.
      const rows = await prisma.webCheckin.findMany({
        where,
        select: { createdAt: true, deliveredAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { count, deliveredCount,
      // pendingCount }. Null/invalid createdAt rows land in "unknown".
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
          bucket = {
            month: monthKey,
            count: 0,
            deliveredCount: 0,
            pendingCount: 0,
          };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;
        if (r.deliveredAt != null) bucket.deliveredCount += 1;
        else bucket.pendingCount += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set; kept otherwise. Mirrors slice 21 /flyer-templates/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also
      // chronological). "unknown" sorts last in asc / first in desc.
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
      const grandCount = months.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
      const grandDeliveredCount = months.reduce(
        (acc, r) => acc + (Number(r.deliveredCount) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as siblings.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandCount,
        grandDeliveredCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-webcheckin] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ─── Tenant-wide quarterly rollup ────────────────────────────────────
//
// GET /api/travel/webcheckins/by-quarter — tenant-wide WebCheckin
// creation rollup, one row per UTC YYYY-Q[1-4] bucket. Completes the
// rollup triplet alongside /webcheckins/stats (snapshot) and
// /webcheckins/by-month (monthly trend). Mirrors the by-quarter
// template shipped on /itineraries/by-quarter (slice 17) +
// /suppliers/by-quarter + /trips/by-quarter — same UTC YYYY-Q[1-4]
// bucketing, same defensive "unknown" bucket math, same orderBy
// semantics, same pagination posture.
//
// Each row carries:
//   - quarter     — "YYYY-Q[1-4]" UTC, or "unknown" for null/invalid
//                   createdAt (excluded when from/to is set so the
//                   comparable quarter-string token still works)
//   - count       — total WebCheckin rows created in this quarter
//   - bySubBrand  — { [sb]: count, _tenant: count } breakdown, derived
//                   via parent Itinerary subBrand. Falsy/missing
//                   subBrand (or null itineraryId on the WebCheckin)
//                   coerces to "_tenant".
//
// PRD §4.6 — WebCheckin tracking dashboard quarterly view.
//
// Sub-brand narrowing: MIRRORS the /webcheckins/by-month handler
// EXACTLY. WebCheckin has NO direct subBrand column — the sub-brand
// lives on the parent Itinerary. When a MANAGER's subBrandAccess set
// is restrictive, we resolve the visible Itinerary id-set first, then
// narrow the WebCheckin query by itineraryId IN. WebCheckin rows whose
// itineraryId is null (manual-create path) are KEPT when the caller is
// unrestricted and DROPPED for a sub-brand-restricted MANAGER (no
// parent itinerary → no sub-brand attribution → cannot prove access).
// Same posture as /webcheckins/stats and /webcheckins/by-month above.
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-Q[1-4] bounds; invalid →
//                     400 INVALID_QUARTER_FORMAT
//   - ?orderBy      — default quarter:asc; accepts quarter:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade
//                     silently to the default
//   - ?limit / ?offset — default 8 / 0; limit caps at 40
//
// USER-readable anodyne aggregate — counts + quarter-string tokens; no
// audit row written. Matches sibling by-quarter posture.
//
// Response envelope:
//   {
//     total: <pre-pagination bucket count>,
//     rows: [{ quarter: "2026-Q2", count: 3, bySubBrand: { tmc: 2, rfu: 1 } }, ...]
//   }
//
// Express route ordering: literal-path /by-quarter MUST be declared
// BEFORE the /:id family or `:id="by-quarter"` would 400 INVALID_ID
// before reaching this handler. Same trap as /upcoming, /stats and
// /by-month above.
const WEBCHECKIN_BY_QUARTER_CAP = 5000;

router.get(
  "/webcheckins/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 8, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

      // YYYY-Q[1-4] validation — mirrors /itineraries/by-quarter slice 17.
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
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

      const tenantId = req.travelTenant.id;
      const where = { tenantId };

      // Sub-brand narrowing — WebCheckin lacks a subBrand column, so we
      // resolve the visible Itinerary id-set up front (same as /stats
      // and /by-month). Unrestricted callers (allowed === null) skip
      // this fetch entirely.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set) {
        if (allowed.size === 0) {
          return res.json({
            total: 0,
            rows: [],
          });
        }
        const visibleItins = await prisma.itinerary.findMany({
          where: { tenantId, subBrand: { in: [...allowed] } },
          select: { id: true },
          take: WEBCHECKIN_BY_QUARTER_CAP,
        });
        if (visibleItins.length === 0) {
          where.itineraryId = -1;
        } else {
          where.itineraryId = { in: visibleItins.map((i) => i.id) };
        }
      }

      // Light projection — createdAt + itineraryId is enough for the
      // bucket totals + bySubBrand breakdown. Same posture as by-month.
      const rows = await prisma.webCheckin.findMany({
        where,
        select: { createdAt: true, itineraryId: true },
      });

      // Resolve sub-brand for the matched WebCheckin rows. One batched
      // Itinerary findMany over the distinct itineraryIds; rows with
      // null itineraryId land in the "_tenant" bucket.
      const itinIds = Array.from(
        new Set(
          rows
            .map((r) => r.itineraryId)
            .filter((x) => Number.isFinite(x)),
        ),
      );
      const itinSubBrandById = new Map();
      if (itinIds.length > 0) {
        const itins = await prisma.itinerary.findMany({
          where: { tenantId, id: { in: itinIds } },
          select: { id: true, subBrand: true },
        });
        for (const it of itins) {
          itinSubBrandById.set(it.id, it.subBrand || null);
        }
      }

      // Aggregate per-UTC-quarter. Map "YYYY-Q[1-4]" → { quarter, count,
      // bySubBrand }. Null/invalid createdAt rows land in "unknown".
      const byQuarter = new Map();
      for (const r of rows) {
        let quarterKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const q = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${q}`;
          }
        }

        let bucket = byQuarter.get(quarterKey);
        if (!bucket) {
          bucket = {
            quarter: quarterKey,
            count: 0,
            bySubBrand: {},
          };
          byQuarter.set(quarterKey, bucket);
        }
        bucket.count += 1;

        // Per-bucket bySubBrand: falsy/missing subBrand coerces to "_tenant".
        let sbKey = "_tenant";
        if (r.itineraryId != null) {
          const sb = itinSubBrandById.get(r.itineraryId);
          if (sb) sbKey = sb;
        }
        bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set; kept otherwise. Mirrors /itineraries/by-quarter
      // (slice 17) posture exactly.
      if (fromRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
      }
      if (toRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Q[1-4] which is
      // also chronological (Q1 < Q2 < Q3 < Q4 in ASCII, years naturally
      // ordered). "unknown" sorts last in asc / first in desc by virtue
      // of being lexicographically > "9999-Q4".
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

      const total = quarters.length;

      // Pagination AFTER aggregation + sort + filter, same as siblings.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        total,
        rows: paged,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-webcheckin] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly rollup" });
    }
  },
);

// ─── Get / create / patch / delete ───────────────────────────────────

// GET /api/travel/webcheckins/:id
router.get("/webcheckins/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const row = await prisma.webCheckin.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!row) return res.status(404).json({ error: "Web check-in not found", code: "NOT_FOUND" });
    res.json(row);
  } catch (e) {
    console.error("[travel-webcheckin] get error:", e.message);
    res.status(500).json({ error: "Failed to get web check-in" });
  }
});

// POST /api/travel/webcheckins — admin manual create. Mostly created
// automatically via /itineraries/:id/accept; this endpoint exists so
// the operator can fill the gap when a flight item lacks the required
// detailsJson fields or the flight was booked outside the itinerary.
router.post(
  "/webcheckins",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        contactId,
        pnr,
        airlineCode,
        flightNumber,
        departureAt,
        passengerName,
        itineraryId,
        windowOpenAt: bodyWindowOpenAt,
        seatPref,
        mealPref,
        assignedAgentId,
      } = req.body || {};

      if (!contactId || !pnr || !airlineCode || !flightNumber || !departureAt || !passengerName) {
        return res.status(400).json({
          error: "contactId, pnr, airlineCode, flightNumber, departureAt, passengerName required",
          code: "MISSING_FIELDS",
        });
      }
      const cid = parseInt(contactId, 10);
      if (!Number.isFinite(cid)) {
        return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
      }
      const dep = new Date(departureAt);
      if (!Number.isFinite(dep.getTime())) {
        return res.status(400).json({ error: "departureAt is not a valid date", code: "INVALID_DATE" });
      }

      // Caller can override windowOpenAt explicitly (rare — typically
      // when an airline ran an early-window promotion); otherwise use
      // the per-airline T-window table.
      const windowAt = bodyWindowOpenAt
        ? new Date(bodyWindowOpenAt)
        : computeWindowOpenAt(dep, airlineCode);

      const created = await prisma.webCheckin.create({
        data: {
          tenantId: req.travelTenant.id,
          contactId: cid,
          itineraryId: itineraryId ? parseInt(itineraryId, 10) : null,
          pnr: String(pnr),
          airlineCode: String(airlineCode).toUpperCase(),
          flightNumber: String(flightNumber),
          departureAt: dep,
          windowOpenAt: windowAt || dep,
          passengerName: String(passengerName),
          seatPref: seatPref ? String(seatPref) : null,
          mealPref: mealPref ? String(mealPref) : null,
          assignedAgentId: assignedAgentId ? parseInt(assignedAgentId, 10) : null,
          status: "pending",
        },
      });
      res.status(201).json(created);
    } catch (e) {
      console.error("[travel-webcheckin] create error:", e.message);
      res.status(500).json({ error: "Failed to create web check-in" });
    }
  },
);

// PATCH /api/travel/webcheckins/:id — amend assignedAgentId, seatPref,
// mealPref, status, attemptsJson, boardingPassUrl. The scheduler cron
// owns 'pending → reminded → fallback-agent' transitions; this endpoint
// exists for the operator to explicitly mark 'done' / 'failed' or
// reassign to an agent.
router.patch(
  "/webcheckins/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.webCheckin.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Web check-in not found", code: "NOT_FOUND" });

      const data = {};
      const {
        status,
        assignedAgentId,
        seatPref,
        mealPref,
        attemptsJson,
        boardingPassUrl,
      } = req.body || {};

      if (status !== undefined) {
        if (!VALID_STATUSES.includes(status)) {
          return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
        }
        data.status = status;
      }
      if (assignedAgentId !== undefined) {
        data.assignedAgentId = assignedAgentId == null ? null : parseInt(assignedAgentId, 10);
      }
      if (seatPref !== undefined) data.seatPref = seatPref || null;
      if (mealPref !== undefined) data.mealPref = mealPref || null;
      if (attemptsJson !== undefined) {
        // attemptsJson shape per webCheckinScheduler.js header comment:
        // [{at, result, errorReason}] — accept either an object/array
        // (will JSON.stringify) or a pre-stringified string. Keep flexible
        // so the cron's future status-transition writes can use whichever
        // form is convenient.
        if (attemptsJson == null) {
          data.attemptsJson = null;
        } else if (typeof attemptsJson === "string") {
          data.attemptsJson = attemptsJson;
        } else {
          data.attemptsJson = JSON.stringify(attemptsJson);
        }
      }
      if (boardingPassUrl !== undefined) data.boardingPassUrl = boardingPassUrl || null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.webCheckin.update({ where: { id }, data });
      res.json(updated);
    } catch (e) {
      console.error("[travel-webcheckin] patch error:", e.message);
      res.status(500).json({ error: "Failed to update web check-in" });
    }
  },
);

// POST /api/travel/webcheckins/:id/upload-boarding-pass — multer upload.
// On success: persists boardingPassUrl and flips status to 'done'.
router.post(
  "/webcheckins/:id/upload-boarding-pass",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  uploadBoardingPassOrReject,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* swallow */ } }
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.webCheckin.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* swallow */ } }
        return res.status(404).json({ error: "Web check-in not found", code: "NOT_FOUND" });
      }
      if (!req.file) {
        return res.status(400).json({
          error: "file is required (multipart field 'file')",
          code: "MISSING_FILE",
        });
      }
      const url = `/uploads/boarding-passes/${req.file.filename}`;
      const updated = await prisma.webCheckin.update({
        where: { id },
        data: { boardingPassUrl: url, status: "done" },
      });
      res.json({ success: true, url, webcheckin: updated });
    } catch (e) {
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* swallow */ } }
      console.error("[travel-webcheckin] upload error:", e.message);
      res.status(500).json({ error: "Failed to upload boarding pass" });
    }
  },
);

// POST /api/travel/webcheckins/:id/deliver — explicit "the agent
// forwarded the boarding pass to the passenger" mark. Stub WhatsApp
// dispatch pending Q9 BSP creds; sets deliveredAt = now.
router.post(
  "/webcheckins/:id/deliver",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.webCheckin.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        include: { tenant: { select: { name: true } } },
      });
      if (!existing) return res.status(404).json({ error: "Web check-in not found", code: "NOT_FOUND" });
      if (!existing.boardingPassUrl) {
        return res.status(409).json({
          error: "No boardingPassUrl on this check-in — upload via /upload-boarding-pass first",
          code: "NO_BOARDING_PASS",
        });
      }

      // Stub Wati dispatch — mirrors contactGreetingsEngine.js pattern.
      // Real WhatsApp send wires in when Q9 BSP creds land.
      let passengerPhone = null;
      try {
        const contact = await prisma.contact.findUnique({
          where: { id: existing.contactId },
          select: { phone: true },
        });
        passengerPhone = contact?.phone || null;
      } catch (_e) { /* tolerate missing contact */ }
      // Q9 cut-over plumbing — resolve the per-sub-brand wabaId so the
      // log line shows which Wati account this WOULD route through. The
      // sub-brand is carried by the parent itinerary (WebCheckin has no
      // subBrand of its own); null itineraryId → "(none)".
      let subBrand = null;
      if (existing.itineraryId) {
        try {
          const itin = await prisma.itinerary.findUnique({
            where: { id: existing.itineraryId },
            select: { subBrand: true },
          });
          subBrand = itin?.subBrand || null;
        } catch (_e) { /* tolerate missing itinerary */ }
      }
      const tenantCfgRow = await prisma.tenant.findUnique({
        where: { id: req.travelTenant.id },
        select: { subBrandConfigJson: true },
      });
      const cfg = subBrand ? resolveForSubBrand(tenantCfgRow, subBrand) : {};
      console.log(
        `[wati-stub] would have sent boarding pass for PNR ${existing.pnr} ` +
          `to ${passengerPhone || "<unknown phone>"} via WhatsApp (pending Q9 creds) — ` +
          `would-route subBrand=${subBrand || "(none)"} wabaId=${cfg.wabaId || "(no-config)"}`,
      );

      const updated = await prisma.webCheckin.update({
        where: { id },
        data: { deliveredAt: new Date() },
      });
      res.json(updated);
    } catch (e) {
      console.error("[travel-webcheckin] deliver error:", e.message);
      res.status(500).json({ error: "Failed to mark delivered" });
    }
  },
);

// DELETE /api/travel/webcheckins/:id — ADMIN only.
router.delete(
  "/webcheckins/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.webCheckin.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Web check-in not found", code: "NOT_FOUND" });
      await prisma.webCheckin.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      console.error("[travel-webcheckin] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete web check-in" });
    }
  },
);

module.exports = router;
