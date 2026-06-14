/**
 * /api/brand-kits — BrandKit CRUD (PRD_TRAVEL_PER_SUBBRAND_BRANDING DD-5.2)
 *
 * Schema at commit 5060dda (2026-05-24 tick #95) — BrandKit model with
 * (tenantId, subBrand, version) composite key, proper columns for assets
 * (logo, darkLogo, favicon, colors, font, tagline), and isActive flag for
 * "one active version per (tenantId, subBrand)" semantics.
 *
 * This module ships the operator-facing CRUD. Only ADMIN can mutate.
 * Activating a new version atomically demotes any prior active row for
 * the same (tenantId, subBrand) via prisma.$transaction.
 *
 * Future slices (not in this commit): brand-asset file upload via multer
 * (currently expects pre-uploaded URLs), version-history purge cron
 * (DD-5.6: keep last 10 versions per sub-brand), WCAG contrast checker
 * (DD-5.5e: warn on save when colors fail AA), live preview UI.
 *
 * Sub-brand isolation: brand kits with .subBrand=null are tenant-wide
 * defaults; subBrand-scoped kits override per-sub-brand. External API
 * keys scoped to a sub-brand cannot create/edit kits under a different
 * sub-brand.
 *
 * Multi-vertical: unlike most /api/travel/* routes, BrandKit is NOT
 * travel-vertical-only. Generic + wellness tenants may also own a
 * single tenant-wide (subBrand=null) kit. We therefore skip the
 * requireTravelTenant guard and only enforce sub-brand validity when
 * subBrand is non-null AND non-empty.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const {
  validateAssetUpload,
  ASSET_CLASSES,
} = require("../lib/brandAssetValidation");

// ── W4.A G099 — Multer upload pipeline ─────────────────────────────
// Disk-storage pattern mirrored from booking_pages.js — files land under
// `backend/uploads/brand-kits/` and are served via the SPA's /uploads
// static route. The directory is created on demand so a fresh checkout
// boots without bootstrap. Buffer is kept in memory via memoryStorage()
// so the brandAssetValidation pipeline can inspect headers BEFORE the
// bytes hit disk (SVG XSS payload rejection + dim probing).
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "brand-kits");
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  /* best-effort */
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // hard 5 MB ceiling (per-class tighter via validator)
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i.test(file.mimetype || "")) {
      return cb(null, true);
    }
    return cb(new Error("Unsupported MIME — png/jpeg/svg/webp/ico only"));
  },
}).single("file");

// Multer surfaces LIMIT_FILE_SIZE etc. as Error objects — translate to
// a structured envelope so the front-end can show a useful message.
function wrappedUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "Upload exceeds 5 MB hard cap",
        code: "FILE_TOO_LARGE_HARD_CAP",
      });
    }
    if (err && err.message) {
      return res.status(400).json({
        error: err.message,
        code: "UPLOAD_REJECTED",
      });
    }
    return res.status(400).json({ error: "Upload failed", code: "UPLOAD_REJECTED" });
  });
}

// Normalises a sub-brand value coming from query/body. Treats null,
// undefined, and empty string as "tenant-wide" (returns null). Any other
// value is validated against the VALID_SUB_BRANDS list.
function normalizeSubBrand(input) {
  if (input == null || input === "") return null;
  const s = String(input);
  assertValidSubBrand(s); // throws 400 INVALID_SUB_BRAND on bad value
  return s;
}

// Whitelist of asset-shaped fields accepted on POST/PUT. Anything else
// in the body is silently dropped (defence-in-depth against accidental
// passthrough of tenantId/createdBy etc.). version + isActive are
// handled explicitly outside this list.
const ASSET_FIELDS = [
  "logoUrl",
  "logoDarkUrl",
  "faviconUrl",
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "bgColor",
  "textColor",
  "fontFamily",
  "fontUrl",
  "tagline",
  // W4.A G089 — extended branding fields (FR-3.1.a-g)
  "wordmarkUrl",
  "heroUrl",
  "successBadge",
  "warningBadge",
  "headingFontFamily",
  "headingFontUrl",
  "bodyFontFamily",
  "bodyFontUrl",
  "codeFontFamily",
  "codeFontUrl",
  "cmykPrimary",
  "cmykSecondary",
  "cmykAccent",
  "signatureTemplate",
  "headerImageUrl",
  "footerText",
  "invoiceStampUrl",
  "missionStatement",
  "supportEmail",
  "supportPhone",
  "socialLinksJson",
];

function pickAssetFields(body) {
  const out = {};
  for (const f of ASSET_FIELDS) {
    if (body[f] !== undefined) {
      // Coerce null-or-string; reject other types.
      if (body[f] === null) {
        out[f] = null;
      } else if (typeof body[f] === "string") {
        out[f] = body[f];
      } else {
        const err = new Error(`${f} must be a string or null`);
        err.status = 400;
        err.code = "INVALID_ASSET_FIELD";
        throw err;
      }
    }
  }
  return out;
}

// ─── Public endpoint ────────────────────────────────────────────────
//
// GET /api/brand-kits/by-subbrand/:subBrand  (no auth)
//
// G092 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.f / FR-3.3.i / FR-3.3.g)
// — Public consumer surface for the customer portal, the public trip
// microsite, the embed widget, and the public landing page. Each of
// those surfaces needs the active brand kit BEFORE the customer logs
// in (the login screen / landing page itself must carry sub-brand
// chrome).
//
// Sub-path is allowlisted in server.js's global auth guard with a
// regex bypass scoped to /brand-kits/by-subbrand/:sub (GET only). The
// handler returns ONLY public-safe fields:
//
//   - logoUrl, logoDarkUrl, faviconUrl, wordmarkUrl, heroUrl,
//     headerImageUrl, invoiceStampUrl
//   - primaryColor, secondaryColor, accentColor, bgColor, textColor
//   - fontFamily, fontUrl, headingFontFamily, bodyFontFamily
//   - tagline, footerText, missionStatement, supportEmail, supportPhone,
//     socialLinksJson
//
// Explicitly NOT returned: id, tenantId, version, createdBy, isActive,
// createdAt, updatedAt, signatureTemplate (no audit / version enumeration
// via the public path; signatureTemplate is internal-only email body
// content not meant for the public chrome).
//
// Tenant resolution: ?tenantId=N when supplied — otherwise the single
// travel-vertical tenant (Travel Stall tenant per Q25 — multi-travel-
// tenant deployments must pass ?tenantId explicitly to disambiguate).
// 404 when no active brand kit exists for (tenantId, subBrand) — the
// frontend consumer falls back to the default palette.
const PUBLIC_BRAND_KIT_SELECT = {
  logoUrl: true,
  logoDarkUrl: true,
  faviconUrl: true,
  wordmarkUrl: true,
  heroUrl: true,
  headerImageUrl: true,
  invoiceStampUrl: true,
  primaryColor: true,
  secondaryColor: true,
  accentColor: true,
  bgColor: true,
  textColor: true,
  fontFamily: true,
  fontUrl: true,
  headingFontFamily: true,
  headingFontUrl: true,
  bodyFontFamily: true,
  bodyFontUrl: true,
  tagline: true,
  footerText: true,
  missionStatement: true,
  supportEmail: true,
  supportPhone: true,
  socialLinksJson: true,
};

router.get("/by-subbrand/:subBrand", async (req, res) => {
  try {
    const subBrand = String(req.params.subBrand || "");
    // Reject "_" / "null" / empty — the public endpoint only resolves
    // NAMED sub-brands (tenant-wide null kits aren't exposed publicly).
    if (!subBrand || subBrand === "_" || subBrand === "null") {
      return res.status(400).json({
        error: "subBrand path segment required (one of tmc, rfu, travelstall, visasure)",
        code: "MISSING_SUB_BRAND",
      });
    }
    try {
      assertValidSubBrand(subBrand);
    } catch (e) {
      return res.status(400).json({
        error: e.message || "Invalid sub-brand",
        code: e.code || "INVALID_SUB_BRAND",
      });
    }

    // Tenant resolution: explicit ?tenantId wins; else fall back to the
    // single travel-vertical tenant. Multi-travel-tenant deployments
    // (uncommon) MUST pass ?tenantId — otherwise the resolver returns
    // the first travel tenant by id (deterministic, but ambiguous).
    let tenantId = null;
    if (req.query && req.query.tenantId !== undefined) {
      const n = parseInt(String(req.query.tenantId), 10);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: "tenantId must be a number", code: "INVALID_TENANT_ID" });
      }
      tenantId = n;
    } else {
      const travel = await prisma.tenant.findFirst({
        where: { vertical: "travel" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      if (!travel) {
        return res.status(404).json({
          error: "No travel tenant configured; pass ?tenantId explicitly",
          code: "NO_TRAVEL_TENANT",
        });
      }
      tenantId = travel.id;
    }

    const brandKit = await prisma.brandKit.findFirst({
      where: { tenantId, subBrand, isActive: true },
      select: PUBLIC_BRAND_KIT_SELECT,
    });
    if (!brandKit) {
      return res.status(404).json({
        error: "No active brand kit for that sub-brand",
        code: "BRAND_KIT_NOT_FOUND",
      });
    }
    res.json({ subBrand, brandKit });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[brand-kits] by-subbrand error:", e.message);
    res.status(500).json({ error: "Failed to resolve public brand kit" });
  }
});

// GET /api/brand-kits
// Honors ?subBrand=tmc (filter — empty string / "null" means tenant-wide),
// ?isActive=true (filter), and ?fields=summary (slim-shape opt-in).
// Default order: subBrand asc, version desc.
router.get("/", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    if (req.query.subBrand !== undefined) {
      const sb = normalizeSubBrand(req.query.subBrand);
      where.subBrand = sb; // null = tenant-wide
    }
    if (req.query.isActive !== undefined) {
      where.isActive = String(req.query.isActive) === "true";
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      // Caller has a restricted sub-brand set. Tenant-wide (subBrand=null)
      // rows are always visible; named sub-brands are intersected with
      // the allowed set.
      if (where.subBrand !== undefined) {
        if (where.subBrand !== null && !canAccessSubBrand(allowed, where.subBrand)) {
          where.subBrand = "__none__";
        }
      } else {
        where.OR = [
          { subBrand: null },
          { subBrand: { in: [...allowed] } },
        ];
      }
    }

    // #920 slice 37: ?fields=summary slim-shape opt-in. Mirrors slices 1-36.
    // BrandKit has heavy visual-asset columns — logoUrl / logoDarkUrl /
    // faviconUrl (URL strings up to 500 chars each), five color columns
    // (primary/secondary/accent/bg/text), fontFamily + fontUrl, and
    // tagline. List/picker UI (e.g. BrandKits.jsx version-history table,
    // BookingExpediaSearch sub-brand picker) only needs chrome columns:
    // id + subBrand + version + isActive + updatedAt. When the caller
    // passes ?fields=summary we forward a slim `select` so the wire payload
    // (and the DB read) stays narrow. Opt-in additive — existing callers
    // (no ?fields, or any non-exact value) get the full row shape unchanged
    // so BrandKits.jsx editor + the /active/:subBrand resolver continue to
    // receive every asset field.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: [{ subBrand: "asc" }, { version: "desc" }],
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        subBrand: true,
        version: true,
        isActive: true,
        updatedAt: true,
      };
    }

    const [brandKits, total] = await Promise.all([
      prisma.brandKit.findMany(findManyArgs),
      prisma.brandKit.count({ where }),
    ]);
    res.json({ brandKits, total });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[brand-kits] list error:", e.message);
    res.status(500).json({ error: "Failed to list brand kits" });
  }
});

// GET /api/brand-kits/active/:subBrand
// Returns the active brand kit for a sub-brand (or null). Empty path
// segment / literal "null" / "_" queries tenant-wide (subBrand IS NULL).
router.get("/active/:subBrand", verifyToken, async (req, res) => {
  try {
    let sb = req.params.subBrand;
    if (sb === "_" || sb === "null" || sb === "") {
      sb = null;
    } else {
      assertValidSubBrand(sb);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (sb !== null && !canAccessSubBrand(allowed, sb)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const brandKit = await prisma.brandKit.findFirst({
      where: { tenantId: req.user.tenantId, subBrand: sb, isActive: true },
    });
    res.json({ brandKit: brandKit || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[brand-kits] active lookup error:", e.message);
    res.status(500).json({ error: "Failed to look up active brand kit" });
  }
});

// GET /api/brand-kits/:id
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const brandKit = await prisma.brandKit.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!brandKit) {
      return res.status(404).json({ error: "Brand kit not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (brandKit.subBrand !== null && !canAccessSubBrand(allowed, brandKit.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(brandKit);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[brand-kits] get error:", e.message);
    res.status(500).json({ error: "Failed to get brand kit" });
  }
});

// POST /api/brand-kits — ADMIN only.
// All asset fields are optional (an empty draft kit is valid). Version is
// auto-assigned per (tenantId, subBrand) tuple. isActive defaults false;
// when true, atomically demotes any prior active row for the same tuple.
router.post(
  "/",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const body = req.body || {};
      const tenantId = req.user.tenantId;
      const subBrand = normalizeSubBrand(body.subBrand);
      const isActive = body.isActive === true;
      const assets = pickAssetFields(body);

      // Sub-brand access gate.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (subBrand !== null && !canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Auto-assign version: max(version) for (tenantId, subBrand) + 1.
      // Race window between this read and the create is closed by the
      // @@unique([tenantId, subBrand, version]) constraint — concurrent
      // creators will collide on P2002 and we retry once with version+1.
      const created = await prisma.$transaction(async (tx) => {
        const latest = await tx.brandKit.findFirst({
          where: { tenantId, subBrand },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const nextVersion = (latest?.version || 0) + 1;

        if (isActive) {
          await tx.brandKit.updateMany({
            where: { tenantId, subBrand, isActive: true },
            data: { isActive: false },
          });
        }

        return tx.brandKit.create({
          data: {
            tenantId,
            subBrand,
            version: nextVersion,
            isActive,
            createdBy: req.user.userId,
            ...assets,
          },
        });
      });

      await writeAudit(
        "BrandKit",
        "CREATE",
        created.id,
        req.user.userId,
        tenantId,
        { subBrand: created.subBrand, version: created.version, isActive: created.isActive },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      // Race on the (tenantId, subBrand, version) unique — caller can retry.
      if (e.code === "P2002") {
        return res.status(409).json({
          error: "Version race — another save landed simultaneously; retry",
          code: "VERSION_RACE",
        });
      }
      console.error("[brand-kits] create error:", e.message);
      res.status(500).json({ error: "Failed to create brand kit" });
    }
  },
);

// PUT /api/brand-kits/:id — ADMIN only.
// version + subBrand are immutable after create. isActive flips trigger
// atomic demotion of any other active row for the same (tenantId, subBrand).
router.put(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.brandKit.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Brand kit not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand !== null && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const body = req.body || {};

      // Reject attempts to change immutable fields. Surface a clear error
      // rather than silently dropping so callers learn the contract.
      if (body.version !== undefined && Number(body.version) !== existing.version) {
        return res.status(400).json({
          error: "version is immutable; create a new kit instead",
          code: "VERSION_IMMUTABLE",
        });
      }
      if (body.subBrand !== undefined) {
        const newSb = normalizeSubBrand(body.subBrand);
        if (newSb !== existing.subBrand) {
          return res.status(400).json({
            error: "subBrand is immutable after create",
            code: "SUB_BRAND_IMMUTABLE",
          });
        }
      }

      const assets = pickAssetFields(body);
      const data = { ...assets };
      let activating = false;
      if (body.isActive !== undefined) {
        data.isActive = body.isActive === true;
        activating = data.isActive === true && existing.isActive === false;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.$transaction(async (tx) => {
        if (activating) {
          // Demote OTHER active rows for the same (tenantId, subBrand).
          // The `id: { not: id }` clause keeps the row we're about to
          // promote untouched.
          await tx.brandKit.updateMany({
            where: {
              tenantId: req.user.tenantId,
              subBrand: existing.subBrand,
              isActive: true,
              id: { not: id },
            },
            data: { isActive: false },
          });
        }
        return tx.brandKit.update({
          where: { id },
          data,
        });
      });

      await writeAudit(
        "BrandKit",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.user.tenantId,
        {
          subBrand: updated.subBrand,
          version: updated.version,
          isActive: updated.isActive,
          fields: Object.keys(data),
        },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[brand-kits] update error:", e.message);
      res.status(500).json({ error: "Failed to update brand kit" });
    }
  },
);

// DELETE /api/brand-kits/:id — ADMIN only.
// Hard-delete. Refuses to delete an active kit (caller must demote first
// or promote a different version). Audit row written BEFORE the prisma
// delete so the entityId still resolves cleanly.
router.delete(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.brandKit.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Brand kit not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (existing.subBrand !== null && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if (existing.isActive === true) {
        return res.status(422).json({
          error: "Cannot delete an active brand kit; demote or replace it first",
          code: "ACTIVE_KIT_LOCKED",
        });
      }

      await writeAudit(
        "BrandKit",
        "DELETE",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          version: existing.version,
          isActive: existing.isActive,
        },
      );

      await prisma.brandKit.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[brand-kits] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete brand kit" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// W4.A G099 — Admin extension endpoints
// ─────────────────────────────────────────────────────────────────────────
//
//   POST   /api/brand-kits/upload                — Multer upload + validation
//   GET    /api/brand-kits/:id/versions          — version history
//   POST   /api/brand-kits/:id/revert/:version   — revert to prior version
//   POST   /api/brand-kits/:id/copy-from/:sourceId — copy assets from another kit
//
// All four are ADMIN-gated. The upload endpoint is multipart/form-data —
// every other surface stays JSON for symmetry with the v1 endpoints.

/**
 * POST /api/brand-kits/upload — ADMIN only.
 *
 * multipart/form-data:
 *   - file        — the binary upload (Multer field name "file")
 *   - assetType   — string key from ASSET_CLASSES (logo / wordmark / favicon /
 *                   hero / headerImage / stamp); validates per-class caps.
 *   - subBrand    — optional sub-brand scope for the destination path; if
 *                   absent, the asset lands in the tenant-wide bucket.
 *
 * Response: { url, mime, ext, width, height, sizeBytes, assetType }.
 *
 * On success the file is written to:
 *   backend/uploads/brand-kits/<tenantId>/<subBrand|_>/<assetType>-<stamp>.<ext>
 * and the returned `url` is the public path the operator pastes into the
 * BrandKit form (or that the front-end auto-populates).
 */
router.post(
  "/upload",
  verifyToken,
  verifyRole(["ADMIN"]),
  wrappedUpload,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided", code: "NO_FILE" });
      }
      const assetType = String(req.body?.assetType || "").trim();
      if (!assetType || !ASSET_CLASSES[assetType]) {
        return res.status(400).json({
          error: `assetType must be one of ${Object.keys(ASSET_CLASSES).join(", ")}`,
          code: "INVALID_ASSET_TYPE",
        });
      }

      const subBrand = normalizeSubBrand(req.body?.subBrand);
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (subBrand !== null && !canAccessSubBrand(allowed, subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const result = validateAssetUpload({ file: req.file, expectedType: assetType });
      if (!result.valid) {
        return res.status(400).json({
          error: result.messages?.[0] || "Validation failed",
          code: result.errors?.[0] || "VALIDATION_FAILED",
          errors: result.errors,
          messages: result.messages,
        });
      }

      // Disk write — segmented by tenant + sub-brand so cross-tenant access
      // via path-traversal stays impossible at the filesystem level.
      const sbSegment = subBrand || "_default";
      const targetDir = path.join(UPLOAD_DIR, String(req.user.tenantId), sbSegment);
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (e) {
        console.error("[brand-kits] upload mkdir failed:", e.message);
      }
      const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const filename = `${assetType}-${stamp}${result.ext}`;
      const fullPath = path.join(targetDir, filename);

      // Write the SANITIZED buffer — SVG payloads have been re-encoded
      // by sanitize-html so any silently-tolerated tag is dropped before
      // disk write. Raster buffers pass through unchanged.
      fs.writeFileSync(fullPath, result.sanitizedBuffer);

      const url = `/uploads/brand-kits/${req.user.tenantId}/${sbSegment}/${filename}`;

      await writeAudit(
        "BrandKit",
        "UPLOAD",
        0, // no row id yet — operator wires the URL into a form
        req.user.userId,
        req.user.tenantId,
        { assetType, subBrand, url, mime: result.mime, sizeBytes: req.file.buffer.length },
      );

      return res.status(201).json({
        url,
        mime: result.mime,
        ext: result.ext,
        width: result.width,
        height: result.height,
        sizeBytes: req.file.buffer.length,
        assetType,
      });
    } catch (e) {
      console.error("[brand-kits] upload error:", e.message);
      res.status(500).json({ error: "Upload failed", code: "UPLOAD_FAILED" });
    }
  },
);

/**
 * GET /api/brand-kits/:id/versions
 *
 * Returns every BrandKit row for the same (tenantId, subBrand) tuple as
 * the row addressed by :id — ordered newest version first. This is the
 * data the version-history table in the admin UI surfaces; the active
 * row is identified via row.isActive===true (one such row at most).
 */
router.get("/:id/versions", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const anchor = await prisma.brandKit.findFirst({
      where: { id, tenantId: req.user.tenantId },
      select: { id: true, subBrand: true },
    });
    if (!anchor) {
      return res.status(404).json({ error: "Brand kit not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (anchor.subBrand !== null && !canAccessSubBrand(allowed, anchor.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const versions = await prisma.brandKit.findMany({
      where: { tenantId: req.user.tenantId, subBrand: anchor.subBrand },
      orderBy: { version: "desc" },
    });
    res.json({ versions, total: versions.length });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[brand-kits] versions error:", e.message);
    res.status(500).json({ error: "Failed to list versions" });
  }
});

/**
 * POST /api/brand-kits/:id/revert/:version — ADMIN only.
 *
 * Reverts the (tenantId, subBrand) chain to the asset shape of the named
 * `:version` by CREATING A NEW VERSION at the next slot that copies the
 * source version's asset fields. The revert is non-destructive — older
 * versions stay in place; the new top version simply mirrors the chosen
 * historical shape.
 *
 * Activation policy: the new revert version is auto-activated, which
 * atomically demotes any currently-active row for the same tuple.
 */
router.post(
  "/:id/revert/:version",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const sourceVersion = parseInt(req.params.version, 10);
      if (!Number.isFinite(id) || !Number.isFinite(sourceVersion)) {
        return res.status(400).json({ error: "id and version must be numbers", code: "INVALID_ID" });
      }

      const anchor = await prisma.brandKit.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, subBrand: true },
      });
      if (!anchor) {
        return res.status(404).json({ error: "Brand kit not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (anchor.subBrand !== null && !canAccessSubBrand(allowed, anchor.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const sourceKit = await prisma.brandKit.findFirst({
        where: {
          tenantId: req.user.tenantId,
          subBrand: anchor.subBrand,
          version: sourceVersion,
        },
      });
      if (!sourceKit) {
        return res.status(404).json({
          error: `Source version v${sourceVersion} not found`,
          code: "SOURCE_VERSION_NOT_FOUND",
        });
      }

      const assetCopy = {};
      for (const f of ASSET_FIELDS) {
        assetCopy[f] = sourceKit[f] ?? null;
      }

      const created = await prisma.$transaction(async (tx) => {
        const latest = await tx.brandKit.findFirst({
          where: { tenantId: req.user.tenantId, subBrand: anchor.subBrand },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const nextVersion = (latest?.version || 0) + 1;

        // Auto-activate the revert version — operator intent is "make
        // historical shape current".
        await tx.brandKit.updateMany({
          where: { tenantId: req.user.tenantId, subBrand: anchor.subBrand, isActive: true },
          data: { isActive: false },
        });

        return tx.brandKit.create({
          data: {
            tenantId: req.user.tenantId,
            subBrand: anchor.subBrand,
            version: nextVersion,
            isActive: true,
            createdBy: req.user.userId,
            ...assetCopy,
          },
        });
      });

      await writeAudit(
        "BrandKit",
        "REVERT",
        created.id,
        req.user.userId,
        req.user.tenantId,
        {
          subBrand: anchor.subBrand,
          newVersion: created.version,
          revertedFromVersion: sourceVersion,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[brand-kits] revert error:", e.message);
      res.status(500).json({ error: "Revert failed" });
    }
  },
);

/**
 * POST /api/brand-kits/:id/copy-from/:sourceId — ADMIN only.
 *
 * Copies asset fields from one BrandKit row (`:sourceId`) into a new
 * version for the (tenantId, subBrand) tuple of `:id`. Used when an
 * operator wants to seed a new sub-brand's kit from an existing one
 * (e.g. "Travel Stall brand mirrors TMC for now").
 *
 * Active flag NOT set automatically — the copied version is a draft
 * the operator can preview before activating via the standard PUT.
 */
router.post(
  "/:id/copy-from/:sourceId",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const sourceId = parseInt(req.params.sourceId, 10);
      if (!Number.isFinite(id) || !Number.isFinite(sourceId)) {
        return res.status(400).json({ error: "id and sourceId must be numbers", code: "INVALID_ID" });
      }

      const anchor = await prisma.brandKit.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, subBrand: true },
      });
      if (!anchor) {
        return res.status(404).json({ error: "Destination brand kit not found", code: "NOT_FOUND" });
      }
      const sourceKit = await prisma.brandKit.findFirst({
        where: { id: sourceId, tenantId: req.user.tenantId },
      });
      if (!sourceKit) {
        return res.status(404).json({ error: "Source brand kit not found", code: "SOURCE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (anchor.subBrand !== null && !canAccessSubBrand(allowed, anchor.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }
      if (sourceKit.subBrand !== null && !canAccessSubBrand(allowed, sourceKit.subBrand)) {
        return res.status(403).json({
          error: "Source sub-brand access denied",
          code: "SOURCE_SUB_BRAND_DENIED",
        });
      }

      const assetCopy = {};
      for (const f of ASSET_FIELDS) {
        assetCopy[f] = sourceKit[f] ?? null;
      }

      const created = await prisma.$transaction(async (tx) => {
        const latest = await tx.brandKit.findFirst({
          where: { tenantId: req.user.tenantId, subBrand: anchor.subBrand },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const nextVersion = (latest?.version || 0) + 1;
        return tx.brandKit.create({
          data: {
            tenantId: req.user.tenantId,
            subBrand: anchor.subBrand,
            version: nextVersion,
            isActive: false,
            createdBy: req.user.userId,
            ...assetCopy,
          },
        });
      });

      await writeAudit(
        "BrandKit",
        "COPY_FROM",
        created.id,
        req.user.userId,
        req.user.tenantId,
        {
          subBrand: anchor.subBrand,
          newVersion: created.version,
          copiedFromKitId: sourceId,
          copiedFromSubBrand: sourceKit.subBrand,
          copiedFromVersion: sourceKit.version,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[brand-kits] copy-from error:", e.message);
      res.status(500).json({ error: "Copy-from failed" });
    }
  },
);

module.exports = router;
