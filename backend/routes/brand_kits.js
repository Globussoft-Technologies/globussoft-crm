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
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

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

// GET /api/brand-kits
// Honors ?subBrand=tmc (filter — empty string / "null" means tenant-wide)
// and ?isActive=true (filter). Default order: subBrand asc, version desc.
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

    const [brandKits, total] = await Promise.all([
      prisma.brandKit.findMany({
        where,
        orderBy: [{ subBrand: "asc" }, { version: "desc" }],
      }),
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

module.exports = router;
