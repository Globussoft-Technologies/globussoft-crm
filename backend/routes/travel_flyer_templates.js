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
 *   GET    /api/travel/flyer-templates/:id            — fetch one
 *   POST   /api/travel/flyer-templates                — ADMIN/MANAGER create
 *   POST   /api/travel/flyer-templates/:id/duplicate  — ADMIN/MANAGER clone (slice 6)
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
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { validateTemplate } = require("../lib/flyerTemplateValidator");

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
      res.json({ templates, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] list error:", e.message);
      res.status(500).json({ error: "Failed to list flyer templates" });
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
      res.json(template);
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

      res.status(201).json(created);
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

      res.json(updated);
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

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-flyer-templates] duplicate error:", e.message);
      res.status(500).json({ error: "Failed to duplicate flyer template" });
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

module.exports = router;
