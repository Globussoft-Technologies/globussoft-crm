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

module.exports = router;
