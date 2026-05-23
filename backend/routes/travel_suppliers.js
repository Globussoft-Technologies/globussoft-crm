// Travel CRM — Supplier credentials vault.
//
// Stores airline / hotel / GDS / visa-portal / payment-gateway login
// credentials. Loginid + password + 2FA seeds are AES-256-GCM encrypted
// at-rest via backend/lib/fieldEncryption.js (no-op if
// WELLNESS_FIELD_KEY env var isn't set — that key name is the existing
// CRM convention; will be renamed to FIELD_ENCRYPTION_KEY in Phase 1.5).
//
// Hard rules for this surface:
//   - List + Get-by-ID NEVER return the encrypted blobs OR their
//     decrypted plaintext. Only metadata (id, category, supplierName,
//     lastUsedAt, ownerUserId).
//   - /:id/reveal is the ONLY decryption path. ADMIN-gated. Writes a
//     SupplierCredentialAccessLog row { action: "viewed", userId, ip }
//     BEFORE returning the plaintext.
//   - PATCH writes an access-log row { action: "rotated" }.
//   - DELETE writes { action: "deleted" } before removing the credential.
//
// Endpoints:
//   GET    /api/travel/supplier-credentials                    — metadata list
//   POST   /api/travel/supplier-credentials                    — ADMIN create
//   GET    /api/travel/supplier-credentials/:id                — metadata fetch
//   POST   /api/travel/supplier-credentials/:id/reveal         — ADMIN decrypt
//   PATCH  /api/travel/supplier-credentials/:id                — ADMIN rotate
//   DELETE /api/travel/supplier-credentials/:id                — ADMIN delete
//   GET    /api/travel/supplier-credentials/:id/access-log     — audit trail

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { encrypt, decrypt } = require("../lib/fieldEncryption");
const { requireTravelTenant } = require("../middleware/travelGuards");

const VALID_CATEGORIES = [
  "airline", "hotel", "gds", "visa-portal",
  "payment-gateway", "insurance", "government",
];

function assertValidCategory(c) {
  if (!VALID_CATEGORIES.includes(c)) {
    const err = new Error(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_CATEGORY";
    throw err;
  }
}

// Sanitised projection — used by list + get-by-id so the encrypted
// columns are NEVER returned in responses unless the explicit /reveal
// path was hit.
const METADATA_SELECT = {
  id: true,
  tenantId: true,
  category: true,
  supplierName: true,
  ownerUserId: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
};

// ─── List + create ────────────────────────────────────────────────────

router.get(
  "/supplier-credentials",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.category) {
        assertValidCategory(String(req.query.category));
        where.category = String(req.query.category);
      }
      const rows = await prisma.supplierCredential.findMany({
        where,
        select: METADATA_SELECT,
        orderBy: [{ category: "asc" }, { supplierName: "asc" }],
        take: 200,
      });
      res.json({ credentials: rows });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] list error:", e.message);
      res.status(500).json({ error: "Failed to list credentials" });
    }
  },
);

router.post(
  "/supplier-credentials",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { category, supplierName, loginId, password, metadata, ownerUserId } = req.body || {};
      if (!category || !supplierName || !loginId || !password) {
        return res.status(400).json({
          error: "category, supplierName, loginId, password required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidCategory(category);

      // Encrypt at the route boundary so plaintext never sits in
      // unencrypted form on disk. If WELLNESS_FIELD_KEY is unset the
      // encrypt() helper is a no-op — that's the documented behaviour;
      // the safety net is the env-key requirement (see CLAUDE.md
      // "Known Security Notes").
      const created = await prisma.supplierCredential.create({
        data: {
          tenantId: req.travelTenant.id,
          category,
          supplierName: String(supplierName),
          loginIdEncrypted: encrypt(String(loginId)),
          passwordEncrypted: encrypt(String(password)),
          metadataJson: metadata ? encrypt(typeof metadata === "string" ? metadata : JSON.stringify(metadata)) : null,
          ownerUserId: ownerUserId ? parseInt(ownerUserId, 10) : req.user.userId,
        },
        select: METADATA_SELECT,
      });
      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] create error:", e.message);
      res.status(500).json({ error: "Failed to create credential" });
    }
  },
);

// ─── Get metadata (NOT the secrets) ───────────────────────────────────

router.get(
  "/supplier-credentials/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.supplierCredential.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: METADATA_SELECT,
      });
      if (!row) return res.status(404).json({ error: "Credential not found", code: "NOT_FOUND" });
      res.json(row);
    } catch (e) {
      console.error("[travel-sup] get error:", e.message);
      res.status(500).json({ error: "Failed to get credential" });
    }
  },
);

// ─── Reveal (ADMIN-gated, writes access log) ─────────────────────────

router.post(
  "/supplier-credentials/:id/reveal",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.supplierCredential.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!row) return res.status(404).json({ error: "Credential not found", code: "NOT_FOUND" });

      // Write the access-log row BEFORE returning the secrets — if the
      // response fails for any reason, the access still got logged.
      // Best-effort IP capture; behind Nginx/Cloudflare the trusted
      // header is X-Forwarded-For (first hop).
      const ip = req.ip || req.headers["x-forwarded-for"] || null;
      await prisma.supplierCredentialAccessLog.create({
        data: {
          credentialId: row.id,
          userId: req.user.userId,
          action: "viewed",
          ip: ip ? String(ip).slice(0, 64) : null,
        },
      });

      // Update lastUsedAt so the list view shows freshness.
      await prisma.supplierCredential.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      });

      res.json({
        id: row.id,
        category: row.category,
        supplierName: row.supplierName,
        loginId: decrypt(row.loginIdEncrypted),
        password: decrypt(row.passwordEncrypted),
        metadata: row.metadataJson ? decrypt(row.metadataJson) : null,
      });
    } catch (e) {
      console.error("[travel-sup] reveal error:", e.message);
      res.status(500).json({ error: "Failed to reveal credential" });
    }
  },
);

// ─── Rotate ──────────────────────────────────────────────────────────

router.patch(
  "/supplier-credentials/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.supplierCredential.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Credential not found", code: "NOT_FOUND" });

      const data = {};
      const { supplierName, loginId, password, metadata, ownerUserId, category } = req.body || {};
      if (category !== undefined) {
        assertValidCategory(category);
        data.category = category;
      }
      if (supplierName !== undefined) data.supplierName = String(supplierName);
      if (loginId !== undefined) data.loginIdEncrypted = encrypt(String(loginId));
      if (password !== undefined) data.passwordEncrypted = encrypt(String(password));
      if (metadata !== undefined) {
        data.metadataJson = metadata
          ? encrypt(typeof metadata === "string" ? metadata : JSON.stringify(metadata))
          : null;
      }
      if (ownerUserId !== undefined) {
        data.ownerUserId = ownerUserId ? parseInt(ownerUserId, 10) : null;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.supplierCredential.update({
        where: { id },
        data,
        select: METADATA_SELECT,
      });
      // Audit on rotate (only when secrets actually change)
      if (data.loginIdEncrypted || data.passwordEncrypted || data.metadataJson !== undefined) {
        await prisma.supplierCredentialAccessLog.create({
          data: {
            credentialId: id,
            userId: req.user.userId,
            action: "rotated",
            ip: req.ip ? String(req.ip).slice(0, 64) : null,
          },
        });
      }
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] patch error:", e.message);
      res.status(500).json({ error: "Failed to update credential" });
    }
  },
);

// ─── Delete ──────────────────────────────────────────────────────────

router.delete(
  "/supplier-credentials/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.supplierCredential.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Credential not found", code: "NOT_FOUND" });

      // Audit BEFORE delete — otherwise the access-log row's
      // credentialId FK would dangle (the SupplierCredentialAccessLog
      // model has onDelete: Cascade so the row gets cascade-deleted
      // anyway, but we want to log the intent).
      await prisma.supplierCredentialAccessLog.create({
        data: {
          credentialId: id,
          userId: req.user.userId,
          action: "deleted",
          ip: req.ip ? String(req.ip).slice(0, 64) : null,
        },
      });
      await prisma.supplierCredential.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-sup] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete credential" });
    }
  },
);

// ─── Access log ──────────────────────────────────────────────────────

router.get(
  "/supplier-credentials/:id/access-log",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const cred = await prisma.supplierCredential.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true },
      });
      if (!cred) return res.status(404).json({ error: "Credential not found", code: "NOT_FOUND" });

      const rows = await prisma.supplierCredentialAccessLog.findMany({
        where: { credentialId: id },
        orderBy: { at: "desc" },
        take: 200,
      });
      res.json({ accessLog: rows });
    } catch (e) {
      console.error("[travel-sup] access-log error:", e.message);
      res.status(500).json({ error: "Failed to get access log" });
    }
  },
);

// ─── TravelSupplier CRUD (PRD_TRAVEL_SUPPLIER_MASTER DD-5.1) ──────────
//
// Mounted at /api/travel/suppliers (via the file's /api/travel base mount
// in server.js:661 + the local "/suppliers" path prefix).
//
// The TravelSupplier model landed at commit fdb793e (tick #94) as the
// fork-side of the symmetric Quote/Billing/Supplier decision. This block
// ships the operator-facing CRUD scaffold — list/create/update/soft-delete.
// It coexists alongside the SupplierCredential vault above (different
// model, different concern: vault stores encrypted logins for airline
// portals / GDS / payment gateways; this stores the operator-facing
// supplier master — name, GSTIN, category).
//
// Future slices (not in this commit): supplier-payable ledger (PRD §3.3),
// commission tracking (PRD §3.4), per-supplier reconciliation (PRD §3.5),
// dispute escalation hooks (DD-5.4 deferred to Phase 2).
//
// Sub-brand isolation: every supplier carries .subBrand. Operator auth
// (verifyToken) plus the sub-brand access set (getSubBrandAccessSet) gates
// cross-sub-brand reads/writes — same pattern as travel_itineraries.js.

const {
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");

const VALID_SUPPLIER_CATEGORIES = ["hotel", "flight", "transport", "visa-consul", "other"];

function assertValidSupplierCategory(c) {
  if (c == null) return;
  if (!VALID_SUPPLIER_CATEGORIES.includes(c)) {
    const err = new Error(
      `supplierCategory must be one of: ${VALID_SUPPLIER_CATEGORIES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_SUPPLIER_CATEGORY";
    throw err;
  }
}

// GET /api/travel/suppliers
// Honors ?subBrand=tmc (filter to that sub-brand) and ?includeInactive=1.
router.get("/suppliers", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.includeInactive !== "1" && req.query.includeInactive !== "true") {
      where.isActive = true;
    }
    if (req.query.supplierCategory) {
      assertValidSupplierCategory(String(req.query.supplierCategory));
      where.supplierCategory = String(req.query.supplierCategory);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [suppliers, total] = await Promise.all([
      prisma.travelSupplier.findMany({
        where,
        orderBy: [{ subBrand: "asc" }, { supplierCategory: "asc" }, { name: "asc" }],
        take,
        skip,
      }),
      prisma.travelSupplier.count({ where }),
    ]);
    res.json({ suppliers, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-sup] list suppliers error:", e.message);
    res.status(500).json({ error: "Failed to list suppliers" });
  }
});

// GET /api/travel/suppliers/:id
router.get("/suppliers/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const supplier = await prisma.travelSupplier.findFirst({
      where: { id, tenantId: req.travelTenant.id },
    });
    if (!supplier) {
      return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, supplier.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(supplier);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-sup] get supplier error:", e.message);
    res.status(500).json({ error: "Failed to get supplier" });
  }
});

// POST /api/travel/suppliers — ADMIN/MANAGER only.
// Required: name. Optional: contactPerson, phone, email, gstin,
// addressLine, supplierCategory (whitelist), subBrand.
router.post(
  "/suppliers",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const {
        name, contactPerson, phone, email, gstin,
        addressLine, supplierCategory, subBrand,
      } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSupplierCategory(supplierCategory);
      if (subBrand) assertValidSubBrand(subBrand);

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_itineraries POST.
      const targetSubBrand = subBrand || "tmc"; // default to first valid for safety
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const created = await prisma.travelSupplier.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: targetSubBrand,
          name: String(name).trim(),
          contactPerson: contactPerson ? String(contactPerson) : null,
          phone: phone ? String(phone) : null,
          email: email ? String(email) : null,
          gstin: gstin ? String(gstin) : null,
          addressLine: addressLine ? String(addressLine) : null,
          supplierCategory: supplierCategory || "other",
          isActive: true,
        },
      });

      await writeAudit(
        "TravelSupplier",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        { name: created.name, subBrand: created.subBrand, supplierCategory: created.supplierCategory },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] create supplier error:", e.message);
      res.status(500).json({ error: "Failed to create supplier" });
    }
  },
);

// PUT /api/travel/suppliers/:id — ADMIN/MANAGER only.
router.put(
  "/suppliers/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        name, contactPerson, phone, email, gstin,
        addressLine, supplierCategory, subBrand, isActive,
      } = req.body || {};

      if (name !== undefined) {
        if (!String(name).trim()) {
          return res.status(400).json({ error: "name must be non-empty", code: "INVALID_NAME" });
        }
        data.name = String(name).trim();
      }
      if (contactPerson !== undefined) data.contactPerson = contactPerson ? String(contactPerson) : null;
      if (phone !== undefined) data.phone = phone ? String(phone) : null;
      if (email !== undefined) data.email = email ? String(email) : null;
      if (gstin !== undefined) data.gstin = gstin ? String(gstin) : null;
      if (addressLine !== undefined) data.addressLine = addressLine ? String(addressLine) : null;
      if (supplierCategory !== undefined) {
        assertValidSupplierCategory(supplierCategory);
        data.supplierCategory = supplierCategory || "other";
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        // Reject moving the supplier to a sub-brand the caller can't access.
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
        }
        data.subBrand = subBrand;
      }
      if (isActive !== undefined) data.isActive = Boolean(isActive);

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelSupplier.update({
        where: { id },
        data,
      });

      await writeAudit(
        "TravelSupplier",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] update supplier error:", e.message);
      res.status(500).json({ error: "Failed to update supplier" });
    }
  },
);

// DELETE /api/travel/suppliers/:id — ADMIN/MANAGER only.
// Soft-delete via isActive=false flip (preserve referential integrity
// for any future TravelInvoice/ItineraryItem.supplierId references).
router.delete(
  "/suppliers/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      await prisma.travelSupplier.update({
        where: { id },
        data: { isActive: false },
      });

      await writeAudit(
        "TravelSupplier",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        { softDelete: true, name: existing.name, subBrand: existing.subBrand },
      );

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] delete supplier error:", e.message);
      res.status(500).json({ error: "Failed to delete supplier" });
    }
  },
);

module.exports = router;
