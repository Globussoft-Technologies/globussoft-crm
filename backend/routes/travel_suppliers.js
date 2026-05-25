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

// PRD_TRAVEL_SUPPLIER_MASTER #903 slice 1 — Indian GSTIN format validator.
// 15-char layout: 2-digit state code, 5 letters (PAN holder), 4 digits (PAN
// holder), 1 letter (PAN entity), 1 char [1-9A-Z] (entity-code), 'Z' literal,
// 1 alphanumeric (checksum). Strict format — no Luhn-style checksum verification
// (FR-3.1.a accepts format validation as sufficient for slice 1; deeper
// state-code-table + checksum validation deferred to PRD_TRAVEL_GST_COMPLIANCE).
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

function assertValidGstin(g) {
  if (g == null || g === "") return;
  if (!GSTIN_REGEX.test(String(g))) {
    const err = new Error(
      "gstin must be a 15-character Indian GSTIN (e.g. 27AAACR4849R1ZW)",
    );
    err.status = 400;
    err.code = "INVALID_GSTIN";
    throw err;
  }
}

function assertValidPaymentTerms(n) {
  if (n == null) return;
  // Accept numeric strings too — route boundary is JSON, but defensive.
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(v) || v < 0) {
    const err = new Error("paymentTermsDays must be a non-negative integer");
    err.status = 400;
    err.code = "INVALID_PAYMENT_TERMS";
    throw err;
  }
}

function assertValidCreditLimit(c) {
  if (c == null) return;
  // Prisma Decimal accepts string or number on the way in; we just need
  // to verify "finite, >= 0" at the route boundary.
  const v = typeof c === "number" ? c : Number(c);
  if (!Number.isFinite(v) || v < 0) {
    const err = new Error("creditLimit must be a non-negative number");
    err.status = 400;
    err.code = "INVALID_CREDIT_LIMIT";
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
        // Slice 1 (#903) — payment terms + credit-tracking + metadata.
        paymentTermsDays, creditLimit, creditCurrency, taxRegimeCode,
        primaryContactRole, notes,
      } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          error: "name required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidSupplierCategory(supplierCategory);
      assertValidGstin(gstin);
      assertValidPaymentTerms(paymentTermsDays);
      assertValidCreditLimit(creditLimit);
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
          paymentTermsDays: paymentTermsDays != null ? parseInt(paymentTermsDays, 10) : null,
          creditLimit: creditLimit != null ? String(creditLimit) : null,
          creditCurrency: creditCurrency ? String(creditCurrency) : undefined,
          taxRegimeCode: taxRegimeCode ? String(taxRegimeCode) : null,
          primaryContactRole: primaryContactRole ? String(primaryContactRole) : null,
          notes: notes ? String(notes) : null,
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
        // Slice 1 (#903) — payment terms + credit-tracking + metadata.
        paymentTermsDays, creditLimit, creditCurrency, taxRegimeCode,
        primaryContactRole, notes,
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
      if (gstin !== undefined) {
        assertValidGstin(gstin);
        data.gstin = gstin ? String(gstin) : null;
      }
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

      // Slice 1 (#903) — payment terms + credit-tracking patch fields.
      if (paymentTermsDays !== undefined) {
        assertValidPaymentTerms(paymentTermsDays);
        data.paymentTermsDays = paymentTermsDays != null ? parseInt(paymentTermsDays, 10) : null;
      }
      if (creditLimit !== undefined) {
        assertValidCreditLimit(creditLimit);
        data.creditLimit = creditLimit != null ? String(creditLimit) : null;
      }
      if (creditCurrency !== undefined) {
        data.creditCurrency = creditCurrency ? String(creditCurrency) : null;
      }
      if (taxRegimeCode !== undefined) {
        data.taxRegimeCode = taxRegimeCode ? String(taxRegimeCode) : null;
      }
      if (primaryContactRole !== undefined) {
        data.primaryContactRole = primaryContactRole ? String(primaryContactRole) : null;
      }
      if (notes !== undefined) {
        data.notes = notes ? String(notes) : null;
      }

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

// ─── Supplier-payable ledger (PRD_TRAVEL_BILLING UC-2.3 — #903 slice 3) ─
//
// CRUD scaffold for the A/P ledger. Each row tracks one obligation we owe
// to a single supplier (one PO / one booking reference).
//
// Status flow:  pending → scheduled → paid       (happy path)
//               pending → cancelled              (operator abort)
//               scheduled → cancelled            (operator abort)
//               * → paid                         (status='paid' auto-sets
//                                                  paidAt=now() if absent)
//
// Sub-brand isolation: inherited via the PARENT TravelSupplier — every
// list / create / update / delete first loads the parent and runs it
// through canAccessSubBrand(). Cross-tenant + sub-brand-denied surface as
// the parent's SUPPLIER_NOT_FOUND / SUB_BRAND_DENIED respectively.
//
// Error codes used by this block (in addition to the suppliers block):
//   INVALID_ID, SUPPLIER_NOT_FOUND, PAYABLE_NOT_FOUND, SUB_BRAND_DENIED,
//   MISSING_FIELDS, INVALID_AMOUNT, INVALID_STATUS, INVALID_DUE_DATE,
//   EMPTY_BODY.

const VALID_PAYABLE_STATUSES = ["pending", "scheduled", "paid", "cancelled"];

function assertValidPayableStatus(s) {
  if (s == null) return;
  if (!VALID_PAYABLE_STATUSES.includes(s)) {
    const err = new Error(`status must be one of: ${VALID_PAYABLE_STATUSES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

function assertValidPayableAmount(a) {
  if (a == null) return;
  // Prisma Decimal accepts string or number; validate "finite, >= 0".
  const v = typeof a === "number" ? a : Number(a);
  if (!Number.isFinite(v) || v < 0) {
    const err = new Error("amount must be a non-negative number");
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
}

function parseDueDateOrThrow(d) {
  if (d == null || d === "") return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) {
    const err = new Error("dueDate must be a valid ISO date / parseable date string");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return dt;
}

// Helper: load the parent supplier + enforce tenant + sub-brand access.
// Returns the supplier row on success; sends a response + returns null on failure.
async function loadParentSupplier(req, res) {
  const supplierId = parseInt(req.params.id, 10);
  if (!Number.isFinite(supplierId)) {
    res.status(400).json({ error: "supplier id must be a number", code: "INVALID_ID" });
    return null;
  }
  const supplier = await prisma.travelSupplier.findFirst({
    where: { id: supplierId, tenantId: req.travelTenant.id },
  });
  if (!supplier) {
    res.status(404).json({ error: "Supplier not found", code: "SUPPLIER_NOT_FOUND" });
    return null;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, supplier.subBrand)) {
    res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    return null;
  }
  return supplier;
}

// GET /api/travel/suppliers/:id/payables — list payables for one supplier.
// Optional ?status=pending|scheduled|paid|cancelled filter.
router.get(
  "/suppliers/:id/payables",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const where = { tenantId: req.travelTenant.id, supplierId: supplier.id };
      if (req.query.status) {
        assertValidPayableStatus(String(req.query.status));
        where.status = String(req.query.status);
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [payables, total] = await Promise.all([
        prisma.travelSupplierPayable.findMany({
          where,
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
          take,
          skip,
        }),
        prisma.travelSupplierPayable.count({ where }),
      ]);
      res.json({ payables, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] list payables error:", e.message);
      res.status(500).json({ error: "Failed to list payables" });
    }
  },
);

// POST /api/travel/suppliers/:id/payables — ADMIN/MANAGER only.
// Required: description, amount. Optional: poNumber, currency, dueDate, notes, status.
router.post(
  "/suppliers/:id/payables",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const {
        description, amount, poNumber, currency, dueDate, notes, status,
      } = req.body || {};

      if (!description || !String(description).trim() || amount == null) {
        return res.status(400).json({
          error: "description, amount required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidPayableAmount(amount);
      assertValidPayableStatus(status);
      const parsedDueDate = parseDueDateOrThrow(dueDate);

      const created = await prisma.travelSupplierPayable.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
          description: String(description).trim(),
          amount: String(amount),
          poNumber: poNumber ? String(poNumber) : null,
          currency: currency ? String(currency) : undefined,
          dueDate: parsedDueDate,
          notes: notes ? String(notes) : null,
          status: status || undefined,
        },
      });

      await writeAudit(
        "TravelSupplierPayable",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: supplier.id, amount: String(amount), status: created.status },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] create payable error:", e.message);
      res.status(500).json({ error: "Failed to create payable" });
    }
  },
);

// PUT /api/travel/suppliers/:id/payables/:payableId — ADMIN/MANAGER only.
// Partial update. Status='paid' auto-sets paidAt=now() if not already set.
router.put(
  "/suppliers/:id/payables/:payableId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const payableId = parseInt(req.params.payableId, 10);
      if (!Number.isFinite(payableId)) {
        return res.status(400).json({ error: "payable id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelSupplierPayable.findFirst({
        where: {
          id: payableId,
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
      });
      if (!existing) {
        return res.status(404).json({ error: "Payable not found", code: "PAYABLE_NOT_FOUND" });
      }

      const data = {};
      const {
        description, amount, poNumber, currency, dueDate, notes, status, paidAt,
      } = req.body || {};

      if (description !== undefined) {
        if (!String(description).trim()) {
          return res.status(400).json({
            error: "description must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.description = String(description).trim();
      }
      if (amount !== undefined) {
        assertValidPayableAmount(amount);
        data.amount = String(amount);
      }
      if (poNumber !== undefined) data.poNumber = poNumber ? String(poNumber) : null;
      if (currency !== undefined) data.currency = currency ? String(currency) : "INR";
      if (dueDate !== undefined) {
        data.dueDate = parseDueDateOrThrow(dueDate);
      }
      if (notes !== undefined) data.notes = notes ? String(notes) : null;
      if (status !== undefined) {
        assertValidPayableStatus(status);
        data.status = status;
        // Auto-set paidAt when transitioning to 'paid' (and the caller
        // didn't supply one). Operator can still override with explicit paidAt.
        if (status === "paid" && paidAt === undefined && !existing.paidAt) {
          data.paidAt = new Date();
        }
      }
      if (paidAt !== undefined) {
        data.paidAt = paidAt ? parseDueDateOrThrow(paidAt) : null;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelSupplierPayable.update({
        where: { id: payableId },
        data,
      });

      await writeAudit(
        "TravelSupplierPayable",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: supplier.id, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] update payable error:", e.message);
      res.status(500).json({ error: "Failed to update payable" });
    }
  },
);

// DELETE /api/travel/suppliers/:id/payables/:payableId — ADMIN/MANAGER only.
// Hard delete (no soft-delete column on the model — payables that were
// cancelled but the operator wants to keep audit history can flip
// status='cancelled' instead of issuing DELETE).
router.delete(
  "/suppliers/:id/payables/:payableId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const payableId = parseInt(req.params.payableId, 10);
      if (!Number.isFinite(payableId)) {
        return res.status(400).json({ error: "payable id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelSupplierPayable.findFirst({
        where: {
          id: payableId,
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
      });
      if (!existing) {
        return res.status(404).json({ error: "Payable not found", code: "PAYABLE_NOT_FOUND" });
      }

      await prisma.travelSupplierPayable.delete({ where: { id: payableId } });

      await writeAudit(
        "TravelSupplierPayable",
        "DELETE",
        payableId,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: supplier.id, amount: String(existing.amount), status: existing.status },
      );

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] delete payable error:", e.message);
      res.status(500).json({ error: "Failed to delete payable" });
    }
  },
);

// ============================================================================
// GET /api/travel/payables — cross-supplier consolidated payables endpoint
// (Arc 2 #903 slice 5 — PRD_TRAVEL_BILLING UC-2.5 Aged Payables month-end close).
//
// Replaces the per-supplier fan-out in frontend/src/pages/travel/Payables.jsx
// (TODO marker `#903 slice 6`). Previously the page hit /api/travel/suppliers
// THEN /suppliers/:id/payables once per supplier (O(N) requests); this slice
// ships the consolidated read so the page can do ONE request.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees payables for suppliers in their allowed sub-brands.
//
// Query params (all optional):
//   ?status=pending|scheduled|paid|cancelled       — filter (default: all)
//   ?supplierCategory=hotel|flight|transport|      — filter via join on
//                       visa-consul|other            TravelSupplier
//   ?subBrand=tmc|rfu|travelstall|visasure         — filter to one sub-brand
//                                                    (within the caller's
//                                                    allowed set; outside-
//                                                    allowed → empty)
//   ?dueBefore=ISODate                             — dueDate <= input
//   ?dueAfter=ISODate                              — dueDate >= input
//   ?limit=N (default 100, clamped to [1, 500]).
//   ?offset=N (default 0).
//
// Response shape:
//   {
//     payables: [
//       { id, supplierId, supplierName, supplierCategory, subBrand,
//         poNumber, description, amount, currency, dueDate, status,
//         paidAt, daysUntilDue, createdAt }
//     ],
//     total,
//     limit,
//     offset,
//     summary: {
//       byStatus: { pending: <int>, scheduled, paid, cancelled },
//       totalPending: "<decimal-string>",
//       totalScheduled: "<decimal-string>",
//       totalPaid: "<decimal-string>",
//       currencyBreakdown: { INR: "<decimal-string>", USD: "..." }
//     }
//   }
//
// Decisions:
//   - daysUntilDue is JS-computed (Math.floor((due - now) / 86_400_000)).
//     Negative ⇒ overdue. NULL dueDate ⇒ daysUntilDue is null.
//   - Sub-brand filtering joins through the parent supplier via
//     supplier.is.subBrand (nested filter). Mirrors travel_invoices.js
//     slice-7 `/payment-schedules/upcoming` (e4832fee) — restricted callers
//     get a {in:[...allowed]} pushed in; forbidden ?subBrand silently
//     substitutes "__none__" rather than 403'ing (consistent with the
//     existing /invoices + /payment-schedules/upcoming patterns).
//   - Summary is computed across the SAME page returned (post-limit/offset),
//     not the full unpaginated set — operator pagers want current-page
//     totals. Callers wanting full-population totals iterate pages or pass
//     limit=500.
//   - totalPending/Scheduled/Paid + currencyBreakdown emit as decimal
//     STRINGS (toFixed(2)) for Prisma Decimal-string compatibility.
//   - Error codes: INVALID_STATUS, INVALID_SUPPLIER_CATEGORY,
//     INVALID_SUB_BRAND, INVALID_DATE, INVALID_LIMIT.
// ============================================================================

const PAYABLES_MAX_LIMIT = 500;
const PAYABLES_DEFAULT_LIMIT = 100;

function parsePayablesLimit(input) {
  if (input == null || input === "") return PAYABLES_DEFAULT_LIMIT;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("limit must be a positive integer");
    err.status = 400;
    err.code = "INVALID_LIMIT";
    throw err;
  }
  return Math.min(v, PAYABLES_MAX_LIMIT);
}

function parsePayablesOffset(input) {
  if (input == null || input === "") return 0;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 0) return 0;
  return v;
}

function parseDateBoundOrThrow(d, label) {
  if (d == null || d === "") return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) {
    const err = new Error(`${label} must be a valid ISO date / parseable date string`);
    err.status = 400;
    err.code = "INVALID_DATE";
    throw err;
  }
  return dt;
}

// Add two decimal strings safely (same shape as slice-7 addDecimal). Both
// inputs normalised to Number, summed, then toFixed(2). For the scales
// here (per-tenant monthly payables totals — well below 1e15) Number
// precision is fine; the toFixed sidesteps display artefacts.
function addPayableDecimal(a, b) {
  const x = Number(a == null ? 0 : a);
  const y = Number(b == null ? 0 : b);
  return (x + y).toFixed(2);
}

router.get(
  "/payables",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      if (status) assertValidPayableStatus(status);

      const supplierCategory = req.query.supplierCategory
        ? String(req.query.supplierCategory)
        : null;
      if (supplierCategory) assertValidSupplierCategory(supplierCategory);

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const dueBefore = parseDateBoundOrThrow(req.query.dueBefore, "dueBefore");
      const dueAfter = parseDateBoundOrThrow(req.query.dueAfter, "dueAfter");

      const limit = parsePayablesLimit(req.query.limit);
      const offset = parsePayablesOffset(req.query.offset);

      const where = { tenantId: req.travelTenant.id };
      if (status) where.status = status;

      if (dueBefore || dueAfter) {
        where.dueDate = {};
        if (dueBefore) where.dueDate.lte = dueBefore;
        if (dueAfter) where.dueDate.gte = dueAfter;
      }

      // Sub-brand + supplierCategory filtering joins through the parent
      // supplier. Prisma can't filter on a related field's column inside
      // a top-level findMany where-clause without `is:` — use the nested
      // filter shape. Same pattern as travel_invoices.js slice-7.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const supplierFilter = {};
      if (subBrand) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrand)) {
          // Filter requested a sub-brand the caller can't see — return
          // empty silently (consistent with /payment-schedules/upcoming).
          supplierFilter.subBrand = "__none__";
        } else {
          supplierFilter.subBrand = subBrand;
        }
      } else if (allowed !== null) {
        supplierFilter.subBrand =
          allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }
      if (supplierCategory) supplierFilter.supplierCategory = supplierCategory;
      if (Object.keys(supplierFilter).length > 0) {
        where.supplier = { is: supplierFilter };
      }

      const [rows, total] = await Promise.all([
        prisma.travelSupplierPayable.findMany({
          where,
          include: {
            supplier: {
              select: { name: true, supplierCategory: true, subBrand: true },
            },
          },
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.travelSupplierPayable.count({ where }),
      ]);

      const now = new Date();
      const nowMs = now.getTime();
      const payables = rows.map((r) => {
        const dueMs =
          r.dueDate instanceof Date
            ? r.dueDate.getTime()
            : r.dueDate
              ? new Date(r.dueDate).getTime()
              : null;
        const daysUntilDue =
          dueMs == null ? null : Math.floor((dueMs - nowMs) / 86_400_000);
        return {
          id: r.id,
          supplierId: r.supplierId,
          supplierName: r.supplier ? r.supplier.name : null,
          supplierCategory: r.supplier ? r.supplier.supplierCategory : null,
          subBrand: r.supplier ? r.supplier.subBrand : null,
          poNumber: r.poNumber,
          description: r.description,
          amount: r.amount,
          currency: r.currency,
          dueDate: r.dueDate,
          status: r.status,
          paidAt: r.paidAt,
          daysUntilDue,
          createdAt: r.createdAt,
        };
      });

      // Summary aggregates over the returned page (see header note).
      const byStatus = { pending: 0, scheduled: 0, paid: 0, cancelled: 0 };
      const currencyBreakdown = {};
      let totalPending = "0.00";
      let totalScheduled = "0.00";
      let totalPaid = "0.00";
      for (const p of payables) {
        if (Object.prototype.hasOwnProperty.call(byStatus, p.status)) {
          byStatus[p.status] += 1;
        } else {
          byStatus[p.status] = (byStatus[p.status] || 0) + 1;
        }
        if (p.status === "pending") {
          totalPending = addPayableDecimal(totalPending, p.amount);
        } else if (p.status === "scheduled") {
          totalScheduled = addPayableDecimal(totalScheduled, p.amount);
        } else if (p.status === "paid") {
          totalPaid = addPayableDecimal(totalPaid, p.amount);
        }
        const cur = p.currency || "INR";
        currencyBreakdown[cur] = addPayableDecimal(
          currencyBreakdown[cur] || "0.00",
          p.amount,
        );
      }

      res.json({
        payables,
        total,
        limit,
        offset,
        summary: {
          byStatus,
          totalPending,
          totalScheduled,
          totalPaid,
          currencyBreakdown,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] cross-supplier payables error:", e.message);
      res.status(500).json({ error: "Failed to list payables" });
    }
  },
);

module.exports = router;
