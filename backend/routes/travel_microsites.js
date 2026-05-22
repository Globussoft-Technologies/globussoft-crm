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
