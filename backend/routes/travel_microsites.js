// Travel CRM — TMC trip microsite routes (Phase 1).
//
// Each TmcTrip can have at most one TripMicrosite (one-to-one via
// schema's @unique([tripId])). The microsite is the public-facing trip
// page (parent/teacher landing) that lives on
// trip-<tripCode>.tmc.travelstall.in per Q21.
//
// Endpoints:
//   POST   /api/travel/trips/:tripId/microsite       — create/publish (ADMIN+MGR)
//   GET    /api/travel/trips/:tripId/microsite       — admin fetch (ADMIN+MGR)
//   PATCH  /api/travel/trips/:tripId/microsite       — amend content (ADMIN+MGR)
//   DELETE /api/travel/trips/:tripId/microsite       — unpublish (ADMIN only)
//   GET    /api/travel/microsites/public/:publicUuid — PUBLIC info (no auth)
//
// Public endpoint returns a sanitised payload (trip name, destination,
// dates, itineraryHtml, faqJson). It does NOT return participants,
// rooming, payment plans, or any PII — those land behind the OTP-gated
// /:uuid/full endpoint shipping in Day 11 once SMS provider creds
// (Q9 → still pending Yasin's Meta Business Manager handover) land.
//
// publicUuid uses crypto.randomUUID() — 128-bit unguessable. Schema has
// @@unique([publicUuid]) so duplicate-uuid creates are impossible.

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { JWT_SECRET } = require("../config/secrets");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const { resolveForSubBrand } = require("../lib/subBrandConfig");

// OTP constants for the public microsite PII reveal flow (PRD §4.5).
// 4-digit code per the PRD spec, 10-minute validity, 30-minute access
// token after verification, 60-second cool-down between OTP requests
// for the same (micrositeId, phone, purpose) tuple.
const OTP_LENGTH = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_ACCESS_TTL = "30m";
const VALID_OTP_PURPOSES = ["registration", "payment-plan", "document-checklist", "teacher-access"];

// SMS dispatch stub — when Wati BSP creds (Q9) land, replace the
// console.log with a prisma.whatsAppMessage.create call. The function
// signature is intentionally minimal so the cutover is a one-line
// substitution.
//
// wabaId is the resolved per-sub-brand WABA id (see lib/subBrandConfig)
// — included for observability so operators can confirm which Wati
// account the OTP WOULD route through once creds land. Microsites are
// always TMC sub-brand per the route's domain ownership.
async function sendOtpStub(phone, code, purpose, wabaId) {
  console.log(
    `[travel-microsite] OTP dispatch stub — phone=${phone} purpose=${purpose} code=${code} ` +
      `(will route through Wati once creds land — would-route subBrand=tmc ` +
      `wabaId=${wabaId || "(no-config)"})`,
  );
}

// Image upload for the microsite editor. Mirrors routes/booking_pages.js's
// multer pattern (disk storage under backend/uploads/, PNG/JPEG/WebP only,
// 4MB cap). Files land under uploads/microsites/ and are served from the
// existing /uploads static mount in server.js.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "microsites");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* best-effort */ }
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = /^\.(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : ".png";
      const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      cb(null, `ms-${stamp}${safeExt}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || "")) return cb(null, true);
    return cb(new Error("Only PNG / JPEG / WebP images are allowed"));
  },
});

// Wrap multer so its rejection paths (LIMIT_FILE_SIZE, fileFilter Error)
// land as 400 INVALID_FILE instead of bubbling to Express's default
// 500 handler. The route's own try/catch can only see errors thrown
// INSIDE the handler — by the time the request reaches the handler,
// multer has already either populated req.file or short-circuited via
// next(err). This wrapper sits between multer and the handler and
// converts the err arg into a structured 400 response.
function uploadImageOrReject(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 4MB)", code: "INVALID_FILE" });
    }
    if (/allowed|invalid|not an image/i.test(err.message || "")) {
      return res.status(400).json({ error: err.message, code: "INVALID_FILE" });
    }
    console.error("[travel-microsite] upload middleware error:", err.message);
    return res.status(500).json({ error: "Upload error", code: "UPLOAD_FAILED" });
  });
}

async function requireTmcAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-microsite] access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// Public projection — what's safe to return on the unauthed
// /microsites/public/:uuid endpoint. Excludes: trip-level FKs (would
// leak schoolContactId enumeration), payment plan, document
// requirements, participants. Includes only what a parent/teacher
// needs to see on the landing page before they OTP-verify.
const PUBLIC_SELECT = {
  publicUuid: true,
  subdomain: true,
  itineraryHtml: true,
  faqJson: true,
  publishedAt: true,
  expiresAt: true,
  trip: {
    select: {
      destination: true,
      departDate: true,
      returnDate: true,
      tripCode: true,
    },
  },
};

async function loadTrip(req) {
  const tripId = parseInt(req.params.tripId, 10);
  if (!Number.isFinite(tripId)) {
    const err = new Error("tripId must be a number"); err.status = 400; err.code = "INVALID_ID"; throw err;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: { id: tripId, tenantId: req.travelTenant.id },
    select: { id: true, tripCode: true },
  });
  if (!trip) {
    const err = new Error("Trip not found"); err.status = 404; err.code = "TRIP_NOT_FOUND"; throw err;
  }
  return trip;
}

// ─── Admin create / fetch / update / delete ──────────────────────────

// POST /api/travel/trips/:tripId/microsite
router.post(
  "/trips/:tripId/microsite",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const { subdomain, itineraryHtml, faqJson, expiresAt } = req.body || {};
      if (!itineraryHtml) {
        return res.status(400).json({ error: "itineraryHtml required", code: "MISSING_FIELDS" });
      }
      const existing = await prisma.tripMicrosite.findUnique({ where: { tripId: trip.id } });
      if (existing) {
        return res.status(409).json({
          error: "Microsite already exists for this trip — use PATCH to amend",
          code: "MICROSITE_EXISTS",
          micrositeId: existing.id,
        });
      }

      // Generate the publicUuid + default subdomain. Subdomain defaults
      // to "trip-<tripCode>" per Q21 unless caller overrides.
      const publicUuid = crypto.randomUUID();
      const sub = subdomain ? String(subdomain) : `trip-${trip.tripCode}`;

      const created = await prisma.tripMicrosite.create({
        data: {
          tenantId: req.travelTenant.id,
          tripId: trip.id,
          publicUuid,
          subdomain: sub,
          itineraryHtml: String(itineraryHtml),
          faqJson: faqJson ? String(faqJson) : null,
          publishedAt: new Date(),
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "P2002") {
        return res.status(409).json({ error: "subdomain collision", code: "DUPLICATE_SUBDOMAIN" });
      }
      console.error("[travel-microsite] create error:", e.message);
      res.status(500).json({ error: "Failed to create microsite" });
    }
  },
);

// GET /api/travel/trips/:tripId/microsite — admin read
router.get(
  "/trips/:tripId/microsite",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const ms = await prisma.tripMicrosite.findUnique({
        where: { tripId: trip.id },
      });
      if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
      res.json(ms);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] get error:", e.message);
      res.status(500).json({ error: "Failed to get microsite" });
    }
  },
);

// PATCH /api/travel/trips/:tripId/microsite
router.patch(
  "/trips/:tripId/microsite",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const existing = await prisma.tripMicrosite.findUnique({ where: { tripId: trip.id } });
      if (!existing) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });

      const data = {};
      const { subdomain, itineraryHtml, faqJson, expiresAt } = req.body || {};
      if (subdomain !== undefined) data.subdomain = String(subdomain);
      if (itineraryHtml !== undefined) data.itineraryHtml = String(itineraryHtml);
      if (faqJson !== undefined) data.faqJson = faqJson ? String(faqJson) : null;
      if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.tripMicrosite.update({
        where: { id: existing.id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "P2002") {
        return res.status(409).json({ error: "subdomain collision", code: "DUPLICATE_SUBDOMAIN" });
      }
      console.error("[travel-microsite] patch error:", e.message);
      res.status(500).json({ error: "Failed to update microsite" });
    }
  },
);

// POST /api/travel/trips/:tripId/microsite/upload
//
// Image upload for the rich-text editor (Phase 1.5 / 8d). Returns
// `{ url: "/uploads/microsites/ms-xxx.png" }`; the editor stashes the URL
// into the inline <img src> as the user inserts the image. No DB write —
// the image is referenced indirectly via the editor's HTML output, which
// the PATCH endpoint stores into itineraryHtml. Orphan files (uploaded
// but never embedded) are tolerated; a separate sweep can prune them by
// scanning itineraryHtml across all microsites if it becomes a concern.
router.post(
  "/trips/:tripId/microsite/upload",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  requireTmcAccess,
  uploadImageOrReject,
  async (req, res) => {
    try {
      // Trip-exists check protects against random uploads to non-existent
      // trip ids — also gives us a chance to clean up the orphan upload.
      const trip = await loadTrip(req);
      if (!req.file) {
        return res.status(400).json({ error: "file is required (multipart field 'file')", code: "MISSING_FILE" });
      }
      const url = `/uploads/microsites/${req.file.filename}`;
      res.status(201).json({ success: true, url, tripId: trip.id });
    } catch (e) {
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* swallow */ } }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e && /file too large|allowed/i.test(e.message || "")) {
        return res.status(400).json({ error: e.message, code: "INVALID_FILE" });
      }
      console.error("[travel-microsite] upload error:", e.message);
      res.status(500).json({ error: "Failed to upload image" });
    }
  },
);

// DELETE /api/travel/trips/:tripId/microsite — ADMIN only
router.delete(
  "/trips/:tripId/microsite",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  requireTmcAccess,
  async (req, res) => {
    try {
      const trip = await loadTrip(req);
      const existing = await prisma.tripMicrosite.findUnique({ where: { tripId: trip.id } });
      if (!existing) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
      await prisma.tripMicrosite.delete({ where: { id: existing.id } });
      res.json({ deleted: true, id: existing.id });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete microsite" });
    }
  },
);

// ============================================================================
// GET /api/travel/microsites/stats — tenant-wide microsite rollup
// (PRD_TRAVEL_TMC §3 microsites).
//
// Mirrors travel_suppliers.js /suppliers/stats pattern (#903 slice 23) —
// anodyne aggregate that powers the Microsites library page's KPI header
// strip ("12 microsites · 8 published · 4 unpublished · 2 expired · last
// published 3h ago"). Without this, the frontend has to fire {list, count
// by publishedAt, count by expiresAt} — N+1 round-trips for a single
// visual surface.
//
// PRD anchors:
//   - §3 — TMC operator dashboard surfaces "how many microsites have I
//          published, how many are still drafts, how many have expired" —
//          this endpoint feeds those KPI tiles
//
// Behaviour:
//   - Tenant-scoped count + breakdown across TripMicrosite rows
//   - USER-readable (anodyne aggregate; same contract as sibling /stats endpoints)
//   - Sub-brand: TripMicrosite is TMC-only by design (microsites live on
//     tmc.travelstall.in per Q21; the parent TmcTrip has no subBrand field).
//     So we DO NOT expose a bySubBrand bucket — would always be { tmc: ... }
//     and the field would mislead future readers into thinking sub-brand
//     scoping exists where it doesn't.
//   - Buckets returned (schema-driven):
//       total            — count of all microsites for the tenant
//       published        — where publishedAt is non-null
//       unpublished      — remainder (publishedAt is null)
//       expired          — where expiresAt is set AND in the past
//       withFaq          — where faqJson is non-empty
//       lastPublishedAt  — max(publishedAt) across rows (ISO string or null)
//       lastActivityAt   — max(updatedAt) across rows (ISO string or null)
//   - ?from / ?to (ISO date bounds) filter microsite.createdAt before aggregation.
//
// Safety cap: process at most 2000 microsites per call; if matching total >
// 2000, return counts but mark aggregateExceedsCap=true.
//
// USER-readable: anodyne aggregate (counts + timestamps); safe.
// No audit row: read-only meta surface, mirrors /suppliers/stats.
//
// Express route ordering: literal-path /microsites/stats MUST be declared
// BEFORE the /microsites/public/:publicUuid family so the regex-checked
// UUID parser doesn't first 400 INVALID_UUID against the literal "stats".
// ============================================================================
const MICROSITES_STATS_CAP = 2000;

router.get(
  "/microsites/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on microsite.createdAt
      const micrositeWhere = { tenantId };
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
        micrositeWhere.createdAt = Object.assign(
          micrositeWhere.createdAt || {},
          { gte: d },
        );
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        micrositeWhere.createdAt = Object.assign(
          micrositeWhere.createdAt || {},
          { lte: d },
        );
      }

      // Bounded fetch to keep in-process aggregation safe.
      const microsites = await prisma.tripMicrosite.findMany({
        where: micrositeWhere,
        select: {
          id: true,
          publishedAt: true,
          expiresAt: true,
          faqJson: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: MICROSITES_STATS_CAP,
      });

      // Get the true total so callers know if aggregation is bounded.
      const totalMatching = await prisma.tripMicrosite.count({
        where: micrositeWhere,
      });
      const aggregateExceedsCap = totalMatching > MICROSITES_STATS_CAP;

      // Empty short-circuit — return zeroed shape.
      if (microsites.length === 0) {
        return res.json({
          total: 0,
          published: 0,
          unpublished: 0,
          expired: 0,
          withFaq: 0,
          lastPublishedAt: null,
          lastActivityAt: null,
          aggregateExceedsCap: false,
        });
      }

      const now = new Date();
      let published = 0;
      let unpublished = 0;
      let expired = 0;
      let withFaq = 0;
      let lastPublishedAt = null;
      let lastActivityAt = null;

      for (const ms of microsites) {
        if (ms.publishedAt) {
          published += 1;
          const ts = ms.publishedAt instanceof Date ? ms.publishedAt : new Date(ms.publishedAt);
          if (!Number.isNaN(ts.getTime())) {
            if (!lastPublishedAt || ts > lastPublishedAt) lastPublishedAt = ts;
          }
        } else {
          unpublished += 1;
        }

        if (ms.expiresAt) {
          const exp = ms.expiresAt instanceof Date ? ms.expiresAt : new Date(ms.expiresAt);
          if (!Number.isNaN(exp.getTime()) && exp < now) expired += 1;
        }

        if (ms.faqJson && String(ms.faqJson).trim().length > 0) withFaq += 1;

        const upd = ms.updatedAt instanceof Date ? ms.updatedAt : new Date(ms.updatedAt);
        if (!Number.isNaN(upd.getTime())) {
          if (!lastActivityAt || upd > lastActivityAt) lastActivityAt = upd;
        }
      }

      res.json({
        total: microsites.length,
        published,
        unpublished,
        expired,
        withFaq,
        lastPublishedAt: lastPublishedAt ? lastPublishedAt.toISOString() : null,
        lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise microsites" });
    }
  },
);

// ============================================================================
// GET /api/travel/microsites/by-month — tenant-wide microsite monthly rollup
// (PRD_TRAVEL §6.x).
//
// Sibling to /microsites/stats (slice above). Mirrors the rollup-triplet
// pattern established by /suppliers/by-month (#903 slice 24), /diagnostics/
// by-month, /religious-packets/by-month — same UTC YYYY-MM bucketing,
// same defensive math (null/invalid createdAt → "unknown" bucket; excluded
// when ?from / ?to is set), same orderBy semantics. Returns one row per
// UTC month bucket with count + bySubBrand breakdown so the Microsites
// library page can render a "microsites published over time" trend chart.
//
// Sub-brand note: TripMicrosite has NO subBrand column (the model is
// TMC-locked by design per Q21 — microsites live on tmc.travelstall.in).
// Same rationale as /microsites/stats which omits bySubBrand entirely.
// We DO surface a bySubBrand map per bucket for envelope-shape parity
// with the rollup-triplet family — every row will land in the "_tenant"
// fallback bucket since `subBrand` is undefined on the projection.
// Sub-brand WHERE narrowing mirrors /microsites/stats EXACTLY: no
// narrowing applied (the model has no subBrand to narrow by; admins and
// sub-brand-scoped operators see the same population).
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// No audit row written — read-only meta surface; matches /microsites/stats
// and /suppliers/by-month posture. USER-readable: anodyne (counts +
// month-string tokens).
//
// Express route ordering: literal-path /microsites/by-month MUST be
// declared BEFORE the /microsites/public/:publicUuid family so the
// UUID-regex check on the public path doesn't first 400 INVALID_UUID
// against the literal "by-month". Same convention as /microsites/stats.
// ============================================================================
router.get(
  "/microsites/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors /suppliers/by-month slice 24.
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

      // Tenant-scoped where. Sub-brand narrowing matches /microsites/stats
      // EXACTLY: no narrowing applied because TripMicrosite has no
      // subBrand column (TMC-only model per Q21).
      const where = { tenantId };

      // Light projection — subBrand + createdAt. subBrand will be undefined
      // on every row since the model has no such column; the bySubBrand
      // aggregator coerces falsy values to "_tenant" so the envelope shape
      // stays consistent with the rollup-triplet family.
      const rows = await prisma.tripMicrosite.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { month, count, bySubBrand }.
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
          bucket = { month: monthKey, count: 0, bySubBrand: {} };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable month token); kept otherwise so the
      // count surface remains complete. Mirrors /suppliers/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also chronological).
      // "unknown" sorts last in asc / first in desc (lexicographically >
      // "9999-12") — acceptable for a defensive fallback bucket.
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

      // Pagination AFTER aggregation + sort + filter, same as
      // /suppliers/by-month.
      const paged = months.slice(skip, skip + take);

      res.json({
        total,
        rows: paged,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/microsites/by-quarter — tenant-wide microsite quarterly rollup
// (PRD_TRAVEL §6.x).
//
// Sibling to /microsites/stats + /microsites/by-month. Mirrors the
// rollup-triplet pattern (by-month + by-quarter + by-year) established by
// /itineraries/by-quarter — same UTC YYYY-Q[1-4] bucketing, same defensive
// math (null/invalid createdAt → "unknown" bucket; excluded when ?from / ?to
// is set), same orderBy semantics. Returns one row per UTC quarter bucket
// with count + bySubBrand breakdown so the Microsites library page can
// render a "microsites published per quarter" trend tile.
//
// Sub-brand note: TripMicrosite has NO subBrand column (the model is
// TMC-locked by design per Q21 — microsites live on tmc.travelstall.in).
// Same rationale as /microsites/stats + /microsites/by-month. We surface
// a bySubBrand map per bucket for envelope-shape parity with the
// rollup-triplet family; every row lands in the "_tenant" fallback bucket
// since `subBrand` is undefined on the projection. WHERE narrowing mirrors
// /microsites/by-month EXACTLY: tenantId only (admins and sub-brand-scoped
// operators see the same population).
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-Q[1-4] bounds; invalid →
//                     400 INVALID_QUARTER_FORMAT
//   - ?orderBy      — default quarter:asc; accepts quarter:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 8 / 0; limit caps at 40
//
// No audit row written — read-only meta surface; matches /microsites/stats
// + /microsites/by-month posture. USER-readable: anodyne (counts +
// quarter-string tokens).
//
// Express route ordering: literal-path /microsites/by-quarter MUST be
// declared BEFORE the /microsites/public/:publicUuid family so the
// UUID-regex check on the public path doesn't first 400 INVALID_UUID
// against the literal "by-quarter". Same convention as /microsites/stats
// and /microsites/by-month.
// ============================================================================
router.get(
  "/microsites/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
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

      // Tenant-scoped where. Sub-brand narrowing matches /microsites/stats
      // and /microsites/by-month EXACTLY: no narrowing applied because
      // TripMicrosite has no subBrand column (TMC-only model per Q21).
      const where = { tenantId };

      // Light projection — subBrand + createdAt. subBrand will be undefined
      // on every row since the model has no such column; the bySubBrand
      // aggregator coerces falsy values to "_tenant" so the envelope shape
      // stays consistent with the rollup-triplet family.
      const rows = await prisma.tripMicrosite.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-quarter. Map "YYYY-Q[1-4]" → { quarter, count, bySubBrand }.
      // Null/invalid createdAt rows land in "unknown".
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
          bucket = { quarter: quarterKey, count: 0, bySubBrand: {} };
          byQuarter.set(quarterKey, bucket);
        }
        bucket.count += 1;
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable quarter token); kept otherwise so the
      // count surface remains complete. Mirrors /microsites/by-month.
      if (fromRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
      }
      if (toRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Q[1-4] which is
      // also chronological (Q1 < Q2 < Q3 < Q4 in ASCII, years naturally
      // ordered). "unknown" sorts last in asc / first in desc by virtue
      // of being lexicographically > "9999-Q4" — acceptable for a
      // defensive fallback bucket.
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

      // Pagination AFTER aggregation + sort + filter, same as
      // /microsites/by-month.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        total,
        rows: paged,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly rollup" });
    }
  },
);

// ─── PUBLIC info endpoint (no auth) ──────────────────────────────────

// GET /api/travel/microsites/public/:publicUuid
//
// Unauthed entry point — parents/teachers hit this from the trip
// microsite landing page. Returns ONLY non-sensitive fields per
// PUBLIC_SELECT. PII (participants, rooming, payment plan) requires
// the OTP-gated /:uuid/full endpoint shipping in Day 11.
//
// Expiry handling: if expiresAt is set and in the past, returns 410
// GONE rather than 404 so the landing page can show a "this trip has
// concluded" message rather than appearing missing.
router.get("/microsites/public/:publicUuid", async (req, res) => {
  try {
    const uuid = String(req.params.publicUuid);
    // Basic UUID-shape guard — saves a wider WHERE scan + makes
    // garbage-token attacks visible as 400s in logs.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return res.status(400).json({ error: "publicUuid must be a UUID", code: "INVALID_UUID" });
    }
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: PUBLIC_SELECT,
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
    if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This trip microsite has expired", code: "GONE" });
    }
    res.json(ms);
  } catch (e) {
    console.error("[travel-microsite] public-get error:", e.message);
    res.status(500).json({ error: "Failed to load microsite" });
  }
});

// ─── PUBLIC OTP flow (PRD §4.5) ──────────────────────────────────────
//
// Three endpoints fronting the PII reveal:
//   POST /microsites/public/:publicUuid/request-otp
//   POST /microsites/public/:publicUuid/verify-otp
//   GET  /microsites/public/:publicUuid/full?token=...
//
// All three are unauthenticated and CORS-public (parents/teachers visit
// the microsite from email/WhatsApp links). The /full endpoint is the
// only one returning participant / rooming / payment-plan PII, and only
// against a valid access-token JWT minted by verify-otp.
//
// Auth allowlist is already covered by server.js's openPaths entry for
// "/travel/microsites/public" (prefix match catches the sub-paths).
//
// Cred dep: sendOtpStub() will swap to a real Wati WhatsApp dispatch
// once Q9 / Meta Business Manager creds arrive — single-line cutover.

function validOtpPurpose(p) {
  return VALID_OTP_PURPOSES.includes(p);
}

function generateOtpCode() {
  // crypto.randomInt range is [min, max) — generate 0000..9999 then
  // pad-left to OTP_LENGTH so codes always have 4 digits.
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, "0");
}

// POST /api/travel/microsites/public/:publicUuid/request-otp
//
// Body: { phone, purpose }. Generates a 4-digit OTP, stores bcrypt hash,
// dispatches via stub. Idempotent within the cool-down: a second request
// within 60s for the same (micrositeId, phone, purpose) returns 429.
router.post("/microsites/public/:publicUuid/request-otp", async (req, res) => {
  try {
    const uuid = String(req.params.publicUuid);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return res.status(400).json({ error: "publicUuid must be a UUID", code: "INVALID_UUID" });
    }
    const { phone, purpose } = req.body || {};
    if (!phone || !purpose) {
      return res.status(400).json({ error: "phone + purpose required", code: "MISSING_FIELDS" });
    }
    if (!validOtpPurpose(purpose)) {
      return res.status(400).json({
        error: `purpose must be one of: ${VALID_OTP_PURPOSES.join(", ")}`,
        code: "INVALID_PURPOSE",
      });
    }
    // Look up the microsite (+ expiry check) before generating an OTP —
    // no point hashing a code for an expired/missing microsite. tenantId
    // pulled along so we can resolve the per-sub-brand wabaId for the
    // dispatch stub log line (Q9 cut-over plumbing).
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: { id: true, expiresAt: true, tenantId: true },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
    if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This microsite has expired", code: "GONE" });
    }

    // Cool-down: reject if we issued an OTP for the same tuple inside
    // the OTP_COOLDOWN_MS window. Prevents trivial spam.
    const cooldownFloor = new Date(Date.now() - OTP_COOLDOWN_MS);
    const recent = await prisma.tripMicrositeOtp.findFirst({
      where: { micrositeId: ms.id, phone: String(phone), purpose, createdAt: { gte: cooldownFloor } },
      select: { id: true },
    });
    if (recent) {
      return res.status(429).json({
        error: `OTP recently sent — wait ${Math.ceil(OTP_COOLDOWN_MS / 1000)}s before requesting again`,
        code: "OTP_COOLDOWN",
      });
    }

    const code = generateOtpCode();
    const otpHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await prisma.tripMicrositeOtp.create({
      data: {
        micrositeId: ms.id,
        phone: String(phone),
        purpose,
        otpHash,
        expiresAt,
      },
    });
    // Resolve the TMC sub-brand WABA id for observability — microsites
    // are domain-locked to TMC per Q21. Q9 cred-drop swaps the stub for
    // a real Wati dispatch using this resolved wabaId.
    const tenant = await prisma.tenant.findUnique({
      where: { id: ms.tenantId },
      select: { subBrandConfigJson: true },
    });
    const tmcCfg = resolveForSubBrand(tenant, "tmc");
    await sendOtpStub(phone, code, purpose, tmcCfg.wabaId);
    res.status(201).json({
      sent: true,
      expiresAt: expiresAt.toISOString(),
      // Code intentionally NOT returned in the response — the stub logs
      // it server-side. When Wati replaces the stub, this endpoint stays
      // identical from the caller's perspective.
    });
  } catch (e) {
    console.error("[travel-microsite] request-otp error:", e.message);
    res.status(500).json({ error: "Failed to request OTP" });
  }
});

// POST /api/travel/microsites/public/:publicUuid/verify-otp
//
// Body: { phone, purpose, code }. Looks up the most-recent unused-and-
// unexpired OTP for the tuple, bcrypt-compares the provided code,
// marks usedAt, and returns a 30-min JWT access token bound to the
// (micrositeId, phone, purpose) that the /full endpoint accepts.
router.post("/microsites/public/:publicUuid/verify-otp", async (req, res) => {
  try {
    const uuid = String(req.params.publicUuid);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return res.status(400).json({ error: "publicUuid must be a UUID", code: "INVALID_UUID" });
    }
    const { phone, purpose, code } = req.body || {};
    if (!phone || !purpose || !code) {
      return res.status(400).json({ error: "phone + purpose + code required", code: "MISSING_FIELDS" });
    }
    if (!validOtpPurpose(purpose)) {
      return res.status(400).json({
        error: `purpose must be one of: ${VALID_OTP_PURPOSES.join(", ")}`,
        code: "INVALID_PURPOSE",
      });
    }
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: { id: true, expiresAt: true },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });

    // Find the latest unused, unexpired OTP for the tuple.
    const otp = await prisma.tripMicrositeOtp.findFirst({
      where: {
        micrositeId: ms.id,
        phone: String(phone),
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) {
      return res.status(400).json({ error: "OTP expired or not found", code: "OTP_INVALID" });
    }
    const match = await bcrypt.compare(String(code), otp.otpHash);
    if (!match) {
      return res.status(400).json({ error: "OTP code does not match", code: "OTP_INVALID" });
    }
    await prisma.tripMicrositeOtp.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });

    // Mint a short-lived access JWT scoped to the (micrositeId, phone,
    // purpose). The /full endpoint verifies this token and refuses to
    // serve PII without it.
    const accessToken = jwt.sign(
      { kind: "microsite-otp", micrositeId: ms.id, phone: String(phone), purpose },
      JWT_SECRET,
      { expiresIn: OTP_ACCESS_TTL },
    );
    res.json({ verified: true, accessToken, expiresIn: OTP_ACCESS_TTL });
  } catch (e) {
    console.error("[travel-microsite] verify-otp error:", e.message);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// GET /api/travel/microsites/public/:publicUuid/full?token=<jwt>
//
// PII-reveal endpoint. Requires the access token from /verify-otp. Returns
// the full microsite payload INCLUDING participants, rooming, payment plan,
// and document requirements. Token's `purpose` claim narrows the response
// (e.g. teacher-access doesn't get payment plan PII; payment-plan purpose
// gets the instalments but not other participants' rooming).
router.get("/microsites/public/:publicUuid/full", async (req, res) => {
  try {
    const uuid = String(req.params.publicUuid);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return res.status(400).json({ error: "publicUuid must be a UUID", code: "INVALID_UUID" });
    }
    const token = req.query.token || req.headers["x-microsite-token"];
    if (!token) {
      return res.status(401).json({ error: "Access token required (?token=<jwt>)", code: "TOKEN_REQUIRED" });
    }
    let claims;
    try {
      claims = jwt.verify(String(token), JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ error: "Access token invalid or expired", code: "TOKEN_INVALID" });
    }
    if (!claims || claims.kind !== "microsite-otp") {
      return res.status(401).json({ error: "Token is not a microsite access token", code: "TOKEN_INVALID" });
    }

    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: {
        id: true,
        subdomain: true,
        itineraryHtml: true,
        faqJson: true,
        publishedAt: true,
        expiresAt: true,
        publicUuid: true,
        tripId: true,
      },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
    if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This microsite has expired", code: "GONE" });
    }
    if (claims.micrositeId !== ms.id) {
      return res.status(403).json({ error: "Token scoped to a different microsite", code: "TOKEN_SCOPE" });
    }

    const trip = await prisma.tmcTrip.findUnique({
      where: { id: ms.tripId },
      select: {
        id: true, tripCode: true, destination: true,
        departDate: true, returnDate: true, status: true,
      },
    });

    // Purpose-narrowed reveal — only the data the OTP was issued for.
    const reveal = { microsite: ms, trip };
    if (claims.purpose === "registration" || claims.purpose === "teacher-access") {
      reveal.participants = await prisma.tripParticipant.findMany({
        where: { tripId: ms.tripId },
        select: {
          id: true, fullName: true, passportNumber: true,
          passportExpiry: true, dob: true,
        },
      });
    }
    if (claims.purpose === "teacher-access") {
      reveal.rooming = await prisma.roomingAssignment.findMany({
        where: { tripId: ms.tripId },
        orderBy: { roomNumber: "asc" },
      });
    }
    if (claims.purpose === "payment-plan") {
      reveal.paymentPlan = await prisma.tripPaymentPlan.findUnique({
        where: { tripId: ms.tripId },
      });
      reveal.instalments = await prisma.tripInstalmentPayment.findMany({
        where: { tripId: ms.tripId },
        orderBy: [{ participantId: "asc" }, { instalmentIndex: "asc" }],
      });
    }
    if (claims.purpose === "document-checklist") {
      reveal.documentRequirements = await prisma.tripDocumentRequirement.findMany({
        where: { tripId: ms.tripId },
      });
    }

    res.json(reveal);
  } catch (e) {
    console.error("[travel-microsite] /full error:", e.message);
    res.status(500).json({ error: "Failed to load full microsite payload" });
  }
});

module.exports = router;
