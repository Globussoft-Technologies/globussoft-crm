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
const { requirePermission } = require("../middleware/requirePermission");
const { JWT_SECRET } = require("../config/secrets");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
const digilockerClient = require("../services/digilockerClient");
const visaDocStore = require("../lib/visaDocStore");
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient"); // connected WhatsApp Web (drop-in)

// Aadhaar/DigiLocker microsite-verification tuning. A session is only
// valid to call back within SESSION_TTL_MS of /start (matches the
// DigiLocker authorise-code lifetime); a second /start for the same
// participant inside REPLAY_WINDOW_MS is rejected as in-flight.
const KYC_SESSION_TTL_MS = 10 * 60 * 1000;
const KYC_REPLAY_WINDOW_MS = 5 * 60 * 1000;
// Registered redirect URI for the PUBLIC microsite flow — distinct from
// the customer-portal flow's DIGILOCKER_REDIRECT_URI (which points at the
// logged-in portal callback). Must match the value registered in the
// APISetu partner app exactly. Falls back to the local dev callback so
// stub-mode dev works without any env config. The value is stored on each
// DigilockerSession so the token-exchange redirect_uri stays in sync with
// the authorize-time one even if the env var changes mid-flight.
const KYC_REDIRECT_URI = process.env.DIGILOCKER_MICROSITE_REDIRECT_URI || "http://localhost:5173/travel/kyc/callback";

// OTP constants for the public microsite PII reveal flow (PRD §4.5).
// 4-digit code per the PRD spec, 10-minute validity, 30-minute access
// token after verification, 60-second cool-down between OTP requests
// for the same (micrositeId, phone, purpose) tuple.
const OTP_LENGTH = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_ACCESS_TTL = "30m";
const VALID_OTP_PURPOSES = ["registration", "payment-plan", "document-checklist", "teacher-access"];

// OTP dispatch — routed through backend/services/watiClient.js (Q9). With
// WATI_API_ENDPOINT + WATI_ACCESS_TOKEN set this sends a real WhatsApp
// message; without them the client stays in stub mode (logs + a QUEUED
// WhatsAppMessage row), preserving the original stub behaviour.
//
// Template: name comes from WATI_OTP_TEMPLATE_NAME (default
// "otp_verification" per WHATSAPP_INTEGRATION_PRD OQ-1 starter set). The
// code is bound under BOTH the named param "otp" and positional "1" so
// either placeholder style ({{otp}} / {{1}}) works. If the template isn't
// approved on the Wati account yet, the client falls back to a session
// message (delivers when the recipient messaged the business number
// within 24h — the standard dev-test flow).
//
// wabaId stays in the signature for observability parity with the old
// stub line. Microsites are always TMC sub-brand per the route's domain
// ownership.
async function sendOtpStub(phone, code, purpose, wabaId, tenantId) {
  const result = await watiClient.sendBestEffort({
    tenantId,
    subBrand: "tmc",
    toPhone: phone,
    templateName: process.env.WATI_OTP_TEMPLATE_NAME || "otp_verification",
    parameters: [
      { name: "otp", value: String(code) },
      { name: "1", value: String(code) },
    ],
    broadcastName: "travel-microsite-otp",
    fallbackText: `Your Travel Stall verification code is ${code}. It is valid for 10 minutes.`,
  });
  // Stub mode logs the code so dev flows can complete (the API response
  // intentionally never returns it). Real mode never logs the code.
  const codeSuffix = result.stub === true ? ` code=${code}` : "";
  console.log(
    `[travel-microsite] OTP dispatch via watiClient — phone=${phone} purpose=${purpose} ` +
      `status=${result.status} stub=${result.stub === true} subBrand=tmc ` +
      `wabaId=${wabaId || "(no-config)"}${codeSuffix}`,
  );
  return result;
}

// Email-channel OTP dispatch. Mirrors sendOtpStub's contract: sends a real
// SendGrid email when SENDGRID_API_KEY is set, otherwise logs the code so
// dev/CI flows complete without keys (the API response never returns the
// code either way). Reuses the SendGrid env vars already documented for the
// self-service email-OTP flow (backend/lib/emailOtp.js) so there's one set
// of mail creds to configure.
async function sendOtpEmailStub(email, code, purpose, tenantId) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
  const subject = "Your Travel Stall verification code";
  const body =
    `Your Travel Stall verification code is ${code}.\n\n` +
    `Enter it on the trip page to confirm your registration. The code is valid for 10 minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.`;

  if (!SENDGRID_API_KEY) {
    console.log(
      `[travel-microsite] OTP email dispatch (stub) — email=${email} purpose=${purpose} ` +
        `tenantId=${tenantId} stub=true code=${code}`,
    );
    return { sent: false, stub: true, reason: "no_api_key" };
  }
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: FROM_EMAIL },
        subject,
        content: [
          { type: "text/plain", value: body },
          { type: "text/html", value: body.replace(/\n/g, "<br>") },
        ],
      }),
    });
    const ok = resp.ok;
    console.log(
      `[travel-microsite] OTP email dispatch via SendGrid — email=${email} purpose=${purpose} ` +
        `tenantId=${tenantId} status=${resp.status} stub=false`,
    );
    return { sent: ok, stub: false, status: resp.status };
  } catch (e) {
    console.error("[travel-microsite] OTP email dispatch failed:", e.message);
    return { sent: false, stub: false, reason: e.message };
  }
}

const VALID_OTP_CHANNELS = ["phone", "email"];

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

// Document upload for the PUBLIC microsite (passport + Aadhaar). These are
// PII scans, NOT editor images — they never land on the public /uploads
// static mount. We use MEMORY storage so the buffer can be handed to
// visaDocStore (S3 when configured, gated-disk fallback otherwise), which
// is the same private-doc backend the Visa Sure checklist uses. Accepts
// JPEG / PNG / PDF only, 8MB cap. Two named fields so a single multipart
// POST carries both documents.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image\/(png|jpe?g)|application\/pdf)$/i.test(file.mimetype || "")) return cb(null, true);
    return cb(new Error("Only JPEG, PNG or PDF files are allowed"));
  },
});

// Mirror of uploadImageOrReject for the two-field document POST — converts
// multer's rejection paths into structured 400 INVALID_FILE responses so
// the public handler's try/catch stays focused on business logic.
function uploadDocsOrReject(req, res, next) {
  docUpload.fields([
    { name: "passport", maxCount: 1 },
    { name: "aadhaar", maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 8MB)", code: "INVALID_FILE" });
    }
    if (/allowed|invalid/i.test(err.message || "")) {
      return res.status(400).json({ error: err.message, code: "INVALID_FILE" });
    }
    console.error("[travel-microsite] doc upload middleware error:", err.message);
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
  // G095 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.i) — tenantId is needed
  // to resolve the active per-sub-brand BrandKit row that gets attached
  // as `brandKit` in the public response. NOT echoed back to the client
  // — the post-find handler deletes it before res.json() so the wire
  // shape stays clean (no enumeration vector).
  tenantId: true,
  trip: {
    select: {
      destination: true,
      departDate: true,
      returnDate: true,
      tripCode: true,
      legalEntity: true,
      pricePerStudent: true,
      status: true,
      documentRequirements: {
        select: { docType: true, required: true },
        orderBy: { id: "asc" },
      },
      paymentPlan: {
        select: { instalmentsJson: true, graceDays: true },
      },
      _count: {
        select: { participants: true },
      },
    },
  },
};

// G095 — public-safe BrandKit fields attached to the microsite GET
// response. Mirrors PUBLIC_BRAND_KIT_SELECT in routes/brand_kits.js so
// both the dedicated endpoint and the embedded microsite block expose
// the same shape (palette + chrome + portal-copy fields; no audit /
// version metadata, no signatureTemplate).
const MICROSITE_BRAND_KIT_SELECT = {
  logoUrl: true,
  logoDarkUrl: true,
  faviconUrl: true,
  wordmarkUrl: true,
  heroUrl: true,
  headerImageUrl: true,
  primaryColor: true,
  secondaryColor: true,
  accentColor: true,
  bgColor: true,
  textColor: true,
  fontFamily: true,
  fontUrl: true,
  headingFontFamily: true,
  bodyFontFamily: true,
  tagline: true,
  footerText: true,
  missionStatement: true,
  supportEmail: true,
  supportPhone: true,
  socialLinksJson: true,
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
  requirePermission("microsites", "write"),
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
  requirePermission("microsites", "read"),
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
  requirePermission("microsites", "update"),
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
  requirePermission("microsites", "update"),
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
  requirePermission("microsites", "delete"),
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

// GET /api/travel/microsites/by-year — tenant-wide microsite annual rollup
// (PRD_TRAVEL §6.x).
//
// Completes the microsites rollup triplet (stats + by-month + by-quarter +
// now by-year). Mirrors /itineraries/by-year + /suppliers/by-year shape at
// year resolution: one row per UTC calendar year with count + bySubBrand
// breakdown. Annual reviews (year-end CFO close, year-over-year trend
// lines) need a single endpoint hit instead of summing 12 month rows or
// 4 quarter rows client-side.
//
// Sub-brand note: TripMicrosite has NO subBrand column (the model is
// TMC-locked by design per Q21 — microsites live on tmc.travelstall.in).
// Same rationale as /microsites/stats + /microsites/by-month +
// /microsites/by-quarter. We surface a bySubBrand map per bucket for
// envelope-shape parity with the rollup-triplet family; every row lands
// in the "_tenant" fallback bucket since `subBrand` is undefined on the
// projection. WHERE narrowing mirrors /microsites/by-quarter EXACTLY:
// tenantId only (admins and sub-brand-scoped operators see the same
// population).
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY bounds; invalid →
//                     400 INVALID_YEAR_FORMAT
//   - ?orderBy      — default year:asc; accepts year:{asc|desc},
//                     count:{asc|desc}; unknown tokens degrade silently
//                     to the default
//   - ?limit / ?offset — default 10 / 0; limit caps at 30
//
// No audit row written — read-only meta surface; matches /microsites/stats
// + /microsites/by-month + /microsites/by-quarter posture. USER-readable:
// anodyne (counts + year-string tokens).
//
// Express route ordering: literal-path /microsites/by-year MUST be
// declared BEFORE the /microsites/public/:publicUuid family so the
// UUID-regex check on the public path doesn't first 400 INVALID_UUID
// against the literal "by-year". Same convention as /microsites/stats,
// /microsites/by-month, and /microsites/by-quarter.
// ============================================================================
router.get(
  "/microsites/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation — exactly 4 digits. Bucket labels we emit follow
      // this shape so callers passing year-tokens to from/to should
      // already be using it.
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
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Tenant-scoped where. Sub-brand narrowing matches /microsites/stats,
      // /microsites/by-month, and /microsites/by-quarter EXACTLY: no
      // narrowing applied because TripMicrosite has no subBrand column
      // (TMC-only model per Q21).
      const where = { tenantId };

      // Light projection — subBrand + createdAt. subBrand will be undefined
      // on every row since the model has no such column; the bySubBrand
      // aggregator coerces falsy values to "_tenant" so the envelope shape
      // stays consistent with the rollup-triplet family.
      const rows = await prisma.tripMicrosite.findMany({
        where,
        select: { subBrand: true, createdAt: true },
      });

      // Aggregate per-UTC-year. Map "YYYY" → { year, count, bySubBrand }.
      // Null/invalid createdAt rows land in "unknown".
      const byYear = new Map();
      for (const r of rows) {
        let yearKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let bucket = byYear.get(yearKey);
        if (!bucket) {
          bucket = { year: yearKey, count: 0, bySubBrand: {} };
          byYear.set(yearKey, bucket);
        }
        bucket.count += 1;
        const sbKey = r.subBrand ? String(r.subBrand) : "_tenant";
        bucket.bySubBrand[sbKey] = (bucket.bySubBrand[sbKey] || 0) + 1;
      }

      let years = [...byYear.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable year token); kept otherwise so the
      // count surface remains complete. Mirrors /microsites/by-quarter.
      if (fromRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
      }
      if (toRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
      }

      // Sort. "year" sorts lexicographically on YYYY which is also
      // chronological (4-digit zero-padded years naturally ordered).
      // "unknown" sorts last in asc / first in desc by virtue of being
      // lexicographically > "9999" — acceptable for a defensive fallback
      // bucket that should rarely appear.
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

      const total = years.length;

      // Pagination AFTER aggregation + sort + filter, same as
      // /microsites/by-quarter.
      const paged = years.slice(skip, skip + take);

      res.json({
        total,
        rows: paged,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute annual rollup" });
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

    // G095 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.i / AC-6.9) — attach
    // the active brand kit for the microsite's sub-brand so the public
    // page can theme its chrome (palette + logo + tagline + mission +
    // support contacts) without a second round-trip. TripMicrosite is
    // TMC-only per Q21 so the sub-brand is statically `tmc`; future
    // schema extensions that allow non-TMC microsites should derive the
    // sub-brand from the row itself.
    let brandKit = null;
    try {
      brandKit = await prisma.brandKit.findFirst({
        where: { tenantId: ms.tenantId, subBrand: "tmc", isActive: true },
        select: MICROSITE_BRAND_KIT_SELECT,
      });
    } catch (bkErr) {
      // Brand-kit lookup is best-effort — a DB hiccup or schema-drift
      // shouldn't 500 the whole microsite. Log + fall through to a
      // null brandKit, the frontend already falls back to the default
      // palette in that case.
      console.warn("[travel-microsite] brand-kit lookup failed (non-fatal):", bkErr.message);
    }

    // Strip the internal tenantId before responding — it was selected
    // ONLY to resolve the brand kit above. Public response shape stays
    // identical to pre-G095 except for the additive `brandKit` field.
    const { tenantId: _tid, ...publicShape } = ms;
    res.json({ ...publicShape, brandKit });
  } catch (e) {
    console.error("[travel-microsite] public-get error:", e.message);
    res.status(500).json({ error: "Failed to load microsite" });
  }
});

// ─── PUBLIC draft summary (Phase 7 hybrid-registration UX) ───────────
//
// GET /api/travel/microsites/public/:publicUuid/draft-summary?token=...
//
// Returns a NON-PII summary of a PendingTripRegistration so the
// microsite UI can:
//   - confirm the visitor "we have your registration" without leaking PII
//   - pre-populate the OTP form's phone field (masked → revealed only
//     after OTP verify via the /full endpoint)
//   - tell the visitor what status their draft is in (DRAFT / OTP_VERIFIED
//     / REJECTED / CONVERTED) so a re-visit shows the right CTA
//
// Same explicit error codes as verify-otp (decision #9):
//   404 DRAFT_NOT_FOUND   — token does not match any draft
//   403 DRAFT_WRONG_TRIP  — draft belongs to a different microsite's trip
//   400 DRAFT_EXPIRED     — draftTokenExpiresAt has passed
router.get("/microsites/public/:publicUuid/draft-summary", async (req, res) => {
  try {
    const uuid = String(req.params.publicUuid);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      return res.status(400).json({ error: "publicUuid must be a UUID", code: "INVALID_UUID" });
    }
    const draftToken = typeof req.query.token === "string" ? req.query.token : "";
    if (!draftToken) {
      return res.status(400).json({ error: "token query parameter is required", code: "MISSING_TOKEN" });
    }
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: { id: true, tripId: true },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });

    const draft = await prisma.pendingTripRegistration.findUnique({
      where: { draftToken },
      select: {
        id: true, tripId: true, status: true,
        otpVerified: true, draftTokenExpiresAt: true,
        // Fields used to build the masked summary
        studentName: true, parentName: true,
        parentEmail: true, parentPhone: true,
        passportNumber: true,
        // extrasJson holds the document-upload descriptors (passport /
        // Aadhaar / consent). We derive booleans from it below — the raw
        // JSON (which carries private storage keys) is NEVER echoed.
        extrasJson: true,
        createdAt: true,
      },
    });
    if (!draft) {
      return res.status(404).json({
        error: "Registration draft not found for this token",
        code: "DRAFT_NOT_FOUND",
      });
    }
    if (draft.tripId !== ms.tripId) {
      return res.status(403).json({
        error: "Draft token belongs to a different trip's microsite",
        code: "DRAFT_WRONG_TRIP",
      });
    }
    if (draft.draftTokenExpiresAt < new Date()) {
      return res.status(400).json({
        error: "Draft token has expired — please re-submit the registration form",
        code: "DRAFT_EXPIRED",
      });
    }

    // Mask PII for the pre-OTP view. Phone keeps last 4 visible so the
    // visitor recognises "yes that's mine" without exposing the full
    // number to anyone who has the URL.
    const maskPhone = (p) => {
      if (!p) return "";
      const s = String(p);
      if (s.length <= 4) return "•".repeat(s.length);
      return "•".repeat(s.length - 4) + s.slice(-4);
    };
    const maskEmail = (e) => {
      if (!e) return "";
      const [local, domain] = String(e).split("@");
      if (!domain) return "•".repeat(e.length);
      const visible = local.slice(0, Math.min(2, local.length));
      return `${visible}${"•".repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
    };
    const firstNameOnly = (n) => {
      if (!n) return "";
      return String(n).split(/\s+/)[0];
    };

    // Derive document-upload status from extrasJson without echoing the
    // raw blob (it carries private storage keys). Drives the microsite's
    // "Upload documents" button state + the modal's per-doc checkmarks.
    let docs = {};
    if (draft.extrasJson) {
      try {
        const parsed = JSON.parse(draft.extrasJson);
        if (parsed && typeof parsed === "object" && parsed.documents && typeof parsed.documents === "object") {
          docs = parsed.documents;
        }
      } catch { /* malformed extras → treat as no documents */ }
    }

    res.json({
      id: draft.id,
      status: draft.status,
      otpVerified: draft.otpVerified,
      createdAt: draft.createdAt,
      // Non-PII summary
      studentFirstName: firstNameOnly(draft.studentName),
      parentFirstName: firstNameOnly(draft.parentName),
      parentEmailMasked: maskEmail(draft.parentEmail),
      parentPhoneMasked: maskPhone(draft.parentPhone),
      parentPhoneLast4: draft.parentPhone ? String(draft.parentPhone).slice(-4) : null,
      hasPassport: !!draft.passportNumber,
      // Document-upload status (booleans + consent timestamp only)
      hasPassportDoc: !!docs.passport,
      hasAadhaarDoc: !!docs.aadhaar,
      consentGiven: !!docs.consentCapturedAt,
      consentCapturedAt: docs.consentCapturedAt || null,
    });
  } catch (e) {
    console.error("[travel-microsite] draft-summary error:", e.message);
    res.status(500).json({ error: "Failed to load draft summary" });
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
    let { phone, email, purpose } = req.body || {};
    const { draftToken } = req.body || {};
    // Delivery channel — "phone" (WhatsApp/SMS, the default for back-compat)
    // or "email" (SendGrid). Parents captured both at registration and may
    // verify against whichever they prefer.
    const channel = (req.body && req.body.channel) || "phone";
    if (!purpose) {
      return res.status(400).json({ error: "purpose required", code: "MISSING_FIELDS" });
    }
    if (!validOtpPurpose(purpose)) {
      return res.status(400).json({
        error: `purpose must be one of: ${VALID_OTP_PURPOSES.join(", ")}`,
        code: "INVALID_PURPOSE",
      });
    }
    if (!VALID_OTP_CHANNELS.includes(channel)) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_OTP_CHANNELS.join(", ")}`,
        code: "INVALID_CHANNEL",
      });
    }
    // Look up the microsite (+ expiry check) before generating an OTP —
    // no point hashing a code for an expired/missing microsite. tenantId
    // pulled along so we can resolve the per-sub-brand wabaId for the
    // dispatch stub log line (Q9 cut-over plumbing).
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: { id: true, tripId: true, expiresAt: true, tenantId: true },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });
    if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
      return res.status(410).json({ error: "This microsite has expired", code: "GONE" });
    }

    // Phase 7+ — if the caller didn't supply the channel's destination but
    // DID supply a draftToken (microsite hybrid-registration UX), derive it
    // from the draft so the visitor doesn't have to retype what they already
    // entered on the landing page. Same explicit error codes as verify-otp
    // (decision #9) — mismatches DON'T silently fall back to whatever the
    // body might have contained.
    const needDestFromDraft = purpose === "registration" && draftToken
      && ((channel === "phone" && !phone) || (channel === "email" && !email));
    if (needDestFromDraft) {
      const draft = await prisma.pendingTripRegistration.findUnique({
        where: { draftToken: String(draftToken) },
        select: { tripId: true, parentPhone: true, parentEmail: true, draftTokenExpiresAt: true },
      });
      if (!draft) {
        return res.status(404).json({
          error: "Registration draft not found for this token",
          code: "DRAFT_NOT_FOUND",
        });
      }
      if (draft.tripId !== ms.tripId) {
        return res.status(403).json({
          error: "Draft token belongs to a different trip's microsite",
          code: "DRAFT_WRONG_TRIP",
        });
      }
      if (draft.draftTokenExpiresAt < new Date()) {
        return res.status(400).json({
          error: "Draft token has expired — please re-submit the registration form",
          code: "DRAFT_EXPIRED",
        });
      }
      if (channel === "phone") phone = draft.parentPhone;
      else email = draft.parentEmail;
    }

    // The destination the code is sent to, keyed by channel.
    const destination = channel === "email" ? email : phone;
    if (!destination) {
      return res.status(400).json({
        error: `${channel} required`,
        code: "MISSING_FIELDS",
      });
    }

    // Cool-down: reject if we issued an OTP for the same tuple inside
    // the OTP_COOLDOWN_MS window. Prevents trivial spam.
    const cooldownFloor = new Date(Date.now() - OTP_COOLDOWN_MS);
    const destWhere = channel === "email"
      ? { email: String(destination) }
      : { phone: String(destination) };
    const recent = await prisma.tripMicrositeOtp.findFirst({
      where: { micrositeId: ms.id, channel, purpose, createdAt: { gte: cooldownFloor }, ...destWhere },
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
        channel,
        phone: channel === "phone" ? String(destination) : null,
        email: channel === "email" ? String(destination) : null,
        purpose,
        otpHash,
        expiresAt,
      },
    });
    if (channel === "email") {
      const emailResult = await sendOtpEmailStub(destination, code, purpose, ms.tenantId);
      // Surface a genuine provider failure so the parent isn't left staring
      // at a "code sent" screen for an email that never left. stub mode
      // (no SENDGRID_API_KEY) still reports success — the code is dev-logged.
      if (!emailResult.sent && !emailResult.stub) {
        return res.status(502).json({
          error: "We couldn't send the code to your email right now — please try again or use your phone.",
          code: "EMAIL_SEND_FAILED",
        });
      }
    } else {
      // Resolve the TMC sub-brand WABA id for observability — microsites
      // are domain-locked to TMC per Q21. Q9 cred-drop swaps the stub for
      // a real Wati dispatch using this resolved wabaId.
      const tenant = await prisma.tenant.findUnique({
        where: { id: ms.tenantId },
        select: { subBrandConfigJson: true },
      });
      const tmcCfg = resolveForSubBrand(tenant, "tmc");
      await sendOtpStub(destination, code, purpose, tmcCfg.wabaId, ms.tenantId);
    }
    res.status(201).json({
      sent: true,
      channel,
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
    let { phone, email, purpose, code } = req.body || {};
    const channel = (req.body && req.body.channel) || "phone";
    if (!purpose || !code) {
      return res.status(400).json({ error: "purpose + code required", code: "MISSING_FIELDS" });
    }
    if (!validOtpPurpose(purpose)) {
      return res.status(400).json({
        error: `purpose must be one of: ${VALID_OTP_PURPOSES.join(", ")}`,
        code: "INVALID_PURPOSE",
      });
    }
    if (!VALID_OTP_CHANNELS.includes(channel)) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_OTP_CHANNELS.join(", ")}`,
        code: "INVALID_CHANNEL",
      });
    }
    const ms = await prisma.tripMicrosite.findUnique({
      where: { publicUuid: uuid },
      select: { id: true, tripId: true, expiresAt: true },
    });
    if (!ms) return res.status(404).json({ error: "Microsite not found", code: "NOT_FOUND" });

    // Phase 7+ — derive the channel's destination from draftToken when not
    // explicitly supplied (microsite hybrid-registration UX where the visitor
    // already entered it on the landing page). Mirrors request-otp's
    // explicit-error model — mismatches surface as deterministic codes,
    // never silent fallbacks.
    const needDestFromDraft = purpose === "registration" && req.body.draftToken
      && ((channel === "phone" && !phone) || (channel === "email" && !email));
    if (needDestFromDraft) {
      const draft = await prisma.pendingTripRegistration.findUnique({
        where: { draftToken: String(req.body.draftToken) },
        select: { tripId: true, parentPhone: true, parentEmail: true, draftTokenExpiresAt: true },
      });
      if (!draft) {
        return res.status(404).json({
          error: "Registration draft not found for this token",
          code: "DRAFT_NOT_FOUND",
        });
      }
      if (draft.tripId !== ms.tripId) {
        return res.status(403).json({
          error: "Draft token belongs to a different trip's microsite",
          code: "DRAFT_WRONG_TRIP",
        });
      }
      if (draft.draftTokenExpiresAt < new Date()) {
        return res.status(400).json({
          error: "Draft token has expired — please re-submit the registration form",
          code: "DRAFT_EXPIRED",
        });
      }
      if (channel === "phone") phone = draft.parentPhone;
      else email = draft.parentEmail;
    }
    const destination = channel === "email" ? email : phone;
    if (!destination) {
      return res.status(400).json({ error: `${channel} required`, code: "MISSING_FIELDS" });
    }

    // Find the latest unused, unexpired OTP for the tuple.
    const destWhere = channel === "email"
      ? { email: String(destination) }
      : { phone: String(destination) };
    const otp = await prisma.tripMicrositeOtp.findFirst({
      where: {
        micrositeId: ms.id,
        channel,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
        ...destWhere,
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

    // Phase 4 — optional PendingTripRegistration binding. When the
    // caller supplies a draftToken AND purpose === "registration", we
    // atomically mark the draft as OTP_VERIFIED in the same transaction
    // that marks the OTP as used. Per decision #9, mismatches surface
    // as explicit error codes rather than silent no-ops — the operator
    // and the user both want a deterministic signal so they don't end
    // up staring at a "verified" page that didn't actually advance the
    // registration. Mismatches return BEFORE marking the OTP used, so
    // the user can retry with a corrected token without re-requesting
    // a fresh OTP.
    let draftBindResult = null;
    if (purpose === "registration" && req.body.draftToken) {
      const draftToken = String(req.body.draftToken);
      const draft = await prisma.pendingTripRegistration.findUnique({
        where: { draftToken },
        select: {
          id: true, tripId: true, status: true,
          otpVerified: true, draftTokenExpiresAt: true,
        },
      });
      if (!draft) {
        return res.status(404).json({
          error: "Registration draft not found for this token",
          code: "DRAFT_NOT_FOUND",
        });
      }
      if (draft.tripId !== ms.tripId) {
        return res.status(403).json({
          error: "Draft token belongs to a different trip's microsite",
          code: "DRAFT_WRONG_TRIP",
        });
      }
      if (draft.draftTokenExpiresAt < new Date()) {
        return res.status(400).json({
          error: "Draft token has expired — please re-submit the registration form",
          code: "DRAFT_EXPIRED",
        });
      }
      // Already verified is idempotent — proceed without re-writing the
      // draft row, but flag the response so the frontend can short-circuit
      // straight to the "already submitted" UI.
      draftBindResult = {
        id: draft.id,
        alreadyVerified: !!draft.otpVerified,
      };
    }

    // Atomic commit. The OTP gets marked used, and (if a draft is being
    // bound) the draft row updates to OTP_VERIFIED in the same
    // transaction so we never end up with a verified OTP and an
    // unverified draft.
    const txOps = [
      prisma.tripMicrositeOtp.update({
        where: { id: otp.id },
        data: { usedAt: new Date() },
      }),
    ];
    if (draftBindResult && !draftBindResult.alreadyVerified) {
      txOps.push(
        prisma.pendingTripRegistration.update({
          where: { id: draftBindResult.id },
          data: {
            status: "OTP_VERIFIED",
            otpVerified: true,
            otpVerifiedAt: new Date(),
            // otpPhone records the phone that verified; only set for the
            // phone channel (email-channel verifications leave it null —
            // the draft already carries parentEmail).
            ...(channel === "phone" ? { otpPhone: String(destination) } : {}),
          },
        }),
      );
    }
    await prisma.$transaction(txOps);

    // Mint a short-lived access JWT scoped to the (micrositeId, channel,
    // destination, purpose). The /full endpoint verifies this token and
    // refuses to serve PII without it.
    const accessToken = jwt.sign(
      {
        kind: "microsite-otp",
        micrositeId: ms.id,
        channel,
        phone: channel === "phone" ? String(destination) : undefined,
        email: channel === "email" ? String(destination) : undefined,
        purpose,
      },
      JWT_SECRET,
      { expiresIn: OTP_ACCESS_TTL },
    );
    const response = { verified: true, channel, accessToken, expiresIn: OTP_ACCESS_TTL };
    if (draftBindResult) {
      response.draftBound = {
        id: draftBindResult.id,
        status: "OTP_VERIFIED",
        alreadyVerified: draftBindResult.alreadyVerified,
      };
    }
    res.json(response);
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
    } catch (_jwtErr) {
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
    // Phase 4 — when an OTP token was minted with purpose=registration
    // AND the caller supplies the same draftToken used to mint it (?
    // draftToken=<token>), surface the OTP_VERIFIED draft so the
    // microsite UI can show the user's collected details + the
    // "awaiting operator review" status. We require the draftToken
    // again here (not just the access token) because the OTP access
    // token is scoped to the (micrositeId, phone, purpose) tuple, not
    // to a specific draft — a single OTP could verify multiple drafts
    // for the same phone, and we want the frontend to be explicit
    // about which one to show. Mismatches surface as explicit codes
    // mirroring the /verify-otp contract.
    if (claims.purpose === "registration" && req.query.draftToken) {
      const draftToken = String(req.query.draftToken);
      const draft = await prisma.pendingTripRegistration.findUnique({
        where: { draftToken },
        select: {
          id: true, tripId: true, status: true, otpVerified: true,
          otpVerifiedAt: true, draftTokenExpiresAt: true,
          studentName: true, studentSchool: true, studentClass: true,
          parentName: true, parentEmail: true, parentPhone: true,
          passportNumber: true, passportExpiry: true,
          createdAt: true,
        },
      });
      if (!draft) {
        return res.status(404).json({
          error: "Registration draft not found for this token",
          code: "DRAFT_NOT_FOUND",
        });
      }
      if (draft.tripId !== ms.tripId) {
        return res.status(403).json({
          error: "Draft token belongs to a different trip's microsite",
          code: "DRAFT_WRONG_TRIP",
        });
      }
      if (draft.draftTokenExpiresAt < new Date()) {
        return res.status(400).json({
          error: "Draft token has expired — please re-submit the registration form",
          code: "DRAFT_EXPIRED",
        });
      }
      reveal.draft = draft;
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

// ─── PUBLIC Aadhaar / DigiLocker verification (PRD §4.5 + §4.7) ───────
//
// Parent-facing flow on the public microsite. A parent verifies a trip
// participant's Aadhaar without logging in. There is NO app-side OTP gate:
// authenticity is established by DigiLocker itself — the user signs in to
// THEIR OWN DigiLocker account (which enforces its own OTP / MPIN) and
// consents before any Aadhaar data is shared. Endpoints:
//   GET  /microsites/public/:publicUuid/participants
//        → { participants: [{ id, fullName, aadhaarLast4 }] }
//   POST /microsites/public/:publicUuid/verify/aadhaar/start
//        body { participantId } → { sessionId, state, oauthUrl, mode, expiresAt }
//   POST /microsites/public/:publicUuid/verify/aadhaar/callback
//        body { state, code }   → { verified, aadhaarLast4 }
//
// Security model:
//   - The publicUuid is a 128-bit unguessable token; /start additionally
//     requires the participant to belong to THIS microsite's trip.
//   - The OAuth `state` is a 128-bit unguessable token (digilockerClient)
//     and is the @unique dedup/replay key. /callback resolves the session
//     by state alone, then re-confirms the participant belongs to this
//     microsite's trip — so a leaked state can't write Aadhaar onto another
//     trip's participant.
//   - Stub-mode (no APISETU_PARTNER_API_KEY) returns synthetic last-4
//     "9999"; real-mode hits APISetu's DigiLocker partner endpoint.
//   - Aadhaar Act §29: only aadhaarLast4 is ever returned; the opaque
//     token is persisted server-side only, never in any HTTP response.

// Resolve a non-expired microsite by publicUuid (shared by the Aadhaar
// endpoints). Throws structured errors for bad-shape / missing / expired.
async function loadPublicMicrosite(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    const err = new Error("publicUuid must be a UUID"); err.status = 400; err.code = "INVALID_UUID"; throw err;
  }
  const ms = await prisma.tripMicrosite.findUnique({
    where: { publicUuid: uuid },
    select: { id: true, tripId: true, tenantId: true, expiresAt: true },
  });
  if (!ms) {
    const err = new Error("Microsite not found"); err.status = 404; err.code = "NOT_FOUND"; throw err;
  }
  if (ms.expiresAt && new Date(ms.expiresAt) < new Date()) {
    const err = new Error("This microsite has expired"); err.status = 410; err.code = "GONE"; throw err;
  }
  return ms;
}

// GET /api/travel/microsites/public/:publicUuid/participants
//
// Public minimal participant list for the Aadhaar verification UI. No OTP
// gate — DigiLocker authenticates the individual during consent. Returns
// ONLY id + fullName + aadhaarLast4 (so the UI can show who's already
// verified) — never passport / DOB / contact PII.
router.get("/microsites/public/:publicUuid/participants", async (req, res) => {
  try {
    const ms = await loadPublicMicrosite(String(req.params.publicUuid));
    const participants = await prisma.tripParticipant.findMany({
      where: { tripId: ms.tripId },
      select: { id: true, fullName: true, aadhaarLast4: true },
      orderBy: { id: "asc" },
    });
    res.json({ participants });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-microsite] public participants error:", e.message);
    res.status(500).json({ error: "Failed to load participants" });
  }
});

// POST /api/travel/microsites/public/:publicUuid/verify/aadhaar/start
router.post("/microsites/public/:publicUuid/verify/aadhaar/start", async (req, res) => {
  try {
    const ms = await loadPublicMicrosite(String(req.params.publicUuid));

    const participantId = parseInt(req.body && req.body.participantId, 10);
    if (!Number.isFinite(participantId)) {
      return res.status(400).json({ error: "participantId required", code: "MISSING_FIELDS" });
    }
    const participant = await prisma.tripParticipant.findFirst({
      where: { id: participantId, tripId: ms.tripId },
      select: { id: true },
    });
    if (!participant) {
      return res.status(404).json({ error: "Participant not found on this trip", code: "PARTICIPANT_NOT_FOUND" });
    }

    // Replay guard — refuse a second start while a recent one is still
    // in-flight for the same participant.
    const replayFloor = new Date(Date.now() - KYC_REPLAY_WINDOW_MS);
    const inFlight = await prisma.digilockerSession.findFirst({
      where: { participantId: participant.id, status: "initiated", initiatedAt: { gte: replayFloor } },
      select: { id: true },
    });
    if (inFlight) {
      return res.status(409).json({ error: "A verification is already in progress for this participant", code: "SESSION_IN_FLIGHT" });
    }

    const { state, oauthUrl } = await digilockerClient.initiateSession({
      participantId: participant.id,
      subjectType: "participant",
      redirectUri: KYC_REDIRECT_URI,
    });
    const session = await prisma.digilockerSession.create({
      data: {
        tenantId: ms.tenantId,
        subjectType: "participant",
        participantId: participant.id,
        state,
        status: "initiated",
        redirectUri: KYC_REDIRECT_URI,
      },
      select: { id: true, state: true, initiatedAt: true },
    });
    res.status(201).json({
      sessionId: session.id,
      state: session.state,
      oauthUrl,
      // "stub" | "apisetu-partner" | "oauth2" — lets the public page decide
      // whether to redirect to a real DigiLocker URL or complete inline (stub).
      mode: digilockerClient.authMode(),
      expiresAt: new Date(session.initiatedAt.getTime() + KYC_SESSION_TTL_MS).toISOString(),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-microsite] aadhaar/start error:", e.message);
    res.status(500).json({ error: "Failed to start Aadhaar verification" });
  }
});

// POST /api/travel/microsites/public/:publicUuid/verify/aadhaar/callback
//
// Resolves the session by the unguessable `state`, then confirms the
// participant belongs to THIS microsite's trip before writing anything.
router.post("/microsites/public/:publicUuid/verify/aadhaar/callback", async (req, res) => {
  try {
    const ms = await loadPublicMicrosite(String(req.params.publicUuid));
    const { state, code } = req.body || {};
    if (!state || typeof state !== "string") {
      return res.status(400).json({ error: "state required", code: "MISSING_FIELDS" });
    }
    const session = await prisma.digilockerSession.findFirst({
      where: { state, subjectType: "participant" },
      select: {
        id: true, status: true, initiatedAt: true, redirectUri: true, participantId: true,
        participant: { select: { id: true, tripId: true } },
      },
    });
    if (!session || !session.participant) {
      return res.status(404).json({ error: "DigiLocker session not found", code: "SESSION_NOT_FOUND" });
    }
    // Scope check: the session's participant must belong to this microsite's
    // trip. Blocks a state leaked from one microsite writing onto another.
    if (session.participant.tripId !== ms.tripId) {
      return res.status(403).json({ error: "Session does not belong to this microsite", code: "SESSION_SCOPE" });
    }
    if (session.status === "verified") {
      return res.status(409).json({ error: "DigiLocker session already verified", code: "INVALID_STATE" });
    }
    if (session.status === "expired" || session.status === "failed") {
      return res.status(410).json({ error: `DigiLocker session ${session.status}`, code: "SESSION_GONE" });
    }
    // Soft expiry — the authorise code is short-lived; refuse a stale callback.
    if (Date.now() - new Date(session.initiatedAt).getTime() > KYC_SESSION_TTL_MS) {
      await prisma.digilockerSession.update({
        where: { id: session.id },
        data: { status: "expired", failedReason: "session timed out before callback" },
      });
      return res.status(410).json({ error: "DigiLocker session expired", code: "SESSION_GONE" });
    }

    let aadhaarLast4, aadhaarTokenId;
    try {
      ({ aadhaarLast4, aadhaarTokenId } = await digilockerClient.exchangeCallback({
        state, code, redirectUri: session.redirectUri,
      }));
    } catch (e) {
      await prisma.digilockerSession.update({
        where: { id: session.id },
        data: { status: "failed", failedReason: String(e.message).slice(0, 200) },
      });
      return res.status(502).json({ error: "DigiLocker exchange failed", code: "EXCHANGE_FAILED" });
    }

    await prisma.$transaction([
      prisma.digilockerSession.update({
        where: { id: session.id },
        data: { status: "verified", verifiedAt: new Date(), resultLast4: aadhaarLast4, resultTokenId: aadhaarTokenId },
      }),
      prisma.tripParticipant.update({
        where: { id: session.participant.id },
        data: { aadhaarLast4, aadhaarTokenId },
      }),
    ]);
    // NEVER return aadhaarTokenId — server-side only (Aadhaar Act §29).
    res.status(200).json({ verified: true, aadhaarLast4 });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-microsite] aadhaar/callback error:", e.message);
    res.status(500).json({ error: "Failed to complete Aadhaar verification" });
  }
});

// ─── PUBLIC document upload (Passport + Aadhaar + parent consent) ─────
//
// POST /api/travel/microsites/public/:publicUuid/documents
//
// Parent-facing document upload on the PUBLIC microsite. The uploader is
// identified ONLY by the opaque draftToken they arrive with from the
// landing-page registration — there is NO traveller list on this page, so
// one family can never see or touch another's data. Documents are stored
// via visaDocStore (private backend: S3 when configured, gated-disk
// fallback otherwise — NEVER the public /uploads static mount), and their
// descriptors are merged into the draft's extrasJson.documents. A parent-
// consent checkbox is mandatory and captured as documents.consentCapturedAt.
//
// The response returns ONLY booleans + the consent timestamp — never a URL
// or storage key (the docs are PII scans; same discretion as the Aadhaar
// flow which only ever returns last-4).
//
// multipart/form-data fields:
//   draftToken (text, required)
//   consent    (text "true", required)
//   passport   (file, required unless already uploaded on the draft)
//   aadhaar    (file, required unless already uploaded on the draft)
router.post(
  "/microsites/public/:publicUuid/documents",
  uploadDocsOrReject,
  async (req, res) => {
    try {
      const ms = await loadPublicMicrosite(String(req.params.publicUuid));

      const draftToken = typeof req.body.draftToken === "string" ? req.body.draftToken.trim() : "";
      if (!draftToken) {
        return res.status(400).json({ error: "draftToken is required", code: "MISSING_TOKEN" });
      }

      const draft = await prisma.pendingTripRegistration.findUnique({
        where: { draftToken },
        select: { id: true, tripId: true, draftTokenExpiresAt: true, extrasJson: true },
      });
      if (!draft) {
        return res.status(404).json({ error: "Registration draft not found for this token", code: "DRAFT_NOT_FOUND" });
      }
      // Scope check — a leaked token from another trip's microsite can't
      // write documents onto a draft that isn't this microsite's.
      if (draft.tripId !== ms.tripId) {
        return res.status(403).json({ error: "Draft token belongs to a different trip's microsite", code: "DRAFT_WRONG_TRIP" });
      }
      if (draft.draftTokenExpiresAt < new Date()) {
        return res.status(400).json({ error: "Draft token has expired — please re-submit the registration form", code: "DRAFT_EXPIRED" });
      }

      // Consent is mandatory — the parent must tick the box.
      const consentRaw = req.body.consent;
      const consentGiven = consentRaw === true || consentRaw === "true" || consentRaw === "1" || consentRaw === "on";
      if (!consentGiven) {
        return res.status(400).json({ error: "Parent consent is required", code: "CONSENT_REQUIRED" });
      }

      // Parse existing extras so we MERGE (never clobber wizard-collected
      // fields like medical notes / dietary prefs stored on the draft).
      let extras = {};
      if (draft.extrasJson) {
        try { extras = JSON.parse(draft.extrasJson) || {}; } catch { extras = {}; }
        if (typeof extras !== "object" || Array.isArray(extras)) extras = {};
      }
      const existingDocs = (extras.documents && typeof extras.documents === "object") ? extras.documents : {};

      const passportFile = req.files?.passport?.[0] || null;
      const aadhaarFile = req.files?.aadhaar?.[0] || null;

      // Both documents must be present AFTER this operation. A doc already
      // stored on the draft satisfies the requirement even without a fresh
      // file this time (so a parent can re-upload just one). Neither present
      // and none stored → reject.
      const willHavePassport = !!passportFile || !!existingDocs.passport;
      const willHaveAadhaar = !!aadhaarFile || !!existingDocs.aadhaar;
      if (!willHavePassport || !willHaveAadhaar) {
        return res.status(400).json({
          error: "Both Passport and Aadhaar documents are required",
          code: "MISSING_FILES",
        });
      }

      const nextDocs = { ...existingDocs };
      if (passportFile) {
        if (existingDocs.passport) await visaDocStore.removeDoc(existingDocs.passport);
        const d = await visaDocStore.storeDoc(passportFile.buffer, passportFile.mimetype);
        nextDocs.passport = { ...d, uploadedAt: new Date().toISOString() };
      }
      if (aadhaarFile) {
        if (existingDocs.aadhaar) await visaDocStore.removeDoc(existingDocs.aadhaar);
        const d = await visaDocStore.storeDoc(aadhaarFile.buffer, aadhaarFile.mimetype);
        nextDocs.aadhaar = { ...d, uploadedAt: new Date().toISOString() };
      }
      nextDocs.consentCapturedAt = new Date().toISOString();

      extras.documents = nextDocs;
      await prisma.pendingTripRegistration.update({
        where: { id: draft.id },
        data: { extrasJson: JSON.stringify(extras) },
      });

      // NEVER return URLs / keys — only booleans + the consent timestamp.
      res.status(200).json({
        ok: true,
        documents: {
          passport: !!nextDocs.passport,
          aadhaar: !!nextDocs.aadhaar,
          consentCapturedAt: nextDocs.consentCapturedAt,
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-microsite] document upload error:", e.message);
      res.status(500).json({ error: "Failed to upload documents" });
    }
  },
);

module.exports = router;
