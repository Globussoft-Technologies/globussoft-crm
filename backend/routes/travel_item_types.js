/**
 * /api/travel/item-types — tenant-defined itinerary item types.
 *
 * The item-type combobox in the day planner offers a fixed built-in
 * vocabulary (flight|train|bus|cab|transfer|hotel|sightseeing|activity|
 * meals|visa|insurance|other — VALID_ITEM_TYPES in travel_itineraries.js)
 * plus whatever an operator has added here ("Ferry", "Photography session").
 * Built-ins are never rows in this table, so they can never be deleted
 * through this endpoint — only custom types the tenant created.
 *
 * `key` is what actually gets written to ItineraryItem.itemType.
 * assertValidItemType() in travel_itineraries.js checks the built-in array
 * first, then falls back to an active row here.
 */

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");

function slugifyKey(label) {
  return String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

// GET /api/travel/item-types?subBrand=<sb>&active=true
router.get("/item-types", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      const sb = String(req.query.subBrand);
      if (sb !== "null" && sb !== "_tenant") {
        assertValidSubBrand(sb);
        // Tenant-wide (subBrand=null) types are always offered alongside
        // sub-brand-specific ones — a Prisma `where` can't express "IN
        // (X, NULL)" via simple equality, so build the OR explicitly.
        where.OR = [{ subBrand: sb }, { subBrand: null }];
      }
    }
    if (req.query.active === "true") where.isActive = true;
    if (req.query.active === "false") where.isActive = false;

    const rows = await prisma.travelItemType.findMany({
      where,
      orderBy: [{ label: "asc" }],
    });
    res.json({ itemTypes: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[item-types] list error:", e.message);
    res.status(500).json({ error: "Failed to list item types" });
  }
});

// POST /api/travel/item-types — create a custom type.
// Body: { label, subBrand? }
router.post(
  "/item-types",
  verifyToken,
  requirePermission("itineraries", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { label, subBrand } = req.body || {};
      if (!label || typeof label !== "string" || !label.trim()) {
        return res.status(400).json({ error: "label is required", code: "MISSING_LABEL" });
      }
      let normalizedSubBrand = null;
      if (subBrand !== undefined && subBrand !== null && subBrand !== "") {
        assertValidSubBrand(subBrand);
        const allowed = await getSubBrandAccessSet(req.user.userId);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        normalizedSubBrand = subBrand;
      }

      const key = slugifyKey(label);
      if (!key) {
        return res.status(400).json({ error: "label must contain at least one letter or number", code: "INVALID_LABEL" });
      }
      // Never allow a custom type to shadow a built-in key — the built-in
      // vocabulary is hardcoded server-side and always wins on collision.
      const BUILT_IN_KEYS = [
        "flight", "train", "bus", "cab", "transfer", "hotel",
        "sightseeing", "activity", "meals", "visa", "insurance", "other",
      ];
      if (BUILT_IN_KEYS.includes(key)) {
        return res.status(409).json({ error: `"${label}" is already a built-in type`, code: "BUILT_IN_KEY_COLLISION" });
      }

      const created = await prisma.travelItemType.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: normalizedSubBrand,
          key,
          label: label.trim(),
        },
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "P2002") {
        return res.status(409).json({ error: "This item type already exists", code: "ITEM_TYPE_KEY_TAKEN" });
      }
      console.error("[item-types] create error:", e.message);
      res.status(500).json({ error: "Failed to create item type" });
    }
  },
);

// DELETE /api/travel/item-types/:id — remove a custom type. Existing
// ItineraryItem rows already using this key are left as-is (itemType is a
// plain string column, not an FK) — they just stop appearing as a
// selectable option for new items.
router.delete(
  "/item-types/:id",
  verifyToken,
  requirePermission("itineraries", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelItemType.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Item type not found", code: "NOT_FOUND" });
      }
      await prisma.travelItemType.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      console.error("[item-types] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete item type" });
    }
  },
);

module.exports = router;
