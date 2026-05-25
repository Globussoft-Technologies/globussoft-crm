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
const { findDuplicateContactFull } = require("../utils/deduplication");

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

    // PRD §4.5 — passport-key duplicate check. If a passport number is
    // provided AND another profile in this tenant already has it (with a
    // different contactId), surface a 409 so the caller's pop-up flow
    // can offer "link to existing" / "edit existing" instead of silently
    // creating a parallel profile that splits the pilgrim's history.
    // Self-match (same contactId, e.g. accidental double-submit) is
    // allowed through — the @unique contactId catches it as DUPLICATE_PROFILE.
    if (req.body.passportNumber) {
      const collision = await prisma.rfuLeadProfile.findFirst({
        where: {
          tenantId: req.travelTenant.id,
          passportNumber: req.body.passportNumber,
          NOT: { contactId: cid },
        },
        select: { id: true, contactId: true },
      });
      if (collision) {
        return res.status(409).json({
          error: "Another contact already has this passport number",
          code: "DUPLICATE_PASSPORT",
          existingProfileId: collision.id,
          existingContactId: collision.contactId,
        });
      }
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

// ─── Phase 2 — preflight duplicate check (PRD §4.5) ──────────────────
//
// The Phase 2 "full pop-up flow with preferences" needs a check-without-
// creating endpoint so the frontend modal can surface the duplicate
// BEFORE the operator submits the form (and before any partial state
// lands in the DB). Returns one of:
//   { duplicate: false }
//   { duplicate: true, matchedBy: 'passport'|'email'|'phone', contact: {...} }
//
// Try-order is passport → email → phone (signal strength descending).
// Tenant-scoped + soft-delete filtered; same contract as the underlying
// findDuplicateContactFull helper.
//
// MUST mount before the `/:id` routes so parseInt("check-duplicate") →
// NaN doesn't capture it.
router.post(
  "/rfu-profiles/check-duplicate",
  verifyToken,
  requireTravelTenant,
  requireRfuAccess,
  async (req, res) => {
    try {
      const { email, phone, passportNumber } = req.body || {};
      if (!email && !phone && !passportNumber) {
        return res
          .status(400)
          .json({ error: "at least one of email/phone/passportNumber required", code: "MISSING_FIELDS" });
      }
      const hit = await findDuplicateContactFull({
        email: email || null,
        phone: phone || null,
        passportNumber: passportNumber || null,
        tenantId: req.travelTenant.id,
      });
      if (!hit) return res.json({ duplicate: false });
      // Trim to a UX-safe contact projection — never leak fields the operator
      // doesn't need (territoryId, portalPasswordHash, etc.).
      const c = hit.contact;
      res.json({
        duplicate: true,
        matchedBy: hit.matchedBy,
        contact: {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          company: c.company,
          subBrand: c.subBrand,
          status: c.status,
        },
      });
    } catch (e) {
      console.error("[travel-rfu] check-duplicate error:", e.message);
      res.status(500).json({ error: "Failed to check duplicate" });
    }
  },
);

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
    // PRD §4.5 — passport-key collision check on UPDATE. If the passport
    // is being changed to one already owned by a DIFFERENT contact in
    // this tenant, surface 409. Matches POST guard above.
    if (data.passportNumber) {
      const collision = await prisma.rfuLeadProfile.findFirst({
        where: {
          tenantId: req.travelTenant.id,
          passportNumber: data.passportNumber,
          NOT: { id: existing.id },
        },
        select: { id: true, contactId: true },
      });
      if (collision) {
        return res.status(409).json({
          error: "Another contact already has this passport number",
          code: "DUPLICATE_PASSPORT",
          existingProfileId: collision.id,
          existingContactId: collision.contactId,
        });
      }
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
