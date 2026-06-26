const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");
const { renderPage } = require("../services/landingPageRenderer");
const landingPageGeneratorLLM = require("../services/landingPageGeneratorLLM");
const { snapshotSafe, VERSION_SOURCES } = require("../lib/landingPageVersions");

const router = express.Router();
const publicRouter = express.Router();
const prisma = require("../lib/prisma");

// ── #446 — image-upload multer config ─────────────────────────────
//
// Why: pre-fix the Image component in the LandingPageBuilder only accepted
// a URL string (`props.src`). Users had to host the image elsewhere first
// (S3, Imgur, etc.) and paste a URL. This route lets the builder POST the
// raw file and get back a `{ url }` we can drop straight into props.src.
//
// Storage: backend/uploads/landing-page-images/<tenantId>/<unique>.<ext>
// Served by: app.use("/uploads", express.static(...)) at server.js:428,
// so the returned `url` field is the public path "/uploads/landing-page-
// images/<tenantId>/<file>".
//
// Constraints:
//   - 5 MB hard limit (multer LIMIT_FILE_SIZE → 400)
//   - MIME-type allowlist: png / jpg / jpeg / webp / gif. SVG is OFF —
//     SVG is a script-execution surface (XSS via inline <script> /
//     onload) when served from same-origin /uploads. The branding logo
//     route (wellness.js:3585) accepts SVG because tenant ADMINs are a
//     trusted population; the landing-page upload should match the
//     tighter image-allowlist used in the public renderer's safeUrl
//     helper (services/landingPageRenderer.js:67-69 only allows http/
//     https/data:image/* — but not svg+xml).
//   - File extension is derived from MIME, not the client's filename,
//     so `evil.svg` masquerading as image/png renders as .png on disk.
const ALLOWED_IMAGE_MIMES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(
        __dirname, "..", "uploads", "landing-page-images", `tenant-${req.user.tenantId}`
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Derive ext from MIME, not from the client filename. The MIME
      // allowlist is enforced in fileFilter so this lookup is safe.
      const ext = ALLOWED_IMAGE_MIMES[(file.mimetype || "").toLowerCase()] || ".bin";
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES[(file.mimetype || "").toLowerCase()]) return cb(null, true);
    cb(new Error("Only PNG, JPG, WebP, and GIF images are allowed"));
  },
});

// ── Video upload multer config ────────────────────────────────────
//
// Why: travelVideo + generic video blocks previously required pasting a
// YouTube / Vimeo / Wistia embed URL. Operators on the 2026-06-22 UAT
// asked for a direct upload path so a single MP4 reel can ship without
// hosting it elsewhere first. Mirrors the image-upload pattern above.
//
// MIME allowlist is the standard browser-playable web video set. SVG-
// style script-execution risk doesn't apply to video files, but we
// still derive the extension from MIME (not the client filename) to
// dodge "evil.exe renamed to evil.mp4" disk-name confusion.
//
// 50 MB cap is the practical limit for landing-page reels. Larger
// videos belong on a CDN; this surface is for short hero clips, not
// long-form content.
const ALLOWED_VIDEO_MIMES = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/ogg": ".ogv",
};
const VIDEO_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(
        __dirname, "..", "uploads", "landing-page-videos", `tenant-${req.user.tenantId}`
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = ALLOWED_VIDEO_MIMES[(file.mimetype || "").toLowerCase()] || ".bin";
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: VIDEO_UPLOAD_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_VIDEO_MIMES[(file.mimetype || "").toLowerCase()]) return cb(null, true);
    cb(new Error("Only MP4, WebM, MOV, and OGG videos are allowed"));
  },
});

// ── Document upload multer config ─────────────────────────────────
//
// Why: the wanderlux brochure section needs an operator-uploaded PDF
// (or DOC/DOCX) the published page can link to directly. Previously
// operators had to host the brochure elsewhere first; this matches the
// image-upload and video-upload ergonomics already used by the builder.
//
// MIME allowlist is intentionally narrow — PDFs are the canonical
// brochure format; DOC/DOCX/PPT/PPTX cover the small "ours is a Word
// deck" cases. 10 MB cap fits the typical agency brochure (5-9 MB).
// Larger files belong on a CDN; we serve from local disk to keep the
// surface simple.
//
// File extension derives from MIME (not the client filename) so a
// renamed `.exe` masquerading as a PDF lands on disk with a `.pdf`
// extension — but the static-serve content-type comes from the
// detected MIME anyway, so the worst case is a download prompt rather
// than execution.
const ALLOWED_DOC_MIMES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};
const DOC_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(
        __dirname, "..", "uploads", "landing-page-documents", `tenant-${req.user.tenantId}`
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = ALLOWED_DOC_MIMES[(file.mimetype || "").toLowerCase()] || ".bin";
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: DOC_UPLOAD_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_DOC_MIMES[(file.mimetype || "").toLowerCase()]) return cb(null, true);
    cb(new Error("Only PDF, DOC, DOCX, PPT, and PPTX documents are allowed"));
  },
});

// #378: slug validation — only lowercase a-z, 0-9, hyphens; max 50 chars.
// Anything else produces broken public URLs (spaces, uppercase, special chars).
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const isValidSlug = (s) =>
  typeof s === "string" && s.length > 0 && s.length <= 50 && SLUG_PATTERN.test(s);

// ── Authenticated CRUD ────────────────────────────────────────────

router.get("/", verifyToken, async (req, res) => {
  try {
    // #920 slice 38: ?fields=summary slim-shape opt-in. Mirrors slices 1-36.
    // The default list already excludes the heavy content @db.LongText +
    // cssOverrides @db.Text + metaTitle/metaDescription columns (LandingPage
    // schema has the body JSON in `content`, see prisma/schema.prisma:1764).
    // Picker / dropdown UI (slug-collision check, page-selector chips, "link
    // to landing page" form fields) doesn't need visits / submissions /
    // templateType / createdAt / updatedAt either — only id + title + slug +
    // status. When the caller passes ?fields=summary we project to that
    // minimal set. Opt-in additive — existing callers (no ?fields, or any
    // non-exact value) get the analytics-bearing shape unchanged so the
    // LandingPages.jsx grid continues to render visits + submissions tiles.
    const isSummary = req.query.fields === "summary";
    // Travel metadata (destination, subBrand, generatedByAi, generatedAt)
    // is included in the default list shape so the LandingPages.jsx grid
    // can surface sub-brand chips + "AI draft" badges without a second
    // fetch. isFeatured + featuredAt are included so the list can render
    // the "★ Featured" badge + the Feature/Unfeature action button. The
    // summary shape stays minimal for slug-collision / dropdown callers —
    // they only need id/title/slug/status.
    const select = isSummary
      ? { id: true, title: true, slug: true, status: true }
      : { id: true, title: true, slug: true, status: true, visits: true, submissions: true, templateType: true, createdAt: true, updatedAt: true, destination: true, subBrand: true, generatedByAi: true, generatedAt: true, isFeatured: true, featuredAt: true };

    // Optional sub-brand filter: ?subBrand=tmc filters to that bucket;
    // ?subBrand=none filters to rows with subBrand=null (generic pages).
    // Unset = no filter (all pages). The schema's
    // @@index([tenantId, subBrand, status]) carries this lookup.
    const where = { tenantId: req.user.tenantId };
    const subBrandFilter = req.query.subBrand;
    if (subBrandFilter === "none") {
      where.subBrand = null;
    } else if (typeof subBrandFilter === "string" && subBrandFilter.length > 0) {
      where.subBrand = subBrandFilter;
    }

    res.json(await prisma.landingPage.findMany({
      where,
      select,
      orderBy: { createdAt: "desc" },
    }));
  } catch (_err) { res.status(500).json({ error: "Failed to fetch landing pages" }); }
});

router.get("/templates/list", verifyToken, (req, res) => {
  res.json(TEMPLATES);
});

// ── Wanderlux static assets (Road A, 2026-06-23) ─────────────────────
// The Wanderlux template is a CLIENT-RENDERED Design Component; the
// template HTML references a `<script src="support.js">` (the dc-runtime
// that compiles `<x-dc>` tags into React). The preview / public-page
// routes rewrite the relative path to this absolute URL so the browser
// can fetch the runtime. Served WITHOUT auth — the script is non-secret
// and is required to render even the public /p/:slug page. Cached for
// 1 day since the file is content-addressed (re-deploy rotates it).
router.get("/wanderlux-static/support.js", (req, res) => {
  const path = require("path");
  const fs = require("fs");
  const file = path.join(__dirname, "..", "services", "templates", "wanderlux", "support.js");
  try {
    const body = fs.readFileSync(file, "utf8");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(body);
  } catch (_e) {
    res.status(404).send("// wanderlux runtime not found");
  }
});

// ── Phase D1 — template-driven catalogue ──────────────────────────
// Surfaces the educational-trip-v1 / travel-premium-v1 / religious-
// tour-v1 / luxury-tour-v1 registry to the builder so the "create
// page" flow can offer a premium template alongside the block-array
// templates. Each entry carries operator-facing copy + a `defaultContent`
// payload the builder uses to seed a fresh page.
router.get("/template-catalogue", verifyToken, (req, res) => {
  const templates = require("../services/templates");
  // Road A (2026-06-23): the operator-facing picker now exposes ONLY the
  // Wanderlux dynamic generator. The four family templates
  // (educational-trip-v1 / religious-tour-v1 / family-trip-v1 /
  // luxury-tour-v1) stay registered in REGISTRY so legacy pages keep
  // rendering, but they don't appear in the picker — the user asked for
  // "complete function like that" rather than "a template among many",
  // so the only build-a-page option is the dynamic generator.
  const VISIBLE_IDS = new Set(["wanderlux-v1"]);
  const catalogue = templates.CATALOGUE
    .filter((entry) => VISIBLE_IDS.has(entry.id))
    .map((entry) => {
      const tmpl = templates.getTemplate(entry.id);
      return {
        ...entry,
        // We expose the schema (editorSlots + slotLabels) so the
        // builder's template editor can render form fields for each
        // slot without hardcoding the schema on the frontend.
        schema: tmpl ? tmpl.schema : null,
        defaultContent: tmpl ? tmpl.defaultContent : null,
      };
    });
  res.json({ templates: catalogue });
});

// ── #446 — image upload for the builder's Image block ─────────────
//
// POST /api/landing-pages/upload (multipart/form-data, field name "image")
//
// Returns: 201 { url, mimetype, size, filename }
// Errors:
//   400 — wrong MIME, missing file, multer LIMIT_FILE_SIZE
//   401/403 — verifyToken (mounted in the global guard, but route-level
//             verifyToken duplicated for explicit defence-in-depth)
//
// Tenant isolation: storage path includes req.user.tenantId so a
// directory listing on disk is segmented per tenant. The returned
// `url` is `/uploads/landing-page-images/tenant-<id>/<file>`. We do
// NOT persist a row in the DB — the URL is opaque and gets stored in
// the parent LandingPage row's `content` JSON when the user saves.
router.post(
  "/upload",
  verifyToken,
  (req, res, next) => {
    imageUpload.single("image")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE"
          ? "Image too large (max 5 MB)"
          : (err.message || "Image upload failed");
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided (field 'image')" });
    }
    const url = `/uploads/landing-page-images/tenant-${req.user.tenantId}/${path.basename(req.file.path)}`;
    res.status(201).json({
      url,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: path.basename(req.file.path),
    });
  }
);

// ── Video upload for the builder's video / travelVideo block ─────
//
// POST /api/landing-pages/upload-video (multipart/form-data, field "video")
//
// Returns: 201 { url, mimetype, size, filename }
// Errors:
//   400 — wrong MIME, missing file, multer LIMIT_FILE_SIZE
//   401/403 — verifyToken
//
// Tenant-segmented path: /uploads/landing-page-videos/tenant-<id>/<file>.
// Caller stores the returned `url` directly in the video block's `url`
// prop; the public renderer detects the /uploads/landing-page-videos
// prefix and emits a native <video controls> tag.
router.post(
  "/upload-video",
  verifyToken,
  (req, res, next) => {
    videoUpload.single("video")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE"
          ? `Video too large (max ${VIDEO_UPLOAD_SIZE_BYTES / 1024 / 1024} MB)`
          : (err.message || "Video upload failed");
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided (field 'video')" });
    }
    const url = `/uploads/landing-page-videos/tenant-${req.user.tenantId}/${path.basename(req.file.path)}`;
    res.status(201).json({
      url,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: path.basename(req.file.path),
    });
  }
);

// ── Document upload for the brochure block ────────────────────────
//
// POST /api/landing-pages/upload-document (multipart/form-data, field "document")
//
// Returns: 201 { url, mimetype, size, filename }
// Errors:
//   400 — wrong MIME, missing file, multer LIMIT_FILE_SIZE
//   401/403 — verifyToken
//
// Tenant-segmented path: /uploads/landing-page-documents/tenant-<id>/<file>.
// Caller stores the returned `url` into `brochure.fileUrl` in the page
// config; the wanderlux template surfaces a "Download brochure" CTA on
// the brochure section's success state when that field is non-empty.
router.post(
  "/upload-document",
  verifyToken,
  (req, res, next) => {
    docUpload.single("document")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE"
          ? `Document too large (max ${DOC_UPLOAD_SIZE_BYTES / 1024 / 1024} MB)`
          : (err.message || "Document upload failed");
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No document file provided (field 'document')" });
    }
    const url = `/uploads/landing-page-documents/tenant-${req.user.tenantId}/${path.basename(req.file.path)}`;
    res.status(201).json({
      url,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: path.basename(req.file.path),
    });
  }
);

// ── GET /api/landing-pages/stats — tenant-wide landing-page rollup ─
//
// Marketing polish — first /stats aggregate for LandingPage. Mirrors the
// posture of knowledge_base.js's /stats (sibling CRM-publishing surface)
// and travel_suppliers.js's /suppliers/stats — read-only meta envelope,
// auth-gated via verifyToken, no audit row written.
//
// Specs:
//   - Tenant-scoped via req.user.tenantId.
//   - ?from / ?to (optional ISO date bounds on createdAt); invalid → 400 INVALID_DATE.
//   - byStatus: { DRAFT: N, PUBLISHED: M, ARCHIVED: K } based on LandingPage.status.
//   - publishedCount: count of status="PUBLISHED".
//   - totalViews: sum of LandingPage.visits (defensive null/undefined → 0).
//   - totalConversions: sum of LandingPage.submissions (defensive null/undefined → 0).
//   - conversionRate: totalConversions / totalViews, half-up 2dp; null when totalViews=0.
//   - lastCreatedAt: max(createdAt) ISO across selected rows, or null when empty.
//   - NO audit row written — anodyne aggregate.
//
// Schema notes (verified against prisma/schema.prisma:1752-1777):
//   - LandingPage uses `status` String enum ("DRAFT"|"PUBLISHED"|"ARCHIVED"),
//     NOT an `isPublished` Boolean. Buckets are emitted under their literal
//     status string for that reason. Per kb-stats convention, empty buckets
//     are omitted entirely (no "PUBLISHED: 0" noise).
//   - "Views" on this model = LandingPage.visits (incremented in the public
//     /:slug GET handler). "Conversions" = LandingPage.submissions
//     (incremented in /:slug/submit). No separate viewCount/conversions
//     column exists in the schema.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family (line below) — otherwise the dynamic /:id matcher catches
// the literal "stats" string and treats it as a numeric id parse failure.
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "from must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "to must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const pages = await prisma.landingPage.findMany({
      where,
      select: { status: true, visits: true, submissions: true, createdAt: true },
    });

    const byStatus = {};
    let publishedCount = 0;
    let totalViews = 0;
    let totalConversions = 0;
    let lastCreatedAt = null;

    for (const p of pages) {
      const bucket = p.status || "DRAFT";
      byStatus[bucket] = (byStatus[bucket] || 0) + 1;
      if (bucket === "PUBLISHED") publishedCount += 1;
      totalViews += Number(p.visits) || 0;
      totalConversions += Number(p.submissions) || 0;
      if (p.createdAt) {
        const ca = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
        if (!lastCreatedAt || ca > lastCreatedAt) lastCreatedAt = ca;
      }
    }

    // conversionRate: half-up 2dp; null when totalViews=0 (undefined division).
    const conversionRate = totalViews > 0
      ? Math.round((totalConversions / totalViews) * 10000) / 10000
      : null;

    res.json({
      totalPages: pages.length,
      byStatus,
      publishedCount,
      totalViews,
      totalConversions,
      conversionRate,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[LandingPages][stats]", err);
    res.status(500).json({ error: "Failed to compute landing-page stats" });
  }
});

// ── Public featured-page resolver ─────────────────────────────────
//
// GET /api/landing-pages/public/featured?subBrand=<bucket>
//
// Powers the dynamic /trips public route. Returns the most recently
// featured PUBLISHED landing page in the requested scope, or 404 if
// none. No auth (added to server.js openPaths allowlist).
//
// Scope rules:
//   ?subBrand=<tmc|rfu|travelstall|visasure> → returns featured page in
//     that sub-brand bucket, or 404 if no page in that bucket is featured
//   ?subBrand=none → returns featured page with subBrand IS NULL
//   omitted → returns ANY featured page across all sub-brands, ordered
//     by featuredAt DESC. Used by the default /trips resolver.
//
// Response shape: { id, slug, title, destination, subBrand, featuredAt }.
// Content is NOT inlined — the resolver redirects to /p/<slug> and the
// existing /:slug renderer reads the full row. Keeps this endpoint cheap
// and cache-friendly.
//
// MUST be declared BEFORE router.get("/:id", ...) — Express literal vs.
// parametric ordering rule per CLAUDE.md standing rules.
router.get("/public/featured", async (req, res) => {
  try {
    const subBrandFilter = req.query.subBrand;
    const where = { isFeatured: true, status: "PUBLISHED" };
    if (subBrandFilter === "none") {
      where.subBrand = null;
    } else if (typeof subBrandFilter === "string" && subBrandFilter.length > 0) {
      where.subBrand = subBrandFilter;
    }
    const page = await prisma.landingPage.findFirst({
      where,
      orderBy: { featuredAt: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        destination: true,
        subBrand: true,
        featuredAt: true,
      },
    });
    if (!page) {
      return res.status(404).json({
        error: "No featured landing page is currently configured.",
        code: "NO_FEATURED_PAGE",
      });
    }
    res.json(page);
  } catch (err) {
    console.error("[LandingPages] public/featured error:", err);
    res.status(500).json({ error: "Failed to resolve featured page" });
  }
});

// ── AI-powered destination landing page generator (PR-B) ─────────
//
// POST /api/landing-pages/generate-from-destination
//
// Body: { destination, durationDays, audience, subBrand? }
// Auth: verifyToken (admin / operator surface — not public)
//
// Generates a complete LandingPage block array via
// services/landingPageGeneratorLLM.js, then OPTIONALLY auto-creates a
// DRAFT LandingPage row when `autoCreate: true` is passed in the body.
// When auto-creating, the response includes the new page's `id` and
// `slug` so the frontend can navigate straight to /landing-pages/builder/<id>.
//
// When `autoCreate` is false (the default), the response returns the
// generated content WITHOUT persisting anything. Useful for "preview
// before creating" UX or for callers that want to mix-and-match the
// blocks before saving.
//
// Strict product rules enforced by the guardrail
// (lib/landingPageGuard.js):
//   - NO pricing values, NO testimonials, NO image URLs, NO discounts,
//     NO ratings, NO vendor / partner names
//   - Pages auto-created here are ALWAYS DRAFT status — operator must
//     review and publish manually
//   - generatedByAi flag is set true so the list grid can surface an
//     "AI draft" affordance
//
// MUST be declared BEFORE router.get("/:id", ...) per the Express
// literal-vs-parametric standing rule.
const VALID_SUB_BRANDS = new Set(["tmc", "rfu", "travelstall", "visasure"]);
// `style` body param picks the destination shape for AI-generated pages:
//   - "premium" (DEFAULT) — LLM emits the block array, the bridge maps
//     blocks → semantic content slots, page is persisted with
//     templateType="educational-trip-v1" so the builder opens in
//     template-editor mode and the public render uses the premium
//     microsite template.
//   - "legacy"            — LLM block array persisted as-is with
//     templateType="travel_destination". The block-based path stays
//     available for operators who want per-section composition freedom.
const VALID_GENERATE_STYLES = new Set(["premium", "legacy"]);
router.post("/generate-from-destination", verifyToken, async (req, res) => {
  try {
    const { destination, durationDays, audience, subBrand, autoCreate, style } = req.body || {};
    // Default to premium so new AI-generated pages get the better
    // visual baseline; operators can opt-in to legacy via the modal.
    const generateStyle = style && VALID_GENERATE_STYLES.has(style) ? style : "premium";

    // ── Input validation ──
    if (!destination || typeof destination !== "string" || !destination.trim()) {
      return res.status(400).json({ error: "destination is required", code: "INVALID_DESTINATION" });
    }
    const destClean = destination.trim();
    if (destClean.length > 80) {
      return res.status(400).json({ error: "destination must be ≤ 80 chars", code: "INVALID_DESTINATION" });
    }
    const days = parseInt(durationDays, 10);
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      return res.status(400).json({ error: "durationDays must be an integer between 1 and 60", code: "INVALID_DURATION" });
    }
    if (audience !== undefined && (typeof audience !== "string" || audience.length > 200)) {
      return res.status(400).json({ error: "audience must be a string ≤ 200 chars", code: "INVALID_AUDIENCE" });
    }
    if (subBrand !== undefined && subBrand !== null && subBrand !== "" && !VALID_SUB_BRANDS.has(subBrand)) {
      return res.status(400).json({
        error: `Invalid subBrand '${subBrand}'. Must be one of: ${[...VALID_SUB_BRANDS].join(", ")}.`,
        code: "INVALID_SUB_BRAND",
      });
    }

    // ── Generate ──
    let result;
    try {
      result = await landingPageGeneratorLLM.generateLandingPageContent({
        tenantId: req.user.tenantId,
        destination: destClean,
        durationDays: days,
        audience: audience || "travellers",
        subBrand: subBrand || null,
        __userId: req.user.userId,
        __surface: "landing-pages-generate",
      });
    } catch (genErr) {
      if (genErr.code === "LANDING_PAGE_GENERATE_BUDGET_EXCEEDED") {
        return res.status(429).json({
          error: "Monthly LLM spend cap reached for this tenant.",
          code: "LLM_BUDGET_EXCEEDED",
          spentCents: genErr.spentCents,
          capCents: genErr.capCents,
        });
      }
      throw genErr;
    }

    // ── Optional auto-create ──
    // When autoCreate is truthy, persist a DRAFT LandingPage with the
    // generated content + travel metadata so the frontend can immediately
    // navigate to the builder. Slug collision retries up to 5 times with
    // a suffix, mirroring the create-with-template path above.
    if (autoCreate) {
      const baseSlug = result.suggestedSlug || `${destClean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${days}d`;
      let slug = baseSlug.slice(0, 50);
      let created = null;
      // ── Phase D1 bridge: AI emits blocks → premium template ─────
      // When the operator chose the premium style, run the LLM-emitted
      // blocks through the educational-trip-v1 bridge mapper so the
      // page persists as a template-driven page (semantic content
      // payload). Cultural flip cards, hero benefit cards, safety
      // features, inclusions and FAQ are all filled by AI; operator-
      // only fields (pricing values, poster image, partner logos,
      // phone/email) stay null and are caught by the publish gate.
      let persistTemplateType;
      let persistContent;
      if (generateStyle === "premium") {
        // ── Road A bridge (2026-06-23) ──────────────────────────────
        // Generate-from-destination now persists as `wanderlux-v1`, the
        // verbatim port of the standalone reference at
        // dynamic_page_geneator/. The bridge maps the LLM's 9-block
        // output into the reference's config schema; the route fetches
        // images per-slot using each slot's `imagePrompt`; the result
        // is persisted as the JSON config the template reads at
        // render time. Was educational-trip-v1 (semantic-payload
        // composer) — that path is kept available via the old template
        // ids but is no longer the AI-generate default. Pre-Road-A
        // pages keep rendering through the old templates by templateType.
        const wanderlux = require("../services/templates/wanderlux/wanderluxBridge");
        let config = wanderlux.mapBlocksToWanderluxConfig(result.blocks, {
          destination: destClean,
          durationDays: days,
          audience: audience || "travellers",
          subBrand: subBrand || null,
          suggestedTitle: result.suggestedTitle || "",
          metaDescription: (result.seoMeta && result.seoMeta.metaDescription) || "",
        });

        // ── Image fetch + apply for the Wanderlux config ────────────
        // The config has imagePrompt strings on:
        //   hero.imagePrompt
        //   cities[i].imagePrompt        (marquee strip)
        //   highlights.cards[i].imagePrompt  (flip cards)
        // We turn those into a destinationImageProvider strategy and
        // attach the returned URLs back onto matching slots. The
        // provider chain is Unsplash → Pexels → Pixabay → AI fallback
        // (DALL-E with key, else Pollinations Flux). Best-effort; if
        // every provider misses, the relevant section's data is
        // missing and the reference's renderVals() simply hides it.
        try {
          const imageProvider = require("../services/destinationImageProvider");
          const cityArr = Array.isArray(config.cities) ? config.cities : [];
          const highlightCards = (config.highlights && Array.isArray(config.highlights.cards))
            ? config.highlights.cards
            : [];
          const strategy = {
            hero: {
              query: (config.hero && config.hero.imagePrompt) || `${destClean} travel`,
              aspectRatio: '4:3',
            },
            marquee: cityArr.map((c, i) => ({
              slot: `cities[${i}]`,
              query: c.imagePrompt || `${c.name || ''} ${destClean} travel`,
            })),
            cultural: highlightCards.map((c, i) => ({
              slot: `highlights.cards[${i}]`,
              query: c.imagePrompt || `${c.name || ''} ${destClean} landmark`,
            })),
          };
          const fetched = await imageProvider.fetchStrategy(strategy, {
            tenantId: req.user.tenantId,
            __userId: req.user.userId,
            __surface: "landing-pages-generate-wanderlux",
          });
          if (!(fetched.hero && fetched.hero.url)) {
            console.warn(`[wanderlux-images] hero slot UNFILLED — every provider in the chain returned null`);
          }
          (fetched.marquee || []).forEach((m, i) => {
            if (!(m && m.image && m.image.url)) {
              console.warn(`[wanderlux-images] marquee[${i}] UNFILLED — slot=${m && m.slot}`);
            }
          });
          (fetched.cultural || []).forEach((c, i) => {
            if (!(c && c.image && c.image.url)) {
              console.warn(`[wanderlux-images] cultural[${i}] UNFILLED — slot=${c && c.slot}`);
            }
          });

          // Attach hero photo URL onto config.hero.image (the reference
          // expects `image: { src, alt }`).
          if (fetched.hero && fetched.hero.url) {
            config.hero = config.hero || {};
            config.hero.image = {
              src: fetched.hero.url,
              alt: (config.hero.imageTitle || destClean) + ' hero photo',
            };
          }
          // City marquee photos onto config.cities[i].image (string URL
          // per the reference schema).
          if (Array.isArray(fetched.marquee) && Array.isArray(config.cities)) {
            config.cities = config.cities.map((c, i) => {
              const fm = fetched.marquee[i];
              if (fm && fm.image && fm.image.url) return { ...c, image: fm.image.url };
              return c;
            });
          }
          // Highlight flip-card photos onto config.highlights.cards[i].image.
          if (Array.isArray(fetched.cultural) && config.highlights && Array.isArray(config.highlights.cards)) {
            config.highlights.cards = config.highlights.cards.map((c, i) => {
              const fc = fetched.cultural[i];
              if (fc && fc.image && fc.image.url) return { ...c, image: fc.image.url };
              return c;
            });
          }

          // ── Pre-warm Pollinations URLs (2026-06-23) ─────────────────
          // Pollinations generates images LAZILY on first GET — the URL
          // returns immediately but the image is materialized server-side
          // when first requested (5-15s wall time). Operators saw "first
          // preview shows 1 image, second shows more" because the browser
          // requests were timing out before Pollinations finished. We
          // pre-warm by firing a HEAD request to every Pollinations URL
          // here, server-side, so the image is cached on Pollinations'
          // CDN by the time the operator opens the preview tab. Done in
          // parallel; whole pre-warm is bounded by the longest single
          // image (typically 10-15s). Best-effort — pre-warm failures
          // don't abort the page generation.
          const toWarm = [];
          if (config.hero && config.hero.image && config.hero.image.src && /pollinations\.ai/.test(config.hero.image.src)) {
            toWarm.push({ slot: 'hero', url: config.hero.image.src });
          }
          (config.cities || []).forEach((c, i) => {
            if (c.image && /pollinations\.ai/.test(c.image)) toWarm.push({ slot: `cities[${i}]`, url: c.image });
          });
          (config.highlights && config.highlights.cards || []).forEach((c, i) => {
            if (c.image && /pollinations\.ai/.test(c.image)) toWarm.push({ slot: `highlights[${i}]`, url: c.image });
          });
          if (toWarm.length > 0) {
            await Promise.allSettled(toWarm.map(async ({ slot, url }) => {
              const slotStart = Date.now();
              try {
                // GET (not HEAD) — Pollinations' lazy generation only fires
                // on the GET path. HEAD returns 200 without generating.
                // AbortController bounds the wait at 25s so a single slow
                // image can't block the whole generate response.
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 25000);
                await fetch(url, { method: 'GET', signal: ctrl.signal });
                clearTimeout(timer);
              } catch (e) {
                console.warn(`[wanderlux-images] pre-warm ${slot} FAILED in ${Date.now() - slotStart}ms: ${e.message || e}`);
              }
            }));
          }

          // ── Pexels VIDEO fetch (2026-06-23) ─────────────────────────
          // The wanderlux template has an "INTERACTIVE PREVIEW" section
          // that embeds a destination video. If the operator hasn't
          // uploaded one yet, auto-fetch a matching Pexels video so the
          // page ships visually complete. Operator can still replace
          // via the editor's Video section (upload or paste a URL).
          // Best-effort — no video means video.enabled stays false.
          try {
            const pexelsVideo = require("../services/imageProviders/pexelsVideoProvider");
            if (pexelsVideo.isAvailable()) {
              const videoQuery = `${destClean} travel`;
              const video = await pexelsVideo.fetchOne(videoQuery);
              if (video && video.url) {
                config.video = config.video || {};
                config.video.enabled = true;
                config.video.embedUrl = video.url;
                config.video.posterUrl = video.posterUrl || '';
                config.video.eyebrow = config.video.eyebrow || 'Interactive Preview';
                config.video.title = config.video.title || 'See the Experience Before You Decide.';
                config.video.body = config.video.body || `Before reading further, take a moment to see what ${destClean} feels like.`;
              }
            }
          } catch (vErr) {
            console.warn(`[wanderlux-video] best-effort video fetch failed (non-fatal): ${vErr.message || vErr}`);
          }
        } catch (imgErr) {
          // Best-effort — empty image slots are OK; the reference
          // renderer hides any section whose data array is empty.
          console.warn(
            `[landing-pages] wanderlux image-provider best-effort fetch failed (non-fatal): ${imgErr.message || imgErr}`,
            imgErr.stack ? `\n${imgErr.stack}` : '',
          );
        }

        persistTemplateType = "wanderlux-v1";
        persistContent = JSON.stringify(config);
      } else {
        persistTemplateType = "travel_destination";
        persistContent = JSON.stringify(result.blocks);
      }
      const baseData = {
        title: result.suggestedTitle,
        templateType: persistTemplateType,
        content: persistContent,
        metaTitle: result.seoMeta?.metaTitle || null,
        metaDescription: result.seoMeta?.metaDescription || null,
        destination: destClean,
        subBrand: subBrand || null,
        generatedByAi: true,
        generatedAt: new Date(),
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const trySlug = attempt === 0 ? slug : `${slug.slice(0, 44)}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          created = await prisma.landingPage.create({ data: { ...baseData, slug: trySlug } });
          slug = trySlug;
          break;
        } catch (e) {
          // Prisma P2002 unique-constraint violation on (tenantId, slug).
          if (e.code !== "P2002") throw e;
          // else: try again with a fresh suffix.
        }
      }
      if (!created) {
        return res.status(500).json({ error: "Failed to allocate a unique slug after 5 attempts" });
      }
      await snapshotSafe(prisma, created, VERSION_SOURCES.AI_GENERATION, req.user);
      return res.status(201).json({
        page: created,
        generation: {
          source: result.source,
          model: result.model,
          stub: result.stub,
          verdict: result.verdict,
          guardrailIssues: result.guardrailIssues,
          realModeError: result.realModeError,
        },
      });
    }

    // ── Preview-only response ──
    res.json({
      blocks: result.blocks,
      suggestedSlug: result.suggestedSlug,
      suggestedTitle: result.suggestedTitle,
      seoMeta: result.seoMeta,
      source: result.source,
      model: result.model,
      stub: result.stub,
      verdict: result.verdict,
      guardrailIssues: result.guardrailIssues,
      realModeError: result.realModeError,
    });
  } catch (err) {
    console.error("[LandingPages] generate-from-destination error:", err);
    res.status(500).json({ error: "Failed to generate landing page content" });
  }
});

// ── PR-E Phase 2.3 — TEE-aware generation endpoint ─────────────────
// Auto-creates a DRAFT LandingPage row via the Travel Experience Engine.
// Routes inputs → trait classification → family/theme/composition pick
// → family-aware LLM prompt → semantic content → image fetch → persist
// as DRAFT. Returns the new page id + TEE decision log so the builder
// UI's Decision Panel + Preview can land immediately.
//
// MUST be declared BEFORE router.get("/:id", ...) per the Express
// literal-vs-parametric standing rule (same as generate-from-destination).
//
// Architectural invariant (locked Phase 2.2):
//   TEE is the AUTHORITATIVE source of family / themeId / visualMood /
//   composition / imageStrategy. This endpoint never reads or branches
//   on the destination string itself; classification lives entirely in
//   travelExperienceEngine.classify(). No destination-specific logic.
router.post("/generate-with-tee", verifyToken, async (req, res) => {
  try {
    const {
      destination,
      durationDays,
      audience,
      travelMonth,
      tripType,
      subBrand,
      autoCreate = true,
      skipImages = false,
      _teeOverrides,
    } = req.body || {};

    // ── Input validation (mirrors the legacy generate endpoint) ──
    if (!destination || typeof destination !== "string" || !destination.trim()) {
      return res.status(400).json({ error: "destination is required", code: "INVALID_DESTINATION" });
    }
    const destClean = destination.trim();
    if (destClean.length > 80) {
      return res.status(400).json({ error: "destination must be ≤ 80 chars", code: "INVALID_DESTINATION" });
    }
    const days = parseInt(durationDays, 10);
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      return res.status(400).json({ error: "durationDays must be an integer between 1 and 60", code: "INVALID_DURATION" });
    }
    if (audience !== undefined && audience !== null && (typeof audience !== "string" || audience.length > 200)) {
      return res.status(400).json({ error: "audience must be a string ≤ 200 chars", code: "INVALID_AUDIENCE" });
    }
    if (subBrand !== undefined && subBrand !== null && subBrand !== "" && !VALID_SUB_BRANDS.has(subBrand)) {
      return res.status(400).json({
        error: `Invalid subBrand '${subBrand}'. Must be one of: ${[...VALID_SUB_BRANDS].join(", ")}.`,
        code: "INVALID_SUB_BRAND",
      });
    }

    // Tenant slug for embedded form data-attrs.
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { slug: true },
    });
    const tenantSlug = tenant && tenant.slug ? tenant.slug : "";

    // ── Run the TEE-aware generator ──
    let teeResult;
    try {
      teeResult = await landingPageGeneratorLLM.generateLandingPageContentWithTee(
        {
          tenantId: req.user.tenantId,
          destination: destClean,
          durationDays: days,
          audience: audience || "travellers",
          travelMonth: travelMonth || null,
          tripType: tripType || null,
          subBrand: subBrand || null,
          tenantSlug,
          _teeOverrides: _teeOverrides && typeof _teeOverrides === "object" ? _teeOverrides : undefined,
        },
        {
          skipImages: !!skipImages,
          __userId: req.user.userId,
          __surface: "landing-pages-generate-tee",
        }
      );
    } catch (genErr) {
      if (genErr.code === "LANDING_PAGE_GENERATE_BUDGET_EXCEEDED" || genErr.code === "LLM_BUDGET_EXCEEDED") {
        return res.status(429).json({
          error: "Monthly LLM spend cap reached for this tenant.",
          code: "LLM_BUDGET_EXCEEDED",
          spentCents: genErr.spentCents,
          capCents: genErr.capCents,
        });
      }
      throw genErr;
    }

    // Compose a default title from the TEE'd content. The brand label is
    // the most stable string; if absent, fall back to the destination.
    const teeBrand = (teeResult.content && teeResult.content.brand) || {};
    const titleFromContent =
      teeBrand.programmeName ||
      teeBrand.label ||
      `${destClean} — ${days} day${days === 1 ? "" : "s"}`;

    // Preview-only response — no DB write.
    if (!autoCreate) {
      return res.json({
        content: teeResult.content,
        templateType: teeResult.templateType,
        teeOutput: teeResult.teeOutput,
        model: teeResult.model,
        source: teeResult.source,
        imagesFetched: teeResult.imagesFetched,
        validation: teeResult.validation,
      });
    }

    // ── Auto-create as DRAFT ──
    const baseSlug = (`${destClean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${days}d`).slice(0, 50);
    let slug = baseSlug;
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        created = await prisma.landingPage.create({
          data: {
            title: titleFromContent.slice(0, 200),
            slug,
            description: (teeBrand.programmeTagline || "").slice(0, 500) || null,
            templateType: teeResult.templateType,
            content: JSON.stringify(teeResult.content),
            metaTitle: titleFromContent.slice(0, 200),
            metaDescription:
              (teeResult.content && teeResult.content.brand && teeResult.content.brand.programmeTagline) || null,
            status: "DRAFT",
            destination: destClean,
            subBrand: subBrand || null,
            generatedByAi: true,
            generatedAt: new Date(),
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (e) {
        if (e.code !== "P2002") throw e;
        // Slug collision — append a 4-char suffix and retry.
        slug = `${baseSlug.slice(0, 45)}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    if (!created) {
      return res.status(500).json({ error: "Failed to allocate a unique slug after 5 attempts" });
    }

    // Snapshot the AI generation as version 1 (CREATE+AI_GENERATION).
    await snapshotSafe(prisma, created, VERSION_SOURCES.AI_GENERATION, req.user);

    return res.status(201).json({
      page: created,
      generation: {
        source: teeResult.source,
        model: teeResult.model,
        imagesFetched: teeResult.imagesFetched,
        validation: teeResult.validation,
      },
      tee: {
        family: teeResult.teeOutput.family,
        themeId: teeResult.teeOutput.themeId,
        composition: teeResult.teeOutput.composition,
        traits: teeResult.teeOutput.traits,
        decisionLog: teeResult.teeOutput.decisionLog,
      },
    });
  } catch (err) {
    console.error("[LandingPages] generate-with-tee error:", err);
    res.status(500).json({ error: "Failed to generate landing page via TEE", message: err.message });
  }
});

// ── PR-E Phase 2.3 — Regenerate Strategy (R3) ──────────────────────
// Re-runs TEE classification without rebuilding the page content. Used
// by the builder's "Regenerate Strategy" button so operators can flip
// (e.g.) tripType or audience and see what theme/composition the TEE
// would pick BEFORE deciding to regenerate the whole page. No LLM call,
// no image fetch — pure classification.
router.post("/:id/tee/reclassify", verifyToken, async (req, res) => {
  try {
    const pageId = parseInt(req.params.id, 10);
    if (!Number.isFinite(pageId)) return res.status(400).json({ error: "Invalid id" });
    const page = await prisma.landingPage.findFirst({
      where: { id: pageId, tenantId: req.user.tenantId },
    });
    if (!page) return res.status(404).json({ error: "Page not found" });

    const { destination, durationDays, audience, travelMonth, tripType, subBrand, _teeOverrides } = req.body || {};
    // Inputs default to the page's persisted travel metadata. The body
    // can override any field so the operator can "what-if" a different
    // classification (e.g. flip tripType from family to luxury).
    const input = {
      destination: destination || page.destination || "",
      durationDays: parseInt(durationDays || 0, 10) || 7,
      audience: audience || "travellers",
      travelMonth: travelMonth || null,
      tripType: tripType || null,
      subBrand: subBrand || page.subBrand || null,
      _teeOverrides: _teeOverrides && typeof _teeOverrides === "object" ? _teeOverrides : undefined,
    };
    if (!input.destination) {
      return res.status(400).json({ error: "destination required (page lacks travel metadata)", code: "MISSING_DESTINATION" });
    }

    const tee = require("../services/travelExperienceEngine");
    const teeOutput = await tee.regenerateStrategy(input, { tenantId: req.user.tenantId });

    return res.json({
      tee: {
        family: teeOutput.family,
        themeId: teeOutput.themeId,
        composition: teeOutput.composition,
        traits: teeOutput.traits,
        decisionLog: teeOutput.decisionLog,
        imageStrategy: teeOutput.imageStrategy,
      },
    });
  } catch (err) {
    console.error("[LandingPages] tee/reclassify error:", err);
    res.status(500).json({ error: "Failed to reclassify", message: err.message });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    res.json(page);
  } catch (_err) { res.status(500).json({ error: "Failed to fetch page" }); }
});

// ── Travel-vertical sub-brand whitelist ───────────────────────────
// Mirrors the VALID_API_KEY_SUB_BRANDS constant in routes/developer.js
// (#899 Part A) so a typo on either side surfaces as a 400 instead of
// silently storing the wrong bucket.
const VALID_TRAVEL_SUB_BRANDS = new Set(["tmc", "rfu", "travelstall", "visasure"]);

router.post("/", verifyToken, async (req, res) => {
  try {
    const { title, slug, templateType, content, destination, subBrand, generatedByAi, generatedAt } = req.body;
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    const trimmedTitle = title.trim();

    // Travel metadata validation: destination + subBrand are free-form
    // optional strings, but if a subBrand is supplied it must be one of
    // the 4 travel-vertical buckets (a bad value would silently break
    // the LandingPages list filter).
    if (subBrand !== undefined && subBrand !== null && subBrand !== "" && !VALID_TRAVEL_SUB_BRANDS.has(subBrand)) {
      return res.status(400).json({
        error: `Invalid subBrand '${subBrand}'. Must be one of: ${[...VALID_TRAVEL_SUB_BRANDS].join(", ")}.`,
        code: "INVALID_SUB_BRAND",
      });
    }
    if (destination !== undefined && destination !== null && (typeof destination !== "string" || destination.length > 80)) {
      return res.status(400).json({ error: "destination must be a string ≤ 80 chars", code: "INVALID_DESTINATION" });
    }

    // #378: if a slug is provided by the client, validate before insert.
    // Auto-generated slugs (built below) already conform to [a-z0-9-]+.
    if (slug !== undefined && slug !== null && slug !== "" && !isValidSlug(slug)) {
      return res.status(400).json({
        error: "Invalid slug. Use lowercase letters, numbers, and hyphens only (max 50 chars).",
      });
    }

    // #339: dedup-on-create — if a Draft landing page with the same title
    // (case-insensitive trim) already exists for this tenant, reject with 409
    // so the user opens the existing draft instead of accumulating dupes.
    // Published / archived pages don't block (a stale "Lead Capture" PUBLISHED
    // doesn't prevent starting a fresh draft to replace it). Fetch the tenant's
    // drafts and JS-compare with toLowerCase().trim() — Prisma `equals` with
    // `mode: 'insensitive'` isn't portable across all MySQL collations, so the
    // JS path is the safer match for the spec.
    const existingDrafts = await prisma.landingPage.findMany({
      where: { tenantId: req.user.tenantId, status: "DRAFT" },
      select: { id: true, title: true },
    });
    const needle = trimmedTitle.toLowerCase();
    const dupe = existingDrafts.find(
      (p) => (p.title || "").trim().toLowerCase() === needle
    );
    if (dupe) {
      return res.status(409).json({
        error: `A landing page named '${trimmedTitle}' already exists in Draft. Open it or rename.`,
        existingId: dupe.id,
      });
    }

    // #378: cap auto-generated slugs at 50 chars (incl. timestamp suffix).
    const tsSuffix = Date.now().toString(36);
    const baseSlug = trimmedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const truncatedBase = baseSlug.slice(0, Math.max(0, 50 - tsSuffix.length - 1));
    const finalSlug = slug || (truncatedBase ? `${truncatedBase}-${tsSuffix}` : tsSuffix);

    let finalContent = content;
    if (templateType && !content) {
      const tmpl = TEMPLATES.find(t => t.id === templateType);
      if (tmpl) finalContent = JSON.stringify(tmpl.content);
    }

    const createData = {
      title: trimmedTitle,
      slug: finalSlug,
      templateType,
      content: finalContent || "[]",
      userId: req.user.userId,
      tenantId: req.user.tenantId,
    };
    if (destination !== undefined && destination !== null) createData.destination = destination;
    if (subBrand !== undefined && subBrand !== null && subBrand !== "") createData.subBrand = subBrand;
    if (generatedByAi === true) {
      createData.generatedByAi = true;
      // Caller may supply a generatedAt; default to now() for AI rows.
      createData.generatedAt = generatedAt ? new Date(generatedAt) : new Date();
    }

    const page = await prisma.landingPage.create({ data: createData });
    await snapshotSafe(prisma, page, VERSION_SOURCES.CREATE, req.user);
    res.status(201).json(page);
  } catch (err) {
    console.error("[LandingPages] Create error:", err);
    res.status(500).json({ error: "Failed to create page" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    const { title, content, cssOverrides, metaTitle, metaDescription, slug, destination, subBrand, templateType } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (content !== undefined) data.content = typeof content === "string" ? content : JSON.stringify(content);
    if (cssOverrides !== undefined) data.cssOverrides = cssOverrides;
    if (metaTitle !== undefined) data.metaTitle = metaTitle;
    if (metaDescription !== undefined) data.metaDescription = metaDescription;
    if (templateType !== undefined) data.templateType = templateType;
    if (destination !== undefined) {
      if (destination !== null && (typeof destination !== "string" || destination.length > 80)) {
        return res.status(400).json({ error: "destination must be a string ≤ 80 chars", code: "INVALID_DESTINATION" });
      }
      data.destination = destination;
    }
    if (subBrand !== undefined) {
      if (subBrand !== null && subBrand !== "" && !VALID_TRAVEL_SUB_BRANDS.has(subBrand)) {
        return res.status(400).json({
          error: `Invalid subBrand '${subBrand}'. Must be one of: ${[...VALID_TRAVEL_SUB_BRANDS].join(", ")}.`,
          code: "INVALID_SUB_BRAND",
        });
      }
      data.subBrand = subBrand === "" ? null : subBrand;
    }
    if (slug !== undefined) {
      // #378: reject invalid slugs on update too — same rules as create.
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          error: "Invalid slug. Use lowercase letters, numbers, and hyphens only (max 50 chars).",
        });
      }
      // #456: tenant-scoped uniqueness check before update. Pre-fix the
      // user could change a slug to one that another draft was already
      // using; the second page silently shadowed the first at /p/<slug>
      // (whichever resolved first won, the other became unreachable).
      // Pre-check + return 409 instead of relying on a DB-level unique
      // constraint to throw a P2002 (which surfaces as 500).
      if (slug !== existing.slug) {
        const collision = await prisma.landingPage.findFirst({
          where: { tenantId: req.user.tenantId, slug, NOT: { id: existing.id } },
          select: { id: true, title: true, status: true },
        });
        if (collision) {
          return res.status(409).json({
            error: `Slug '${slug}' is already used by '${collision.title}' (${collision.status.toLowerCase()}, id ${collision.id}). Pick a different slug.`,
            existingId: collision.id,
          });
        }
        // #456: slug change on a PUBLISHED page breaks every inbound link
        // (ad campaigns, email links, QR codes). Don't block — the owner
        // may legitimately need to rename — but require an explicit
        // ?confirmSlugChange=true query so an accidental autosave can't
        // strand customers. The frontend builder should pop a "this will
        // break /p/<old-slug>" dialog before sending the confirmation.
        if (existing.status === "PUBLISHED" && req.query.confirmSlugChange !== "true") {
          return res.status(409).json({
            error: `Page is PUBLISHED. Changing the slug breaks every inbound link to /p/${existing.slug}. Re-submit with ?confirmSlugChange=true to proceed.`,
            code: "PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM",
            currentSlug: existing.slug,
            requestedSlug: slug,
          });
        }
      }
      data.slug = slug;
    }

    const updated = await prisma.landingPage.update({ where: { id: existing.id }, data });
    // Snapshot on MANUAL_SAVE only when content/title/slug changed —
    // avoids flooding the version list with no-op autosaves that only
    // touched metaTitle / metaDescription / templateType.
    const contentChanged = data.content !== undefined && data.content !== existing.content;
    const titleChanged = data.title !== undefined && data.title !== existing.title;
    const slugChanged = data.slug !== undefined && data.slug !== existing.slug;
    if (contentChanged || titleChanged || slugChanged) {
      await snapshotSafe(prisma, updated, VERSION_SOURCES.MANUAL_SAVE, req.user);
    }
    res.json(updated);
  } catch (_err) { res.status(500).json({ error: "Failed to update page" }); }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    await prisma.landingPage.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (_err) { res.status(500).json({ error: "Failed to delete page" }); }
});

// ── Publish-gate helper ───────────────────────────────────────────
//
// A travel_destination page must satisfy a set of completeness checks
// before going PUBLISHED — the user explicitly asked for this gate so
// half-baked AI drafts (missing hero image, no itinerary, fewer than
// 4 FAQs, tier amounts still null, etc.) can't be shipped to a public
// URL accidentally.
//
// Non-travel pages (templateType ≠ "travel_destination") skip the
// travel checks entirely so the generic landing-page UX is unaffected.
//
// Returns { ok: boolean, issues: [{ code, message, blockType?, blockIndex? }] }.
// Caller decides whether to surface as a hard error or a warning chip.
const MIN_FAQ_COUNT = 4;
const MIN_HIGHLIGHT_COUNT = 3;
const MIN_INCLUSIONS_COUNT = 3;

/**
 * Publish-readiness for the new template-driven pages (Phase D1).
 * Content is a JSON object, not a block array. We check the most
 * commonly-forgotten slots:
 *   - hero.headline, hero.posterUrl, brand.programmeName
 *   - registration form has a sub-brand + tenantSlug or fallback
 *     submit endpoint route
 *   - faq has ≥ MIN_FAQ_COUNT items
 *   - investment.tiers if rendered are all priced (no null amounts)
 */
function validateTemplatePublishReadiness(page) {
  const issues = [];
  let content = {};
  try {
    content = typeof page.content === "string" ? JSON.parse(page.content || "{}") : (page.content || {});
  } catch (_e) {
    issues.push({ code: "CONTENT_INVALID_JSON", message: "Page content is not valid JSON. Re-open the builder to fix." });
    return { ok: false, issues };
  }
  if (typeof content !== "object" || Array.isArray(content) || content === null) {
    issues.push({ code: "CONTENT_NOT_OBJECT", message: "Template pages store content as a JSON object, not a block array." });
    return { ok: false, issues };
  }

  if (!page.title || !page.title.trim()) {
    issues.push({ code: "MISSING_TITLE", message: "Page title is empty." });
  }
  if (!page.slug || !/^[a-z0-9-]+$/.test(page.slug)) {
    issues.push({ code: "INVALID_SLUG", message: "Page slug is missing or invalid." });
  }

  // Hero headline — Wanderlux stores titleLines[] (the bridge splits the
  // LLM's headline into multiple display lines); older templates store
  // a single `headline` string. Either non-empty is enough.
  const hero = content.hero || {};
  const heroTitleLines = Array.isArray(hero.titleLines) ? hero.titleLines : [];
  const hasHeadline = heroTitleLines.some((l) => l && String(l).trim())
    || (hero.headline && String(hero.headline).trim());
  if (!hasHeadline) {
    issues.push({ code: "HERO_HEADLINE_EMPTY", message: "Hero headline is empty." });
  }
  // Hero image — Wanderlux uses hero.image.src (set by the route's
  // image-fetcher) OR hero.backgroundImage (set by operator upload);
  // older templates use hero.posterUrl. Any of the three counts.
  const hasHeroImage = (hero.image && hero.image.src && String(hero.image.src).trim())
    || (hero.backgroundImage && String(hero.backgroundImage).trim())
    || (hero.posterUrl && String(hero.posterUrl).trim());
  if (!hasHeroImage) {
    issues.push({ code: "HERO_IMAGE_MISSING", message: "Upload a hero image — Publish is blocked without one." });
  }

  // Brand name — Wanderlux stores brand.name; older templates use
  // brand.programmeName. Accept either.
  const brand = content.brand || {};
  const hasBrandName = (brand.name && String(brand.name).trim())
    || (brand.programmeName && String(brand.programmeName).trim());
  if (!hasBrandName) {
    issues.push({ code: "BRAND_NAME_EMPTY", message: "Brand / programme name is empty." });
  }

  // FAQ coverage — Wanderlux uses content.faqs.items (plural) and the
  // bridge sets the whole `faqs` object to null when there are no
  // items; older templates use content.faq.items (singular). Try both;
  // if both are absent, `faqContainer` falls through to {} and
  // faqItems.length is 0, which correctly triggers the gate.
  const faqContainer = content.faqs || content.faq || {};
  const faqItems = Array.isArray(faqContainer.items) ? faqContainer.items : [];
  if (faqContainer.show !== false && faqItems.length < MIN_FAQ_COUNT) {
    issues.push({
      code: "FAQ_TOO_FEW",
      message: `Add at least ${MIN_FAQ_COUNT} FAQ entries (currently ${faqItems.length}).`,
    });
  }

  // If the investment section is rendered, every tier must have an
  // amount (operator hasn't left a pricing TBD in production).
  // Wanderlux stores tiers under investment.installments[]; older
  // templates use investment.tiers[]. Accept either.
  const invest = content.investment || {};
  const tierList = Array.isArray(invest.installments)
    ? invest.installments
    : (Array.isArray(invest.tiers) ? invest.tiers : []);
  if (invest.show !== false && tierList.length > 0) {
    tierList.forEach((tier, idx) => {
      if (!tier || tier.amount == null || tier.amount === "") {
        issues.push({
          code: "TIER_UNCONFIGURED",
          message: `Investment tier #${idx + 1} ("${(tier && (tier.title || tier.label)) || ""}") has no amount set.`,
        });
      }
    });
  }

  return { ok: issues.length === 0, issues };
}

function validatePublishReadiness(page) {
  // ── Phase D1 — template-driven page gate ──────────────────────
  // Pages whose templateType is a registered template id store their
  // content as a SEMANTIC PAYLOAD object (not a block array). The
  // legacy block checks below don't apply — instead we verify the
  // hero / programme-name / FAQ count slots that operators most
  // commonly forget. The renderer is tolerant of empty slots so the
  // gate is the only enforcement layer.
  const templates = require("../services/templates");
  if (templates.isTemplatePage(page)) {
    return validateTemplatePublishReadiness(page);
  }

  const issues = [];
  let components = [];
  try {
    components = typeof page.content === "string" ? JSON.parse(page.content || "[]") : (page.content || []);
  } catch (_e) {
    issues.push({ code: "CONTENT_INVALID_JSON", message: "Page content is not valid JSON. Re-open the builder to fix." });
    return { ok: false, issues };
  }
  if (!Array.isArray(components)) {
    issues.push({ code: "CONTENT_NOT_ARRAY", message: "Page content must be a block array." });
    return { ok: false, issues };
  }

  // Generic checks apply to every page.
  if (!page.title || !page.title.trim()) {
    issues.push({ code: "MISSING_TITLE", message: "Page title is empty." });
  }
  if (!page.slug || !/^[a-z0-9-]+$/.test(page.slug)) {
    issues.push({ code: "INVALID_SLUG", message: "Page slug is missing or invalid." });
  }
  if (components.length === 0) {
    issues.push({ code: "NO_BLOCKS", message: "Page has no blocks." });
  }

  // Travel checks apply only when the page is a travel destination.
  const isTravel = page.templateType === "travel_destination";
  if (!isTravel) {
    return { ok: issues.length === 0, issues };
  }

  // Find each travel block by type so we can validate completeness.
  const byType = {};
  components.forEach((c, idx) => {
    if (!c || !c.type) return;
    (byType[c.type] = byType[c.type] || []).push({ comp: c, idx });
  });

  // Hero — must exist, must have headline, posterUrl must be a non-null
  // string (manual upload required). Empty posterUrl OR the AI-stub
  // placeholder (null) both fail.
  const hero = (byType.destinationHero || [])[0];
  if (!hero) {
    issues.push({ code: "MISSING_HERO", message: "Add a Destination Hero block — required for travel landing pages." });
  } else {
    const p = hero.comp.props || {};
    if (!p.headline || !String(p.headline).trim()) {
      issues.push({ code: "HERO_HEADLINE_EMPTY", message: "Hero headline is empty.", blockType: "destinationHero", blockIndex: hero.idx });
    }
    if (!p.posterUrl || !String(p.posterUrl).trim()) {
      issues.push({ code: "HERO_IMAGE_MISSING", message: "Upload a hero image — Reserve / Publish is blocked without one.", blockType: "destinationHero", blockIndex: hero.idx });
    }
  }

  // City cards — each card needs an image and a title. AI emits null
  // images; user must upload before publishing.
  const cities = (byType.cityCards || [])[0];
  if (cities) {
    const cards = Array.isArray(cities.comp.props?.cards) ? cities.comp.props.cards : [];
    cards.forEach((card, ci) => {
      if (!card || !card.img || !String(card.img).trim()) {
        issues.push({
          code: "CITY_IMAGE_MISSING",
          message: `City card "${card?.title || `#${ci + 1}`}" is missing an image.`,
          blockType: "cityCards",
          blockIndex: cities.idx,
        });
      }
      if (!card || !card.title || !String(card.title).trim()) {
        issues.push({
          code: "CITY_TITLE_MISSING",
          message: `City card #${ci + 1} is missing a title.`,
          blockType: "cityCards",
          blockIndex: cities.idx,
        });
      }
    });
  }

  // Itinerary — must exist with ≥1 day.
  const itin = (byType.itineraryTimeline || [])[0];
  if (!itin) {
    issues.push({ code: "MISSING_ITINERARY", message: "Add an Itinerary Timeline block — required for travel landing pages." });
  } else {
    const days = Array.isArray(itin.comp.props?.days) ? itin.comp.props.days : [];
    if (days.length === 0) {
      issues.push({ code: "ITINERARY_EMPTY", message: "Itinerary has zero days.", blockType: "itineraryTimeline", blockIndex: itin.idx });
    }
    days.forEach((d, di) => {
      const hasTitle = d?.title && String(d.title).trim();
      const hasBullets = Array.isArray(d?.bullets) && d.bullets.some((b) => String(b || "").trim());
      if (!hasTitle && !hasBullets) {
        issues.push({
          code: "ITINERARY_DAY_EMPTY",
          message: `Day ${di + 1} of the itinerary is empty.`,
          blockType: "itineraryTimeline",
          blockIndex: itin.idx,
        });
      }
    });
  }

  // Highlights — at least 3.
  const highlights = (byType.highlightsGrid || [])[0];
  if (highlights) {
    const items = Array.isArray(highlights.comp.props?.items) ? highlights.comp.props.items : [];
    const filled = items.filter((it) => it && it.title && String(it.title).trim()).length;
    if (filled < MIN_HIGHLIGHT_COUNT) {
      issues.push({
        code: "HIGHLIGHTS_INSUFFICIENT",
        message: `Add at least ${MIN_HIGHLIGHT_COUNT} highlights — only ${filled} are filled in.`,
        blockType: "highlightsGrid",
        blockIndex: highlights.idx,
      });
    }
  }

  // Inclusions — at least 3.
  const inclusions = (byType.inclusionsGrid || [])[0];
  if (inclusions) {
    const items = Array.isArray(inclusions.comp.props?.items) ? inclusions.comp.props.items : [];
    const filled = items.filter((s) => String(s || "").trim()).length;
    if (filled < MIN_INCLUSIONS_COUNT) {
      issues.push({
        code: "INCLUSIONS_INSUFFICIENT",
        message: `Add at least ${MIN_INCLUSIONS_COUNT} inclusion items — only ${filled} are filled in.`,
        blockType: "inclusionsGrid",
        blockIndex: inclusions.idx,
      });
    }
  }

  // FAQs — at least MIN_FAQ_COUNT entries, each non-empty.
  const faq = (byType.faqAccordion || [])[0];
  if (!faq) {
    issues.push({ code: "MISSING_FAQ", message: "Add an FAQ block — required for travel landing pages." });
  } else {
    const faqs = Array.isArray(faq.comp.props?.faqs) ? faq.comp.props.faqs : [];
    const valid = faqs.filter((f) => f && String(f.q || "").trim() && String(f.a || "").trim());
    if (valid.length < MIN_FAQ_COUNT) {
      issues.push({
        code: "FAQ_INSUFFICIENT",
        message: `Add at least ${MIN_FAQ_COUNT} FAQs — only ${valid.length} are filled in.`,
        blockType: "faqAccordion",
        blockIndex: faq.idx,
      });
    }
  }

  // Pricing — block must exist AND every tier must have a non-empty
  // amount entered. AI never fills pricing; the operator must type each
  // tier's amount before publish is allowed.
  const pricing = (byType.tierPricing || [])[0];
  if (!pricing) {
    issues.push({ code: "MISSING_PRICING", message: "Add a Tier Pricing block — required for travel landing pages." });
  } else {
    const tiers = Array.isArray(pricing.comp.props?.tiers) ? pricing.comp.props.tiers : [];
    if (tiers.length === 0) {
      issues.push({ code: "PRICING_NO_TIERS", message: "Tier Pricing block has no tiers configured.", blockType: "tierPricing", blockIndex: pricing.idx });
    }
    tiers.forEach((t, ti) => {
      const hasAmount = t && t.amount != null && String(t.amount).trim() !== "";
      if (!hasAmount) {
        issues.push({
          code: "PRICING_TIER_UNCONFIGURED",
          message: `Pricing tier #${ti + 1} ("${t?.label || ""}") has no amount entered.`,
          blockType: "tierPricing",
          blockIndex: pricing.idx,
        });
      }
    });
  }

  // Lead-capture surface — must have at least one block that submits a
  // lead. THREE block types qualify (added across PR-A through PR-C):
  //   - `form`             generic lead form
  //   - `registrationForm` travel registration funnel (TMC / RFU / etc.
  //                        audience presets; canonical for educational +
  //                        religious trip pages)
  //   - `brochureDownload` when fileUrl is null/empty → renders an inline
  //                        lead-capture form that posts to the same
  //                        /api/pages/<slug>/submit endpoint. When
  //                        fileUrl is set the block is a direct download
  //                        (no lead capture) and doesn't count toward
  //                        this gate.
  //
  // Pre-fix: the gate only accepted `form`, so travel pages built with
  // the registration funnel + brochure download (the canonical PR-C
  // shape) tripped MISSING_FORM even though they have two working
  // lead-capture surfaces. Surfaced in UAT against the Bali school-trip
  // page.
  const formBlocks = byType.form || [];
  const registrationBlocks = byType.registrationForm || [];
  const brochureLeadBlocks = (byType.brochureDownload || []).filter(({ comp }) => {
    const fileUrl = comp?.props?.fileUrl;
    return !fileUrl || !String(fileUrl).trim();
  });
  const leadCaptureCount = formBlocks.length + registrationBlocks.length + brochureLeadBlocks.length;
  if (leadCaptureCount === 0) {
    issues.push({
      code: "MISSING_FORM",
      message: "Add a Form, Registration Form, or Brochure Download block so visitors can submit leads.",
    });
  }

  return { ok: issues.length === 0, issues };
}

// POST /api/landing-pages/:id/preview-token — mint a short-lived
// single-purpose JWT that authorises ONE landing-page preview.
//
// Why this exists: a `window.open("/api/.../preview")` new-tab cannot
// carry an `Authorization` header — browsers never set Authorization on
// top-level navigations. The auth_token cookie set on login (15-min
// TTL, httpOnly, sameSite=strict) would work but expires fast enough
// that operators previewing a page they've been editing for 20+ minutes
// hit an unexpected 401. A short-lived preview token decouples the
// preview flow from the cookie's lifetime.
//
// The minted token:
//   - Carries `previewLandingPageId: <id>` + `tenantId: <user.tenantId>`
//   - Has `exp: now + 5 minutes` — short enough to make replay
//     attractive only if the attacker is already on the operator's
//     machine, in which case they already have the localStorage JWT
//   - Carries `previewOnly: true` so verifyToken-protected routes won't
//     accept it for anything other than the preview render (defence-
//     in-depth — verifyToken rejects tokens missing `userId`)
//   - Is signed with the existing JWT_SECRET
router.post("/:id/preview-token", verifyToken, async (req, res) => {
  try {
    const pageId = parseInt(req.params.id);
    if (!Number.isFinite(pageId)) {
      return res.status(400).json({ error: "Invalid page id", code: "INVALID_ID" });
    }
    const page = await prisma.landingPage.findFirst({
      where: { id: pageId, tenantId: req.user.tenantId },
      select: { id: true, slug: true, title: true },
    });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const jwt = require("jsonwebtoken");
    const { JWT_SECRET } = require("../config/secrets");
    const token = jwt.sign(
      {
        previewLandingPageId: page.id,
        tenantId: req.user.tenantId,
        previewOnly: true,
      },
      JWT_SECRET,
      { expiresIn: "5m" }
    );
    return res.json({ token, pageId: page.id, slug: page.slug });
  } catch (err) {
    console.error("[LandingPages] preview-token mint failed:", err);
    return res.status(500).json({ error: "Failed to mint preview token" });
  }
});

// GET /api/landing-pages/:id/preview — true draft preview.
//
// Why: operators need to see the EXACT rendered microsite before they
// publish. Existing `/p/:slug` only serves PUBLISHED pages (DRAFT pages
// return 404 to public visitors), and the builder's left-panel preview
// is an approximation, not the production render.
//
// Auth (any of):
//   1. `?previewToken=<jwt>` — short-lived (5 min) single-purpose token
//      minted by POST /:id/preview-token. The route opens in a new tab
//      via window.open, which cannot carry an Authorization header,
//      so the token rides in the URL. The token's lifetime is short
//      enough that URL-bar leakage doesn't expose a long-replay vector.
//   2. `Authorization: Bearer <jwt>` header — for programmatic preview
//      callers (tests, future automation).
//   3. `auth_token` cookie — same-tab navigations from an authenticated
//      builder session. Works when the cookie is still fresh.
//
// Behaviour:
//   - Tenant-isolated: 404 if the page belongs to a different tenant.
//   - Works for DRAFT and PUBLISHED. PUBLISHED previews are a "see
//     what's live right now" affordance, identical to /p/:slug minus
//     analytics tracking.
//   - Uses the SAME `renderPage()` as production. The `preview: true`
//     flag only suppresses the analytics-pixel injection so operator
//     reviews don't inflate visit counters. No visual difference.
//   - Sets `X-Robots-Tag: noindex, nofollow` so crawlers that respect
//     the response header (Google, Bing) won't index a preview URL
//     even if a token were to leak.
//   - Cache-Control: no-store. Previews always reflect the most-recent
//     save so refresh-after-edit always shows the new state.
async function previewAuth(req) {
  // 1. Short-lived preview token (URL query). The token must match the
  //    requested :id AND must have previewOnly=true to prevent reuse
  //    against other authenticated routes (verifyToken rejects it
  //    anyway because it lacks userId, but defence-in-depth).
  const previewToken = typeof req.query.previewToken === "string" ? req.query.previewToken : null;
  if (previewToken) {
    try {
      const jwt = require("jsonwebtoken");
      const { JWT_SECRET } = require("../config/secrets");
      const decoded = jwt.verify(previewToken, JWT_SECRET);
      if (!decoded.previewOnly) return { ok: false, reason: "not_preview_token" };
      if (!Number.isFinite(decoded.previewLandingPageId)) return { ok: false, reason: "missing_page_id" };
      if (decoded.previewLandingPageId !== parseInt(req.params.id)) return { ok: false, reason: "page_id_mismatch" };
      return { ok: true, tenantId: decoded.tenantId };
    } catch (_e) {
      return { ok: false, reason: "invalid_or_expired" };
    }
  }
  // 2. Authorization header / 3. cookie — defer to the existing
  //    verifyToken middleware. We invoke it inline so we can return
  //    HTML errors (verifyToken returns JSON).
  return new Promise((resolve) => {
    verifyToken(req, { set: () => {}, status: () => ({ json: () => resolve({ ok: false, reason: "unauthenticated" }) }) }, () => {
      resolve({ ok: true, tenantId: req.user.tenantId });
    });
  });
}

router.get("/:id/preview", async (req, res) => {
  try {
    const auth = await previewAuth(req);
    if (!auth.ok) {
      return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;">
        <h1>Preview unavailable</h1>
        <p>This preview link is missing or expired. Open the page in the builder and click Preview again to generate a fresh link.</p>
      </body></html>`);
    }
    const page = await prisma.landingPage.findFirst({
      where: { id: parseInt(req.params.id), tenantId: auth.tenantId },
    });
    if (!page) return res.status(404).send("<h1>Page not found</h1>");

    // PR-E Phase 2.3 — version-aware preview. ?version=N renders the
    // snapshot at versionNumber=N WITHOUT mutating the live page. Used
    // by the builder's "Preview this version" affordance in the version
    // history list so operators can compare BEFORE restoring. Renders
    // through the SAME production renderer — no preview-specific path.
    let rendered = page;
    let versionForLog = null;
    const versionParam = req.query.version;
    if (versionParam != null && versionParam !== "") {
      const versionNumber = parseInt(versionParam, 10);
      if (!Number.isFinite(versionNumber) || versionNumber < 1) {
        return res.status(400).send("<h1>Invalid ?version parameter</h1>");
      }
      const snapshot = await prisma.landingPageVersion.findFirst({
        where: {
          landingPageId: page.id,
          tenantId: auth.tenantId,
          versionNumber,
        },
        select: { content: true, title: true, slug: true, source: true, versionNumber: true },
      });
      if (!snapshot) {
        return res.status(404).send(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;">
            <h1>Version ${versionNumber} not found</h1>
            <p>This page does not have a version with that number.</p>
          </body></html>`
        );
      }
      // Render the historical snapshot through the SAME pipeline as
      // the live page — same template renderer, same CSS, same JS.
      // Preserve page-level metadata (templateType / cssOverrides /
      // metaTitle / metaDescription / featured flag) so themed pages
      // render correctly; only swap content + title + slug from the
      // snapshot.
      rendered = {
        ...page,
        title: snapshot.title || page.title,
        slug: snapshot.slug || page.slug,
        content: snapshot.content,
      };
      versionForLog = snapshot.versionNumber;
    }

    const html = renderPage(rendered, { preview: true });
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      // X-Preview-Source distinguishes a live-state preview from a
      // historical-snapshot preview. The builder UI badges this in
      // the preview tab's header so operators see what they're looking at.
      "X-Preview-Source": versionForLog != null ? `version:${versionForLog}` : "live-draft",
    });
    // Per-response CSP override for Wanderlux templates ONLY (2026-06-23).
    // The Wanderlux dc-runtime ships Babel-standalone (loaded from unpkg)
    // and uses it to compile the `<x-dc>` template's JSX at runtime — a
    // legitimate `new Function(...)` / `eval()` use that the global CSP
    // blocks by default. We override CSP on JUST this one response so
    // unsafe-eval is scoped to the preview render (not the whole CRM).
    // Image-src is also widened so Pollinations + any photo CDN URLs
    // load. style/font-src widened for the reference's Google-Fonts
    // imports. media-src widened so operator-pasted video URLs (Pexels
    // CDN .mp4 etc.) load — without this the <video> renders the poster
    // but the play button stays disabled because the bytes never arrive.
    // frame-ancestors stays 'none' (no clickjacking surface).
    if (rendered && rendered.templateType === "wanderlux-v1") {
      res.set(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data: blob: https:",
          "media-src 'self' https: blob:",
          "connect-src 'self' https://image.pollinations.ai https://unpkg.com",
          // frame-src — mirrors the public-page route so YouTube / Vimeo /
          // Wistia / Loom embed URLs render in the preview the same way
          // they will when visitors hit the live page.
          "frame-src 'self' https://*.wistia.net https://*.wistia.com https://fast.wistia.net https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "object-src 'none'",
        ].join("; "),
      );
      // helmet sets a SECOND Report-Only CSP header that doesn't allow
      // unsafe-eval; without removing it the browser logs a violation even
      // though the enforcing header allows it. Drop the Report-Only on
      // wanderlux responses so devtools stays quiet.
      res.removeHeader("Content-Security-Policy-Report-Only");
    }
    return res.send(html);
  } catch (err) {
    console.error("[LandingPages] preview render error:", err);
    return res.status(500).send("<h1>Server error</h1>");
  }
});

// GET /api/landing-pages/:id/publish-check — non-mutating readiness
// check. Used by the builder's Publish gate UI to show the user a
// checklist of what's still missing.
router.get("/:id/publish-check", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    res.json(validatePublishReadiness(existing));
  } catch (err) {
    console.error("[LandingPages] publish-check error:", err);
    res.status(500).json({ error: "Failed to validate publish readiness" });
  }
});

router.post("/:id/publish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });

    // Publish-gate enforcement. Default behaviour is BLOCK on any
    // missing-content issue; ?force=true bypasses (for power users who
    // need to ship a partially-configured page, e.g. the gate adds a
    // new check after a page is already published and the operator
    // wants to re-publish without re-meeting it).
    const force = req.query.force === "true" || req.body.force === true;
    if (!force) {
      const verdict = validatePublishReadiness(existing);
      if (!verdict.ok) {
        return res.status(409).json({
          error: "Publish blocked — page is not ready.",
          code: "PUBLISH_GATE_FAILED",
          issues: verdict.issues,
        });
      }
    }

    // Single-page-live workflow: publishing ALSO features the page so
    // /trips resolves to it. Any sibling (same tenantId + subBrand)
    // currently featured gets demoted in the same transaction — the
    // invariant "at most ONE featured page per (tenant, subBrand)"
    // still holds. Pre-merge this required two button clicks (Publish
    // then Feature); the user opted to collapse the workflow because
    // they only ever want one landing page live at a time.
    const scope = {
      tenantId: req.user.tenantId,
      subBrand: existing.subBrand,
    };
    const now = new Date();
    const [, published] = await prisma.$transaction([
      prisma.landingPage.updateMany({
        where: { ...scope, isFeatured: true, NOT: { id: existing.id } },
        data: { isFeatured: false, featuredAt: null },
      }),
      prisma.landingPage.update({
        where: { id: existing.id },
        data: {
          status: "PUBLISHED",
          publishedAt: now,
          isFeatured: true,
          // Preserve the original featuredAt on re-publish so admin can
          // see WHEN this page first became the /trips destination; only
          // set it now if it was never featured before.
          featuredAt: existing.featuredAt || now,
        },
      }),
    ]);
    await snapshotSafe(prisma, published, VERSION_SOURCES.PUBLISH, req.user);
    res.json(published);
  } catch (err) {
    console.error("[LandingPages] publish error:", err);
    res.status(500).json({ error: "Failed to publish" });
  }
});

router.post("/:id/unpublish", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    // Unpublishing auto-clears the featured flag. Invariant: a featured
    // page must always be PUBLISHED so the /trips resolver never points
    // at a draft (which the /p/<slug> renderer 404s on).
    res.json(await prisma.landingPage.update({
      where: { id: existing.id },
      data: { status: "DRAFT", isFeatured: false, featuredAt: null },
    }));
  } catch (_err) { res.status(500).json({ error: "Failed to unpublish" }); }
});

// ── Feature / Unfeature ────────────────────────────────────────────
//
// "Featured" is the pointer the dynamic /trips public route resolves
// against. At most ONE landing page per (tenantId, subBrand) bucket
// should carry isFeatured=true. This is enforced transactionally by the
// /feature handler (un-feature any sibling in scope, then feature the
// target), not by a schema constraint — MySQL doesn't support partial
// unique indexes and a hard unique([tenantId, subBrand]) wouldn't allow
// multiple non-featured pages per scope.
//
// Featuring requires status=PUBLISHED so /trips never resolves to a
// page that /p/<slug> would 404 on. Unpublish auto-clears the flag
// (above) — same invariant from the other direction.
//
// Idempotency: re-featuring an already-featured page is a no-op (refresh
// featuredAt? no — keeps the original timestamp so admin can see WHEN
// the current featured page was first activated). Unfeaturing a non-
// featured page returns the row unchanged.
router.post("/:id/feature", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Page not found" });

    if (existing.status !== "PUBLISHED") {
      return res.status(409).json({
        error: "Only published pages can be featured. Publish this page first.",
        code: "PAGE_NOT_PUBLISHED",
        currentStatus: existing.status,
      });
    }

    // Already featured → idempotent no-op (keeps original featuredAt).
    if (existing.isFeatured) {
      return res.json(existing);
    }

    // Scope is (tenantId, subBrand). subBrand can legitimately be null
    // (a generic page that's not tied to a travel sub-brand). Prisma
    // treats `null` correctly in updateMany WHERE clauses.
    const scope = {
      tenantId: req.user.tenantId,
      subBrand: existing.subBrand,
    };

    await prisma.$transaction([
      // Demote any prior featured page in the same scope. NOT clause
      // excludes the target row in case it was already featured (handled
      // above but defence-in-depth doesn't hurt).
      prisma.landingPage.updateMany({
        where: { ...scope, isFeatured: true, NOT: { id: existing.id } },
        data: { isFeatured: false, featuredAt: null },
      }),
      prisma.landingPage.update({
        where: { id: existing.id },
        data: { isFeatured: true, featuredAt: new Date() },
      }),
    ]);

    const updated = await prisma.landingPage.findUnique({ where: { id: existing.id } });
    res.json(updated);
  } catch (err) {
    console.error("[LandingPages] feature error:", err);
    res.status(500).json({ error: "Failed to feature page" });
  }
});

router.post("/:id/unfeature", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.landingPage.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Page not found" });
    if (!existing.isFeatured) return res.json(existing); // idempotent
    const updated = await prisma.landingPage.update({
      where: { id: existing.id },
      data: { isFeatured: false, featuredAt: null },
    });
    res.json(updated);
  } catch (err) {
    console.error("[LandingPages] unfeature error:", err);
    res.status(500).json({ error: "Failed to unfeature page" });
  }
});

router.post("/:id/duplicate", verifyToken, async (req, res) => {
  try {
    const orig = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!orig) return res.status(404).json({ error: "Page not found" });
    const copy = await prisma.landingPage.create({
      data: {
        title: `Copy of ${orig.title}`,
        slug: `${orig.slug}-copy-${Date.now().toString(36)}`,
        content: orig.content,
        cssOverrides: orig.cssOverrides,
        templateType: orig.templateType,
        metaTitle: orig.metaTitle,
        metaDescription: orig.metaDescription,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(copy);
  } catch (_err) { res.status(500).json({ error: "Failed to duplicate" }); }
});

// ── Version history ───────────────────────────────────────────────
//
// Lightweight versioning surface for UAT / client demos / AI
// experimentation. Snapshots are captured automatically on create,
// manual save (content/title/slug change), publish, AI generation,
// and restore. Operators see them in the Builder's Versions panel
// and can restore any prior snapshot.
//
// Restore is append-only: the restore handler writes a NEW snapshot
// (source=RESTORE, restoredFromVersionId=N) and overwrites the
// LandingPage's content/title/slug from the chosen version. Previous
// versions remain in the chain.
//
// Excluded from this surface by design (per PRD): diff views,
// branching, merge, Git-like history.

router.get("/:id/versions", verifyToken, async (req, res) => {
  try {
    const pageId = parseInt(req.params.id, 10);
    if (!Number.isFinite(pageId)) return res.status(400).json({ error: "Invalid id" });
    const page = await prisma.landingPage.findFirst({
      where: { id: pageId, tenantId: req.user.tenantId },
      select: { id: true },
    });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const versions = await prisma.landingPageVersion.findMany({
      where: { landingPageId: page.id, tenantId: req.user.tenantId },
      orderBy: { versionNumber: "desc" },
      select: {
        id: true,
        versionNumber: true,
        title: true,
        slug: true,
        source: true,
        restoredFromVersionId: true,
        createdAt: true,
        createdById: true,
      },
    });
    res.json({ versions });
  } catch (err) {
    console.error("[LandingPages] list versions error:", err);
    res.status(500).json({ error: "Failed to list versions" });
  }
});

router.post("/:id/versions/:versionId/restore", verifyToken, async (req, res) => {
  try {
    const pageId = parseInt(req.params.id, 10);
    const versionId = parseInt(req.params.versionId, 10);
    if (!Number.isFinite(pageId) || !Number.isFinite(versionId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const page = await prisma.landingPage.findFirst({
      where: { id: pageId, tenantId: req.user.tenantId },
    });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const version = await prisma.landingPageVersion.findFirst({
      where: { id: versionId, landingPageId: page.id, tenantId: req.user.tenantId },
    });
    if (!version) return res.status(404).json({ error: "Version not found" });

    // Don't restore the slug if it would collide with another page in
    // the same tenant — that would silently strand a sibling's public
    // URL. Keep the current slug in that case; surface a warning flag
    // so the UI can tell the user "title/content restored, slug kept."
    let slugCollision = null;
    if (version.slug && version.slug !== page.slug) {
      slugCollision = await prisma.landingPage.findFirst({
        where: { tenantId: req.user.tenantId, slug: version.slug, NOT: { id: page.id } },
        select: { id: true, title: true },
      });
    }
    const slugToWrite = slugCollision ? page.slug : version.slug;

    const restored = await prisma.landingPage.update({
      where: { id: page.id },
      data: {
        title: version.title,
        slug: slugToWrite,
        content: version.content,
      },
    });
    const newVersion = await snapshotSafe(prisma, restored, VERSION_SOURCES.RESTORE, req.user, {
      restoredFromVersionId: version.id,
    });
    res.json({
      page: restored,
      restoredFromVersion: { id: version.id, versionNumber: version.versionNumber },
      newVersion: newVersion ? { id: newVersion.id, versionNumber: newVersion.versionNumber } : null,
      slugKept: slugCollision ? { reason: "SLUG_IN_USE", conflictingPageId: slugCollision.id } : null,
    });
  } catch (err) {
    console.error("[LandingPages] restore version error:", err);
    res.status(500).json({ error: "Failed to restore version" });
  }
});

router.get("/:id/analytics", verifyToken, async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const events = await prisma.landingPageAnalytics.findMany({
      where: { landingPageId: page.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const visits = events.filter(e => e.eventType === "VISIT").length;
    const submissions = events.filter(e => e.eventType === "FORM_SUBMIT").length;
    // #639 — return raw numeric so frontend's formatPercent can render
    // consistently. Pre-fix this returned a string ("12.3") which the FE then
    // appended "%" to without re-formatting → list/detail/CSV diverged.
    const conversionRate = visits > 0 ? Math.round((submissions / visits) * 1000) / 10 : 0;
    res.json({ events, visits, submissions, conversionRate });
  } catch (_err) { res.status(500).json({ error: "Failed to fetch analytics" }); }
});

// ── Public routes (no auth) ───────────────────────────────────────
// Pages are looked up by slug (globally unique). Inferred tenantId comes from the page itself.

publicRouter.get("/:slug", async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { slug: req.params.slug } });
    if (!page || page.status !== "PUBLISHED") return res.status(404).send("<h1>Page not found</h1>");

    await prisma.landingPage.update({ where: { id: page.id }, data: { visits: { increment: 1 } } });
    await prisma.landingPageAnalytics.create({
      data: { landingPageId: page.id, eventType: "VISIT", visitorIp: req.ip, userAgent: req.headers["user-agent"], referrer: req.headers["referer"], tenantId: page.tenantId || 1 },
    });

    const html = renderPage(page);
    res.set("Content-Type", "text/html");
    // Same per-response CSP override as the preview route — Wanderlux
    // pages need 'unsafe-eval' for the dc-runtime's Babel-standalone
    // JSX compiler. Scoped to wanderlux-v1 responses ONLY.
    if (page && page.templateType === "wanderlux-v1") {
      res.set(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data: blob: https:",
          "media-src 'self' https: blob:",
          "connect-src 'self' https://image.pollinations.ai https://unpkg.com",
          // frame-src — required for the reference's "INTERACTIVE PREVIEW"
          // video block. Allows iframe embeds from the major video CDNs
          // (Wistia / YouTube / Vimeo / Loom). Without this the iframe
          // renders "This content is blocked. Contact the site owner".
          "frame-src 'self' https://*.wistia.net https://*.wistia.com https://fast.wistia.net https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "object-src 'none'",
        ].join("; "),
      );
      res.removeHeader("Content-Security-Policy-Report-Only");
    }
    res.send(html);
  } catch (err) {
    console.error("[LandingPage] Render error:", err);
    res.status(500).send("<h1>Server error</h1>");
  }
});

// ── #451 — verify a Cloudflare Turnstile token ─────────────────────
//
// Stub-friendly: if `TURNSTILE_SECRET_KEY` is unset we WARN once per
// process and skip verification (returns true so the submit goes
// through). This means dev/CI environments don't 500 just because the
// secret is missing. In production the env-var must be set.
//
// On real verification we POST the token to Cloudflare's siteverify
// endpoint with `secret + response + remoteip`. Cloudflare returns
// `{ success: true|false, ... }`.
let _turnstileWarnedMissing = false;
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (!_turnstileWarnedMissing) {
      console.warn(
        "[LandingPage] TURNSTILE_SECRET_KEY not set — CAPTCHA verification skipped. Set this env var to enforce Cloudflare Turnstile."
      );
      _turnstileWarnedMissing = true;
    }
    return true;
  }
  if (!token || typeof token !== "string") return false;
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.success;
  } catch (err) {
    console.error("[LandingPage] Turnstile verify error:", err.message);
    return false;
  }
}

// ── #451 — apply a per-form lead-routing rule ──────────────────────
//
// Reads the form-level config out of the page's content JSON. If the
// form component has `leadRoutingRuleId`, we look up that rule (must
// belong to the same tenant), compute the assignee per rule type, and
// set contact.assignedToId. Errors are swallowed — routing failure
// shouldn't reject the lead.
//
// If unset, the contact is created without an assignee so the
// tenant-level lead_routing apply-all path picks it up later.
async function pickFormFromContent(content, submittedAudience, isBrochureRequest = false) {
  if (!content) return null;
  let arr = [];
  try {
    arr = typeof content === "string" ? JSON.parse(content) : content;
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  // Three block types qualify as lead-capture surfaces — `form`,
  // `registrationForm`, and `brochureDownload` (when fileUrl is empty
  // it renders an inline lead-capture form; when set it's a direct
  // download). All three honour the form-level config
  // (leadRoutingRuleId, enableCaptcha, successRedirectUrl).
  //
  // Disambiguation:
  //   1. Brochure submissions set `brochureRequest: true` in the body
  //      — prefer the brochureDownload block when it's present so
  //      brochure-specific routing rules apply.
  //   2. Registration-form submissions set `audience: <preset>` in
  //      the body — prefer the matching registrationForm block so
  //      multi-audience pages route by audience.
  //   3. Otherwise fall back to the first form / registrationForm /
  //      brochureDownload block in the page (legacy behaviour).
  if (isBrochureRequest) {
    const brochMatch = arr.find(
      (c) => c && c.type === "brochureDownload" && (!c.props || !c.props.fileUrl || !String(c.props.fileUrl).trim())
    );
    if (brochMatch) return brochMatch;
  }
  if (submittedAudience) {
    const audMatch = arr.find(
      (c) => c && c.type === "registrationForm" && (c.props || {}).audience === submittedAudience
    );
    if (audMatch) return audMatch;
  }
  return arr.find((c) => c && (
    c.type === "form"
    || c.type === "registrationForm"
    || (c.type === "brochureDownload" && (!c.props || !c.props.fileUrl || !String(c.props.fileUrl).trim()))
  )) || null;
}
async function applyLeadRouting(formProps, tenantId, contactId) {
  if (!formProps || !formProps.leadRoutingRuleId) return null;
  const ruleId = parseInt(formProps.leadRoutingRuleId, 10);
  if (!Number.isFinite(ruleId)) return null;
  try {
    const rule = await prisma.leadRoutingRule.findFirst({
      where: { id: ruleId, tenantId, isActive: true },
    });
    if (!rule) return null;
    let assigneeId = null;
    if (rule.assignType === "user" && rule.assignTo) {
      assigneeId = parseInt(rule.assignTo, 10) || null;
    } else if (rule.assignType === "round_robin") {
      // Best-effort: pick the first ADMIN/MANAGER/USER on this tenant.
      // Full round-robin counter lives in lead_routing.js — we don't
      // duplicate that complexity here for the inbound landing-page
      // path.
      const candidate = await prisma.user.findFirst({
        where: { tenantId, role: { in: ["ADMIN", "MANAGER", "USER"] } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assigneeId = candidate?.id ?? null;
    }
    if (assigneeId) {
      await prisma.contact.update({ where: { id: contactId }, data: { assignedToId: assigneeId } });
      return assigneeId;
    }
  } catch (err) {
    console.error("[LandingPage] applyLeadRouting failed:", err.message);
  }
  return null;
}

// Resolves the registration-mode marker for the form block being
// submitted. Two sources:
//   1. block.props.mode === "registration-draft"  → preferred, generic-block path
//   2. page.content.register.mode === "registration-draft"  → Wanderlux templatePayload path
// Either being truthy opts the submission into the
// PendingTripRegistration flow instead of Contact+Deal.
function resolveRegistrationMode(page, formProps) {
  if (formProps && formProps.mode === "registration-draft") return "registration-draft";
  if (page.templateType === "wanderlux-v1" && typeof page.content === "string") {
    try {
      const cfg = JSON.parse(page.content);
      if (cfg && cfg.register && cfg.register.mode === "registration-draft") {
        return "registration-draft";
      }
    } catch (_e) {
      // malformed wanderlux config — fall through to lead path
    }
  }
  return "lead";
}

// Hybrid landing-page → microsite registration-draft branch (Phase 3).
//
// When mode=registration-draft AND the page is trip-linked, the
// landing-page wizard submission creates a PendingTripRegistration
// staging row and returns a redirect URL pointing at the trip's
// microsite with an opaque draftToken in the query string. No PII
// in the URL. Falls back to a thank-you response (no microsite
// redirect) when the trip has no published microsite yet — gives
// operators a graceful pre-publish state.
//
// Does NOT create Contact + Deal. Marketing analytics for these
// submissions still flow through LandingPageAnalytics (the FORM_SUBMIT
// event is recorded by the main handler after this returns).
async function handleRegistrationDraft(req, res, page, formProps) {
  const tenantId = page.tenantId || 1;
  // The wizard's per-step values arrive flattened under `fields`
  // (the existing Wanderlux dc-runtime contract) or under a structured
  // `{ student, parent, passport, extras }` envelope (Phase 6 frontend).
  // Accept both shapes so we don't couple the backend to a single
  // submit-side encoding.
  const flat = (req.body && typeof req.body.fields === "object" && req.body.fields) ? req.body.fields : {};
  const student = (req.body && typeof req.body.student === "object" && req.body.student) ? req.body.student : {};
  const parent  = (req.body && typeof req.body.parent  === "object" && req.body.parent)  ? req.body.parent  : {};
  const passport = (req.body && typeof req.body.passport === "object" && req.body.passport) ? req.body.passport : {};
  const extras  = (req.body && typeof req.body.extras  === "object" && req.body.extras)  ? req.body.extras  : null;

  // Read from structured payload first, then flat fallback.
  const studentName    = student.name || flat.student_name || flat.studentName || null;
  const parentName     = parent.name  || flat.parent_name  || flat.parentName  || flat.name || null;
  const parentEmail    = parent.email || flat.parent_email || flat.parentEmail || flat.email || null;
  const parentPhone    = parent.phone || flat.parent_phone || flat.parentPhone || flat.phone || null;

  if (!studentName || !parentName || !parentEmail || !parentPhone) {
    return res.status(400).json({
      error: "studentName, parentName, parentEmail and parentPhone are required for trip-registration submissions",
      code: "MISSING_FIELDS",
    });
  }

  const draftToken = crypto.randomBytes(32).toString("hex");
  const draftTokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h

  const draft = await prisma.pendingTripRegistration.create({
    data: {
      tenantId,
      tripId: page.tripId, // guaranteed non-null by caller's branch guard
      landingPageId: page.id,
      studentName,
      studentDob: parseDateOrNull(student.dob || flat.student_dob),
      studentSchool: student.school || flat.student_school || null,
      studentClass: student.class || student.className || flat.student_class || null,
      studentGender: student.gender || flat.student_gender || null,
      parentName,
      parentEmail,
      parentPhone,
      parentRelation: parent.relation || flat.parent_relation || null,
      passportNumber: passport.number || flat.passport_number || null,
      passportExpiry: parseDateOrNull(passport.expiry || flat.passport_expiry),
      passportNationality: passport.nationality || flat.passport_nationality || null,
      passportPlaceOfIssue: passport.placeOfIssue || flat.passport_place_of_issue || null,
      extrasJson: extras ? JSON.stringify(extras) : null,
      audience: typeof req.body.audience === "string" ? req.body.audience : (formProps.audience || null),
      subBrand: page.subBrand || (typeof req.body.subBrand === "string" ? req.body.subBrand : null),
      draftToken,
      draftTokenExpiresAt,
      status: "DRAFT",
      otpVerified: false,
    },
  });

  // Bump LandingPage.submissions + drop a FORM_SUBMIT analytics row so
  // operators still see funnel metrics on registration-draft pages.
  await prisma.landingPage.update({ where: { id: page.id }, data: { submissions: { increment: 1 } } });
  await prisma.landingPageAnalytics.create({
    data: { landingPageId: page.id, eventType: "FORM_SUBMIT", visitorIp: req.ip, metadata: JSON.stringify({ kind: "registration-draft", draftId: draft.id }), tenantId },
  });

  // Resolve microsite redirect. If the trip has a published microsite,
  // the URL carries ONLY the opaque draftToken (no PII). If the trip
  // hasn't published a microsite yet, fall back to a thank-you
  // response — the operator can ship the microsite later and the
  // PendingTripRegistration row will still flow through the CRM
  // approval queue.
  const microsite = await prisma.tripMicrosite.findUnique({
    where: { tripId: page.tripId },
    select: { publicUuid: true, publishedAt: true, expiresAt: true },
  });
  const now = Date.now();
  const micrositeLive = microsite
    && microsite.publicUuid
    && microsite.publishedAt
    && (!microsite.expiresAt || microsite.expiresAt.getTime() > now);

  if (micrositeLive) {
    return res.status(201).json({
      ok: true,
      draftId: draft.id,
      redirect: {
        type: "microsite",
        url: `/p/tripmicrosite/${microsite.publicUuid}?draftToken=${draftToken}`,
      },
    });
  }
  return res.status(201).json({
    ok: true,
    draftId: draft.id,
    redirect: { type: "thanks" },
    message: "Thank you — your registration has been received. We'll be in touch shortly.",
  });
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

publicRouter.post("/:slug/submit", express.json(), async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { slug: req.params.slug } });
    if (!page) return res.status(404).json({ error: "Page not found" });
    const tenantId = page.tenantId || 1;

    // #451: locate the form component in the page's content so we can
    // honour its enableCaptcha / leadRoutingRuleId / successRedirectUrl
    // props on the server side too. The renderer-side checks aren't
    // sufficient — a malicious client could bypass the JS guard.
    // The `audience` body field (set by registrationForm hidden input)
    // lets us pick the right form block when a page has multiple.
    const submittedAudience = typeof req.body.audience === "string" ? req.body.audience : null;
    const isBrochureRequest = req.body.brochureRequest === true;
    const formComp = await pickFormFromContent(page.content, submittedAudience, isBrochureRequest);
    const formProps = (formComp && formComp.props) || {};

    // Phase 3 hybrid branch — when the page is trip-linked AND the
    // form block (or the Wanderlux templatePayload) declares
    // mode=registration-draft, create a PendingTripRegistration
    // instead of a Contact+Deal lead. The microsite OTP step
    // (Phase 4) then attaches phone verification to the draft, and
    // the CRM approval step (Phase 5) converts an OTP_VERIFIED draft
    // to a TripParticipant. Outside this branch the existing
    // Contact+Deal flow runs unchanged.
    if (page.tripId && resolveRegistrationMode(page, formProps) === "registration-draft") {
      // CAPTCHA still applies if the form-block configured it.
      if (formProps.enableCaptcha) {
        const ok = await verifyTurnstile(req.body.cfTurnstileToken, req.ip);
        if (!ok) {
          return res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
        }
      }
      return handleRegistrationDraft(req, res, page, formProps);
    }

    // #451: CAPTCHA verification before any DB writes.
    if (formProps.enableCaptcha) {
      const ok = await verifyTurnstile(req.body.cfTurnstileToken, req.ip);
      if (!ok) {
        return res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
      }
    }

    // The Wanderlux template sends form values nested under `fields`
    // (multi-step form aggregates all step inputs there); the older
    // single-block form types post flat. Read from `fields` first so
    // Wanderlux submissions land with real contact info instead of
    // the anonymous `lp-{slug}-{ts}@anonymous.local` fallback. Falls
    // back to the flat shape for back-compat with the older types.
    const formFields = (req.body && typeof req.body.fields === "object" && req.body.fields) ? req.body.fields : {};
    const pick = (key) => formFields[key] || req.body[key] || null;
    // Student programmes capture the PARENT as the lead contact (the
    // person we'll actually call back); student details land in the
    // contact's notes / source so the sales team has the full picture.
    const email = pick("email") || pick("parent_email");
    const name = pick("name") || pick("parent_name") || pick("full_name");
    const full_name = pick("full_name");
    const phone = pick("phone") || pick("parent_phone");
    const company = pick("company") || pick("company_name") || pick("student_school");
    const company_name = pick("company_name");
    const contactEmail = email || `lp-${page.slug}-${Date.now()}@anonymous.local`;
    const contactName = name || full_name || pick("student_name") || "Landing Page Lead";
    // Append the audience tag to the contact source so lead-routing
    // rules + manual triage can branch on it (e.g. "Landing Page: Bali
    // (tmc)" vs "Landing Page: Bali (rfu)"). Only appends when the body
    // came from a registrationForm.
    const sourceSuffix = submittedAudience ? ` (${submittedAudience})` : "";
    const contactSource = `Landing Page: ${page.title}${sourceSuffix}`;

    // Contact has @@unique([email, tenantId]) (schema.prisma:343) — Prisma's
    // upsert requires the where clause to match a unique constraint exactly,
    // so we use the composite `email_tenantId` selector that Prisma generates
    // from the @@unique declaration. Pre-fix this used `where: { email }`
    // which compiles but throws a Prisma validation error at runtime
    // ("Argument where: Got invalid value... Argument email_tenantId is
    // missing"), surfacing as the route's catch-all 500. The bug only fires
    // in production when an unauth visitor POSTs /p/<slug>/submit; the
    // path was previously gated behind the #445 Nginx-proxy fix so the bug
    // never reached real traffic until that landed.
    const contact = await prisma.contact.upsert({
      where: { email_tenantId: { email: contactEmail, tenantId } },
      update: { source: contactSource },
      create: {
        name: contactName,
        email: contactEmail,
        phone: phone || null,
        company: company || company_name || null,
        status: "Lead",
        source: contactSource,
        aiScore: 30,
        tenantId,
      },
    });

    // #451: apply per-form lead routing if configured.
    await applyLeadRouting(formProps, tenantId, contact.id);

    await prisma.deal.create({
      data: { title: `LP Inbound: ${page.title}`, amount: 0, stage: "lead", contactId: contact.id, tenantId },
    });

    await prisma.landingPage.update({ where: { id: page.id }, data: { submissions: { increment: 1 } } });
    await prisma.landingPageAnalytics.create({
      data: { landingPageId: page.id, eventType: "FORM_SUBMIT", visitorIp: req.ip, metadata: JSON.stringify(req.body), tenantId },
    });

    if (req.io) req.io.emit("deal_updated", {});

    res.json({ success: true, message: "Thank you for your submission!" });
  } catch (err) {
    console.error("[LandingPage] Submit error:", err);
    res.status(500).json({ error: "Submission failed" });
  }
});

publicRouter.get("/:slug/track", async (req, res) => {
  try {
    const page = await prisma.landingPage.findFirst({ where: { slug: req.params.slug } });
    if (page) {
      await prisma.landingPageAnalytics.create({
        data: { landingPageId: page.id, eventType: req.query.event || "VISIT", visitorIp: req.ip, userAgent: req.headers["user-agent"], tenantId: page.tenantId || 1 },
      });
    }
  } catch (_err) { /* silent */ }
  // 1x1 transparent GIF
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store" }).send(gif);
});

// ── Templates ─────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: "lead_capture", name: "Lead Capture", description: "Simple lead generation form with headline and CTA",
    content: [
      { type: "heading", props: { text: "Get Started Today", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Fill out the form below and our team will get back to you within 24 hours.", align: "center", color: "#64748b" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Full Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }, { label: "Phone", name: "phone", type: "tel", required: false }, { label: "Company", name: "company", type: "text", required: false }], submitText: "Get in Touch", thankYouMessage: "Thank you! We'll be in touch soon." } },
    ],
  },
  {
    id: "product_showcase", name: "Product Showcase", description: "Showcase your product with features and a signup form",
    content: [
      { type: "heading", props: { text: "The Best Solution for Your Business", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Trusted by 10,000+ businesses worldwide. See why teams love our platform.", align: "center", color: "#64748b" } },
      { type: "image", props: { src: "https://placehold.co/800x400/3b82f6/white?text=Product+Screenshot", alt: "Product", maxWidth: "800px" } },
      { type: "spacer", props: { height: "40px" } },
      { type: "columns", props: { gap: "2rem", columns: [{ components: [{ type: "heading", props: { text: "Fast Setup", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Get started in minutes, not months.", align: "center", color: "#64748b" } }] }, { components: [{ type: "heading", props: { text: "Powerful Analytics", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Real-time dashboards and insights.", align: "center", color: "#64748b" } }] }, { components: [{ type: "heading", props: { text: "24/7 Support", level: "h3", align: "center", color: "#1e293b" } }, { type: "text", props: { text: "Our team is always here to help.", align: "center", color: "#64748b" } }] }] } },
      { type: "spacer", props: { height: "40px" } },
      { type: "form", props: { fields: [{ label: "Name", name: "name", type: "text", required: true }, { label: "Work Email", name: "email", type: "email", required: true }], submitText: "Start Free Trial", thankYouMessage: "Welcome aboard! Check your email for next steps." } },
    ],
  },
  {
    id: "event_registration", name: "Event Registration", description: "Event landing page with details and registration form",
    content: [
      { type: "heading", props: { text: "Annual Business Summit 2026", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Join 500+ industry leaders on March 15, 2026 for a day of insights, networking, and innovation.", align: "center", color: "#64748b", fontSize: "1.1rem" } },
      { type: "spacer", props: { height: "20px" } },
      { type: "video", props: { url: "https://www.youtube.com/embed/dQw4w9WgXcQ", width: "100%" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Full Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }, { label: "Company", name: "company", type: "text", required: true }, { label: "Job Title", name: "title", type: "text", required: false }], submitText: "Register Now", thankYouMessage: "You're registered! We'll send confirmation details to your email." } },
    ],
  },
  {
    id: "webinar_signup", name: "Webinar Signup", description: "Webinar registration with countdown and signup form",
    content: [
      { type: "heading", props: { text: "Free Webinar: Scaling Your Sales Pipeline", level: "h1", align: "center", color: "#1e293b" } },
      { type: "text", props: { text: "Learn proven strategies to 3x your pipeline in 90 days. Live on April 20, 2026 at 2:00 PM IST.", align: "center", color: "#64748b" } },
      { type: "image", props: { src: "https://placehold.co/600x300/10b981/white?text=Webinar+Preview", alt: "Webinar", maxWidth: "600px" } },
      { type: "spacer", props: { height: "30px" } },
      { type: "form", props: { fields: [{ label: "Name", name: "name", type: "text", required: true }, { label: "Email", name: "email", type: "email", required: true }], submitText: "Save My Spot", thankYouMessage: "You're in! Check your inbox for the webinar link." } },
    ],
  },
  {
    // Travel destination skeleton — used by both the "Travel Destination"
    // template-picker entry (manual flow) AND as the canonical block
    // ordering the PR-B AI generator emits. All images / pricing amounts
    // start as null and are gated by the publish-validation endpoint
    // until the operator fills them in.
    id: "travel_destination",
    name: "Travel Destination",
    description: "Complete skeleton for a destination landing page — hero, cities, highlights, inclusions, itinerary, pricing, FAQ, registration.",
    content: [
      {
        type: "destinationHero",
        props: {
          destination: "Your Destination",
          headline: "A Journey That Matters",
          subhead: "Replace this subhead with your destination's hook.",
          posterUrl: null,
          countdownTo: null,
          ctaText: "Reserve Your Spot",
          ctaScrollTarget: "register",
          palette: { bg: "#1f1a17", fg: "#ffffff", accent: "#b8893b" },
        },
      },
      {
        type: "highlightsGrid",
        props: {
          title: "Why This Destination",
          subtitle: "",
          items: [
            { icon: "◈", title: "Highlight one", body: "Describe the first thing that makes this destination matter." },
            { icon: "⊕", title: "Highlight two", body: "Add a second supporting reason." },
            { icon: "⌂", title: "Highlight three", body: "And a third — operators recommend at least three." },
          ],
        },
      },
      {
        type: "cityCards",
        props: {
          title: "Where You'll Go",
          subtitle: "",
          cards: [
            { tag: "ICONIC", title: "City One", img: null, body: "Why this city matters to the journey." },
            { tag: "CULTURAL", title: "City Two", img: null, body: "Why this city matters to the journey." },
            { tag: "HERITAGE", title: "City Three", img: null, body: "Why this city matters to the journey." },
          ],
        },
      },
      {
        type: "inclusionsGrid",
        props: {
          title: "What's Included",
          subtitle: "",
          items: [
            "Return international airfare",
            "Hotel accommodation",
            "All meals",
            "Guided sightseeing",
            "Travel insurance",
          ],
        },
      },
      {
        type: "itineraryTimeline",
        props: {
          title: "Day-by-day",
          subtitle: "",
          days: [
            { day: 1, title: "Arrival", bullets: ["Airport pickup", "Hotel check-in", "Welcome briefing"] },
            { day: 2, title: "Day Two", bullets: ["Add the day's plan here"] },
            { day: 3, title: "Day Three", bullets: ["Add the day's plan here"] },
          ],
        },
      },
      {
        type: "tierPricing",
        props: {
          title: "Investment",
          subtitle: "Enter the amounts after operator review.",
          currency: "₹",
          tiers: [
            { step: 1, label: "Registration", subtitle: "Booking confirmation", amount: null, dueDate: null, vendor: null, tag: null },
            { step: 2, label: "Mid-term payment", subtitle: "", amount: null, dueDate: null, vendor: null, tag: null },
            { step: 3, label: "Final payment", subtitle: "", amount: null, dueDate: null, vendor: null, tag: null },
          ],
        },
      },
      {
        type: "faqAccordion",
        props: {
          title: "Frequently Asked Questions",
          subtitle: "",
          categories: [
            { id: "all", label: "All", icon: "◇" },
            { id: "tour", label: "Tour", icon: "◈" },
            { id: "payments", label: "Payments", icon: "⊞" },
            { id: "safety", label: "Safety", icon: "⊕" },
          ],
          faqs: [
            { cat: "tour", q: "What is the duration of this trip?", a: "Replace with the actual duration in days." },
            { cat: "tour", q: "Who is this trip designed for?", a: "Replace with the audience profile." },
            { cat: "payments", q: "What is the payment structure?", a: "Replace with the operator's policy." },
            { cat: "safety", q: "What are the safety protocols?", a: "Replace with the operator's safety framework." },
          ],
        },
      },
      {
        type: "form",
        props: {
          fields: [
            { label: "Full name", name: "name", type: "text", required: true },
            { label: "Email", name: "email", type: "email", required: true },
            { label: "Phone", name: "phone", type: "tel", required: true },
          ],
          submitText: "Reserve Your Spot",
          thankYouMessage: "Thank you — our team will reach out within 48 hours.",
        },
      },
    ],
  },
];

module.exports = { router, publicRouter };
