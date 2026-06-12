/**
 * /api/travel/flyer-templates — TravelFlyerTemplate CRUD
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice 3).
 *
 * Sibling to /api/travel/commission-profiles + /api/travel/quotes. Stores
 * operator-composed flyer templates (palette + layout blocks + optional
 * asset URLs) consumed by lib/flyerTemplateValidator.js (slice 1 commit
 * 28146498). Replaces the frontend STUB in FlyerTemplates.jsx (slice 2
 * commit a64c1058) — the page hits these endpoints once server.js mount
 * lands in a subsequent wire-in slice.
 *
 * The validator returns { ok, errors[] } envelopes; this route surfaces
 * any errors as 400 INVALID_TEMPLATE with the errors array attached so
 * the editor UI can highlight the offending fields. JSON-parse failure
 * (palette / layout / assets columns are @db.Text storing JSON) is a
 * separate 400 INVALID_PALETTE_JSON / INVALID_LAYOUT_JSON / INVALID_ASSETS_JSON
 * so the editor can distinguish "your JSON didn't parse" from "your shape
 * doesn't validate."
 *
 * Endpoints:
 *   GET    /api/travel/flyer-templates                — list (tenant + sub-brand scoped)
 *   GET    /api/travel/flyer-templates/sub-brands     — USER+ per-sub-brand counts (slice 13)
 *   GET    /api/travel/flyer-templates/global-stats   — USER+ tenant-wide rollup (slice 19)
 *   GET    /api/travel/flyer-templates/by-month       — USER+ tenant-wide monthly rollup (slice 21)
 *   GET    /api/travel/flyer-templates/by-quarter     — USER+ tenant-wide quarterly rollup (slice 22)
 *   GET    /api/travel/flyer-templates/by-year        — USER+ tenant-wide annual rollup (slice 23)
 *   POST   /api/travel/flyer-templates/bulk-archive   — ADMIN/MANAGER batch archive (slice 15)
 *   POST   /api/travel/flyer-templates/bulk-unarchive — ADMIN/MANAGER batch restore (slice 16)
 *   GET    /api/travel/flyer-templates/:id            — fetch one
 *   POST   /api/travel/flyer-templates                — ADMIN/MANAGER create
 *   POST   /api/travel/flyer-templates/:id/duplicate  — ADMIN/MANAGER clone (slice 6)
 *   POST   /api/travel/flyer-templates/:id/archive    — ADMIN/MANAGER soft-archive (slice 14)
 *   POST   /api/travel/flyer-templates/:id/unarchive  — ADMIN/MANAGER restore (slice 14)
 *   POST   /api/travel/flyer-templates/:id/export     — ADMIN/MANAGER queue render (slice 10)
 *   GET    /api/travel/flyer-templates/:id/preview.pdf — USER+ inline PDF preview (slice 12)
 *   GET    /api/travel/flyer-templates/:id/usage-stats — USER+ per-template AuditLog rollup (slice 17)
 *   GET    /api/travel/flyer-templates/:id/audit-trail  — USER+ ordered per-template audit list (slice 18)
 *   GET    /api/travel/flyer-templates/:id/clone-history — USER+ chronological per-source clone history (slice 20)
 *   PUT    /api/travel/flyer-templates/:id            — ADMIN/MANAGER partial update
 *   DELETE /api/travel/flyer-templates/:id            — ADMIN-only hard delete
 *
 * Validation strictness (slice 3):
 *   - name required, non-empty trim                     → 400 MISSING_FIELDS
 *   - paletteJson + layoutJson required on POST         → 400 MISSING_FIELDS
 *   - paletteJson / layoutJson / assetsJson must JSON.parse
 *                                                       → 400 INVALID_PALETTE_JSON
 *                                                          INVALID_LAYOUT_JSON
 *                                                          INVALID_ASSETS_JSON
 *   - Parsed { palette, layout, assets } must pass
 *     flyerTemplateValidator.validateTemplate           → 400 INVALID_TEMPLATE
 *     (response includes the errors array verbatim so the editor UI can
 *      annotate the offending fields).
 *   - subBrand (if provided) must match assertValidSubBrand
 *                                                       → 400 INVALID_SUB_BRAND
 *
 * PUT re-validates iff palette/layout/assets is part of the diff. A name-
 * only or notes-only update does NOT re-run flyerTemplateValidator (the
 * stored shape is unchanged). This matches the editor's UX: renaming a
 * template shouldn't fail because the saved layout no longer passes a
 * tightened validator — that's a separate migration concern.
 *
 * Response envelope (slice 9): every row returned by list/get/create/
 * update/duplicate carries a virtual `templateHash` field — the
 * deterministic SHA-256 of the JSON-canonicalized { palette, layout,
 * assets } shape (lib/flyerExport.js, slice 8 commit 2390069b). The
 * field is computed on read, NOT stored on disk — Prisma schema is
 * unchanged. Two reasons it's read-time only:
 *   (1) Hash is a derivative of the stored columns; persisting it means
 *       keeping it in sync on every write, and an out-of-sync stale hash
 *       is worse than the recompute cost.
 *   (2) The hash function lives in flyerExport.js next to the cache-key
 *       builder; future changes to either side land as a single helper
 *       edit + a route response that just re-reads.
 * The frontend uses `templateHash` as a client-side cache-key for
 * preview thumbnails + the future MarketingFlyer.outputUrls cache lookup
 * (FR-3.4.5, AC-6.3). A row whose paletteJson or layoutJson is
 * unparseable falls back to the same hash as the empty `{}` shape — the
 * cache will simply miss + the renderer regenerates the asset, which is
 * the right degraded behaviour for a corrupted-stored-shape row.
 *
 * Sub-brand isolation: every list / get / write goes through
 * getSubBrandAccessSet + canAccessSubBrand. A MANAGER restricted to one
 * sub-brand cannot read or write templates attached to other sub-brands;
 * templates with NULL subBrand are tenant-wide and visible to everyone.
 *
 * Error codes (route-specific):
 *   INVALID_ID, MISSING_FIELDS, INVALID_TEMPLATE, INVALID_PALETTE_JSON,
 *   INVALID_LAYOUT_JSON, INVALID_ASSETS_JSON, INVALID_SUB_BRAND,
 *   TEMPLATE_NOT_FOUND, SUB_BRAND_DENIED, EMPTY_BODY.
 *
 * Mount in server.js is a SEPARATE slice (wire-in deferred).
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  VALID_SUB_BRANDS,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { validateTemplate } = require("../lib/flyerTemplateValidator");
const {
  hashTemplateShape,
  validateExportRequest,
  buildOutputCacheKey,
} = require("../lib/flyerExport");
const { renderFlyerPdf } = require("../lib/flyerPdfRender");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const s3 = require("../services/s3Service");

// Flyer asset upload (PRD_TRAVEL_MARKETING_FLYER FR-3.2.2). memoryStorage so the
// buffer can route to S3 (when AWS_S3_BUCKET_NAME is set) OR local disk (dev /
// no creds) — works now, uses S3 the moment the bucket env lands, no code change.
const FLYER_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
const flyerImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (FLYER_IMAGE_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, GIF, WebP, or SVG images are allowed"));
  },
});
function flyerImageExt(mime) {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" })[mime] || ".img";
}

/**
 * Parse a `@db.Text` column expected to contain JSON. Accepts:
 *   - a string  → JSON.parse it, throw with `code` on parse failure
 *   - an object → return as-is (the caller stringifies for storage)
 *
 * Returns `{ parsed, stringified }`. `stringified` is the canonical
 * `@db.Text` payload to persist; `parsed` is the live JS value the
 * validator runs against.
 */
function parseJsonColumn(input, fieldName, code) {
  if (input == null || input === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  if (typeof input === "string") {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (_e) {
      const err = new Error(`${fieldName} must be valid JSON`);
      err.status = 400;
      err.code = code;
      throw err;
    }
    return { parsed, stringified: input };
  }
  if (typeof input === "object") {
    let stringified;
    try {
      stringified = JSON.stringify(input);
    } catch (_e) {
      const err = new Error(`${fieldName} must be JSON-serializable`);
      err.status = 400;
      err.code = code;
      throw err;
    }
    return { parsed: input, stringified };
  }
  const err = new Error(`${fieldName} must be a JSON object/array or string`);
  err.status = 400;
  err.code = code;
  throw err;
}

/**
 * Run flyerTemplateValidator.validateTemplate against parsed
 * { palette, layout, assets } values. Throws a tagged error the route
 * catch block converts to 400 INVALID_TEMPLATE with the errors array.
 */
function assertValidTemplateShape({ palette, layout, assets }) {
  const result = validateTemplate({ palette, layout, assets });
  if (!result.ok) {
    const err = new Error("Template failed shape validation");
    err.status = 400;
    err.code = "INVALID_TEMPLATE";
    err.errors = result.errors;
    throw err;
  }
}

/**
 * Decorate a TravelFlyerTemplate row with the virtual `templateHash`
 * field (slice 9). Computed at read-time from the row's stored JSON
 * columns; never persisted (see file header rationale).
 *
 * A row whose paletteJson / layoutJson / assetsJson is unparseable
 * folds into the same empty-envelope hash as `{}` — the renderer cache
 * will simply miss + regenerate, which is the right degraded behaviour
 * for a corrupted-stored-shape row.
 */
function withTemplateHash(row) {
  if (!row || typeof row !== "object") return row;
  let palette = null;
  let layout = null;
  let assets = null;
  if (row.paletteJson) {
    try { palette = JSON.parse(row.paletteJson); } catch (_e) { palette = null; }
  }
  if (row.layoutJson) {
    try { layout = JSON.parse(row.layoutJson); } catch (_e) { layout = null; }
  }
  if (row.assetsJson) {
    try { assets = JSON.parse(row.assetsJson); } catch (_e) { assets = null; }
  }
  // Expose the parsed shapes alongside the raw JSON strings so the
  // FlyerTemplates list page can render a scaled-down preview of each
  // template's layout without parsing on the client. Additive — older
  // callers still see paletteJson / layoutJson / assetsJson untouched.
  return {
    ...row,
    palette,
    layout,
    assets,
    templateHash: hashTemplateShape({ palette, layout, assets }),
  };
}

// POST /api/travel/flyer-templates/upload
//
// FR-3.2.2 — upload a flyer asset image (multipart/form-data, field "image").
// Storage: AWS S3 via services/s3Service when AWS_S3_BUCKET_NAME is configured
// (marketing flyers are public-shareable assets, so s3Service's public-read ACL
// is appropriate here); otherwise written to local disk under
// backend/uploads/flyer-assets/tenant-<id>/ (served by the /uploads static
// mount). ADMIN/MANAGER + travel-vertical only (matches the studio RBAC).
// Returns { url, storage }.
router.post(
  "/flyer-templates/upload",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  (req, res) => {
    flyerImageUpload.single("image")(req, res, async (err) => {
      if (err) {
        const code = err.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "INVALID_UPLOAD";
        return res.status(400).json({ error: err.message || "Upload failed", code });
      }
      if (!req.file) {
        return res.status(400).json({ error: "image file is required (field 'image')", code: "MISSING_FILE" });
      }
      try {
        const tenantId = req.travelTenant.id;
        if (s3.BUCKET_NAME) {
          const url = await s3.uploadImage(
            req.file.buffer,
            req.file.originalname || "flyer-asset",
            req.file.mimetype,
            `flyer-assets/tenant-${tenantId}`,
          );
          return res.status(201).json({ url, storage: "s3" });
        }
        // Local-disk fallback (no S3 configured).
        const dir = path.join(__dirname, "..", "uploads", "flyer-assets", `tenant-${tenantId}`);
        await fs.promises.mkdir(dir, { recursive: true });
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${flyerImageExt(req.file.mimetype)}`;
        await fs.promises.writeFile(path.join(dir, fileName), req.file.buffer);
        return res.status(201).json({ url: `/uploads/flyer-assets/tenant-${tenantId}/${fileName}`, storage: "local" });
      } catch (e) {
        console.error("[flyer-upload] store error:", e.message);
        return res.status(500).json({ error: "Failed to store image", code: "UPLOAD_STORE_FAILED" });
      }
    });
  },
);

// POST /api/travel/flyer-templates/suggest-copy
//
// S71 — AI-generated marketing flyer copy via Gemini 2.5 Flash.
// Body: { destination (required), subBrand?, themeJson?, targetAudience? }
// Returns: { headline, body, cta, source, model, stub }
//
// Stub mode (no GEMINI_API_KEY) returns [STUB]-prefixed strings so the
// UI keeps working; real mode returns parsed Gemini JSON. Budget cap
// enforced inside marketingFlyerCopyLLM via checkBudgetCap.
router.post(
  "/flyer-templates/suggest-copy",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { destination, subBrand, themeJson, targetAudience } = req.body || {};
      const dest = typeof destination === "string" ? destination.trim() : "";
      if (!dest) {
        return res.status(400).json({ error: "destination is required", code: "MISSING_DESTINATION" });
      }
      let resolvedSubBrand = null;
      if (subBrand != null && String(subBrand).trim() !== "") {
        assertValidSubBrand(String(subBrand).trim());
        resolvedSubBrand = String(subBrand).trim();
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, resolvedSubBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
      }
      const audience = typeof targetAudience === "string" ? targetAudience.slice(0, 200) : null;
      const svc = require("../services/marketingFlyerCopyLLM");
      const result = await svc.generateFlyerCopy({
        tenantId: req.travelTenant.id,
        destination: dest,
        subBrand: resolvedSubBrand,
        themeJson: themeJson || null,
        targetAudience: audience,
      });
      return res.status(200).json({
        headline: result.copyJson.headline,
        body: result.copyJson.body,
        cta: result.copyJson.cta,
        source: result.source,
        model: result.model,
        stub: Boolean(result.stub),
        realModeError: result.realModeError || null,
      });
    } catch (e) {
      if (e.code === "MARKETING_FLYER_COPY_BUDGET_EXCEEDED") {
        return res.status(429).json({
          error: "Monthly AI budget reached for this tenant.",
          code: "LLM_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[flyer-suggest-copy] error:", e.message);
      return res.status(500).json({ error: "Failed to generate flyer copy" });
    }
  },
);

// POST /api/travel/flyer-templates/suggest-image
//
// S72 — AI-generated flyer hero image via OpenAI DALL-E 3.
// Body: { destination (required), subBrand?, themeJson?, aspectRatio? }
//   aspectRatio ∈ '1:1' | '9:16' | '16:9' (default '1:1')
// Returns: { imageUrl, source, model, stub }
//
// imageUrl is an OpenAI CDN URL with a ~1h TTL. Operator should save the
// flyer template (encodes URL into assetsJson) shortly after generating —
// persistence to local storage is a follow-up. Stub mode returns a
// deterministic placeholder URL. Budget cap enforced inside
// marketingFlyerImageLLM via checkBudgetCap.
router.post(
  "/flyer-templates/suggest-image",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { destination, subBrand, themeJson, aspectRatio } = req.body || {};
      const dest = typeof destination === "string" ? destination.trim() : "";
      if (!dest) {
        return res.status(400).json({ error: "destination is required", code: "MISSING_DESTINATION" });
      }
      let resolvedSubBrand = null;
      if (subBrand != null && String(subBrand).trim() !== "") {
        assertValidSubBrand(String(subBrand).trim());
        resolvedSubBrand = String(subBrand).trim();
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, resolvedSubBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
      }
      const svc = require("../services/marketingFlyerImageLLM");
      const result = await svc.generateFlyerImage({
        tenantId: req.travelTenant.id,
        destination: dest,
        subBrand: resolvedSubBrand,
        themeJson: themeJson || null,
        aspectRatio: typeof aspectRatio === "string" ? aspectRatio : undefined,
      });
      return res.status(200).json({
        imageUrl: result.imageUrl,
        source: result.source,
        model: result.model,
        stub: Boolean(result.stub),
        realModeError: result.realModeError || null,
      });
    } catch (e) {
      if (e.code === "MARKETING_FLYER_IMAGE_BUDGET_EXCEEDED") {
        return res.status(429).json({
          error: "Monthly AI budget reached for this tenant.",
          code: "LLM_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[flyer-suggest-image] error:", e.message);
      return res.status(500).json({ error: "Failed to generate flyer image" });
    }
  },
);

// GET /api/travel/flyer-templates
// Honors ?subBrand=tmc, ?isActive=true/false.
// Sub-brand-restricted callers see only their allowed sub-brands PLUS
// tenant-wide templates (subBrand IS NULL).
router.get(
  "/flyer-templates",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing — same pattern as travel_commission_profiles.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__"; // silent-empty
          }
        } else {
          where.OR = [
            { subBrand: { in: [...allowed] } },
            { subBrand: null },
          ];
        }
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [templates, total] = await Promise.all([
        prisma.travelFlyerTemplate.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          skip,
        }),
        prisma.travelFlyerTemplate.count({ where }),
      ]);
      res.json({
        templates: templates.map(withTemplateHash),
        total,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] list error:", e.message);
      res.status(500).json({ error: "Failed to list flyer templates" });
    }
  },
);

// GET /api/travel/flyer-templates/sub-brands — per-sub-brand template counts
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 13).
//
// USER-readable meta endpoint that powers the flyer-library UI's sub-brand
// filter chips ("TMC (8) · RFU (6) · Travel Stall (12) · Tenant-wide (3)").
// Without this, the frontend has to page through every flyer just to
// populate the filter dropdown.
//
// PRD anchors:
//   - §3.7.1 — curated per-sub-brand template library (TMC / RFU /
//              Travel Stall / Visa Sure)
//   - §3.7.4 — template marketplace search + filter by sub-brand
//   - AC-6.6 — flyer library per sub-brand (cross-sub-brand leakage
//              blocked at API + UI levels)
//
// Behaviour:
//   - One bucket per VALID_SUB_BRANDS value the caller can see + a
//     synthetic "(tenant-wide)" bucket for rows with subBrand=NULL.
//   - Sub-brand-restricted callers (User.subBrandAccess narrows to a
//     subset) see ONLY their allowed sub-brand buckets PLUS the
//     tenant-wide bucket. The tenant-wide bucket is always visible —
//     same rule the list endpoint enforces (NULL subBrand rows are
//     visible to everyone).
//   - Optional ?isActive=true|false narrows the counts to active /
//     archived rows only. Default (no query) counts every row.
//   - Response shape is a stable array (not a map) so callers can sort
//     it for UI display. `subBrand: null` is the tenant-wide bucket;
//     `total` is the convenience sum of all bucket counts.
//
// Implementation note: uses findMany over groupBy intentionally — the
// total population (4 sub-brands + 1 tenant-wide) is bounded, the row
// shape stays mock-friendly for vitest, and the JS-side aggregation
// step is O(rows) on a per-tenant scale that maxes out in the low
// thousands. groupBy would add a second mock surface for marginal
// efficiency.
//
// No write side effects; no audit row (read-only meta, mirrors the
// rationale on /:id/preview.pdf).
router.get(
  "/flyer-templates/sub-brands",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing — same gate as the list endpoint above.
      // Sub-brand-restricted callers see their allowed sub-brands plus
      // the tenant-wide (NULL) rows.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      const rows = await prisma.travelFlyerTemplate.findMany({
        where,
        select: { subBrand: true },
      });

      // Initialise a zero-count bucket for every VALID sub-brand the
      // caller can see, PLUS the tenant-wide bucket. Pre-seeding with
      // zeros means the frontend always sees the full set of filter
      // chips (with zeros visually-distinct) rather than an unstable
      // shape that grows / shrinks as templates appear / disappear.
      const counts = new Map();
      counts.set(null, 0); // tenant-wide bucket
      for (const sb of VALID_SUB_BRANDS) {
        if (!allowed || allowed.has(sb)) counts.set(sb, 0);
      }

      for (const row of rows) {
        const key = row.subBrand ?? null;
        // Defensive: skip a sub-brand row the caller shouldn't see
        // (shouldn't happen given the where-clause narrowing above,
        // but the cost of being explicit is one .has() check).
        if (!counts.has(key)) continue;
        counts.set(key, counts.get(key) + 1);
      }

      // Stable order: tenant-wide first, then sub-brands alphabetically.
      const buckets = [];
      buckets.push({ subBrand: null, count: counts.get(null) });
      for (const sb of VALID_SUB_BRANDS) {
        if (counts.has(sb)) {
          buckets.push({ subBrand: sb, count: counts.get(sb) });
        }
      }

      const total = buckets.reduce((sum, b) => sum + b.count, 0);

      res.json({ buckets, total });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] sub-brands error:", e.message);
      res.status(500).json({ error: "Failed to summarise flyer templates by sub-brand" });
    }
  },
);

// GET /api/travel/flyer-templates/global-stats — tenant-wide flyer-templates rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 19).
//
// USER-readable meta endpoint. Powers the FlyerTemplates library page's
// header summary strip ("42 templates · 35 active · 7 archived ·
// 184 lifetime exports · 12 last 7d"). Without this, the frontend has
// to fire {/sub-brands, /?isActive=true, /?isActive=false, /audit poll}
// just to render the header — 4 round-trips for a single visual surface.
//
// Distinct from slice 13 /sub-brands (per-sub-brand counts only) and
// slice 17 /:id/usage-stats (per-template rollup). This is the
// tenant-wide aggregate across BOTH dimensions: template-count summary
// (status + sub-brand) AND audit-derived activity (lifetime exports +
// recent activity), in one envelope.
//
// PRD anchors:
//   - §3.7.2 — per-template metadata feeds the marketplace list +
//              future conversion-rate column (this is the upstream
//              tenant-level rollup the dashboard reads)
//   - §3.7.4 — template marketplace search/filter (header summary
//              gives the operator the population denominator)
//   - §3.6.4 — performance hint engine consumes per-tenant export
//              counts to surface optimisation suggestions
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees
//     ONLY their allowed sub-brands' templates in the counts, PLUS
//     tenant-wide (NULL subBrand) rows. Same gate as the list endpoint.
//   - Template-count rollup (from prisma.travelFlyerTemplate.findMany
//     with select: { subBrand, isActive }):
//       total, active, archived              — overall + by status
//       bySubBrand[]                         — { subBrand, total, active, archived }
//                                              one row per visible sub-brand
//                                              + tenant-wide (subBrand: null)
//   - Audit-derived rollup (from prisma.auditLog.findMany scoped to
//     entity='TravelFlyerTemplate' for this tenant):
//       exports.total                        — lifetime EXPORTED + EXPORT_QUEUED
//       exports.last7d                       — exports in the last 7d
//       recentActivity.last7d                — total audit rows in last 7d
//       lastActivityAt                       — ISO ts of newest audit row,
//                                              or null if no history
//
// USER-readable: matches the read-only-aid contract on /sub-brands +
// /usage-stats + /audit-trail. The data is anodyne (counts +
// timestamps); no payload bodies leak.
//
// No audit row: read-only meta surface. Mirrors slice 12 / 13 / 17 / 18.
//
// Implementation note: two findMany reads (templates + audit logs)
// rather than groupBy. Templates findMany returns { subBrand, isActive }
// only (light row shape); audit findMany returns { action, createdAt }
// only. JS-side aggregation stays mock-friendly for vitest and matches
// the rationale on /sub-brands (slice 13) + /usage-stats (slice 17).
// Sub-brand-restricted callers' template read is narrowed via the
// same OR / IN clause as the list endpoint, so cross-sub-brand rows
// can NEVER appear in the rollup denominator.
//
// Express route ordering: literal-path /global-stats MUST be declared
// BEFORE the /:id family or `:id="global-stats"` would 400 INVALID_ID
// before reaching this handler. Same convention as /sub-brands +
// /bulk-archive + /bulk-unarchive.
router.get(
  "/flyer-templates/global-stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Sub-brand narrowing — same gate as the list endpoint above.
      // Sub-brand-restricted callers see their allowed sub-brands plus
      // tenant-wide (NULL) rows; admins/managers without subBrandAccess
      // see everything.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const templateWhere = { tenantId };
      if (allowed) {
        templateWhere.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Single findMany returns the light projection; JS aggregates
      // both status counts AND per-sub-brand buckets in one pass.
      const rows = await prisma.travelFlyerTemplate.findMany({
        where: templateWhere,
        select: { subBrand: true, isActive: true },
      });

      // Pre-seed buckets — tenant-wide always present, plus every
      // sub-brand the caller can see. Zero-init so the frontend
      // sees a stable shape regardless of which sub-brands have rows.
      const bucketMap = new Map();
      bucketMap.set(null, { subBrand: null, total: 0, active: 0, archived: 0 });
      for (const sb of VALID_SUB_BRANDS) {
        if (!allowed || allowed.has(sb)) {
          bucketMap.set(sb, { subBrand: sb, total: 0, active: 0, archived: 0 });
        }
      }

      let total = 0;
      let active = 0;
      let archived = 0;
      for (const row of rows) {
        const key = row.subBrand ?? null;
        const bucket = bucketMap.get(key);
        // Defensive: skip a row the where-clause shouldn't have surfaced.
        if (!bucket) continue;
        bucket.total += 1;
        if (row.isActive) bucket.active += 1;
        else bucket.archived += 1;
        total += 1;
        if (row.isActive) active += 1;
        else archived += 1;
      }

      // Stable order: tenant-wide first, then sub-brands in VALID_SUB_BRANDS
      // order (matches /sub-brands convention).
      const bySubBrand = [bucketMap.get(null)];
      for (const sb of VALID_SUB_BRANDS) {
        if (bucketMap.has(sb)) bySubBrand.push(bucketMap.get(sb));
      }

      // Audit-derived rollup. Single findMany over this entity's tenant
      // audit history. The result set is bounded per tenant (a heavy
      // user might accumulate a few thousand rows over months) — JS
      // aggregation keeps it mock-friendly. We do NOT sub-brand-narrow
      // the audit read: audit rows don't carry subBrand and the data
      // we surface (counts + timestamps) is anodyne enough that the
      // tenant-level slice is correct for the header strip.
      const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const auditRows = await prisma.auditLog.findMany({
        where: {
          tenantId,
          entity: "TravelFlyerTemplate",
        },
        select: { action: true, createdAt: true },
      });

      let exportsTotal = 0;
      let exportsLast7d = 0;
      let recentActivityLast7d = 0;
      let lastActivityAt = null;
      for (const row of auditRows) {
        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);
        if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
        const isRecent = ts.getTime() >= sevenDaysAgoMs;
        if (isRecent) recentActivityLast7d += 1;
        if (
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORTED" ||
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED"
        ) {
          exportsTotal += 1;
          if (isRecent) exportsLast7d += 1;
        }
      }

      res.json({
        total,
        active,
        archived,
        bySubBrand,
        exports: {
          total: exportsTotal,
          last7d: exportsLast7d,
        },
        recentActivity: {
          last7d: recentActivityLast7d,
        },
        lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] global-stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise flyer templates" });
    }
  },
);

// POST /api/travel/flyer-templates/bulk-archive — ADMIN/MANAGER batch archive
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 15).
//
// Accepts `{ ids: [int, ...] }` and archives every matching template the
// caller can access. Per-id outcomes are bucketed into the response
// envelope so operators driving the library page's "select N rows →
// archive" affordance can render per-row feedback without N round-trips.
//
// Why a dedicated endpoint instead of looping POST /:id/archive on the
// frontend:
//   (1) One round-trip vs N (~5-50 templates is the realistic batch
//       size for a library-page selection).
//   (2) Atomic audit-batch — every successful archive shares the same
//       requesting user + same wall-clock, so audit reports can correlate
//       a bulk action as a single operator intent rather than N
//       indistinguishable singletons.
//   (3) Partial-success contract: a denied / not-found id inside the
//       batch does NOT roll back the rest. Operators get { archived,
//       alreadyArchived, notFound, denied } buckets in the response —
//       same shape the future bulk-export / bulk-tag endpoints will use.
//
// Express route ordering: this route MUST be declared BEFORE the
// `/flyer-templates/:id` family because `bulk-archive` would otherwise
// be captured as `:id="bulk-archive"` and 400-INVALID_ID before reaching
// the bulk handler. The literal-path-first convention is documented in
// the file header and pinned by the slice-15 unit tests.
//
// Body limits: `ids` must be a non-empty array of finite integers; max
// 100 ids per request (mirrors the bulk-tag / bulk-delete cap convention
// in other routes — protects against accidental "select all 10k rows"
// abuse and keeps the per-request prisma round-trips bounded).
//
// Per-id outcomes (returned in the response envelope):
//   - archived[]            — ids successfully flipped to isActive=false
//                             (one audit row each)
//   - alreadyArchived[]     — ids whose row was already isActive=false
//                             (no prisma.update, no audit — idempotent)
//   - notFound[]            — ids that don't exist or live on another
//                             tenant
//   - denied[]              — ids whose row's sub-brand is outside the
//                             caller's subBrandAccess
//
// Status: 200 even on partial success (the buckets carry the per-id
// outcome). 400 INVALID_IDS / EMPTY_IDS / TOO_MANY_IDS for malformed
// requests. 403 RBAC_DENIED via verifyRole if role !∈ {ADMIN, MANAGER}.
router.post(
  "/flyer-templates/bulk-archive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { ids } = req.body || {};

      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "ids must be an array of template ids",
          code: "INVALID_IDS",
        });
      }
      if (ids.length === 0) {
        return res.status(400).json({
          error: "ids must contain at least one template id",
          code: "EMPTY_IDS",
        });
      }
      if (ids.length > 100) {
        return res.status(400).json({
          error: "ids must contain at most 100 template ids per request",
          code: "TOO_MANY_IDS",
        });
      }

      // Normalise + de-dupe. Reject the whole batch if ANY id is not a
      // finite integer — silent-skip of non-numeric entries would mask
      // upstream UI bugs.
      const seen = new Set();
      const normalised = [];
      for (const raw of ids) {
        const n =
          typeof raw === "number" ? raw : parseInt(raw, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          return res.status(400).json({
            error: "every id must be a finite integer",
            code: "INVALID_IDS",
          });
        }
        if (!seen.has(n)) {
          seen.add(n);
          normalised.push(n);
        }
      }

      // Pre-fetch sub-brand access once for the whole batch — avoids
      // N look-ups against the same User row.
      const allowed = await getSubBrandAccessSet(req.user.userId);

      const archived = [];
      const alreadyArchived = [];
      const notFound = [];
      const denied = [];

      // Per-id loop. Each id gets a tenant-scoped findFirst (mirrors
      // single-id archive), then bucketed into the response envelope.
      // The route deliberately does NOT short-circuit on first failure —
      // bulk callers want every row's outcome surfaced.
      for (const id of normalised) {
        const row = await prisma.travelFlyerTemplate.findFirst({
          where: { id, tenantId: req.travelTenant.id },
        });
        if (!row) {
          notFound.push(id);
          continue;
        }
        if (row.subBrand && !canAccessSubBrand(allowed, row.subBrand)) {
          denied.push(id);
          continue;
        }
        if (row.isActive === false) {
          alreadyArchived.push(id);
          continue;
        }
        await prisma.travelFlyerTemplate.update({
          where: { id },
          data: { isActive: false },
        });
        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
          id,
          req.user.userId,
          req.travelTenant.id,
          {
            name: row.name,
            subBrand: row.subBrand,
            bulk: true,
          },
        );
        archived.push(id);
      }

      res.status(200).json({
        archived,
        alreadyArchived,
        notFound,
        denied,
        total: normalised.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] bulk-archive error:", e.message);
      res.status(500).json({ error: "Failed to bulk-archive flyer templates" });
    }
  },
);

// POST /api/travel/flyer-templates/bulk-unarchive — ADMIN/MANAGER batch restore
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 16).
//
// Mirror of /bulk-archive (slice 15) — accepts `{ ids: [int, ...] }` and
// restores every matching archived template the caller can access. Per-id
// outcomes are bucketed into the response envelope so operators driving
// the library page's "filter=archived → select N → restore" affordance
// can render per-row feedback without N round-trips.
//
// Symmetry rationale (mirrors slice 15's "why a dedicated endpoint"):
//   (1) One round-trip vs N — operators reviewing the archived bucket
//       typically pick 3-20 to restore at once (post-spring-clean, season
//       reset, accidental over-archive recovery).
//   (2) Atomic audit-batch — every successful restore shares the same
//       requesting user + wall-clock, so reports can correlate a bulk
//       restore as a single operator intent.
//   (3) Partial-success contract: a denied / not-found id inside the
//       batch does NOT roll back the rest. Operators get { unarchived,
//       alreadyActive, notFound, denied } buckets in the response —
//       same shape family as bulk-archive (s/archived/unarchived,
//       s/alreadyArchived/alreadyActive) so the frontend can render
//       both endpoints' results through the same chrome.
//
// Express route ordering: this route MUST be declared BEFORE the
// `/flyer-templates/:id` family because `bulk-unarchive` would otherwise
// be captured as `:id="bulk-unarchive"` and 400-INVALID_ID before reaching
// the bulk handler. Pinned by the slice-16 ordering test.
//
// Body limits: `ids` must be a non-empty array of finite integers; max
// 100 ids per request — same cap as bulk-archive (mirrors the bulk-tag
// / bulk-delete convention across the route file family).
//
// Per-id outcomes (returned in the response envelope):
//   - unarchived[]    — ids successfully flipped to isActive=true
//                       (one audit row each, action
//                       TRAVEL_FLYER_TEMPLATE_UNARCHIVED with bulk:true)
//   - alreadyActive[] — ids whose row was already isActive=true
//                       (no prisma.update, no audit — idempotent)
//   - notFound[]      — ids that don't exist or live on another tenant
//   - denied[]        — ids whose row's sub-brand is outside the caller's
//                       subBrandAccess
//
// Status: 200 even on partial success (the buckets carry the per-id
// outcome). 400 INVALID_IDS / EMPTY_IDS / TOO_MANY_IDS for malformed
// requests. 403 RBAC_DENIED via verifyRole if role !∈ {ADMIN, MANAGER}.
router.post(
  "/flyer-templates/bulk-unarchive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { ids } = req.body || {};

      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "ids must be an array of template ids",
          code: "INVALID_IDS",
        });
      }
      if (ids.length === 0) {
        return res.status(400).json({
          error: "ids must contain at least one template id",
          code: "EMPTY_IDS",
        });
      }
      if (ids.length > 100) {
        return res.status(400).json({
          error: "ids must contain at most 100 template ids per request",
          code: "TOO_MANY_IDS",
        });
      }

      // Normalise + de-dupe. Reject the whole batch if ANY id is not a
      // finite integer — silent-skip of non-numeric entries would mask
      // upstream UI bugs (same gate as bulk-archive).
      const seen = new Set();
      const normalised = [];
      for (const raw of ids) {
        const n =
          typeof raw === "number" ? raw : parseInt(raw, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          return res.status(400).json({
            error: "every id must be a finite integer",
            code: "INVALID_IDS",
          });
        }
        if (!seen.has(n)) {
          seen.add(n);
          normalised.push(n);
        }
      }

      // Pre-fetch sub-brand access once for the whole batch.
      const allowed = await getSubBrandAccessSet(req.user.userId);

      const unarchived = [];
      const alreadyActive = [];
      const notFound = [];
      const denied = [];

      for (const id of normalised) {
        const row = await prisma.travelFlyerTemplate.findFirst({
          where: { id, tenantId: req.travelTenant.id },
        });
        if (!row) {
          notFound.push(id);
          continue;
        }
        if (row.subBrand && !canAccessSubBrand(allowed, row.subBrand)) {
          denied.push(id);
          continue;
        }
        if (row.isActive === true) {
          alreadyActive.push(id);
          continue;
        }
        await prisma.travelFlyerTemplate.update({
          where: { id },
          data: { isActive: true },
        });
        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
          id,
          req.user.userId,
          req.travelTenant.id,
          {
            name: row.name,
            subBrand: row.subBrand,
            bulk: true,
          },
        );
        unarchived.push(id);
      }

      res.status(200).json({
        unarchived,
        alreadyActive,
        notFound,
        denied,
        total: normalised.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] bulk-unarchive error:", e.message);
      res.status(500).json({ error: "Failed to bulk-unarchive flyer templates" });
    }
  },
);

// GET /api/travel/flyer-templates/by-month — tenant-wide monthly rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 21).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket
// for the tenant-scoped (and sub-brand-narrowed) flyer-template
// population. Each row carries count + activeCount + archivedCount so
// the operator dashboard can render a "templates created over time"
// trend chart without N round-trips per month.
//
// Mirrors #900 slice 16 (/quotes/by-month) + #901 slice 29
// (/invoices/by-month) — same UTC YYYY-MM bucketing template, same
// defensive math (null/invalid createdAt → "unknown" bucket; excluded
// when ?from / ?to is set, kept otherwise so count surface stays
// accurate), same orderBy semantics. The activeCount/archivedCount
// split is the flyer-templates analogue of the by-month quote-status
// breakdown — templates flip between active and archived via slice 14
// archive/unarchive and slice 15/16 bulk handlers, and the rollup makes
// the "lifetime population vs. currently-active" delta visible at a
// glance.
//
// PRD anchors:
//   - §3 — tenant-wide flyer-template analytics (trend chart for the
//          marketing-ops dashboard; per-month drill-down picker)
//   - §3.6.4 — performance hint engine consumes per-month template
//              counts to surface "cadence dropped this month" hints
//   - §3.7.4 — template marketplace UI consumes the by-month rollup
//              for its time-series header strip
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' templates in the rollup, plus
//     tenant-wide (subBrand=NULL) rows. Same gate as the list endpoint
//     above. Empty access set → all-zeros rollup (not 403) so the
//     dashboard tile renders cleanly for not-yet-onboarded operators.
//   - JS-side aggregation over a light findMany projection
//     ({ isActive, createdAt }) — the population is bounded by tenant
//     scale (low thousands), and the mock-friendly JS aggregation
//     matches the rationale on /quotes/by-month + /invoices/by-month +
//     /global-stats. No groupBy for marginal efficiency.
//   - "unknown" bucket: rows with null/invalid createdAt land here so
//     the count surface stays accurate. Excluded when ?from / ?to is
//     set (no comparable month token); included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter —
//     same posture as /quotes/by-month slice 16.
//
// No audit row written — read-only meta surface; matches /global-stats
// and /quotes/by-month posture. USER-readable: anodyne (counts +
// month-string tokens).
//
// Express route ordering: literal-path /by-month MUST be declared
// BEFORE the /:id family or `:id="by-month"` would 400 INVALID_ID
// before reaching this handler. Same convention as /sub-brands +
// /global-stats + /bulk-archive + /bulk-unarchive.
router.get(
  "/flyer-templates/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors slice 16 /quotes/by-month.
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
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors /global-stats
      // slice 19: subBrand-restricted callers see allowed sub-brands +
      // tenant-wide (NULL) rows; admins without subBrandAccess see all.
      // Empty allowed set returns the zero-rollup envelope (not 403).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json({
          months: [],
          totalMonths: 0,
          grandCount: 0,
          grandActiveCount: 0,
          limit: take,
          offset: skip,
        });
      }
      const where = { tenantId: req.travelTenant.id };
      if (allowed instanceof Set) {
        where.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      // Light projection — isActive + createdAt is enough for the
      // bucket totals. No JSON columns pulled.
      const rows = await prisma.travelFlyerTemplate.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { count, activeCount,
      // archivedCount }. Null/invalid createdAt rows land in "unknown".
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
            activeCount: 0,
            archivedCount: 0,
          };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. Mirrors slice 16 /quotes/by-month.
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

      const totalMonths = months.length;
      const grandCount = months.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
      const grandActiveCount = months.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as slice 16.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// GET /api/travel/flyer-templates/by-quarter — tenant-wide quarterly rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 22).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-Qn calendar
// quarter for the tenant-scoped (and sub-brand-narrowed) flyer-template
// population. Each row carries count + activeCount + archivedCount so
// the operator dashboard can render a "templates created per quarter"
// trend at coarser granularity than slice 21's by-month — useful for
// year-over-year boardroom views and seasonality analysis.
//
// Mirrors slice 21 (/flyer-templates/by-month) at quarter resolution.
// Calendar quarter computed as Math.floor(UTCMonth/3)+1 → Jan-Mar=Q1,
// Apr-Jun=Q2, Jul-Sep=Q3, Oct-Dec=Q4. Token format YYYY-Qn (e.g.
// "2026-Q2") for both the rollup row and the from/to bounds. Same
// defensive "unknown" bucket for null/invalid createdAt rows. Same
// activeCount/archivedCount split. Same JS-side aggregation rationale
// (mock-friendly + bounded tenant population).
//
// PRD anchors:
//   - §3 — tenant-wide flyer-template analytics (quarterly trend tile
//          for the marketing-ops dashboard)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-Qn bounds; invalid →
//                     400 INVALID_QUARTER_FORMAT
//   - ?orderBy      — default quarter:asc; accepts quarter:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 40 (smaller cap
//                        than by-month — quarterly granularity covers
//                        10 years in 40 rows)
//
// Behaviour:
//   - Sub-brand-scoped: identical gate to slice 21 — MANAGER restricted
//     to one sub-brand sees their allowed sub-brands' templates plus
//     tenant-wide (subBrand=NULL) rows. Empty access set → all-zeros
//     rollup envelope (not 403).
//   - JS-side aggregation over { isActive, createdAt } projection.
//   - "unknown" bucket: rows with null/invalid createdAt land here.
//     Excluded when ?from / ?to is set (no comparable quarter token);
//     included otherwise so the count surface stays accurate.
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches slice 21.
//
// Express route ordering: literal-path /by-quarter MUST be declared
// BEFORE the /:id family or `:id="by-quarter"` would 400 INVALID_ID
// before reaching this handler. Same convention as /by-month +
// /sub-brands + /global-stats + /bulk-archive + /bulk-unarchive.
router.get(
  "/flyer-templates/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

      // YYYY-Qn validation — Q1..Q4 only.
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
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

      // Tenant-scoped where + sub-brand narrowing — identical to slice 21.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json({
          quarters: [],
          totalQuarters: 0,
          grandCount: 0,
          grandActiveCount: 0,
          limit: take,
          offset: skip,
        });
      }
      const where = { tenantId: req.travelTenant.id };
      if (allowed instanceof Set) {
        where.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      const rows = await prisma.travelFlyerTemplate.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-quarter. Calendar quarter = Math.floor(M/3)+1.
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
            activeCount: 0,
            archivedCount: 0,
          };
          byQuarter.set(quarterKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. YYYY-Qn lexicographic sort is
      // also chronological because the year prefix dominates and Q1..Q4
      // sort correctly within a year. "unknown" excluded when bounded.
      if (fromRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
      }
      if (toRaw !== null) {
        quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
      }

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
      const grandCount = quarters.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
      const grandActiveCount = quarters.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      const paged = quarters.slice(skip, skip + take);

      res.json({
        quarters: paged,
        totalQuarters,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly rollup" });
    }
  },
);

// GET /api/travel/flyer-templates/by-year — tenant-wide annual rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 23).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY calendar
// year for the tenant-scoped (and sub-brand-narrowed) flyer-template
// population. Each row carries count + activeCount + archivedCount so
// the operator dashboard can render a "templates created per year"
// trend at the coarsest granularity — boardroom YoY views and long-
// horizon seasonality analysis without the noise of monthly buckets.
//
// Completes the by-month / by-quarter / by-year triplet (slices
// 21 + 22 + 23). Mirrors slice 22 at year resolution. Calendar year
// computed via getUTCFullYear(); token format YYYY (e.g. "2026") for
// both the rollup row and the from/to bounds. Same defensive "unknown"
// bucket for null/invalid createdAt rows. Same activeCount /
// archivedCount split. Same JS-side aggregation rationale (mock-
// friendly + bounded tenant population).
//
// PRD anchors:
//   - §3 — tenant-wide flyer-template analytics (annual trend tile
//          for the marketing-ops dashboard)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY bounds; invalid →
//                     400 INVALID_YEAR_FORMAT
//   - ?orderBy      — default year:asc; accepts year:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 10 / 0; limit caps at 30 (smaller cap
//                        than by-quarter — annual granularity covers
//                        three decades in 30 rows)
//
// Behaviour:
//   - Sub-brand-scoped: identical gate to slice 21/22 — MANAGER
//     restricted to one sub-brand sees their allowed sub-brands'
//     templates plus tenant-wide (subBrand=NULL) rows. Empty access
//     set → all-zeros rollup envelope (not 403).
//   - JS-side aggregation over { isActive, createdAt } projection.
//   - "unknown" bucket: rows with null/invalid createdAt land here.
//     Excluded when ?from / ?to is set (no comparable year token);
//     included otherwise so the count surface stays accurate.
//   - Pagination applied AFTER aggregation + sort + bucket filter.
//
// No audit row written — read-only meta surface; matches slice 21/22.
//
// Express route ordering: literal-path /by-year MUST be declared
// BEFORE the /:id family or `:id="by-year"` would 400 INVALID_ID
// before reaching this handler. Same convention as /by-month +
// /by-quarter + /sub-brands + /global-stats + /bulk-archive +
// /bulk-unarchive.
router.get(
  "/flyer-templates/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation — 4-digit calendar year only.
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
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Tenant-scoped where + sub-brand narrowing — identical to slice 21/22.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json({
          years: [],
          totalYears: 0,
          grandCount: 0,
          grandActiveCount: 0,
          limit: take,
          offset: skip,
        });
      }
      const where = { tenantId: req.travelTenant.id };
      if (allowed instanceof Set) {
        where.OR = [
          { subBrand: { in: [...allowed] } },
          { subBrand: null },
        ];
      }

      const rows = await prisma.travelFlyerTemplate.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-year via getUTCFullYear().
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
          bucket = {
            year: yearKey,
            count: 0,
            activeCount: 0,
            archivedCount: 0,
          };
          byYear.set(yearKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let years = [...byYear.values()];

      // Apply ?from / ?to bucket filter. YYYY lexicographic sort is
      // also chronological (zero-padded 4-digit years). "unknown"
      // excluded when bounded.
      if (fromRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
      }
      if (toRaw !== null) {
        years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
      }

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
      const grandCount = years.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
      const grandActiveCount = years.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      const paged = years.slice(skip, skip + take);

      res.json({
        years: paged,
        totalYears,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute annual rollup" });
    }
  },
);

// GET /api/travel/flyer-templates/:id
router.get(
  "/flyer-templates/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      // Sub-brand access — NULL subBrand is tenant-wide and visible to all.
      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }
      res.json(withTemplateHash(template));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] get error:", e.message);
      res.status(500).json({ error: "Failed to get flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates — ADMIN/MANAGER only.
// Required: name, paletteJson, layoutJson.
// Optional: assetsJson, subBrand, isActive (default true), notes.
router.post(
  "/flyer-templates",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, paletteJson, layoutJson, assetsJson,
        subBrand, isActive, notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }

      // Parse + stringify each JSON column. Throws tagged errors that the
      // outer catch surfaces as 400 INVALID_*_JSON / MISSING_FIELDS.
      const palette = parseJsonColumn(paletteJson, "paletteJson", "INVALID_PALETTE_JSON");
      const layout = parseJsonColumn(layoutJson, "layoutJson", "INVALID_LAYOUT_JSON");
      let assets = null;
      if (assetsJson !== undefined && assetsJson !== null && assetsJson !== "") {
        assets = parseJsonColumn(assetsJson, "assetsJson", "INVALID_ASSETS_JSON");
      }

      // Deep-shape validation against the renderer contract.
      assertValidTemplateShape({
        palette: palette.parsed,
        layout: layout.parsed,
        assets: assets ? assets.parsed : undefined,
      });

      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        // Sub-brand isolation — same gate as commission-profiles. NULL
        // (tenant-wide) creates are allowed for any authorised caller.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const created = await prisma.travelFlyerTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          paletteJson: palette.stringified,
          layoutJson: layout.stringified,
          assetsJson: assets ? assets.stringified : null,
          subBrand: subBrand ? String(subBrand) : null,
          isActive: isActive === false ? false : true,
          notes: notes ? String(notes) : null,
        },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(withTemplateHash(created));
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.errors) body.errors = e.errors;
        return res.status(e.status).json(body);
      }
      console.error("[travel-flyer-templates] create error:", e.message);
      res.status(500).json({ error: "Failed to create flyer template" });
    }
  },
);

// PUT /api/travel/flyer-templates/:id — ADMIN/MANAGER only.
// Partial update. Re-runs flyerTemplateValidator iff palette/layout/assets
// is part of the diff (see file header for the rationale — renaming a
// template should NOT fail because the saved shape no longer validates).
// Sub-brand reassignment requires access to both the existing AND target.
router.put(
  "/flyer-templates/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const data = {};
      const {
        name, paletteJson, layoutJson, assetsJson,
        subBrand, isActive, notes,
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

      // Re-validate iff any of palette/layout/assets is in the diff.
      // Use the existing-stored shape for unsupplied pieces so the
      // validator sees a complete { palette, layout, assets } envelope.
      const reValidate =
        paletteJson !== undefined ||
        layoutJson !== undefined ||
        assetsJson !== undefined;

      let paletteForValidation;
      let layoutForValidation;
      let assetsForValidation;

      if (paletteJson !== undefined) {
        const parsed = parseJsonColumn(paletteJson, "paletteJson", "INVALID_PALETTE_JSON");
        data.paletteJson = parsed.stringified;
        paletteForValidation = parsed.parsed;
      }
      if (layoutJson !== undefined) {
        const parsed = parseJsonColumn(layoutJson, "layoutJson", "INVALID_LAYOUT_JSON");
        data.layoutJson = parsed.stringified;
        layoutForValidation = parsed.parsed;
      }
      if (assetsJson !== undefined) {
        if (assetsJson === null || assetsJson === "") {
          data.assetsJson = null;
          assetsForValidation = undefined;
        } else {
          const parsed = parseJsonColumn(assetsJson, "assetsJson", "INVALID_ASSETS_JSON");
          data.assetsJson = parsed.stringified;
          assetsForValidation = parsed.parsed;
        }
      }

      if (reValidate) {
        // Fall back to the row's existing stored shape for any piece the
        // PUT didn't touch — the validator needs a complete envelope.
        if (paletteForValidation === undefined) {
          try {
            paletteForValidation = JSON.parse(existing.paletteJson);
          } catch (_e) {
            paletteForValidation = null;
          }
        }
        if (layoutForValidation === undefined) {
          try {
            layoutForValidation = JSON.parse(existing.layoutJson);
          } catch (_e) {
            layoutForValidation = null;
          }
        }
        if (assetsForValidation === undefined && assetsJson === undefined && existing.assetsJson) {
          try {
            assetsForValidation = JSON.parse(existing.assetsJson);
          } catch (_e) {
            assetsForValidation = undefined;
          }
        }
        assertValidTemplateShape({
          palette: paletteForValidation,
          layout: layoutForValidation,
          assets: assetsForValidation,
        });
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
      if (isActive !== undefined) data.isActive = Boolean(isActive);
      if (notes !== undefined) data.notes = notes ? String(notes) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.errors) body.errors = e.errors;
        return res.status(e.status).json(body);
      }
      console.error("[travel-flyer-templates] update error:", e.message);
      res.status(500).json({ error: "Failed to update flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/duplicate — ADMIN/MANAGER only.
//
// Clones an existing TravelFlyerTemplate row into a fresh row under the
// same tenant. Optional body fields { name, subBrand } let the operator
// override the copy's name + sub-brand assignment (e.g. cloning a TMC
// flyer across to RFU, or naming the variant "Diwali palette swap").
//
// Source row is looked up tenant-scoped + sub-brand-scoped (the same
// guard as GET/PUT/DELETE), so cross-tenant lookups yield 404 and
// cross-sub-brand reads yield 403. The duplicate inherits paletteJson /
// layoutJson / assetsJson / notes verbatim from the source — operators
// use duplicate as a starting point for variations (seasonal palette
// swap, A/B test variant), so the full shape comes with it. isActive
// is reset to true regardless of source state so the new copy enters
// the active list cleanly; source.isActive=false still duplicates fine
// (no INVALID_STATE gate — archiving a template should not block
// authoring a variant of it).
//
// Name suffix convention: when no `name` override is supplied, the
// copy is named `"<source.name> (copy)"`. Operators routinely duplicate
// then immediately rename in the editor, so the suffix is a hint not a
// commitment; pin the verbatim string here so consumers (tests, UI
// chrome) can rely on it.
router.post(
  "/flyer-templates/:id/duplicate",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
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

      const created = await prisma.travelFlyerTemplate.create({
        data: {
          tenantId: req.travelTenant.id,
          name: targetName,
          paletteJson: source.paletteJson,
          layoutJson: source.layoutJson,
          assetsJson: source.assetsJson,
          subBrand: targetSubBrand,
          isActive: true,
          notes: source.notes,
        },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_DUPLICATED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          newId: created.id,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(withTemplateHash(created));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/archive — ADMIN/MANAGER soft-archive
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 14).
//
// Dedicated lifecycle endpoint that flips `isActive` to false. Functionally
// equivalent to `PUT /:id { isActive: false }` but split off as a distinct
// route so:
//   (1) The audit row carries a SPECIFIC `TRAVEL_FLYER_TEMPLATE_ARCHIVED`
//       action rather than a generic UPDATE with `{ fields: ['isActive'] }`
//       — reports that segment "archive events" from "edit events" can read
//       the action verbatim without parsing the diff blob.
//   (2) The frontend's "Archive" button has a clean POST target rather than
//       building a PUT body. Less mistake surface; less JSON to send.
//   (3) Idempotent: archiving an already-archived row returns 200 + a
//       no-op envelope rather than mutating + writing a redundant audit
//       row (mirrors how the wellness portal's archive endpoints behave).
//
// Sub-brand isolation: same gate as the rest of the route — sub-branded
// templates require canAccessSubBrand; tenant-wide (NULL) templates are
// accessible to any tenant operator with ADMIN/MANAGER role.
//
// Hard-delete is intentionally NOT replaced by archive — operators who
// truly want a row gone still hit DELETE (ADMIN-only). Archive is the
// "remove from library, keep around for un-archive" surface.
router.post(
  "/flyer-templates/:id/archive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Idempotency: already archived → 200 no-op envelope. No audit row
      // for no-op (otherwise the audit log accumulates noise from UI
      // double-clicks or refresh-loops).
      if (existing.isActive === false) {
        return res.status(200).json({
          ...withTemplateHash(existing),
          alreadyArchived: true,
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data: { isActive: false },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: updated.name,
          subBrand: updated.subBrand,
        },
      );

      res.status(200).json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] archive error:", e.message);
      res.status(500).json({ error: "Failed to archive flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/unarchive — ADMIN/MANAGER restore
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 14).
//
// Inverse of /archive. Flips `isActive` back to true. Same idempotency
// + audit-row + sub-brand-isolation contract as the archive endpoint.
// Distinct audit action `TRAVEL_FLYER_TEMPLATE_UNARCHIVED` so reports
// can distinguish "operator restored an archived template" from "operator
// edited the row's isActive flag inline via PUT".
router.post(
  "/flyer-templates/:id/unarchive",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (existing.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, existing.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Idempotency: already active → 200 no-op envelope. No audit row.
      if (existing.isActive === true) {
        return res.status(200).json({
          ...withTemplateHash(existing),
          alreadyActive: true,
        });
      }

      const updated = await prisma.travelFlyerTemplate.update({
        where: { id },
        data: { isActive: true },
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: updated.name,
          subBrand: updated.subBrand,
        },
      );

      res.status(200).json(withTemplateHash(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] unarchive error:", e.message);
      res.status(500).json({ error: "Failed to unarchive flyer template" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/export — ADMIN/MANAGER only.
//
// PRD_TRAVEL_MARKETING_FLYER §3 (AC-6.3 / AC-6.4 export contract).
//
// Slice 10 validation + cache-key plumbing (commit f7d8311d):
//   - Validates the export envelope via lib/flyerExport.validateExportRequest
//     (`{ format: 'pdf'|'png', aspect }`).
//   - Computes the deterministic content-addressed cache key via
//     lib/flyerExport.buildOutputCacheKey({ format, aspect, hash }) where
//     `hash` is hashTemplateShape over the source row's parsed JSON columns.
//
// Slice 11 PDF rendering (this commit):
//   - For format='pdf' AND ?inline=1, calls lib/flyerPdfRender.renderFlyerPdf
//     to materialise the template into a real pdfkit Buffer and streams it
//     back with `Content-Type: application/pdf` + 200 OK. No file
//     persistence — the inline-buffer path is the smaller slice that
//     unblocks operators previewing PDFs while file-persistence + the
//     cache plumbing land in a later slice.
//   - For format='pdf' WITHOUT ?inline=1, stays on the slice-10 contract
//     (202 queued + cacheKey) so the existing async polling surface keeps
//     working untouched. Future slice swaps this for a real cache-lookup
//     + a `url` field on cache hit.
//   - For format='png', stays fully STUBBED (202 queued) — Puppeteer
//     infrastructure is a separate blocker.
//
// Sub-brand isolation: the source row's sub-brand gate is enforced
// before any computation runs (cross-sub-brand operators cannot enqueue
// renders against templates they cannot read).
router.post(
  "/flyer-templates/:id/export",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Validate the export envelope BEFORE the DB lookup so callers
      // get the same 400 INVALID_EXPORT_REQUEST regardless of whether
      // the template id is real — the validator's error array is the
      // load-bearing surface the future renderer slice depends on.
      const { format, aspect } = req.body || {};
      const validation = validateExportRequest({ format, aspect });
      if (!validation.ok) {
        return res.status(400).json({
          error: "Invalid export request",
          code: "INVALID_EXPORT_REQUEST",
          errors: validation.errors,
        });
      }

      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Compute the deterministic template-shape hash from the row's
      // stored JSON columns. Same canonicalization the GET responses
      // surface via the `templateHash` virtual field (slice 9) — pin
      // identity here so the cache key is end-to-end stable.
      let palette = null;
      let layout = null;
      let assets = null;
      if (source.paletteJson) {
        try { palette = JSON.parse(source.paletteJson); } catch (_e) { palette = null; }
      }
      if (source.layoutJson) {
        try { layout = JSON.parse(source.layoutJson); } catch (_e) { layout = null; }
      }
      if (source.assetsJson) {
        try { assets = JSON.parse(source.assetsJson); } catch (_e) { assets = null; }
      }
      const hash = hashTemplateShape({ palette, layout, assets });
      const cacheKey = buildOutputCacheKey({ format, aspect, hash });

      // Slice 11 inline-PDF path: when caller passes `?inline=1` AND
      // format='pdf', synchronously render the PDF via lib/flyerPdfRender
      // and stream the Buffer back as `application/pdf` with status 200.
      // PNG stays STUBBED (Puppeteer infra pending).
      const wantsInline =
        req.query &&
        (req.query.inline === "1" ||
          req.query.inline === 1 ||
          req.query.inline === "true");

      if (wantsInline && format === "pdf") {
        const buffer = await renderFlyerPdf(
          { palette, layout, assets },
          { aspect, hash },
        );

        await writeAudit(
          "TravelFlyerTemplate",
          "TRAVEL_FLYER_TEMPLATE_EXPORTED",
          source.id,
          req.user.userId,
          req.travelTenant.id,
          { format, aspect, cacheKey, inline: true, bytes: buffer.length },
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="flyer-${source.id}-${aspect}.pdf"`,
        );
        res.setHeader("X-Flyer-Cache-Key", cacheKey);
        res.setHeader("X-Flyer-Template-Hash", hash);
        return res.status(200).send(buffer);
      }

      // STUB (PNG always, PDF without ?inline=1): rendering pipeline
      // pending headless-render infrastructure. Returns the slice-10
      // 202-queued envelope so existing async pollers stay unchanged.
      // STUB: Puppeteer rendering pending
      const queuedAt = new Date().toISOString();

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED",
        source.id,
        req.user.userId,
        req.travelTenant.id,
        { format, aspect, cacheKey },
      );

      res.status(202).json({
        format,
        aspect,
        hash,
        cacheKey,
        status: "queued",
        queuedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] export error:", e.message);
      res.status(500).json({ error: "Failed to queue flyer export" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/preview.pdf — inline PDF preview
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 12).
//
// Read-only preview surface: any authenticated tenant user (USER /
// MANAGER / ADMIN) can fetch a rendered PDF preview of a flyer template
// they have sub-brand access to. Pairs with the FlyerTemplates list
// page's "Use as starting point" affordance — a marketer needs to see
// what a saved template actually looks like before picking it as a base
// for a new flyer.
//
// Distinction from POST /:id/export?inline=1 (slice 11):
//   - GET vs POST     — this is a true read; cacheable + bookmarkable +
//                       browser-previewable via a plain anchor tag.
//   - Roles           — opens up to USER as well as ADMIN/MANAGER. The
//                       export POST stays gated to ADMIN/MANAGER because
//                       export is operator-driven distribution; preview
//                       is a list-browsing aid.
//   - No audit row    — read-only preview, every list-page render would
//                       otherwise pollute the audit log.
//   - Query-driven    — aspect lives in ?aspect= rather than a JSON body
//                       (browsers can't POST a body from an <a href>).
//
// Sub-brand isolation: same gate as the rest of the route file — NULL
// subBrand rows are tenant-wide and visible to everyone; sub-branded
// rows enforce canAccessSubBrand. Cross-tenant lookups 404 cleanly.
//
// Aspect taxonomy reuses lib/flyerExport's PDF_PAPER_SIZES (a4 /
// us_letter); invalid aspect → 400 INVALID_ASPECT.
router.get(
  "/flyer-templates/:id/preview.pdf",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Aspect defaults to 'a4'. Reuses the canonical PDF_PAPER_SIZES
      // list rather than hardcoding so a future taxonomy widening
      // (e.g. 'tabloid', 'legal') automatically flows here.
      const aspect = (req.query && req.query.aspect) || "a4";
      const { PDF_PAPER_SIZES } = require("../lib/flyerExport");
      if (!PDF_PAPER_SIZES.includes(String(aspect))) {
        return res.status(400).json({
          error: `aspect must be one of: ${PDF_PAPER_SIZES.join(", ")}`,
          code: "INVALID_ASPECT",
        });
      }

      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Parse the row's JSON columns into the live shape the renderer
      // consumes. Same defensive try/catch dance as POST /:id/export —
      // a corrupted-stored-row should still render a degraded placeholder
      // PDF rather than 500.
      let palette = null;
      let layout = null;
      let assets = null;
      if (source.paletteJson) {
        try { palette = JSON.parse(source.paletteJson); } catch (_e) { palette = null; }
      }
      if (source.layoutJson) {
        try { layout = JSON.parse(source.layoutJson); } catch (_e) { layout = null; }
      }
      if (source.assetsJson) {
        try { assets = JSON.parse(source.assetsJson); } catch (_e) { assets = null; }
      }

      const hash = hashTemplateShape({ palette, layout, assets });
      const buffer = await renderFlyerPdf(
        { palette, layout, assets },
        { aspect: String(aspect), hash },
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="flyer-${source.id}-preview-${aspect}.pdf"`,
      );
      res.setHeader("X-Flyer-Template-Hash", hash);
      // Short-cache so a list-page hover-preview doesn't re-render on
      // every mouse-over but template edits still propagate quickly.
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.status(200).send(buffer);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] preview error:", e.message);
      res.status(500).json({ error: "Failed to render flyer preview" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/usage-stats — per-template usage rollup
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 17).
//
// Read-only AuditLog aggregation surface. Powers the FlyerTemplates library
// page's per-row meta strip ("Exports: 12 · Last exported 3h ago · Edited
// 2x · Archived 0x"). Without this endpoint the frontend has to either
// page the generic /api/audit feed and filter client-side (heavy + leaks
// other entities), or fire N separate audit reads per row (N round-trips
// just to render the library list).
//
// PRD anchors:
//   - §3.7.2 — per-template metadata (usage count) feeds the marketplace
//              list + future conversion-rate column
//   - §3.6.4 — performance hint engine consumes per-template impression /
//              export counts to surface optimisation suggestions
//   - FR-3.4.5 — output URLs cached per format/aspect; the export-count
//              rollup is the upstream signal for cache-hit analytics
//
// Behaviour:
//   - Tenant + sub-brand scoped — the template id is resolved first via
//     the same findFirst gate as GET /:id, returning 404 for cross-tenant
//     and 403 for cross-sub-brand BEFORE any AuditLog read fires. Stops a
//     fishing-rod attack that would otherwise leak the existence of a
//     template id via the audit-count surface.
//   - Counts every AuditLog row for this { tenantId, entity: 'TravelFlyerTemplate',
//     entityId } tuple, grouped by action. Returns:
//       { templateId, total, byAction, firstActionAt, lastActionAt,
//         exports, lastExportedAt }
//     Where `byAction` is a stable shape with one bucket per action verb
//     used by this route file (CREATE / UPDATE / DELETE /
//     TRAVEL_FLYER_TEMPLATE_DUPLICATED / TRAVEL_FLYER_TEMPLATE_ARCHIVED /
//     TRAVEL_FLYER_TEMPLATE_UNARCHIVED / TRAVEL_FLYER_TEMPLATE_EXPORTED /
//     TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED) zero-initialised so the
//     frontend always sees the full set rather than a shape that grows
//     as new action verbs first appear in a tenant's logs.
//   - `exports` is the convenience sum of EXPORTED + EXPORT_QUEUED — both
//     count as "an operator asked for a render" from the library-page
//     perspective regardless of whether the renderer ran inline (PDF
//     inline path, slice 11) or queued (PNG stub path, slice 10).
//   - `firstActionAt` / `lastActionAt` are the min/max createdAt timestamps
//     across all bucketed actions. `lastExportedAt` narrows to the export
//     buckets only (matches the UI affordance "last exported X ago").
//
// USER-readable: any tenant operator with sub-brand access to the template
// can fetch usage stats. The data is anodyne — counts + timestamps, no
// payload bodies — and the library page is a USER-facing surface, not
// admin-only. Matches the read-only-aid rationale on GET /:id/preview.pdf
// (slice 12).
//
// No audit row: read-only meta surface. Mirrors slice 12 / slice 13.
//
// Implementation note: findMany over groupBy intentionally — the per-row
// bucket-set is bounded (8 known action verbs), the rows themselves are
// per-template (low cardinality even for heavily-used templates), and
// the JS aggregation keeps the test surface mock-friendly without a
// second prisma method to stub. Same trade made on /sub-brands (slice 13).
router.get(
  "/flyer-templates/:id/usage-stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Resolve + gate the template first so cross-tenant / cross-sub-brand
      // callers can't enumerate audit-event existence via this surface.
      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Stable bucket set — one entry per known action verb the route
      // file emits (incl. built-in CREATE/UPDATE/DELETE). Zero-init so
      // the frontend never sees a missing key.
      const KNOWN_ACTIONS = [
        "CREATE",
        "UPDATE",
        "DELETE",
        "TRAVEL_FLYER_TEMPLATE_DUPLICATED",
        "TRAVEL_FLYER_TEMPLATE_ARCHIVED",
        "TRAVEL_FLYER_TEMPLATE_UNARCHIVED",
        "TRAVEL_FLYER_TEMPLATE_EXPORTED",
        "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED",
      ];
      const byAction = {};
      for (const a of KNOWN_ACTIONS) byAction[a] = 0;

      const rows = await prisma.auditLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          entity: "TravelFlyerTemplate",
          entityId: id,
        },
        select: { action: true, createdAt: true },
      });

      let firstActionAt = null;
      let lastActionAt = null;
      let lastExportedAt = null;

      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(byAction, row.action)) {
          byAction[row.action] += 1;
        } else {
          // Unknown action — track in an `other` bucket so a future
          // verb addition surfaces in the count even if it's not yet
          // listed in KNOWN_ACTIONS.
          byAction.other = (byAction.other || 0) + 1;
        }
        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);
        if (!firstActionAt || ts < firstActionAt) firstActionAt = ts;
        if (!lastActionAt || ts > lastActionAt) lastActionAt = ts;
        if (
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORTED" ||
          row.action === "TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED"
        ) {
          if (!lastExportedAt || ts > lastExportedAt) lastExportedAt = ts;
        }
      }

      const exports =
        byAction.TRAVEL_FLYER_TEMPLATE_EXPORTED +
        byAction.TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED;

      res.json({
        templateId: id,
        total: rows.length,
        byAction,
        exports,
        firstActionAt: firstActionAt ? firstActionAt.toISOString() : null,
        lastActionAt: lastActionAt ? lastActionAt.toISOString() : null,
        lastExportedAt: lastExportedAt ? lastExportedAt.toISOString() : null,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] usage-stats error:", e.message);
      res.status(500).json({ error: "Failed to read flyer template usage stats" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/audit-trail — ordered per-template audit history
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 18).
//
// Read-only AuditLog list surface. Complements slice 17 /usage-stats
// (which returns counts + timestamps rollup) by surfacing the actual
// ordered rows — who did what, when — so the FlyerTemplates library
// page can render a per-template "Recent activity" drawer without
// paging the generic /api/audit feed and filtering client-side
// (heavy + leaks other entities + cross-tenant risk).
//
// PRD anchors:
//   - §3.7.2 — per-template metadata feeds the marketplace list +
//              future conversion-rate column (audit-trail is the
//              source-of-truth list backing the rollup in slice 17)
//   - §3.6.4 — performance hint engine consumes per-template events
//              (the trail is the time-series the engine reads from;
//              stats are the summary, trail is the detail)
//   - §3.8 — compliance / record-of-record for marketing assets
//
// Behaviour:
//   - Tenant + sub-brand scoped — the template id is resolved first
//     via the same findFirst gate as GET /:id and /usage-stats,
//     returning 404 for cross-tenant and 403 for cross-sub-brand
//     BEFORE any AuditLog read fires. Stops the fishing-rod attack
//     where the audit-trail surface would otherwise leak the
//     existence of a template id via a 200-with-empty-rows reply.
//   - Returns the ordered rows for this { tenantId, entity:
//     'TravelFlyerTemplate', entityId } tuple. Default order is
//     newest-first (createdAt desc) so the UI's "Recent activity"
//     drawer renders top-to-bottom chronologically.
//   - Pagination: ?limit (default 50, max 200) + ?offset (default 0).
//     The 200 cap mirrors the /api/audit list endpoint convention
//     and keeps a single round-trip bounded — operators paging
//     deeper than 200 rows on a single template are an edge case
//     (heavy templates hit ~50-100 lifetime events).
//   - Optional ?action= narrows to a single verb (CREATE / UPDATE /
//     TRAVEL_FLYER_TEMPLATE_EXPORTED / etc.). Unknown verbs return
//     200 with an empty array — silent narrowing rather than 400
//     because future verb additions shouldn't break the UI.
//
// Per-row shape (returned in the response envelope):
//   { id, action, createdAt (ISO), userId, details }
//   - `details` is the row's stored JSON string parsed back into the
//     live shape so consumers don't re-parse. Parse failure folds to
//     null (the row is still surfaced — the row's existence + verb
//     is the load-bearing signal; the payload is auxiliary).
//   - `userId` is surfaced verbatim (no user join). Frontend resolves
//     the display-name from the existing /api/users feed by id —
//     keeps this endpoint's prisma surface narrow.
//
// USER-readable: matches the read-only-aid rationale on /usage-stats
// (slice 17) and /preview.pdf (slice 12). Library page is a USER
// surface; audit verbs + timestamps + actor ids are anodyne (the
// payload details column does NOT carry PHI for this entity).
//
// No audit row: read-only meta surface. Mirrors slice 12 / 13 / 17.
router.get(
  "/flyer-templates/:id/audit-trail",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Resolve + gate the template first so cross-tenant / cross-sub-brand
      // callers can't enumerate audit-event existence via this surface.
      const template = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!template) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (template.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, template.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Pagination — 200 cap matches the /api/audit list convention.
      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;

      const where = {
        tenantId: req.travelTenant.id,
        entity: "TravelFlyerTemplate",
        entityId: id,
      };

      // Optional action filter — silent narrowing on unknown verbs
      // (200 + empty rows). Routes adding new verbs later shouldn't
      // need to update an allow-list here.
      if (req.query.action !== undefined && req.query.action !== "") {
        where.action = String(req.query.action);
      }

      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
          select: {
            id: true,
            action: true,
            createdAt: true,
            userId: true,
            details: true,
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      const entries = rows.map((row) => {
        let details = null;
        if (row.details != null) {
          if (typeof row.details === "string") {
            try { details = JSON.parse(row.details); }
            catch (_e) { details = null; }
          } else {
            details = row.details;
          }
        }
        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);
        return {
          id: row.id,
          action: row.action,
          createdAt: ts.toISOString(),
          userId: row.userId ?? null,
          details,
        };
      });

      res.json({
        templateId: id,
        entries,
        total,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] audit-trail error:", e.message);
      res.status(500).json({ error: "Failed to read flyer template audit trail" });
    }
  },
);

// DELETE /api/travel/flyer-templates/:id — ADMIN-only hard delete.
// Audit row written BEFORE the prisma.delete fires so the intent is
// captured even if the delete subsequently throws.
router.delete(
  "/flyer-templates/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

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
        "TravelFlyerTemplate",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          name: existing.name,
          subBrand: existing.subBrand,
        },
      );

      await prisma.travelFlyerTemplate.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete flyer template" });
    }
  },
);

// GET /api/travel/flyer-templates/:id/clone-history — per-source clone feed
// (PRD_TRAVEL_MARKETING_FLYER #908 slice 20).
//
// Read-only AuditLog-derived endpoint. Returns the chronological list of
// CLONES spawned FROM this template (children), distinct from slice 18's
// /audit-trail (which is the ordered list of EVENTS that happened TO this
// template). The two surfaces overlap on the template's own
// TRAVEL_FLYER_TEMPLATE_DUPLICATED row when the template ITSELF was the
// child of a clone — audit-trail surfaces "I was created as a clone of X"
// (entityId = me); clone-history surfaces "X spawned from me" (sourceId
// inside details = me).
//
// Why a separate endpoint:
//   - The library page's per-template "Variants" / "Family tree" drawer
//     needs the FORWARD list of children to render the "Clones spawned"
//     count (PRD §3.7.2 marketplace metadata; PRD §3.6.4 performance hint
//     engine consumes child-count as a "popular template" signal). Doing
//     this via /audit-trail + client-side filter is wrong: audit-trail's
//     where clause pins entityId = source.id, but the clone's audit row's
//     entityId is the NEW (child) template id, not the source. The two
//     queries hit different entityIds entirely.
//   - Tenant + sub-brand gate fires BEFORE the AuditLog read so cross-
//     tenant / cross-sub-brand callers can't enumerate clone-counts via
//     a 200-with-empty-rows reply (same fishing-rod stop as slice 18).
//
// Behaviour:
//   - Tenant + sub-brand scoped on the SOURCE template id. 404
//     TEMPLATE_NOT_FOUND when source missing; 403 SUB_BRAND_DENIED when
//     caller can't read the source's sub-brand.
//   - Loads AuditLog where { entity: 'TravelFlyerTemplate', action:
//     'TRAVEL_FLYER_TEMPLATE_DUPLICATED', tenantId: req.travelTenant.id }
//     — these are the rows the slice 6 duplicate handler writes. The
//     entityId on those rows is the NEW template id (the clone), so we
//     filter post-parse on `details.sourceId === <id>` (the field the
//     duplicate handler stores).
//   - Defensive against field-name drift: the post-parse filter accepts
//     `details.sourceId` (today's emit), `details.clonedFromId` (an
//     alternative name some sister modules use), and `details.parentId`
//     (a third common convention). If a future refactor changes the
//     stored field name, the per-source filter keeps working without
//     having to refactor this endpoint in lockstep.
//   - Empty list (0 matching rows) is a NORMAL response: 200 with
//     history: []. NOT a 404. The source template existing without any
//     children is the most common state.
//   - Defensive against malformed details JSON: rows whose details column
//     fails JSON.parse are silently skipped (NOT 500). The row's existence
//     without a parseable parent-id reference can't satisfy the filter
//     either way, so dropping it is the right call.
//   - Limit clamp: default 100, max 500. Optional ?from / ?to ISO date
//     bounds threaded into the AuditLog `createdAt` where clause. Optional
//     ?orderBy=at:asc | at:desc — default `at:asc` (chronological — the
//     library page renders the family tree top-to-bottom from oldest
//     clone to newest).
//
// Per-entry shape:
//   { at: ISO, clonedById: int|null, newTemplateId: int|null, details: object }
//   - `clonedById` comes from `row.userId` (the actor who ran the
//     duplicate) — surface null when missing.
//   - `newTemplateId` comes from `details.newId` (the child template id
//     written by the duplicate handler) — fall back to `row.entityId`
//     when details doesn't carry it (older rows from before the
//     stored-payload extended).
//   - `details` is the parsed details JSON in full (no narrowing) so
//     the UI can render `subBrand`, `name`, or any future field the
//     duplicate handler adds without an endpoint change.
//
// Response envelope:
//   { templateId, totalClones, history: [...] }
//
// USER-readable: mirrors slice 18 / 17 read-only-aid contract. No audit
// row written by this read-only endpoint.
router.get(
  "/flyer-templates/:id/clone-history",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Resolve + gate the source template first.
      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Clamp limit: default 100, max 500.
      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);

      // Order: default chronological asc, accept desc.
      const orderParam = String(req.query.orderBy || "at:asc").toLowerCase();
      const orderDir = orderParam === "at:desc" ? "desc" : "asc";

      // Optional ?from / ?to ISO date bounds.
      const where = {
        tenantId: req.travelTenant.id,
        entity: "TravelFlyerTemplate",
        action: "TRAVEL_FLYER_TEMPLATE_DUPLICATED",
      };
      if (req.query.from || req.query.to) {
        where.createdAt = {};
        if (req.query.from) {
          const fromDate = new Date(String(req.query.from));
          if (!isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
        }
        if (req.query.to) {
          const toDate = new Date(String(req.query.to));
          if (!isNaN(toDate.getTime())) where.createdAt.lte = toDate;
        }
      }

      // Fetch a generous superset — the post-parse per-source filter
      // narrows further. We take up to 4x the limit to absorb the filter
      // shrinkage, capped at 2000 to keep round-trips bounded.
      const fetchTake = Math.min(take * 4, 2000);

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: orderDir },
        take: fetchTake,
        select: {
          id: true,
          createdAt: true,
          userId: true,
          entityId: true,
          details: true,
        },
      });

      const history = [];
      for (const row of rows) {
        let parsed = null;
        if (row.details != null) {
          if (typeof row.details === "string") {
            try { parsed = JSON.parse(row.details); }
            catch (_e) { parsed = null; }
          } else if (typeof row.details === "object") {
            parsed = row.details;
          }
        }
        // Skip rows we can't parse — without details we can't confirm
        // this clone descended from THIS source.
        if (parsed == null) continue;

        // Field-name drift defence: accept any of the three conventions.
        const parentId =
          parsed.sourceId != null ? parsed.sourceId :
          parsed.clonedFromId != null ? parsed.clonedFromId :
          parsed.parentId != null ? parsed.parentId :
          null;

        if (parentId !== id) continue;

        const ts = row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt);

        const newTemplateId =
          parsed.newId != null ? parsed.newId :
          row.entityId != null ? row.entityId :
          null;

        history.push({
          at: ts.toISOString(),
          clonedById: row.userId ?? null,
          newTemplateId,
          details: parsed,
        });

        if (history.length >= take) break;
      }

      res.json({
        templateId: id,
        totalClones: history.length,
        history,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] clone-history error:", e.message);
      res.status(500).json({ error: "Failed to read flyer template clone history" });
    }
  },
);

// POST /api/travel/flyer-templates/:id/render — synchronous multi-format render
// (PRD_TRAVEL_MARKETING_FLYER #908 slice S17 — docs/TRAVEL_BIG_SCOPE_BACKLOG.md).
//
// Synchronous sibling of the slice 10/11 `/:id/export` async-queued surface.
// Where /export returns a 202 envelope (queued render, picked up by a future
// worker pool), this `/render` synchronously materialises one of FIVE format
// outputs and streams the buffer back to the caller in a single response:
//
//   - pdf-a4            : 595×842 pt A4 PDF (Hassan / Priya / Arjun marketers — print)
//   - pdf-a5            : 420×595 pt A5 PDF (compact drop-flyer half-page)
//   - png-square        : 1200×1200 PNG (Instagram square / FB cover)
//   - png-portrait-ig   : 1080×1920 PNG (Instagram story / WhatsApp story)
//   - png-landscape-fb  : 1920×1080 PNG (Facebook landscape banner / YouTube card)
//
// Why synchronous: Hassan's clone-and-tweak flow (PRD §1 Story 1) needs the
// rendered output IN THE MARKETER'S HAND to share via WhatsApp / print. A
// queued envelope means a second poll-loop UI on top of an already-tight
// 4-minute Hassan flow. The renderer's `lib/flyerPdfRender` PDF path
// completes in <100ms for the placeholder layout; Puppeteer PNG path
// completes in <2s per the NFR-4.2 budget. Both fit comfortably under
// Express's 60s timeout.
//
// Auth + sub-brand gate: same envelope as `/:id/export` (slice 10) —
// ADMIN/MANAGER write role + the sub-brand check on the source template
// (mirroring the read-only gates on `/preview.pdf` slice 12 but at the
// render-write tier because /render emits an audit trail). USER cannot
// render directly — they're routed through the marketer's library page.
//
// Audit: every successful render writes a TRAVEL_FLYER_TEMPLATE_RENDERED
// audit row with `{ format, bytes, engine, templateHash, cacheKey }` so
// `/usage-stats` (slice 17) and per-template byte-volume rollups can see
// the new action verb. The action verb is distinct from
// TRAVEL_FLYER_TEMPLATE_EXPORTED (slice 11) — operators need to tell
// "rendered inline via /render" apart from "queued + downloaded via
// /export" in the audit-trail UI.
//
// Stub-render fallback: when Puppeteer isn't installed (today's state —
// see backend/services/flyerRenderEngine.js header rationale), PNG
// formats return a 1×1 placeholder PNG with `X-Flyer-Render-Engine:
// stub-1x1`. The route still emits a real audit row + a real
// Content-Type + Content-Disposition — only the bytes are placeholder.
// Frontend can read the engine header to surface a "PNG renderer not
// yet wired" toast.
//
// Error codes:
//   - INVALID_ID           : non-numeric :id
//   - INVALID_FORMAT       : format not in the 5-element supported set
//   - TEMPLATE_NOT_FOUND   : cross-tenant or genuinely-missing :id
//   - SUB_BRAND_DENIED     : MANAGER lacks sub-brand access to source row
router.post(
  "/flyer-templates/:id/render",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Lazy-load the render engine so the route file's existing
      // require list stays untouched at parse-time + Puppeteer-resolution
      // is deferred to first /render call.
      const {
        renderFlyer,
        SUPPORTED_FORMATS,
      } = require("../services/flyerRenderEngine");

      const { format, data } = req.body || {};

      // Format-validity gate runs BEFORE the DB lookup so callers get
      // the same 400 INVALID_FORMAT regardless of whether the template
      // id is real. Same defensive ordering as /:id/export (slice 10).
      if (typeof format !== "string" || !SUPPORTED_FORMATS.includes(format)) {
        return res.status(400).json({
          error: `format must be one of: ${SUPPORTED_FORMATS.join(", ")}`,
          code: "INVALID_FORMAT",
        });
      }

      const source = await prisma.travelFlyerTemplate.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!source) {
        return res.status(404).json({
          error: "Flyer template not found",
          code: "TEMPLATE_NOT_FOUND",
        });
      }

      if (source.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, source.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      // Parse stored JSON columns into the live shape the renderer
      // consumes. Same defensive try/catch dance as /:id/export /
      // /:id/preview.pdf — corrupted-stored-rows still render the
      // renderer's placeholder rather than 500.
      let palette = null;
      let layout = null;
      let assets = null;
      if (source.paletteJson) {
        try { palette = JSON.parse(source.paletteJson); } catch (_e) { palette = null; }
      }
      if (source.layoutJson) {
        try { layout = JSON.parse(source.layoutJson); } catch (_e) { layout = null; }
      }
      if (source.assetsJson) {
        try { assets = JSON.parse(source.assetsJson); } catch (_e) { assets = null; }
      }

      const templateHash = hashTemplateShape({ palette, layout, assets });
      const cacheFormat = format.startsWith("pdf-") ? "pdf" : "png";
      const cacheAspect = format.startsWith("pdf-")
        ? format.slice("pdf-".length)
        : format.slice("png-".length);
      const cacheKey = buildOutputCacheKey({
        format: cacheFormat,
        aspect: cacheAspect,
        hash: templateHash,
      });

      // Both PDF and PNG renderers now honour the operator's absolute-
      // positioned canvas blocks block-for-block (lib/flyerPdfRender +
      // services/flyerRenderEngine.buildHtmlShellForPng). The PDF
      // renderer fetches image bytes via axios + embeds via doc.image()
      // so DALL-E / uploaded images appear in the PDF exactly as in
      // the PNG screenshot. The adapter (adaptCanvasForRenderer) is no
      // longer needed for either format.
      const result = await renderFlyer({
        template: { palette, layout, assets },
        data,
        format,
      });

      await writeAudit(
        "TravelFlyerTemplate",
        "TRAVEL_FLYER_TEMPLATE_RENDERED",
        source.id,
        req.user.userId,
        req.travelTenant.id,
        {
          format,
          bytes: result.buffer.length,
          engine: result.engine,
          templateHash,
          cacheKey,
        },
      );

      res.setHeader("Content-Type", result.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="flyer-${source.id}-${format}.${result.extension}"`,
      );
      res.setHeader("X-Flyer-Template-Hash", templateHash);
      res.setHeader("X-Flyer-Cache-Key", cacheKey);
      res.setHeader("X-Flyer-Render-Engine", result.engine);
      if (result.widthPx) res.setHeader("X-Flyer-Width-Px", String(result.widthPx));
      if (result.heightPx) res.setHeader("X-Flyer-Height-Px", String(result.heightPx));
      return res.status(200).send(result.buffer);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] render error:", e.message);
      res.status(500).json({ error: "Failed to render flyer" });
    }
  },
);

module.exports = router;
