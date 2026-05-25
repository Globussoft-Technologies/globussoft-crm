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
//   GET    /api/travel/webcheckins/:id                        — fetch one
//   POST   /api/travel/webcheckins                            — admin manual create
//   PATCH  /api/travel/webcheckins/:id                        — amend
//   POST   /api/travel/webcheckins/:id/upload-boarding-pass   — multer upload
//   POST   /api/travel/webcheckins/:id/deliver                — mark delivered (stub WA)
//   DELETE /api/travel/webcheckins/:id                        — ADMIN only
//
// Route-precedence note: /upcoming AND /stats MUST mount before /:id
// so the parseInt("upcoming"|"stats") → NaN trap doesn't capture them
// (CLAUDE.md standing rule).
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
