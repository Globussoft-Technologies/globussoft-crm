// Travel CRM — RFU customer profile extension.
//
// One-to-one with Contact (schema @unique on contactId). Stores RFU-
// specific fields that don't belong on the generic Contact:
// passport, visa history, frequent-flyer programs, seat/meal pref,
// travel style, budget min/max, emergency contact, medical notes,
// past complaints, product tier (entry/primary/premium).
//
// PII handling: passport number sits on this row in plaintext per
// current schema (no field-level encryption on String columns
// without a schema change). Phase 1.5 will move passport to the
// fieldEncryption helper alongside the Aadhaar token pattern on
// TripParticipant. For now, retention policy (24m post-trip per Q14)
// is the primary control.
//
// Endpoints:
//   GET    /api/travel/rfu-profiles                            — list
//   POST   /api/travel/rfu-profiles                            — create
//   GET    /api/travel/rfu-profiles/by-contact/:contactId      — lookup
//   GET    /api/travel/rfu-profiles/:id                        — fetch
//   PATCH  /api/travel/rfu-profiles/:id                        — amend
//   DELETE /api/travel/rfu-profiles/:id                        — ADMIN

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { requireTravelTenant, getSubBrandAccessSet } = require("../middleware/travelGuards");

const VALID_TIERS = ["entry", "primary", "premium"];

async function requireRfuAccess(req, res, next) {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed && !allowed.has("rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    next();
  } catch (e) {
    console.error("[travel-rfu] access error:", e.message);
    res.status(500).json({ error: "Access check failed" });
  }
}

// ─── List + create ────────────────────────────────────────────────────

router.get("/rfu-profiles", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.productTier) {
      if (!VALID_TIERS.includes(String(req.query.productTier))) {
        return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
      }
      where.productTier = String(req.query.productTier);
    }
    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;
    const [profiles, total] = await Promise.all([
      prisma.rfuLeadProfile.findMany({ where, orderBy: { id: "desc" }, take, skip }),
      prisma.rfuLeadProfile.count({ where }),
    ]);
    res.json({ profiles, total, limit: take, offset: skip });
  } catch (e) {
    console.error("[travel-rfu] list error:", e.message);
    res.status(500).json({ error: "Failed to list profiles" });
  }
});

router.post("/rfu-profiles", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const { contactId, productTier } = req.body || {};
    if (!contactId) {
      return res.status(400).json({ error: "contactId required", code: "MISSING_FIELDS" });
    }
    const cid = parseInt(contactId, 10);
    if (!Number.isFinite(cid)) {
      return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
    }
    if (productTier && !VALID_TIERS.includes(productTier)) {
      return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
    }

    const data = {
      tenantId: req.travelTenant.id,
      contactId: cid,
    };
    const fields = [
      "passportNumber", "passportExpiry",
      "visaHistoryJson", "frequentFlyerJson",
      "seatPref", "mealPref", "travelStyle",
      "budgetMin", "budgetMax",
      "emergencyContactName", "emergencyContactPhone",
      "medicalNotes", "specialAssistance", "pastComplaintsJson",
      "productTier",
    ];
    for (const k of fields) {
      if (req.body[k] !== undefined) {
        const v = req.body[k];
        if (k === "passportExpiry") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "budgetMin" || k === "budgetMax") {
          data[k] = v != null ? Number(v) : null;
        } else {
          data[k] = v ?? null;
        }
      }
    }

    const created = await prisma.rfuLeadProfile.create({ data });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "Profile already exists for this contact", code: "DUPLICATE_PROFILE" });
    }
    console.error("[travel-rfu] create error:", e.message);
    res.status(500).json({ error: "Failed to create profile" });
  }
});

// ─── Lookup-by-contact ────────────────────────────────────────────────

router.get(
  "/rfu-profiles/by-contact/:contactId",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const cid = parseInt(req.params.contactId, 10);
      if (!Number.isFinite(cid)) {
        return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
      }
      const row = await prisma.rfuLeadProfile.findFirst({
        where: { contactId: cid, tenantId: req.travelTenant.id },
      });
      if (!row) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
      res.json(row);
    } catch (e) {
      console.error("[travel-rfu] by-contact error:", e.message);
      res.status(500).json({ error: "Failed to get profile" });
    }
  },
);

// ─── Get + patch + delete ────────────────────────────────────────────

router.get("/rfu-profiles/:id", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const row = await prisma.rfuLeadProfile.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!row) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
    res.json(row);
  } catch (e) {
    console.error("[travel-rfu] get error:", e.message);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

router.patch("/rfu-profiles/:id", verifyToken, requireTravelTenant, requireRfuAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.rfuLeadProfile.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!existing) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });

    const data = {};
    const fields = [
      "passportNumber", "passportExpiry",
      "visaHistoryJson", "frequentFlyerJson",
      "seatPref", "mealPref", "travelStyle",
      "budgetMin", "budgetMax",
      "emergencyContactName", "emergencyContactPhone",
      "medicalNotes", "specialAssistance", "pastComplaintsJson",
      "productTier",
    ];
    for (const k of fields) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = req.body[k];
        if (k === "productTier" && v != null && !VALID_TIERS.includes(v)) {
          return res.status(400).json({ error: "invalid productTier", code: "INVALID_TIER" });
        }
        if (k === "passportExpiry") {
          data[k] = v ? new Date(v) : null;
        } else if (k === "budgetMin" || k === "budgetMax") {
          data[k] = v != null ? Number(v) : null;
        } else {
          data[k] = v ?? null;
        }
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }
    const updated = await prisma.rfuLeadProfile.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[travel-rfu] patch error:", e.message);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.delete(
  "/rfu-profiles/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.rfuLeadProfile.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
      await prisma.rfuLeadProfile.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-rfu] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete profile" });
    }
  },
);

module.exports = router;
