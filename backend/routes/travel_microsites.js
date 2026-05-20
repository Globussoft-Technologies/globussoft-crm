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
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");

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
  upload.single("file"),
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

module.exports = router;
