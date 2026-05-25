/**
 * /api/travel/commission-profiles — TravelCommissionProfile CRUD
 * (PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 2).
 *
 * Sibling to /api/travel/quotes + /api/travel/suppliers. Stores named
 * commission profiles consumed by lib/agentCommissionCalculator.js
 * (slice 1, commit cb284098). Each row is one operator-facing pricing
 * shape — flat_percent | tiered | per_pax_flat | hybrid — stored as a
 * JSON String column so future calculator extensions don't require
 * schema migrations.
 *
 * Endpoints:
 *   GET    /api/travel/commission-profiles                — list (tenant + sub-brand scoped)
 *   GET    /api/travel/commission-profiles/:id            — fetch one
 *   POST   /api/travel/commission-profiles                — ADMIN/MANAGER create
 *   PUT    /api/travel/commission-profiles/:id            — ADMIN/MANAGER partial update
 *   DELETE /api/travel/commission-profiles/:id            — ADMIN-only hard delete
 *
 * Validation strictness (slice 2):
 *   - name required, non-empty trim                       → 400 MISSING_FIELDS
 *   - profileType must match 4-item whitelist             → 400 INVALID_PROFILE_TYPE
 *   - profileJson must JSON.parse                         → 400 INVALID_PROFILE_JSON
 *   - subBrand (if provided) must match assertValidSubBrand → 400 INVALID_SUB_BRAND
 *   - DEEP-SHAPE validation of parsed profileJson against profileType is
 *     INTENTIONALLY DEFERRED. The calculator returns commission=0 with a
 *     'unknown profile type X' breakdown on malformed shape — so a misconfigured
 *     row surfaces as an operator-visible $0 commission row at use-time
 *     rather than a 500 throw at edit-time. Tightening to per-type
 *     shape-validation is a future slice when the profile editor UI lands
 *     (the operator-facing editor will pin shape via form fields anyway).
 *
 * Sub-brand isolation: every list / get / write goes through
 * getSubBrandAccessSet + canAccessSubBrand. A MANAGER restricted to one
 * sub-brand cannot read or write profiles attached to other sub-brands;
 * profiles with NULL subBrand are tenant-wide and visible to everyone.
 *
 * Error codes (route-specific):
 *   INVALID_ID, MISSING_FIELDS, INVALID_PROFILE_TYPE, INVALID_PROFILE_JSON,
 *   INVALID_SUB_BRAND, PROFILE_NOT_FOUND, SUB_BRAND_DENIED, EMPTY_BODY.
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
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

const VALID_PROFILE_TYPES = ["flat_percent", "tiered", "per_pax_flat", "hybrid"];

function assertValidProfileType(t) {
  if (!VALID_PROFILE_TYPES.includes(t)) {
    const err = new Error(
      `profileType must be one of: ${VALID_PROFILE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_PROFILE_TYPE";
    throw err;
  }
}

/**
 * Light JSON parse-only validation. Accepts already-stringified JSON
 * (the canonical shape; column is @db.Text) OR a live object/array (the
 * route stringifies it for storage). Throws INVALID_PROFILE_JSON on
 * anything unparseable. Returns the canonical stringified form ready
 * for the column.
 *
 * Deep-shape validation against profileType is deferred (see file header).
 */
function normalizeProfileJson(input) {
  if (input == null || input === "") {
    const err = new Error("profileJson is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  if (typeof input === "string") {
    try {
      JSON.parse(input);
    } catch (_e) {
      const err = new Error("profileJson must be valid JSON");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
    return input;
  }
  if (typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch (_e) {
      const err = new Error("profileJson must be JSON-serializable");
      err.status = 400;
      err.code = "INVALID_PROFILE_JSON";
      throw err;
    }
  }
  const err = new Error("profileJson must be a JSON object or string");
  err.status = 400;
  err.code = "INVALID_PROFILE_JSON";
  throw err;
}

// GET /api/travel/commission-profiles
// Honors ?subBrand=tmc, ?profileType=flat_percent, ?isActive=true/false.
// Sub-brand-restricted callers see only their allowed sub-brands PLUS
// tenant-wide profiles (subBrand IS NULL).
router.get(
  "/commission-profiles",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };

      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.profileType) {
        assertValidProfileType(String(req.query.profileType));
        where.profileType = String(req.query.profileType);
      }
      if (req.query.isActive !== undefined) {
        const v = String(req.query.isActive);
        if (v === "true" || v === "1") where.isActive = true;
        else if (v === "false" || v === "0") where.isActive = false;
      }

      // Sub-brand narrowing. Restricted callers see profiles whose
      // subBrand is in their allowed set OR is NULL (tenant-wide).
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand !== undefined) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__"; // silent-empty consistent with siblings
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

      const [profiles, total] = await Promise.all([
        prisma.travelCommissionProfile.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          skip,
        }),
        prisma.travelCommissionProfile.count({ where }),
      ]);
      res.json({ profiles, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] list error:", e.message);
      res.status(500).json({ error: "Failed to list commission profiles" });
    }
  },
);

// GET /api/travel/commission-profiles/:id
router.get(
  "/commission-profiles/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const profile = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!profile) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // Sub-brand access — NULL subBrand is tenant-wide and visible to all.
      if (profile.subBrand) {
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, profile.subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }
      res.json(profile);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] get error:", e.message);
      res.status(500).json({ error: "Failed to get commission profile" });
    }
  },
);

// POST /api/travel/commission-profiles — ADMIN/MANAGER only.
// Required: name, profileType, profileJson.
// Optional: subBrand (null/omitted = tenant-wide), isActive (default true), notes.
router.post(
  "/commission-profiles",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, profileType, profileJson,
        subBrand, isActive, notes,
      } = req.body || {};

      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }
      if (!profileType) {
        return res.status(400).json({
          error: "profileType required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidProfileType(profileType);
      const profileJsonString = normalizeProfileJson(profileJson);

      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        // Sub-brand isolation: reject create that targets a sub-brand
        // the caller can't access. Tenant-wide (null subBrand) creates
        // are allowed for any authorised caller — the gate is the
        // ADMIN/MANAGER role check above.
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
      }

      const created = await prisma.travelCommissionProfile.create({
        data: {
          tenantId: req.travelTenant.id,
          name: name.trim(),
          profileType,
          profileJson: profileJsonString,
          subBrand: subBrand ? String(subBrand) : null,
          isActive: isActive === false ? false : true,
          notes: notes ? String(notes) : null,
        },
      });

      await writeAudit(
        "TravelCommissionProfile",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          name: created.name,
          profileType: created.profileType,
          subBrand: created.subBrand,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] create error:", e.message);
      res.status(500).json({ error: "Failed to create commission profile" });
    }
  },
);

// PUT /api/travel/commission-profiles/:id — ADMIN/MANAGER only.
// Partial update. Sub-brand reassignment requires access to both the
// existing AND the target sub-brand.
router.put(
  "/commission-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      // Caller must be able to access the existing sub-brand (NULL is
      // tenant-wide and accessible to any authorised role).
      if (existing.subBrand && !canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const data = {};
      const {
        name, profileType, profileJson,
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
      if (profileType !== undefined) {
        assertValidProfileType(profileType);
        data.profileType = profileType;
      }
      if (profileJson !== undefined) {
        data.profileJson = normalizeProfileJson(profileJson);
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

      const updated = await prisma.travelCommissionProfile.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelCommissionProfile",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] update error:", e.message);
      res.status(500).json({ error: "Failed to update commission profile" });
    }
  },
);

// DELETE /api/travel/commission-profiles/:id — ADMIN-only hard delete.
// Audit row written BEFORE the prisma.delete fires so the intent is
// captured even if the delete subsequently throws.
router.delete(
  "/commission-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelCommissionProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Commission profile not found",
          code: "PROFILE_NOT_FOUND",
        });
      }

      // ADMINs always have full sub-brand access (getSubBrandAccessSet
      // returns null for ADMIN role), so no additional sub-brand gate
      // is strictly needed here. Keeping the check defensive in case
      // the role/access semantics evolve.
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
        "TravelCommissionProfile",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          name: existing.name,
          profileType: existing.profileType,
          subBrand: existing.subBrand,
        },
      );

      await prisma.travelCommissionProfile.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-commission-profiles] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete commission profile" });
    }
  },
);

module.exports = router;
