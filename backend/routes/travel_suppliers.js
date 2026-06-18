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
const { requirePermission } = require("../middleware/requirePermission");
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
  requireTravelTenant,
  requirePermission("suppliers", "read"),
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
  requireTravelTenant,
  requirePermission("suppliers", "manage"),
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
  requireTravelTenant,
  requirePermission("suppliers", "read"),
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
  requireTravelTenant,
  requirePermission("suppliers", "manage"),
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
  requireTravelTenant,
  requirePermission("suppliers", "manage"),
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
  requireTravelTenant,
  requirePermission("suppliers", "manage"),
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
  requireTravelTenant,
  requirePermission("suppliers", "read"),
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
const listProjection = require("../lib/listProjection");

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

// PRD_TRAVEL_SUPPLIER_MASTER G040 — status enum.
// Values map to operator-facing governance states:
//   active           — default, listed in pickers, can be booked against.
//   paused           — temporarily off-limits (e.g. vendor on vacation). MANAGER+ may pause/reactivate.
//   blocked_disputed — open chargeback / dispute, blocked from new POs. ADMIN-only flip + reason required.
//   archived         — terminal soft-delete (replaces isActive=false). ADMIN-only.
const VALID_SUPPLIER_STATUSES = ["active", "paused", "blocked_disputed", "archived"];

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_SUPPLIER_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_SUPPLIER_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

// Derive the legacy isActive flag from the new status enum. Active → true;
// every non-active state → false (paused / blocked_disputed / archived all
// hide the supplier from default pickers).
function deriveIsActive(status) {
  return status === "active";
}

// PRD_TRAVEL_SUPPLIER_MASTER G041 — payment-terms kind enum.
const VALID_PAYMENT_TERMS_KINDS = ["net", "prepay", "on_departure", "on_arrival"];

function assertValidPaymentTermsKind(k) {
  if (k == null) return;
  if (!VALID_PAYMENT_TERMS_KINDS.includes(k)) {
    const err = new Error(
      `paymentTermsKind must be one of: ${VALID_PAYMENT_TERMS_KINDS.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_PAYMENT_TERMS_KIND";
    throw err;
  }
}

// GET /api/travel/suppliers
// Honors ?subBrand=tmc (filter to that sub-brand) and ?includeInactive=1.
// GET /api/travel/suppliers
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction).
// Default shape unchanged (full TravelSupplier row including supplier
// PII — contactPerson, phone, email, gstin, addressLine, paymentTermsDays,
// creditLimit, notes). Pass `?fields=summary` to opt into the slim
// projection (id + subBrand + name + supplierCategory + isActive +
// createdAt) — picker / dashboard-tile callers don't need supplier
// PII. The detail endpoint GET /suppliers/:id surfaces the full row.
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

    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: [{ subBrand: "asc" }, { supplierCategory: "asc" }, { name: "asc" }],
      take,
      skip,
    };
    if (isSummary) {
      findManyArgs.select = listProjection("TravelSupplier", false);
    }
    const [suppliers, total] = await Promise.all([
      prisma.travelSupplier.findMany(findManyArgs),
      prisma.travelSupplier.count({ where }),
    ]);
    res.json({ suppliers, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-sup] list suppliers error:", e.message);
    res.status(500).json({ error: "Failed to list suppliers" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/travel/suppliers/search — autocomplete picker (Arc 2 #903 slice 10)
//
// Operator-facing supplier picker for quote-line / invoice-line forms.
// Returns the top-N suppliers whose name CONTAINS the query token (case-
// insensitive). Top-10 default, max 50, alphabetical sort by name.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees suppliers in their allowed sub-brands.
//
// MUST be registered BEFORE `GET /suppliers/:id` — Express matches routes in
// declaration order, and the literal "search" token would otherwise be
// consumed by the :id param (yielding 400 INVALID_ID since parseInt("search")
// is NaN). Placement here keeps the slice atomic at this insertion point.
//
// Query params:
//   q                  required, 1..100 chars  — search needle (case-insensitive contains)
//   subBrand           optional                — narrow to one sub-brand
//   supplierCategory   optional, whitelist     — narrow by category
//   limit              optional, default 10    — clamped to [1, 50]
//
// Response shape:
//   { suppliers: [{ id, name, supplierCategory, subBrand, email, phone }], total }
//
// Decisions:
//   - CONTAINS (not prefix-only): operators searching "hilton" should find
//     "Grand Hilton" and "Hilton Mumbai" both. Prefix-only would miss the
//     former. Same UX shape as Gmail / Slack contact pickers.
//   - Case-insensitive: relies on Prisma's `mode: 'insensitive'` on `contains`
//     — supported on PostgreSQL natively and on MySQL via collation
//     (utf8mb4_general_ci default is case-insensitive, so the mode flag is
//     essentially a no-op on MySQL but harmless and forward-compatible).
//   - Only returns isActive=true rows — soft-deleted suppliers should not
//     appear in pickers. The full list endpoint already filters this way
//     by default; the picker has no opt-out (no ?includeInactive).
//   - Slim projection: id + name + supplierCategory + subBrand + email + phone.
//     Picker UI does NOT need gstin / paymentTermsDays / creditLimit; keeping
//     the wire payload tight matters for tenants with hundreds of suppliers.
//   - Error codes: INVALID_QUERY, INVALID_SUPPLIER_CATEGORY (re-uses the
//     existing helper's code), INVALID_SUB_BRAND, INVALID_LIMIT.
// ────────────────────────────────────────────────────────────────────────

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_Q_LEN = 100;

function parseSearchLimitOrThrow(input) {
  if (input == null || input === "") return SEARCH_DEFAULT_LIMIT;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("limit must be a positive integer");
    err.status = 400;
    err.code = "INVALID_LIMIT";
    throw err;
  }
  return Math.min(v, SEARCH_MAX_LIMIT);
}

router.get(
  "/suppliers/search",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const q = req.query.q != null ? String(req.query.q) : "";
      if (q.length < 1 || q.length > SEARCH_MAX_Q_LEN) {
        return res.status(400).json({
          error: `q must be 1..${SEARCH_MAX_Q_LEN} characters`,
          code: "INVALID_QUERY",
        });
      }

      const supplierCategory = req.query.supplierCategory
        ? String(req.query.supplierCategory)
        : null;
      if (supplierCategory) assertValidSupplierCategory(supplierCategory);

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const limit = parseSearchLimitOrThrow(req.query.limit);

      const where = {
        tenantId: req.travelTenant.id,
        isActive: true,
        name: { contains: q, mode: "insensitive" },
      };
      if (supplierCategory) where.supplierCategory = supplierCategory;
      if (subBrand) where.subBrand = subBrand;

      // Sub-brand access narrowing — same pattern as the /suppliers list.
      // If the caller requested a sub-brand they can't access, substitute
      // "__none__" so the query returns empty rather than 403'ing.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed !== null) {
        if (where.subBrand) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__";
          }
        } else {
          where.subBrand = allowed.size > 0 ? { in: [...allowed] } : "__none__";
        }
      }

      const suppliers = await prisma.travelSupplier.findMany({
        where,
        select: {
          id: true,
          name: true,
          supplierCategory: true,
          subBrand: true,
          email: true,
          phone: true,
        },
        orderBy: { name: "asc" },
        take: limit,
      });
      res.json({ suppliers, total: suppliers.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] search suppliers error:", e.message);
      res.status(500).json({ error: "Failed to search suppliers" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/exposure — per-supplier credit-utilization summary
// (Arc 2 #903 slice 11 — PRD_TRAVEL_SUPPLIER_MASTER §3.1.c credit limit
// + §3.7.a credit-utilization gauge + §3.7.b suppliers-index sortable-by-
// -exposure).
//
// Realizes the "which of my N suppliers are near limit?" operator question
// in one round-trip. Natural follow-on to slice 5 (/payables cross-supplier
// list) + slice 8 (/payables/aging buckets) — same aggregation surface,
// different keying: payables grouped by SUPPLIER rather than by status
// bucket or due-date window.
//
// MUST be registered BEFORE `GET /suppliers/:id` — Express matches routes in
// declaration order, and the literal "exposure" token would otherwise be
// consumed by the :id param (yielding 400 INVALID_ID since
// parseInt("exposure") is NaN). Mirrors the placement of /suppliers/search
// (slice 10) which is also a sub-path under /suppliers.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees suppliers in their allowed sub-brands.
//
// Query params (all optional):
//   ?subBrand=tmc|rfu|travelstall|visasure         — filter to one sub-brand
//                                                    (within the caller's
//                                                    allowed set; outside-
//                                                    allowed → empty)
//   ?supplierCategory=hotel|flight|transport|      — filter by category
//                       visa-consul|other
//   ?includeInactive=1                             — include soft-deleted
//                                                    suppliers (default off)
//   ?nearLimitOnly=1                               — return only suppliers
//                                                    with utilization >= 0.8
//                                                    (80% threshold, the
//                                                    "needs attention" cohort)
//
// Response shape:
//   {
//     suppliers: [
//       { id, name, supplierCategory, subBrand,
//         creditLimit, creditCurrency,
//         openExposure,            // sum of pending+scheduled payable amounts
//         utilization,             // openExposure / creditLimit (null if no limit)
//         openPayableCount,        // # of pending+scheduled payables
//         status,                  // 'ok' | 'near-limit' | 'over-limit' | 'no-limit'
//         isActive,
//       },
//       ...
//     ],
//     total,
//     summary: {
//       overLimitCount,
//       nearLimitCount,           // 80% <= util <= 100%
//       totalExposure,            // grand-total across returned suppliers
//     }
//   }
//
// Decisions:
//   - openExposure = sum(amount) over payables where status IN ('pending',
//     'scheduled'). Paid + cancelled excluded (settled / voided liabilities
//     don't consume credit). Same semantics as payableAging.js exclusion rules.
//   - utilization rounded to 4dp (half-up) so the UI gauge can render
//     percentages cleanly: 0.8421 → "84.21%". null when creditLimit is null
//     or 0 (we don't divide-by-zero).
//   - status 'over-limit' fires at utilization > 1.0 (strictly greater —
//     a utilization of exactly 1.0 is "at-limit", still 'near-limit'). The
//     PRD §3.3.e booking-confirm hard-block is (current owed + new PO) >
//     limit — for the dashboard surface, > limit is the alarm threshold.
//   - nearLimitOnly=1 filters in JS (post-aggregate) rather than in SQL,
//     because utilization is computed from BOTH sides (limit + sum) — a
//     SQL-side filter would need a subquery + HAVING; the JS-side filter
//     keeps the route shape simple and works correctly across the typical
//     50-500 suppliers-per-tenant scale.
//   - Sorted: openExposure DESC then name ASC (biggest debts first; ties
//     broken alphabetically). Operators reading top-to-bottom see the
//     highest-priority suppliers first.
//   - Sub-brand filtering pattern mirrors /payables (slice 5) + /payables/
//     aging (slice 8): joins through supplier.subBrand at the WHERE level,
//     restricted callers requesting a sub-brand they can't see get
//     "__none__" substituted (silent empty rather than 403).
//   - Error codes: INVALID_SUB_BRAND, INVALID_SUPPLIER_CATEGORY.
// ============================================================================

const EXPOSURE_MAX_SUPPLIERS = 1_000;
const NEAR_LIMIT_THRESHOLD = 0.8;

function round2Exposure(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function round4Exposure(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

router.get(
  "/suppliers/exposure",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const supplierCategory = req.query.supplierCategory
        ? String(req.query.supplierCategory)
        : null;
      if (supplierCategory) assertValidSupplierCategory(supplierCategory);

      const includeInactive =
        req.query.includeInactive === "1" || req.query.includeInactive === "true";
      const nearLimitOnly =
        req.query.nearLimitOnly === "1" || req.query.nearLimitOnly === "true";

      // Supplier where-clause + sub-brand access narrowing (same pattern as
      // /suppliers list + /payables + /payables/aging).
      const where = { tenantId: req.travelTenant.id };
      if (!includeInactive) where.isActive = true;
      if (supplierCategory) where.supplierCategory = supplierCategory;

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (subBrand) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrand)) {
          where.subBrand = "__none__";
        } else {
          where.subBrand = subBrand;
        }
      } else if (allowed !== null) {
        where.subBrand = allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }

      const suppliers = await prisma.travelSupplier.findMany({
        where,
        select: {
          id: true,
          name: true,
          supplierCategory: true,
          subBrand: true,
          creditLimit: true,
          creditCurrency: true,
          isActive: true,
        },
        orderBy: { name: "asc" },
        take: EXPOSURE_MAX_SUPPLIERS,
      });

      if (suppliers.length === 0) {
        return res.json({
          suppliers: [],
          total: 0,
          summary: { overLimitCount: 0, nearLimitCount: 0, totalExposure: 0 },
        });
      }

      // Aggregate open exposure per supplier via groupBy. status ∈
      // {pending, scheduled} are the unsettled liabilities that consume
      // credit; paid + cancelled are excluded.
      const supplierIds = suppliers.map((s) => s.id);
      const grouped = await prisma.travelSupplierPayable.groupBy({
        by: ["supplierId"],
        where: {
          tenantId: req.travelTenant.id,
          supplierId: { in: supplierIds },
          status: { in: ["pending", "scheduled"] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      });

      // Build a quick lookup: supplierId → { sum, count }
      const exposureBySupplierId = new Map();
      for (const g of grouped) {
        exposureBySupplierId.set(g.supplierId, {
          sum: g._sum && g._sum.amount != null ? Number(g._sum.amount) : 0,
          count: g._count && g._count._all != null ? g._count._all : 0,
        });
      }

      let overLimitCount = 0;
      let nearLimitCount = 0;
      let totalExposure = 0;

      const rows = suppliers.map((s) => {
        const exposure = exposureBySupplierId.get(s.id) || { sum: 0, count: 0 };
        const openExposure = round2Exposure(exposure.sum);
        const limitNum =
          s.creditLimit == null ? null : Number(s.creditLimit);
        const hasLimit = limitNum != null && Number.isFinite(limitNum) && limitNum > 0;
        const utilization = hasLimit ? round4Exposure(openExposure / limitNum) : null;

        let status;
        if (!hasLimit) {
          status = "no-limit";
        } else if (utilization > 1) {
          status = "over-limit";
        } else if (utilization >= NEAR_LIMIT_THRESHOLD) {
          status = "near-limit";
        } else {
          status = "ok";
        }

        if (status === "over-limit") overLimitCount++;
        else if (status === "near-limit") nearLimitCount++;

        totalExposure = round2Exposure(totalExposure + openExposure);

        return {
          id: s.id,
          name: s.name,
          supplierCategory: s.supplierCategory,
          subBrand: s.subBrand,
          creditLimit: limitNum,
          creditCurrency: s.creditCurrency || "INR",
          openExposure,
          utilization,
          openPayableCount: exposure.count,
          status,
          isActive: s.isActive,
        };
      });

      // Sort by exposure DESC then name ASC (post-aggregate — Prisma
      // can't sort by a computed sum natively).
      rows.sort((a, b) => {
        if (b.openExposure !== a.openExposure) return b.openExposure - a.openExposure;
        return a.name.localeCompare(b.name);
      });

      // Optional near-limit filter (post-aggregate; see header decision note).
      const filtered = nearLimitOnly
        ? rows.filter((r) => r.status === "near-limit" || r.status === "over-limit")
        : rows;

      res.json({
        suppliers: filtered,
        total: filtered.length,
        summary: {
          overLimitCount,
          nearLimitCount,
          totalExposure,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] exposure error:", e.message);
      res.status(500).json({ error: "Failed to build supplier exposure summary" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/stats — tenant-wide supplier rollup
// (PRD_TRAVEL_SUPPLIER_MASTER §3 #903 slice 23).
//
// Mirrors #905 slice 18 /commission-profiles/stats + #908 slice 19
// /flyer-templates/global-stats. USER-readable anodyne aggregate. Powers
// the Supplier Master library page's header summary strip ("42 suppliers
// · 35 active · 7 archived · 18 hotels · 12 flights ... · ₹4.2L payables ·
// last activity 3h ago"). Without this, the frontend has to fire {list,
// count by category×5, count by subBrand×4, /payables count + sum} —
// N+1 round-trips for a single visual surface.
//
// Distinct from /:id/payables/{month,quarter,year} (per-supplier time
// series), /suppliers/exposure (per-supplier credit-utilization), and
// /:id/scorecard (per-supplier KPI page). This is the tenant-wide rollup
// across BOTH the supplier-count summary (status + category + sub-brand)
// AND the payable-derived activity (count + sum + paid-sum + lastActivityAt).
//
// PRD anchors:
//   - §3 — operator-facing supplier dashboard surfaces "how many
//          suppliers do I have, of what shape, with what payable burden" —
//          this endpoint feeds those KPI tiles
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' suppliers in the counts. Same gate as
//     the /suppliers list endpoint. TravelSupplier.subBrand is
//     non-nullable in the schema, but the bucketing code defensively
//     coalesces null/empty → '_tenant' for forward-compat (and to match
//     the sibling /commission-profiles/stats shape, where subBrand IS
//     nullable).
//   - Supplier-count rollup (from prisma.travelSupplier.findMany):
//       total, active, archived             — overall + by isActive
//       bySubBrand: { <sb|_tenant>: { count } }
//       byCategory: { <cat>: { count } }    — using TravelSupplier.supplierCategory
//   - Payable-derived activity (from prisma.travelSupplierPayable findMany over
//     supplierId IN visibleSet):
//       totalPayables                       — count of all payable rows
//       totalPayableAmount                  — sum of amount (defensive null→0)
//       paidPayableAmount                   — sum where paidAt non-null
//       lastActivityAt                      — max(updatedAt) across all
//                                             matching suppliers
//   - ?from / ?to (ISO date bounds) filter supplier.createdAt before aggregation.
//
// Safety cap: process at most 2000 suppliers per call; if matching total >
// 2000, return counts but mark aggregateExceedsCap=true (payable sums
// would be incomplete past the cap).
//
// USER-readable: anodyne aggregate (counts + sums + timestamps); safe.
// No audit row: read-only meta surface, mirrors /commission-profiles/stats.
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would 400 INVALID_ID before reaching this
// handler.
// ============================================================================
const SUPPLIERS_STATS_CAP = 2000;

router.get(
  "/suppliers/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const tenantId = req.travelTenant.id;

      // Optional ISO date bounds on supplier.createdAt
      const supplierWhere = { tenantId };
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        supplierWhere.createdAt = Object.assign(
          supplierWhere.createdAt || {},
          { gte: d },
        );
      }
      if (toRaw) {
        const d = new Date(toRaw);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        supplierWhere.createdAt = Object.assign(
          supplierWhere.createdAt || {},
          { lte: d },
        );
      }

      // Sub-brand narrowing — same gate as the /suppliers list endpoint.
      // MANAGER subBrandAccess restricts the visible-set BEFORE counting.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          supplierWhere.subBrand = { in: [...allowed] };
        } else {
          // Empty allowed set = deny everything; force-empty query.
          supplierWhere.subBrand = "__none__";
        }
      }

      // Bounded fetch to keep in-process aggregation safe.
      const suppliers = await prisma.travelSupplier.findMany({
        where: supplierWhere,
        select: {
          id: true,
          subBrand: true,
          supplierCategory: true,
          isActive: true,
          updatedAt: true,
        },
        orderBy: [{ id: "asc" }],
        take: SUPPLIERS_STATS_CAP,
      });

      // Get the true total so callers know if aggregation is bounded.
      const totalMatching = await prisma.travelSupplier.count({
        where: supplierWhere,
      });
      const aggregateExceedsCap = totalMatching > SUPPLIERS_STATS_CAP;

      // Empty short-circuit — return zeroed shape.
      if (suppliers.length === 0) {
        return res.json({
          total: 0,
          active: 0,
          archived: 0,
          bySubBrand: {},
          byCategory: {},
          totalPayables: 0,
          totalPayableAmount: 0,
          paidPayableAmount: 0,
          lastActivityAt: null,
          aggregateExceedsCap: false,
        });
      }

      // Counts overall + per-bucket pre-seeding (so categories/sub-brands
      // with zero payables still appear with count populated).
      let active = 0;
      let archived = 0;
      let lastActivityAt = null;
      const bySubBrand = {};
      const byCategory = {};

      for (const s of suppliers) {
        if (s.isActive) active += 1;
        else archived += 1;

        const ts = s.updatedAt instanceof Date ? s.updatedAt : new Date(s.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
        }

        // TravelSupplier.subBrand is non-nullable in schema, but defensively
        // coalesce falsy → '_tenant' to match the sibling stats endpoint
        // shape and forward-compat with any future nullable migration.
        const sbKey = s.subBrand ? String(s.subBrand) : "_tenant";
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
        bySubBrand[sbKey].count += 1;

        const catKey = s.supplierCategory || "other";
        if (!byCategory[catKey]) byCategory[catKey] = { count: 0 };
        byCategory[catKey].count += 1;
      }

      // Payable-derived aggregation. groupBy isn't ideal here — we just
      // need the sum + paid-subset-sum + count across ALL payables for the
      // visible supplier set, plus we want the per-row paidAt check.
      // findMany keeps the math straightforward.
      const supplierIds = suppliers.map((s) => s.id);
      const payables = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId,
          supplierId: { in: supplierIds },
        },
        select: { id: true, amount: true, paidAt: true },
      });

      // Half-up round to 2dp — matches sibling stats endpoints.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      let totalPayableAmount = 0;
      let paidPayableAmount = 0;
      for (const p of payables) {
        const amt = Number(p.amount);
        if (!Number.isFinite(amt)) continue; // defensive null/invalid → 0
        totalPayableAmount += amt;
        if (p.paidAt != null) paidPayableAmount += amt;
      }

      res.json({
        total: suppliers.length,
        active,
        archived,
        bySubBrand,
        byCategory,
        totalPayables: payables.length,
        totalPayableAmount: round2(totalPayableAmount),
        paidPayableAmount: round2(paidPayableAmount),
        lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
        aggregateExceedsCap,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] stats error:", e.message);
      res.status(500).json({ error: "Failed to summarise suppliers" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/by-month — tenant-wide supplier monthly rollup
// (PRD_TRAVEL_SUPPLIER_MASTER §3 #903 slice 24).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-MM bucket for
// the tenant-scoped (and sub-brand-narrowed) supplier population. Each row
// carries count + activeCount + archivedCount so the operator dashboard
// can render a "suppliers onboarded over time" trend chart without N
// round-trips per month.
//
// Mirrors #908 slice 21 (/flyer-templates/by-month) + #900 slice 16
// (/quotes/by-month) + #901 slice 29 (/invoices/by-month) — same UTC
// YYYY-MM bucketing template, same defensive math (null/invalid
// createdAt → "unknown" bucket; excluded when ?from / ?to is set, kept
// otherwise so count surface stays accurate), same orderBy semantics. The
// activeCount/archivedCount split is the supplier-master analogue of the
// flyer-templates active-vs-archived breakdown — suppliers flip between
// active and archived via the soft-delete handler and the activate/
// deactivate endpoints, and the rollup makes the "lifetime population vs.
// currently-active" delta visible at a glance.
//
// Distinct from /suppliers/stats (slice 23): /stats is a single
// point-in-time KPI tile (total / active / archived / bySubBrand /
// byCategory / payable sums); /by-month is the per-month time series
// across the same population. The two endpoints powering the same
// Supplier Master library page header — /stats for the KPI strip,
// /by-month for the trend chart.
//
// PRD anchors:
//   - §3 — tenant-wide supplier analytics (trend chart for the
//          supplier-master dashboard; per-month drill-down picker)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-MM bounds; invalid →
//                     400 INVALID_MONTH_FORMAT
//   - ?orderBy      — default month:asc; accepts month:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 60
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' suppliers in the rollup. Same gate as
//     /suppliers/stats — TravelSupplier.subBrand is NON-nullable in the
//     schema, so we do NOT add a `{ subBrand: null }` OR clause (which
//     #908 slice 21 does for flyer-templates whose subBrand IS nullable).
//     Empty access set → forces `subBrand: "__none__"` so the query
//     returns the zero-rollup envelope (not 403) and the dashboard tile
//     renders cleanly for not-yet-onboarded operators.
//   - JS-side aggregation over a light findMany projection
//     ({ isActive, createdAt }) — the population is bounded by tenant
//     scale (low thousands), and the mock-friendly JS aggregation matches
//     the rationale on /flyer-templates/by-month + /quotes/by-month +
//     /suppliers/stats. No groupBy for marginal efficiency.
//   - "unknown" bucket: rows with null/invalid createdAt land here so the
//     count surface stays accurate. Excluded when ?from / ?to is set
//     (no comparable month token); included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter — same
//     posture as /flyer-templates/by-month slice 21.
//
// No audit row written — read-only meta surface; matches /suppliers/stats
// and /flyer-templates/by-month posture. USER-readable: anodyne (counts +
// month-string tokens).
//
// Express route ordering: literal-path /by-month MUST be declared BEFORE
// the /:id family or `:id="by-month"` would 400 INVALID_ID before
// reaching this handler. Same convention as /suppliers/search,
// /suppliers/exposure, /suppliers/stats.
// ============================================================================
router.get(
  "/suppliers/by-month",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

      // YYYY-MM validation — mirrors slice 21 /flyer-templates/by-month.
      const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }
      if (toRaw !== null && !MONTH_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-MM format",
          code: "INVALID_MONTH_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "month:asc",
        "month:desc",
        "count:asc",
        "count:desc",
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors /suppliers/stats
      // slice 23: subBrand-restricted callers see only their allowed
      // sub-brands' suppliers; admins (allowed=null) see all. Empty
      // allowed set returns the zero-rollup envelope (not 403).
      //
      // Note: TravelSupplier.subBrand is NON-nullable, so we do NOT mix
      // in a `{ subBrand: null }` OR clause (that's the flyer-templates
      // pattern, where subBrand IS nullable). The narrowing is a pure
      // `subBrand: { in: [...allowed] }`.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          // Empty allowed set = deny everything; force-empty query so
          // the response stays a clean zero-rollup envelope.
          where.subBrand = "__none__";
        }
      }

      // Light projection — isActive + createdAt is enough for the bucket
      // totals. No JSON columns pulled.
      const rows = await prisma.travelSupplier.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-month. Map "YYYY-MM" → { count, activeCount,
      // archivedCount }. Null/invalid createdAt rows land in "unknown".
      const byMonth = new Map();
      for (const r of rows) {
        let monthKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
            monthKey = `${yyyy}-${mm}`;
          }
        }

        let bucket = byMonth.get(monthKey);
        if (!bucket) {
          bucket = {
            month: monthKey,
            count: 0,
            activeCount: 0,
            archivedCount: 0,
          };
          byMonth.set(monthKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let months = [...byMonth.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. Mirrors slice 21 /flyer-templates/by-month.
      if (fromRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
      }
      if (toRaw !== null) {
        months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
      }

      // Sort. "month" sorts lexicographically on YYYY-MM (also
      // chronological). "unknown" sorts last in asc / first in desc
      // (lexicographically > "9999-12") — acceptable for a defensive
      // fallback bucket that should rarely appear.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      months.sort((a, b) => {
        if (field === "month") {
          if (a.month < b.month) return -1 * mult;
          if (a.month > b.month) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalMonths = months.length;
      const grandCount = months.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
      const grandActiveCount = months.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as slice 21.
      const paged = months.slice(skip, skip + take);

      res.json({
        months: paged,
        totalMonths,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] by-month error:", e.message);
      res.status(500).json({ error: "Failed to compute monthly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/by-quarter — tenant-wide supplier quarterly rollup
// (PRD_TRAVEL_SUPPLIER_MASTER §3 #903 slice 25).
//
// USER-readable meta endpoint. Returns one row per UTC YYYY-Qn bucket for
// the tenant-scoped (and sub-brand-narrowed) supplier population. Each row
// carries count + activeCount + archivedCount so the operator dashboard
// can render a "suppliers onboarded by quarter" trend tile at lower
// resolution than the /by-month time series (slice 24).
//
// Mirrors slice 24 (/suppliers/by-month) at quarter resolution and the
// #901 slice 30 (/invoices/by-quarter) + #900 slice 17 (/quotes/by-quarter)
// + #908 slice 22 (/flyer-templates/by-quarter) pattern for YYYY-Qn
// bucketing. Calendar quarter is `Math.floor(month/3)+1` (Q1=Jan-Mar,
// Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec). Same defensive math (null/invalid
// createdAt → "unknown" bucket; excluded when ?from / ?to is set, kept
// otherwise so the count surface stays accurate), same orderBy semantics,
// same active-vs-archived split as the by-month aggregator.
//
// Distinct from /suppliers/stats (slice 23): /stats is a point-in-time
// KPI tile; /by-month is the high-resolution time series; /by-quarter is
// the low-resolution rollup ideal for sparse / multi-year overview tiles.
//
// PRD anchors:
//   - §3 — tenant-wide supplier analytics (quarterly trend tile for the
//          supplier-master dashboard; coarse-grained period picker)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY-Qn bounds; invalid →
//                     400 INVALID_QUARTER_FORMAT
//   - ?orderBy      — default quarter:asc; accepts quarter:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 12 / 0; limit caps at 40 (quarters
//                       are sparser than months, so a smaller cap suffices)
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' suppliers in the rollup. Same gate as
//     /suppliers/by-month — TravelSupplier.subBrand is NON-nullable in
//     the schema, so we do NOT add a `{ subBrand: null }` OR clause
//     (which #908 slice 22 does for flyer-templates whose subBrand IS
//     nullable). Empty access set → forces `subBrand: "__none__"` so the
//     response stays a clean zero-rollup envelope.
//   - JS-side aggregation over a light findMany projection
//     ({ isActive, createdAt }) — same rationale as the by-month sibling.
//   - "unknown" bucket: rows with null/invalid createdAt land here so the
//     count surface stays accurate. Excluded when ?from / ?to is set
//     (no comparable quarter token); included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter — same
//     posture as the by-month sibling.
//
// No audit row written — read-only meta surface; matches /suppliers/stats
// and /suppliers/by-month posture. USER-readable: anodyne (counts +
// quarter-string tokens).
//
// Express route ordering: literal-path /by-quarter MUST be declared BEFORE
// the /:id family or `:id="by-quarter"` would 400 INVALID_ID before
// reaching this handler. Same convention as /suppliers/by-month,
// /suppliers/stats, /suppliers/search.
// ============================================================================
router.get(
  "/suppliers/by-quarter",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

      // YYYY-Qn validation — mirrors slice 30 /invoices/by-quarter.
      const QUARTER_RE = /^\d{4}-Q[1-4]$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }
      if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY-Qn format",
          code: "INVALID_QUARTER_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "quarter:asc",
        "quarter:desc",
        "count:asc",
        "count:desc",
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors slice 24
      // /suppliers/by-month posture. TravelSupplier.subBrand is
      // NON-nullable, so we use a single `subBrand: { in: [...] }`
      // (no `{ subBrand: null }` OR clause). Empty allowed set returns
      // the zero-rollup envelope.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          where.subBrand = "__none__";
        }
      }

      // Light projection — isActive + createdAt is enough for the bucket
      // totals.
      const rows = await prisma.travelSupplier.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { count, activeCount,
      // archivedCount }. Null/invalid createdAt rows land in "unknown".
      // Calendar quarter: Math.floor(month/3)+1 where month is 0-indexed.
      const byQuarter = new Map();
      for (const r of rows) {
        let quarterKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            const yyyy = dt.getUTCFullYear();
            const qn = Math.floor(dt.getUTCMonth() / 3) + 1;
            quarterKey = `${yyyy}-Q${qn}`;
          }
        }

        let bucket = byQuarter.get(quarterKey);
        if (!bucket) {
          bucket = {
            quarter: quarterKey,
            count: 0,
            activeCount: 0,
            archivedCount: 0,
          };
          byQuarter.set(quarterKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let quarters = [...byQuarter.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. YYYY-Qn sorts lexicographically the
      // same as chronologically (since "Q1" < "Q2" < "Q3" < "Q4" and
      // year-prefix dominates).
      if (fromRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter >= fromRaw,
        );
      }
      if (toRaw !== null) {
        quarters = quarters.filter(
          (r) => r.quarter !== "unknown" && r.quarter <= toRaw,
        );
      }

      // Sort. "quarter" sorts lexicographically on YYYY-Qn (also
      // chronological). "unknown" sorts last in asc / first in desc
      // (lexicographically > "9999-Q4") — acceptable for a defensive
      // fallback bucket that should rarely appear.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      quarters.sort((a, b) => {
        if (field === "quarter") {
          if (a.quarter < b.quarter) return -1 * mult;
          if (a.quarter > b.quarter) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalQuarters = quarters.length;
      const grandCount = quarters.reduce(
        (acc, r) => acc + (Number(r.count) || 0),
        0,
      );
      const grandActiveCount = quarters.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as slice 24.
      const paged = quarters.slice(skip, skip + take);

      res.json({
        quarters: paged,
        totalQuarters,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] by-quarter error:", e.message);
      res.status(500).json({ error: "Failed to compute quarterly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/by-year — tenant-wide supplier annual rollup
// (PRD_TRAVEL_SUPPLIER_MASTER §3 #903 slice 26).
//
// USER-readable meta endpoint. Returns one row per UTC calendar year for
// the tenant-scoped (and sub-brand-narrowed) supplier population. Each
// row carries count + activeCount + archivedCount so the operator
// dashboard can render a multi-year "suppliers onboarded by year" trend
// tile at the coarsest resolution alongside the /by-month (slice 24)
// and /by-quarter (slice 25) siblings.
//
// Completes the by-month / by-quarter / by-year triplet. Calendar year
// via `getUTCFullYear()`. Same defensive math (null/invalid createdAt
// → "unknown" bucket; excluded when ?from / ?to is set, kept otherwise
// so the count surface stays accurate), same orderBy semantics, same
// active-vs-archived split as the by-month + by-quarter aggregators.
//
// Distinct from /suppliers/:id/payables/yearly (slice 22) which is the
// per-supplier yearly payables rollup keyed by paidAt. THIS surface is
// tenant-wide onboarded-count keyed by TravelSupplier.createdAt.
//
// PRD anchors:
//   - §3 — tenant-wide supplier analytics (annual trend tile for the
//          supplier-master dashboard; multi-year overview picker)
//
// Query params:
//   - ?from / ?to   — optional inclusive YYYY bounds; invalid →
//                     400 INVALID_YEAR_FORMAT
//   - ?orderBy      — default year:asc; accepts year:{asc|desc},
//                     count:{asc|desc}, activeCount:{asc|desc};
//                     unknown tokens degrade silently to the default
//   - ?limit / ?offset — default 10 / 0; limit caps at 30 (years are
//                       coarser than quarters, so a smaller cap suffices)
//
// Behaviour:
//   - Sub-brand-scoped: a MANAGER restricted to one sub-brand sees ONLY
//     their allowed sub-brands' suppliers in the rollup. Same gate as
//     /suppliers/by-month + /suppliers/by-quarter — TravelSupplier
//     .subBrand is NON-nullable in the schema, so we do NOT add a
//     `{ subBrand: null }` OR clause. Empty access set → forces
//     `subBrand: "__none__"` so the response stays a clean zero-rollup
//     envelope.
//   - JS-side aggregation over a light findMany projection
//     ({ isActive, createdAt }) — same rationale as the siblings.
//   - "unknown" bucket: rows with null/invalid createdAt land here so
//     the count surface stays accurate. Excluded when ?from / ?to is
//     set (no comparable year token); included otherwise.
//   - Pagination applied AFTER aggregation + sort + bucket filter —
//     same posture as the siblings.
//
// No audit row written — read-only meta surface; matches /suppliers/stats
// + /suppliers/by-month + /suppliers/by-quarter posture. USER-readable:
// anodyne (counts + year tokens).
//
// Express route ordering: literal-path /by-year MUST be declared BEFORE
// the /:id family or `:id="by-year"` would 400 INVALID_ID before
// reaching this handler. Same convention as /suppliers/by-quarter,
// /suppliers/by-month, /suppliers/stats, /suppliers/search.
// ============================================================================
router.get(
  "/suppliers/by-year",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      const skip = parseInt(req.query.offset, 10) || 0;
      const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

      // YYYY validation. Match exactly 4 digits.
      const YEAR_RE = /^\d{4}$/;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;
      if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
        return res.status(400).json({
          error: "from must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }
      if (toRaw !== null && !YEAR_RE.test(toRaw)) {
        return res.status(400).json({
          error: "to must be in YYYY format",
          code: "INVALID_YEAR_FORMAT",
        });
      }

      const VALID_ORDER_BY = new Set([
        "year:asc",
        "year:desc",
        "count:asc",
        "count:desc",
        "activeCount:asc",
        "activeCount:desc",
      ]);
      const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

      // Tenant-scoped where + sub-brand narrowing. Mirrors slice 24
      // /suppliers/by-month + slice 25 /suppliers/by-quarter posture.
      // TravelSupplier.subBrand is NON-nullable, so we use a single
      // `subBrand: { in: [...] }` (no `{ subBrand: null }` OR clause).
      // Empty allowed set returns the zero-rollup envelope.
      const where = { tenantId: req.travelTenant.id };
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (allowed.size > 0) {
          where.subBrand = { in: [...allowed] };
        } else {
          where.subBrand = "__none__";
        }
      }

      // Light projection — isActive + createdAt is enough for the bucket
      // totals.
      const rows = await prisma.travelSupplier.findMany({
        where,
        select: { isActive: true, createdAt: true },
      });

      // Aggregate per-UTC-year. Map "YYYY" → { count, activeCount,
      // archivedCount }. Null/invalid createdAt rows land in "unknown".
      const byYear = new Map();
      for (const r of rows) {
        let yearKey = "unknown";
        if (r.createdAt) {
          const dt = r.createdAt instanceof Date
            ? r.createdAt
            : new Date(r.createdAt);
          if (!Number.isNaN(dt.getTime())) {
            yearKey = String(dt.getUTCFullYear());
          }
        }

        let bucket = byYear.get(yearKey);
        if (!bucket) {
          bucket = {
            year: yearKey,
            count: 0,
            activeCount: 0,
            archivedCount: 0,
          };
          byYear.set(yearKey, bucket);
        }
        bucket.count += 1;
        if (r.isActive) bucket.activeCount += 1;
        else bucket.archivedCount += 1;
      }

      let years = [...byYear.values()];

      // Apply ?from / ?to bucket filter. "unknown" excluded when either
      // bound is set (no comparable token); kept otherwise so the count
      // surface remains complete. YYYY sorts lexicographically the same
      // as chronologically (4-digit zero-padded).
      if (fromRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year >= fromRaw,
        );
      }
      if (toRaw !== null) {
        years = years.filter(
          (r) => r.year !== "unknown" && r.year <= toRaw,
        );
      }

      // Sort. "year" sorts lexicographically on YYYY (also chronological
      // since 4-digit zero-padded). "unknown" sorts last in asc / first
      // in desc (lexicographically > "9999") — acceptable for a defensive
      // fallback bucket that should rarely appear.
      const [field, dir] = orderBy.split(":");
      const mult = dir === "asc" ? 1 : -1;
      years.sort((a, b) => {
        if (field === "year") {
          if (a.year < b.year) return -1 * mult;
          if (a.year > b.year) return 1 * mult;
          return 0;
        }
        return ((a[field] || 0) - (b[field] || 0)) * mult;
      });

      const totalYears = years.length;
      const grandCount = years.reduce(
        (acc, r) => acc + (Number(r.count) || 0),
        0,
      );
      const grandActiveCount = years.reduce(
        (acc, r) => acc + (Number(r.activeCount) || 0),
        0,
      );

      // Pagination AFTER aggregation + sort + filter, same as siblings.
      const paged = years.slice(skip, skip + take);

      res.json({
        years: paged,
        totalYears,
        grandCount,
        grandActiveCount,
        limit: take,
        offset: skip,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] by-year error:", e.message);
      res.status(500).json({ error: "Failed to compute yearly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/credentials — per-supplier portal-logins view
// (Arc 2 #903 slice 13 — PRD_TRAVEL_SUPPLIER_MASTER AC-6.8 "Supplier Portal
// Logins" sub-tab under the SupplierMaster detail page).
//
// Operator-facing list of vault credentials (airline / hotel / GDS / visa
// portal logins) scoped to a single TravelSupplier. The `SupplierCredential`
// model has NO direct FK to `TravelSupplier`; the link is by-name (the vault
// stores supplierName as a free-form string). This endpoint matches on
// `supplierName === supplier.name` after sub-brand-access-checking the parent.
//
// MUST be registered BEFORE `GET /suppliers/:id` — Express matches in
// declaration order and the sub-path `:id/credentials` should win the
// `/suppliers/42/credentials` shape. (Routes with different segment counts
// don't actually collide in Express's matcher, but the standing rule is
// "sub-paths first" so the ordering decision stays uniform across slices.)
//
// Auth: ADMIN or MANAGER. Same level the existing `/supplier-credentials`
// metadata-list endpoint uses — the response NEVER contains decrypted
// secret material, so MANAGER is acceptable.
//
// Access log: per the slice 13 task brief, EVERY read writes one
// `SupplierCredentialAccessLog` row { action: "viewed", userId } per
// credential returned. (The pre-existing top-level `/supplier-credentials`
// list does NOT log; this surface does, because it's the operator-visible
// sub-tab where audit-coverage matters most — operators are clicking into a
// specific supplier and need a paper trail.)
//
// Response shape (per PRD slice 13 brief — no secret material):
//   {
//     supplier: { id, name, supplierCategory, subBrand },
//     credentials: [
//       {
//         id, type (= category), label (= supplierName),
//         lastUsedAt,            // from SupplierCredential.lastUsedAt
//         lastRotatedAt,         // most-recent accessLog row with action="rotated"
//         expiresAt,             // parsed from metadataJson.expiresAt (ISO), or null
//         isExpired,             // expiresAt != null && expiresAt < now()
//         ownerUserId,
//         createdAt, updatedAt,
//       },
//     ],
//     total: <int>,
//   }
//
// Schema-drift note:
//   The slice 13 task brief asks for `lastRotatedAt` and `expiresAt` fields
//   that are NOT direct columns on the SupplierCredential model. The
//   schema-freeze rule of this slice means we derive them at the route
//   boundary:
//     - lastRotatedAt: most-recent SupplierCredentialAccessLog row with
//       action="rotated" for this credential. The PATCH /:id endpoint
//       already writes such rows on rotation, so the data exists.
//     - expiresAt: parsed from the existing metadataJson field. Operators
//       can set `metadataJson = '{"expiresAt": "2026-12-31T00:00:00Z"}'`;
//       missing or unparseable JSON yields expiresAt:null + isExpired:false.
//   When a future schema-bump lands first-class columns, this derivation
//   can be replaced with direct field reads.
//
// Decisions:
//   - Match-by-name is a string equality (not contains) — the picker UI
//     creates SupplierCredential rows with the supplier's exact name, and
//     this lookup must NOT bleed across suppliers whose names share a
//     prefix. Same tenantId scoping the rest of the vault uses.
//   - Returns empty `credentials:[]` rather than 404 when the supplier has
//     no credentials — the supplier itself exists, just no portal logins
//     yet. 404 is reserved for "supplier does not exist".
//   - No pagination params yet — a single supplier rarely has >20 portal
//     logins (one per airline / GDS / portal). If we hit that ceiling
//     a follow-up slice will add limit/offset.
//   - Error codes: INVALID_ID, NOT_FOUND, SUB_BRAND_DENIED.
// ============================================================================

router.get(
  "/suppliers/:id/credentials",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const supplier = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true, name: true, supplierCategory: true, subBrand: true },
      });
      if (!supplier) {
        return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      // Vault lookup: tenant + exact-supplier-name match. The credentials
      // surface does NOT carry sub-brand directly, so the parent's
      // sub-brand check (above) is the only access gate.
      const creds = await prisma.supplierCredential.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierName: supplier.name,
        },
        select: {
          id: true,
          category: true,
          supplierName: true,
          metadataJson: true,
          ownerUserId: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ category: "asc" }, { id: "asc" }],
      });

      // Per-cred: find lastRotatedAt + parse expiresAt from metadataJson +
      // write an access-log row { action: "viewed" }.
      const nowMs = Date.now();
      const credentials = [];
      for (const c of creds) {
        // lastRotatedAt — most-recent rotation event.
        const lastRotation = await prisma.supplierCredentialAccessLog.findFirst({
          where: { credentialId: c.id, action: "rotated" },
          orderBy: { at: "desc" },
          select: { at: true },
        });

        // expiresAt — try to parse from metadataJson { expiresAt: ISO }.
        // Malformed JSON or missing key yields null (no throw).
        let expiresAt = null;
        if (c.metadataJson) {
          try {
            const meta = JSON.parse(c.metadataJson);
            if (meta && typeof meta.expiresAt === "string") {
              const d = new Date(meta.expiresAt);
              if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
            }
          } catch (_e) {
            // Unparseable metadata — leave expiresAt null. Not an error;
            // operators can store free-form notes in metadataJson and we
            // don't want to fail the whole read.
          }
        }
        const isExpired = expiresAt != null && new Date(expiresAt).getTime() < nowMs;

        // Access log: write a "viewed" row for audit (per task brief).
        // Best-effort — a write failure does NOT fail the read. The cred
        // metadata is the load-bearing return value.
        try {
          await prisma.supplierCredentialAccessLog.create({
            data: {
              credentialId: c.id,
              userId: req.user.userId,
              action: "viewed",
              ip: req.ip || null,
            },
          });
        } catch (_e) {
          // swallow — access-log write is non-blocking.
        }

        credentials.push({
          id: c.id,
          type: c.category,
          label: c.supplierName,
          lastUsedAt: c.lastUsedAt,
          lastRotatedAt: lastRotation ? lastRotation.at : null,
          expiresAt,
          isExpired,
          ownerUserId: c.ownerUserId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        });
      }

      res.json({
        supplier,
        credentials,
        total: credentials.length,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] per-supplier credentials error:", e.message);
      res.status(500).json({ error: "Failed to list supplier credentials" });
    }
  },
);

// ============================================================================
// POST /api/travel/suppliers/:id/credentials/:credId/rotate
// (Arc 2 #903 slice 14 — PRD_TRAVEL_SUPPLIER_MASTER §3.7 "credentials audit
// trail").
//
// Operator-facing "mark rotated" action. The flow is: operator changes the
// password on the supplier's portal (e.g. Booking.com admin) out-of-band, then
// clicks "Mark Rotated" in the SupplierMaster detail page → this endpoint
// records the rotation event so the team has a paper trail of "when was this
// credential last cycled".
//
// This slice does NOT change the underlying secret material. The body MAY
// carry a future `secret` field for when a real secrets-vault lands, but for
// now we only record the rotation event by writing a
// SupplierCredentialAccessLog row { action: "rotated", userId, ip }. The
// existing slice 13 GET handler then derives `lastRotatedAt` from this row.
//
// Auth: ADMIN-only. The existing PATCH /supplier-credentials/:id (the real
// secret-rotation surface) is ADMIN-only — we mirror that even though no
// secret material moves here, since "I rotated the cred" is a write event
// that affects the team's audit trail.
//
// Route ordering: registered BEFORE the catch-all `GET /suppliers/:id` so the
// 4-segment sub-path wins. Sibling sub-paths under `/suppliers/:id/...` are
// listed in this section in order of specificity.
//
// Response: 200 + { credentialId, rotatedAt, supplierId }.
// Errors: INVALID_ID (400) — non-numeric :id or :credId.
//         NOT_FOUND (404) — supplier missing OR credential missing OR cred
//                           supplierName doesn't match the supplier's name.
//         SUB_BRAND_DENIED (403) — user lacks sub-brand access to supplier.
//
// Decisions:
//   - The :credId must belong to a SupplierCredential whose
//     supplierName === supplier.name (same name-match contract as slice 13).
//     A cred for a DIFFERENT supplier returns 404 — operators must not be
//     able to backdate a rotation event on the wrong supplier just because
//     they have the credentialId.
//   - The access-log write is the LOAD-BEARING side effect; if it throws we
//     return 500 (unlike slice 13's GET where the log write is best-effort).
//     For a write action the audit row IS the side effect.
//   - Idempotency: repeated calls each record a distinct accessLog row. That's
//     correct — operators may rotate the same credential multiple times, and
//     each event needs its own timestamp. Callers wanting "last rotated at"
//     hit slice 13's GET which surfaces the most-recent row.
// ============================================================================

router.post(
  "/suppliers/:id/credentials/:credId/rotate",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const credId = parseInt(req.params.credId, 10);
      if (!Number.isFinite(id) || !Number.isFinite(credId)) {
        return res
          .status(400)
          .json({ error: "id and credId must be numbers", code: "INVALID_ID" });
      }

      const supplier = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true, name: true, subBrand: true },
      });
      if (!supplier) {
        return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      // Look up the cred + verify the name-match. If the cred belongs to a
      // different supplier (or to no supplier with this name), 404 — the
      // operator should not be able to mark "rotated" on a cred they wouldn't
      // see in this supplier's portal-logins tab.
      const cred = await prisma.supplierCredential.findFirst({
        where: {
          id: credId,
          tenantId: req.travelTenant.id,
          supplierName: supplier.name,
        },
        select: { id: true },
      });
      if (!cred) {
        return res
          .status(404)
          .json({ error: "Credential not found for this supplier", code: "NOT_FOUND" });
      }

      // Load-bearing audit write. If this throws we surface 500 — the whole
      // point of the endpoint is to record the rotation event.
      const log = await prisma.supplierCredentialAccessLog.create({
        data: {
          credentialId: cred.id,
          userId: req.user.userId,
          action: "rotated",
          ip: req.ip ? String(req.ip).slice(0, 64) : null,
        },
        select: { id: true, at: true },
      });

      res.json({
        credentialId: cred.id,
        supplierId: supplier.id,
        rotatedAt: log.at,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] mark-rotated error:", e.message);
      res.status(500).json({ error: "Failed to mark credential as rotated" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/access-trail
// (Arc 2 #903 slice 15 — PRD_TRAVEL_SUPPLIER_MASTER §3.7 "credentials audit
// trail" + AC-6.8 supplier-detail "Supplier Portal Logins" sub-tab).
//
// Paginated cross-credential audit-trail view for a single TravelSupplier:
// every SupplierCredentialAccessLog row across ALL of the supplier's vault
// credentials, joined into one feed sorted DESC by `at`. Complements slice 13
// (GET creds — per-cred metadata) and slice 14 (POST rotate — writes one
// "rotated" row): this slice surfaces the historical record so operators can
// audit "who touched which cred when" for a single supplier on one page.
//
// A per-credential equivalent exists at `GET /supplier-credentials/:id/
// access-log` (route line ~319). That returns rows for ONE credentialId. This
// slice spans ALL credentials whose `supplierName === supplier.name` (same
// name-match contract as slice 13).
//
// Auth: ADMIN + MANAGER (mirrors slice 13's GET — read-only audit trail). USER
// gets 403. Sub-brand access enforced via the parent supplier's subBrand.
//
// Route ordering: registered BEFORE the catch-all `GET /suppliers/:id` so the
// 3-segment sub-path wins. Sibling to slice 13's GET and slice 14's POST under
// `/suppliers/:id/...`.
//
// Query params (all optional):
//   ?limit=N         — page size; default 50, max 200 (ACCESS_TRAIL_MAX_LIMIT).
//                      Out-of-range or non-integer → 400 INVALID_LIMIT.
//   ?offset=N        — page offset; default 0. Negative / non-integer silently
//                      coerces to 0 (mirrors parsePayablesOffset shape).
//   ?action=X        — filter to one action. Valid: viewed | used-in-checkin |
//                      rotated | deleted. Anything else → 400 INVALID_ACTION.
//
// Response: 200 + { supplier: {id, name, supplierCategory, subBrand},
//                   accessTrail: [{ id, credentialId, credentialName, action,
//                                   userId, ip, at }],
//                   total, limit, offset }.
// Errors:  INVALID_ID (400)     — non-numeric :id.
//          INVALID_LIMIT (400)  — out-of-range or non-integer limit.
//          INVALID_ACTION (400) — action filter not in valid set.
//          NOT_FOUND (404)      — supplier missing or different tenant.
//          SUB_BRAND_DENIED (403) — caller lacks sub-brand access.
//
// Decisions:
//   - Credential IDs are resolved via a single findMany on supplierCredential
//     (where supplierName + tenantId), then accessLog rows are loaded via
//     `credentialId: { in: [...] }`. Two-step rather than nested relation
//     filter so the credentialName join in the response is a plain map lookup
//     (no extra `include`). Empty cred list short-circuits to empty trail.
//   - credentialName in each row is derived from the parent cred's
//     `supplierName` field (which IS the supplier.name by definition here).
//     We include the credentialId so the frontend can route into the per-cred
//     access log if needed. credentialCategory carried for context too.
//   - This endpoint READS audit rows — it does NOT write a new audit row.
//     Slice 13's GET writes "viewed" rows because it surfaces secrets-adjacent
//     metadata; this endpoint surfaces only the audit-rows themselves, so
//     adding "viewed" rows here would be circular/noisy.
//   - Pagination total uses a paired count() on the same WHERE so the caller
//     can build a paginator. Cap at limit=200/page is sized to fit a typical
//     audit-tab UI without further clicks; longer histories paginate.
// ============================================================================

const ACCESS_TRAIL_DEFAULT_LIMIT = 50;
const ACCESS_TRAIL_MAX_LIMIT = 200;
const VALID_ACCESS_TRAIL_ACTIONS = [
  "viewed",
  "used-in-checkin",
  "rotated",
  "deleted",
];

function parseAccessTrailLimit(input) {
  if (input == null || input === "") return ACCESS_TRAIL_DEFAULT_LIMIT;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("limit must be a positive integer");
    err.status = 400;
    err.code = "INVALID_LIMIT";
    throw err;
  }
  return Math.min(v, ACCESS_TRAIL_MAX_LIMIT);
}

function parseAccessTrailOffset(input) {
  if (input == null || input === "") return 0;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 0) return 0;
  return v;
}

router.get(
  "/suppliers/:id/access-trail",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const limit = parseAccessTrailLimit(req.query.limit);
      const offset = parseAccessTrailOffset(req.query.offset);

      const actionFilter = req.query.action
        ? String(req.query.action)
        : null;
      if (actionFilter && !VALID_ACCESS_TRAIL_ACTIONS.includes(actionFilter)) {
        return res.status(400).json({
          error: `action must be one of: ${VALID_ACCESS_TRAIL_ACTIONS.join(", ")}`,
          code: "INVALID_ACTION",
        });
      }

      const supplier = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true, name: true, supplierCategory: true, subBrand: true },
      });
      if (!supplier) {
        return res
          .status(404)
          .json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      // Resolve all credentialIds for this supplier (name-match — same
      // contract as slice 13). Two-step lookup so the join into credential
      // metadata for the response is a cheap in-memory map.
      const creds = await prisma.supplierCredential.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierName: supplier.name,
        },
        select: { id: true, category: true, supplierName: true },
      });

      // Short-circuit: no credentials → empty trail. Avoids a findMany on
      // accessLog with an empty `in` array (which Prisma's `in: []` shape
      // would technically handle, but is unnecessary work).
      if (creds.length === 0) {
        return res.json({
          supplier,
          accessTrail: [],
          total: 0,
          limit,
          offset,
        });
      }

      const credIds = creds.map((c) => c.id);
      const credById = new Map(creds.map((c) => [c.id, c]));

      const where = { credentialId: { in: credIds } };
      if (actionFilter) where.action = actionFilter;

      const [rows, total] = await Promise.all([
        prisma.supplierCredentialAccessLog.findMany({
          where,
          orderBy: [{ at: "desc" }, { id: "desc" }],
          take: limit,
          skip: offset,
        }),
        prisma.supplierCredentialAccessLog.count({ where }),
      ]);

      const accessTrail = rows.map((r) => {
        const cred = credById.get(r.credentialId);
        return {
          id: r.id,
          credentialId: r.credentialId,
          credentialName: cred ? cred.supplierName : null,
          credentialCategory: cred ? cred.category : null,
          action: r.action,
          userId: r.userId,
          ip: r.ip,
          at: r.at,
        };
      });

      res.json({
        supplier,
        accessTrail,
        total,
        limit,
        offset,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] access-trail error:", e.message);
      res.status(500).json({ error: "Failed to load access trail" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/scorecard
// (Arc 2 #903 slice 16 — PRD_TRAVEL_SUPPLIER_MASTER §3.7.a per-supplier
// dashboard "operational metrics" block).
//
// Per-supplier performance scorecard derived entirely from existing
// TravelSupplierPayable rows. Surfaces three operational signals that the
// supplier detail page promised in §3.7.a ("live obligations, recent POs,
// commission earned this FY, open disputes...") — the operational-quality
// half of that block. No schema changes needed; everything is computed from
// the status / dueDate / paidAt columns the slice-3 model already carries.
//
// Three metrics:
//   - bookingVolume: total count of payables for this supplier (any status,
//     within the optional date window). This is the proxy for "PO count" /
//     "how often we transact with this supplier".
//   - onTimeDeliveryRate: of the PAID payables, fraction where paidAt <= dueDate.
//     Payables with no dueDate or no paidAt are excluded from the denominator.
//     Mirrors the supplier-quality signal in §3.6 (chargeback / dispute prelude).
//   - cancelRate: cancelled / total. The "supplier flakiness" signal — POs we
//     opened and then had to void.
//
// MUST be registered BEFORE `GET /suppliers/:id` — Express matches in
// declaration order and the 3-segment sub-path `:id/scorecard` should win
// the `/suppliers/42/scorecard` shape. Same placement reasoning as slice
// 13 (`:id/credentials`) and slice 15 (`:id/access-trail`).
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet on the parent supplier.
//
// Query params (all optional):
//   ?from=ISODate   — lower bound on payable.createdAt (inclusive).
//   ?to=ISODate     — upper bound on payable.createdAt (inclusive).
//                     Default window: trailing 365 days from now if neither
//                     bound provided. Bounds INVERTED (from > to) → 400
//                     INVALID_DATE_RANGE.
//
// Response shape:
//   {
//     supplier: { id, name, supplierCategory, subBrand },
//     window:   { from: <ISO>, to: <ISO> },
//     metrics: {
//       bookingVolume:      <int>,                   // total payables in window
//       paidCount:          <int>,
//       cancelledCount:     <int>,
//       pendingCount:       <int>,
//       scheduledCount:     <int>,
//       onTimeCount:        <int>,                   // paid where paidAt <= dueDate
//       lateCount:          <int>,                   // paid where paidAt  > dueDate
//       onTimeDeliveryRate: <number|null>,           // onTime / (onTime + late); null if denom=0
//       cancelRate:         <number|null>,           // cancelled / total; null if total=0
//       totalAmountPaid:    <number>,                // sum of amount where status='paid'
//     }
//   }
//
// Decisions:
//   - On-time denominator EXCLUDES paid rows without both dueDate AND paidAt.
//     A row without dueDate has no contractual due-by so we cannot judge
//     timeliness; a row without paidAt is by definition not paid so it
//     shouldn't be in this calc anyway (defensive guard). Excluded rows show
//     up in paidCount but NOT in onTimeCount + lateCount.
//   - Rates rounded to 4dp half-up (mirrors slice 11 exposure utilization
//     rounding via round4 helper). null when denominator is 0 — never NaN,
//     never divide-by-zero. Frontend renders null as "—".
//   - Default window: trailing 365 days. Operators looking at a supplier
//     scorecard typically want "last year" — analogous to "Year-to-Date"
//     financial dashboards. Explicit bounds always override.
//   - All metrics computed from a single findMany returning the slim
//     projection {status, dueDate, paidAt, amount}. ~500 payables/supplier/yr
//     even for high-volume tenants → no need for groupBy here; the in-memory
//     reduce is simpler and one round-trip cheaper than 4 separate groupBys.
//   - Hard cap of 10_000 rows (same as slice 8 aging) as a sanity guard
//     against pathological tenants.
//   - Error codes: INVALID_ID, NOT_FOUND, SUB_BRAND_DENIED, INVALID_DATE,
//     INVALID_DATE_RANGE.
// ============================================================================

const SCORECARD_MAX_ROWS = 10_000;
const SCORECARD_DEFAULT_WINDOW_MS = 365 * 86_400_000;

function round4Scorecard(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

function round2Scorecard(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

router.get(
  "/suppliers/:id/scorecard",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      // Window parsing — both bounds optional; if both omitted, default to
      // trailing 365 days. Invalid date → 400 INVALID_DATE. Inverted bounds
      // (from > to) → 400 INVALID_DATE_RANGE.
      const now = new Date();
      let from = null;
      let to = null;
      if (req.query.from != null && req.query.from !== "") {
        const dt = new Date(String(req.query.from));
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date / parseable date string",
            code: "INVALID_DATE",
          });
        }
        from = dt;
      }
      if (req.query.to != null && req.query.to !== "") {
        const dt = new Date(String(req.query.to));
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date / parseable date string",
            code: "INVALID_DATE",
          });
        }
        to = dt;
      }
      if (from && to && from.getTime() > to.getTime()) {
        return res.status(400).json({
          error: "from must not be after to",
          code: "INVALID_DATE_RANGE",
        });
      }
      if (!from && !to) {
        to = now;
        from = new Date(now.getTime() - SCORECARD_DEFAULT_WINDOW_MS);
      } else if (!from) {
        from = new Date(to.getTime() - SCORECARD_DEFAULT_WINDOW_MS);
      } else if (!to) {
        to = now;
      }

      const supplier = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true, name: true, supplierCategory: true, subBrand: true },
      });
      if (!supplier) {
        return res
          .status(404)
          .json({ error: "Supplier not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: id,
          createdAt: { gte: from, lte: to },
        },
        select: {
          status: true,
          dueDate: true,
          paidAt: true,
          amount: true,
        },
        take: SCORECARD_MAX_ROWS,
      });

      let paidCount = 0;
      let cancelledCount = 0;
      let pendingCount = 0;
      let scheduledCount = 0;
      let onTimeCount = 0;
      let lateCount = 0;
      let totalAmountPaid = 0;

      for (const r of rows) {
        if (r.status === "paid") {
          paidCount++;
          totalAmountPaid += Number(r.amount || 0);
          // On-time delivery requires BOTH dueDate AND paidAt — defensive.
          if (r.dueDate && r.paidAt) {
            const due = r.dueDate instanceof Date
              ? r.dueDate.getTime()
              : new Date(r.dueDate).getTime();
            const paid = r.paidAt instanceof Date
              ? r.paidAt.getTime()
              : new Date(r.paidAt).getTime();
            if (Number.isFinite(due) && Number.isFinite(paid)) {
              if (paid <= due) onTimeCount++;
              else lateCount++;
            }
          }
        } else if (r.status === "cancelled") {
          cancelledCount++;
        } else if (r.status === "pending") {
          pendingCount++;
        } else if (r.status === "scheduled") {
          scheduledCount++;
        }
      }

      const bookingVolume = rows.length;
      const onTimeDenom = onTimeCount + lateCount;
      const onTimeDeliveryRate = onTimeDenom > 0
        ? round4Scorecard(onTimeCount / onTimeDenom)
        : null;
      const cancelRate = bookingVolume > 0
        ? round4Scorecard(cancelledCount / bookingVolume)
        : null;

      res.json({
        supplier,
        window: { from: from.toISOString(), to: to.toISOString() },
        metrics: {
          bookingVolume,
          paidCount,
          cancelledCount,
          pendingCount,
          scheduledCount,
          onTimeCount,
          lateCount,
          onTimeDeliveryRate,
          cancelRate,
          totalAmountPaid: round2Scorecard(totalAmountPaid),
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] scorecard error:", e.message);
      res.status(500).json({ error: "Failed to build supplier scorecard" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/compare — multi-supplier side-by-side scorecard
//                                      (Arc 2 #903 slice 19)
//
// PRD §3.7.b sortable suppliers index + §3.7.a per-supplier dashboard +
// OQ-9.5 quality-score: operators picking between two or three suppliers
// for the same route/category need a compact "Hilton Mumbai vs Marriott
// Mumbai vs Taj Mumbai" comparison. Same metrics as slice-16 scorecard
// (bookingVolume, onTimeDeliveryRate, cancelRate, totalAmountPaid, paid /
// pending / scheduled / cancelled counts), computed in one batched query
// per supplier window, then the response also picks a "best" / "worst"
// summary across the requested set.
//
// MUST be registered BEFORE `GET /suppliers/:id` — the literal "compare"
// token would otherwise be consumed by the :id param (yielding 400
// INVALID_ID since parseInt("compare") is NaN). Same hazard as slice-10
// search + slice-11 exposure.
//
// Query params:
//   ids   required, comma-separated supplier ids  — 2..10 items
//   from  optional ISO date / parseable date string (default: now - 365d)
//   to    optional ISO date / parseable date string (default: now)
//
// Response shape:
//   {
//     window: { from, to },
//     suppliers: [
//       {
//         id, name, supplierCategory, subBrand,
//         metrics: {
//           bookingVolume, paidCount, cancelledCount, pendingCount,
//           scheduledCount, onTimeCount, lateCount, onTimeDeliveryRate,
//           cancelRate, totalAmountPaid,
//         },
//       },
//       ...
//     ],
//     summary: {
//       bestOnTimeSupplierId,    // null if all rates null
//       worstOnTimeSupplierId,   // null if all rates null
//       lowestCancelSupplierId,  // null if all rates null
//       highestVolumeSupplierId, // null if all 0 volume
//     },
//   }
//
// Decisions:
//   - 2..10 ids: 1 id makes no sense (use scorecard); >10 is operator
//     fat-finger / loop sink. Hard cap at 10 keeps the response payload
//     small (UI table is the realistic consumer; 10 rows fits a viewport
//     before scrolling).
//   - Each supplier's metrics are computed via the same shape as slice-16
//     scorecard so the front-end can re-use that renderer. Reuses
//     round4Scorecard + round2Scorecard helpers + SCORECARD_DEFAULT_WINDOW_MS
//     + SCORECARD_MAX_ROWS already declared above.
//   - Sub-brand access: ALL ids must be in the operator's allowed set. If
//     ANY id is denied, the whole request returns 403 SUB_BRAND_DENIED with
//     the offending supplierId — partial responses would create confusing
//     UX where an operator sees scorecard rows for some suppliers and not
//     others without knowing why.
//   - 404: if ANY id is missing, return 404 NOT_FOUND with missingIds[].
//     Same all-or-nothing principle as sub-brand denial above.
//   - One batched groupBy across the ids covers payable aggregation cheaply
//     in the common case (≤10 suppliers, ≤500 payables each). For on-time
//     metrics we still need the slim row projection (status + dueDate +
//     paidAt + amount) — done via a single findMany scoped to all ids.
//   - Error codes: INVALID_IDS, TOO_FEW_IDS, TOO_MANY_IDS, INVALID_ID,
//     INVALID_DATE, INVALID_DATE_RANGE, NOT_FOUND, SUB_BRAND_DENIED.
// ============================================================================

const COMPARE_MIN_IDS = 2;
const COMPARE_MAX_IDS = 10;

function parseCompareIdsOrThrow(input) {
  if (input == null || String(input).trim() === "") {
    const err = new Error(
      "ids query param is required (comma-separated supplier ids)",
    );
    err.status = 400;
    err.code = "INVALID_IDS";
    throw err;
  }
  const parts = String(input)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length < COMPARE_MIN_IDS) {
    const err = new Error(
      `ids must contain at least ${COMPARE_MIN_IDS} supplier ids`,
    );
    err.status = 400;
    err.code = "TOO_FEW_IDS";
    throw err;
  }
  if (parts.length > COMPARE_MAX_IDS) {
    const err = new Error(
      `ids must contain at most ${COMPARE_MAX_IDS} supplier ids`,
    );
    err.status = 400;
    err.code = "TOO_MANY_IDS";
    throw err;
  }
  const ids = [];
  const seen = new Set();
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || String(n) !== p) {
      const err = new Error(`ids must all be numeric (offender: "${p}")`);
      err.status = 400;
      err.code = "INVALID_ID";
      throw err;
    }
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  if (ids.length < COMPARE_MIN_IDS) {
    const err = new Error(
      `ids must contain at least ${COMPARE_MIN_IDS} distinct supplier ids`,
    );
    err.status = 400;
    err.code = "TOO_FEW_IDS";
    throw err;
  }
  return ids;
}

router.get(
  "/suppliers/compare",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const ids = parseCompareIdsOrThrow(req.query.ids);

      // Window parsing — mirrors scorecard (same default + same error codes).
      const now = new Date();
      let from = null;
      let to = null;
      if (req.query.from != null && req.query.from !== "") {
        const dt = new Date(String(req.query.from));
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date / parseable date string",
            code: "INVALID_DATE",
          });
        }
        from = dt;
      }
      if (req.query.to != null && req.query.to !== "") {
        const dt = new Date(String(req.query.to));
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date / parseable date string",
            code: "INVALID_DATE",
          });
        }
        to = dt;
      }
      if (from && to && from.getTime() > to.getTime()) {
        return res.status(400).json({
          error: "from must not be after to",
          code: "INVALID_DATE_RANGE",
        });
      }
      if (!from && !to) {
        to = now;
        from = new Date(now.getTime() - SCORECARD_DEFAULT_WINDOW_MS);
      } else if (!from) {
        from = new Date(to.getTime() - SCORECARD_DEFAULT_WINDOW_MS);
      } else if (!to) {
        to = now;
      }

      const suppliers = await prisma.travelSupplier.findMany({
        where: { id: { in: ids }, tenantId: req.travelTenant.id },
        select: { id: true, name: true, supplierCategory: true, subBrand: true },
      });

      // 404 if ANY requested id is missing — all-or-nothing semantics.
      if (suppliers.length !== ids.length) {
        const foundIds = new Set(suppliers.map((s) => s.id));
        const missingIds = ids.filter((id) => !foundIds.has(id));
        return res.status(404).json({
          error: "One or more suppliers not found",
          code: "NOT_FOUND",
          missingIds,
        });
      }

      // Sub-brand gate: if ANY supplier's subBrand is denied, 403.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const deniedIds = [];
      for (const s of suppliers) {
        if (!canAccessSubBrand(allowed, s.subBrand)) deniedIds.push(s.id);
      }
      if (deniedIds.length > 0) {
        return res.status(403).json({
          error: "Sub-brand access denied for one or more suppliers",
          code: "SUB_BRAND_DENIED",
          deniedIds,
        });
      }

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: { in: ids },
          createdAt: { gte: from, lte: to },
        },
        select: {
          supplierId: true,
          status: true,
          dueDate: true,
          paidAt: true,
          amount: true,
        },
        take: SCORECARD_MAX_ROWS,
      });

      // Group rows by supplierId, then run the same metric reducer used by
      // scorecard (slice 16). Each supplier's reducer state stored in a Map
      // so we can iterate the supplier list in input order at the end.
      const stateById = new Map();
      for (const id of ids) {
        stateById.set(id, {
          bookingVolume: 0,
          paidCount: 0,
          cancelledCount: 0,
          pendingCount: 0,
          scheduledCount: 0,
          onTimeCount: 0,
          lateCount: 0,
          totalAmountPaid: 0,
        });
      }
      for (const r of rows) {
        const st = stateById.get(r.supplierId);
        if (!st) continue;
        st.bookingVolume++;
        if (r.status === "paid") {
          st.paidCount++;
          st.totalAmountPaid += Number(r.amount || 0);
          if (r.dueDate && r.paidAt) {
            const due = r.dueDate instanceof Date
              ? r.dueDate.getTime()
              : new Date(r.dueDate).getTime();
            const paid = r.paidAt instanceof Date
              ? r.paidAt.getTime()
              : new Date(r.paidAt).getTime();
            if (Number.isFinite(due) && Number.isFinite(paid)) {
              if (paid <= due) st.onTimeCount++;
              else st.lateCount++;
            }
          }
        } else if (r.status === "cancelled") {
          st.cancelledCount++;
        } else if (r.status === "pending") {
          st.pendingCount++;
        } else if (r.status === "scheduled") {
          st.scheduledCount++;
        }
      }

      // Build the suppliers[] array in the ORDER requested by the operator
      // so the comparison columns line up with their query.
      const supplierById = new Map(suppliers.map((s) => [s.id, s]));
      const resultSuppliers = ids.map((id) => {
        const s = supplierById.get(id);
        const st = stateById.get(id);
        const onTimeDenom = st.onTimeCount + st.lateCount;
        const onTimeDeliveryRate = onTimeDenom > 0
          ? round4Scorecard(st.onTimeCount / onTimeDenom)
          : null;
        const cancelRate = st.bookingVolume > 0
          ? round4Scorecard(st.cancelledCount / st.bookingVolume)
          : null;
        return {
          id: s.id,
          name: s.name,
          supplierCategory: s.supplierCategory,
          subBrand: s.subBrand,
          metrics: {
            bookingVolume: st.bookingVolume,
            paidCount: st.paidCount,
            cancelledCount: st.cancelledCount,
            pendingCount: st.pendingCount,
            scheduledCount: st.scheduledCount,
            onTimeCount: st.onTimeCount,
            lateCount: st.lateCount,
            onTimeDeliveryRate,
            cancelRate,
            totalAmountPaid: round2Scorecard(st.totalAmountPaid),
          },
        };
      });

      // Cross-supplier summary — pick best/worst across the comparison set.
      // Nulls are excluded from best/worst picks; if every supplier has a
      // null rate (no on-time-eligible rows), the corresponding pick is null.
      let bestOnTimeSupplierId = null;
      let worstOnTimeSupplierId = null;
      let lowestCancelSupplierId = null;
      let highestVolumeSupplierId = null;
      let bestOnTimeVal = -Infinity;
      let worstOnTimeVal = Infinity;
      let lowestCancelVal = Infinity;
      let highestVolumeVal = -Infinity;
      for (const r of resultSuppliers) {
        if (r.metrics.onTimeDeliveryRate != null) {
          if (r.metrics.onTimeDeliveryRate > bestOnTimeVal) {
            bestOnTimeVal = r.metrics.onTimeDeliveryRate;
            bestOnTimeSupplierId = r.id;
          }
          if (r.metrics.onTimeDeliveryRate < worstOnTimeVal) {
            worstOnTimeVal = r.metrics.onTimeDeliveryRate;
            worstOnTimeSupplierId = r.id;
          }
        }
        if (r.metrics.cancelRate != null) {
          if (r.metrics.cancelRate < lowestCancelVal) {
            lowestCancelVal = r.metrics.cancelRate;
            lowestCancelSupplierId = r.id;
          }
        }
        if (r.metrics.bookingVolume > 0 && r.metrics.bookingVolume > highestVolumeVal) {
          highestVolumeVal = r.metrics.bookingVolume;
          highestVolumeSupplierId = r.id;
        }
      }

      res.json({
        window: { from: from.toISOString(), to: to.toISOString() },
        suppliers: resultSuppliers,
        summary: {
          bestOnTimeSupplierId,
          worstOnTimeSupplierId,
          lowestCancelSupplierId,
          highestVolumeSupplierId,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] compare error:", e.message);
      res.status(500).json({ error: "Failed to compare suppliers" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/timeline — unified supplier-event feed
// (Arc 2 #903 slice 21 — PRD_TRAVEL_SUPPLIER_MASTER §3.7.a per-supplier
// dashboard "activity stream"; sibling to §3.1.g dispute-history surface).
//
// Composes events from existing data sources (NO schema edit):
//   - SUPPLIER_CREATED / SUPPLIER_UPDATED (from TravelSupplier.createdAt /
//     updatedAt, with a 1s delta guard so the auto-stamped same-txn mirror
//     doesn't appear as a phantom update).
//   - PAYABLE_CREATED / PAYABLE_PAID / PAYABLE_CANCELLED (from
//     TravelSupplierPayable rows — paidAt fires the PAID event; status=
//     cancelled with updatedAt fires the CANCELLED event since there's no
//     dedicated cancelledAt column).
//   - CREDENTIAL_CREATED (from SupplierCredential rows joined by
//     name-match against supplier.name within tenant — same join used by
//     slice 13 /credentials and slice 15 /access-trail).
//   - CREDENTIAL_<ACTION> (from SupplierCredentialAccessLog rows: ROTATED,
//     VIEWED, USED_IN_CHECKIN, DELETED, ...).
//
// Merge + sort done in the pure backend/lib/supplierTimeline.js helper so
// the route stays IO-only. Helper handles `?since=<ISODate>` and
// `?limit=<N>` (default 100, capped at 500).
//
// Auth: any verified token; tenant + sub-brand access enforced via
// loadParentSupplier (returns SUPPLIER_NOT_FOUND / SUB_BRAND_DENIED).
//
// Query params (all optional):
//   ?limit=N           — max events returned (default 100, cap 500;
//                        invalid → silent fallback to 100, mirroring
//                        access-trail's parseAccessTrailLimit defensive shape).
//   ?since=<ISODate>   — only events strictly later than this. Invalid
//                        parseable date → 400 INVALID_SINCE.
//
// Response shape:
//   {
//     supplier: { id, name, supplierCategory, subBrand },
//     events: [ { kind, at, id, ...payload }, ... ],   // newest-first
//     count: <events.length>,
//     limit: <effectiveLimit>
//   }
//
// Decisions:
//   - Reuse loadParentSupplier so the 400/404/403 contract for the parent
//     supplier matches sibling /payables, /scorecard, /access-trail routes.
//   - Per-source findMany takes 500 each (matches MAX_LIMIT) so a high-
//     traffic supplier with many recent payables doesn't starve the
//     credential/access-log streams. Total event payload bounded by limit.
//   - Helper returns events with payload fields (amount/currency/poNumber
//     for payables; category for credentials; userId/credentialId for
//     access-log) so the timeline UI can render meaningful entries without
//     a follow-up lookup per event.
//   - Route ordering: registered BEFORE /suppliers/:id (sub-paths-before-:id
//     standing rule) so `timeline` cannot be captured as an `id`.
// ============================================================================

const {
  composeSupplierTimeline,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
} = require("../lib/supplierTimeline");
const TIMELINE_PER_SOURCE_TAKE = TIMELINE_MAX_LIMIT;

router.get(
  "/suppliers/:id/timeline",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Parse limit defensively — invalid values fall back to default
      // rather than 400 (mirrors access-trail parseAccessTrailOffset shape
      // for non-numeric / negative inputs).
      let limit = TIMELINE_DEFAULT_LIMIT;
      if (req.query.limit != null && req.query.limit !== "") {
        const v = Number(req.query.limit);
        if (Number.isInteger(v) && v >= 1) {
          limit = Math.min(v, TIMELINE_MAX_LIMIT);
        }
      }

      // ?since parsing — surface INVALID_SINCE (distinct from INVALID_DATE
      // used by scorecard so the caller can distinguish a cursor parse
      // failure from a window-bound parse failure).
      let since = null;
      if (req.query.since != null && req.query.since !== "") {
        const parsed = new Date(String(req.query.since));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "since must be a valid ISO date / parseable date string",
            code: "INVALID_SINCE",
          });
        }
        since = parsed;
      }

      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const [payables, credentials] = await Promise.all([
        prisma.travelSupplierPayable.findMany({
          where: {
            tenantId: req.travelTenant.id,
            supplierId: supplier.id,
          },
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            paidAt: true,
            status: true,
            amount: true,
            currency: true,
            poNumber: true,
          },
          orderBy: { createdAt: "desc" },
          take: TIMELINE_PER_SOURCE_TAKE,
        }),
        prisma.supplierCredential.findMany({
          where: {
            tenantId: req.travelTenant.id,
            supplierName: supplier.name,
          },
          select: {
            id: true,
            createdAt: true,
            category: true,
          },
          take: TIMELINE_PER_SOURCE_TAKE,
        }),
      ]);

      // Access log is keyed by credentialId — short-circuit if no creds.
      let accessLog = [];
      if (credentials.length > 0) {
        const credIds = credentials.map((c) => c.id);
        accessLog = await prisma.supplierCredentialAccessLog.findMany({
          where: { credentialId: { in: credIds } },
          select: {
            id: true,
            credentialId: true,
            userId: true,
            action: true,
            at: true,
          },
          orderBy: { at: "desc" },
          take: TIMELINE_PER_SOURCE_TAKE,
        });
      }

      const events = composeSupplierTimeline(
        { supplier, payables, credentials, accessLog },
        { limit, since },
      );

      res.json({
        supplier: {
          id: supplier.id,
          name: supplier.name,
          supplierCategory: supplier.supplierCategory,
          subBrand: supplier.subBrand,
        },
        events,
        count: events.length,
        limit,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] timeline error:", e.message);
      res.status(500).json({ error: "Failed to build supplier timeline" });
    }
  },
);

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
  requireTravelTenant,
  requirePermission("suppliers", "write"),
  async (req, res) => {
    try {
      const {
        name, contactPerson, phone, email, gstin,
        addressLine, supplierCategory, subBrand,
        // Slice 1 (#903) — payment terms + credit-tracking + metadata.
        paymentTermsDays, creditLimit, creditCurrency, taxRegimeCode,
        primaryContactRole, notes,
        // G045 — supplier-side default commission rate (used as fallback
        // by the commission ledger when an accrual omits commissionPercent).
        commissionPercent,
        // G040 / G041 — governance status + payment-terms kind enums.
        status, paymentTermsKind,
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
      assertValidStatus(status);
      assertValidPaymentTermsKind(paymentTermsKind);
      if (subBrand) assertValidSubBrand(subBrand);
      if (commissionPercent != null) {
        const cp = Number(commissionPercent);
        if (!Number.isFinite(cp) || cp < 0 || cp > 100) {
          return res.status(400).json({
            error: "commissionPercent must be 0-100",
            code: "INVALID_COMMISSION_PERCENT",
          });
        }
      }

      // G041 — when kind != "net", paymentTermsDays must be null (auto-null
      // for the operator instead of 400'ing — friendlier and matches the
      // intent of the kind=prepay / on_departure / on_arrival states which
      // have no NET-N day count).
      const effectiveKind = paymentTermsKind || "net";
      const effectiveDays = effectiveKind === "net" && paymentTermsDays != null
        ? parseInt(paymentTermsDays, 10)
        : null;

      // G040 — status default is "active" and isActive is derived from it
      // for backwards compatibility with the existing list filter.
      const effectiveStatus = status || "active";

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
          isActive: deriveIsActive(effectiveStatus),
          status: effectiveStatus,
          paymentTermsKind: effectiveKind,
          paymentTermsDays: effectiveDays,
          creditLimit: creditLimit != null ? String(creditLimit) : null,
          creditCurrency: creditCurrency ? String(creditCurrency) : undefined,
          taxRegimeCode: taxRegimeCode ? String(taxRegimeCode) : null,
          primaryContactRole: primaryContactRole ? String(primaryContactRole) : null,
          notes: notes ? String(notes) : null,
          commissionPercent: commissionPercent != null ? String(commissionPercent) : null,
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
  requireTravelTenant,
  requirePermission("suppliers", "update"),
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
        // G045 — supplier-side default commission rate.
        commissionPercent,
        // G040 / G041 — governance status + payment-terms kind enums.
        status, paymentTermsKind,
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
      if (commissionPercent !== undefined) {
        if (commissionPercent != null) {
          const cp = Number(commissionPercent);
          if (!Number.isFinite(cp) || cp < 0 || cp > 100) {
            return res.status(400).json({
              error: "commissionPercent must be 0-100",
              code: "INVALID_COMMISSION_PERCENT",
            });
          }
          data.commissionPercent = String(commissionPercent);
        } else {
          data.commissionPercent = null;
        }
      }

      // G040 / G041 — status + paymentTermsKind enum patches.
      // Status flips also propagate to isActive (back-compat derived flag) so
      // the existing /suppliers list filter (where.isActive=true by default)
      // keeps the right set of suppliers hidden.
      if (status !== undefined) {
        assertValidStatus(status);
        data.status = status;
        data.isActive = deriveIsActive(status);
      }
      if (paymentTermsKind !== undefined) {
        assertValidPaymentTermsKind(paymentTermsKind);
        data.paymentTermsKind = paymentTermsKind;
        // When operator switches to a non-net kind, auto-null any existing
        // NET-N day count to keep the row coherent.
        if (paymentTermsKind !== "net") {
          data.paymentTermsDays = null;
        }
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
  requireTravelTenant,
  requirePermission("suppliers", "delete"),
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

// ─── G040 — Supplier governance state transitions ─────────────────────
//
// Four POST endpoints (one per state) that flip the supplier's status enum
// + sync the legacy isActive flag in the same write. Same access-control
// pattern as the rest of /suppliers: tenant + sub-brand isolation.
//
// /pause       — ADMIN/MANAGER, no body required.
// /block       — ADMIN only, body.reason required (free-text — auditing
//                the reason is the dispute-master gate per PRD §3.1.g).
// /archive     — ADMIN only, terminal state (soft-delete via isActive=false
//                + status='archived').
// /reactivate  — ADMIN only, flips back to active from ANY non-active state.
//                Use case: dispute resolved → operator reactivates the row.
//
// Every transition writes an audit row { fields: ['status'], from, to,
// reason? } so the supplier-timeline composer can surface the events.
//
// Why 4 endpoints not 1 generic /:id/transition? The body-strip middleware
// guarantees req.body fields are operator-supplied (not id/userId/tenantId)
// but the verb-per-state pattern matches the existing PO state-machine
// (/:id/send, /:id/acknowledge, /:id/fulfill, /:id/cancel) and makes the
// access-control + audit-narrative simpler — each verb has its own role
// gate and its own audit shape.

function buildStateTransitionHandler({ toStatus, requireReason }) {
  return async (req, res) => {
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

      // Block transition requires a reason (audit + dispute correlation).
      let reason = null;
      if (requireReason) {
        reason = req.body && req.body.reason ? String(req.body.reason).trim() : "";
        if (!reason) {
          return res.status(400).json({
            error: "reason required for this transition",
            code: "MISSING_FIELDS",
          });
        }
      }

      const updated = await prisma.travelSupplier.update({
        where: { id },
        data: {
          status: toStatus,
          isActive: deriveIsActive(toStatus),
        },
      });

      await writeAudit(
        "TravelSupplier",
        "STATUS_TRANSITION",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          from: existing.status || (existing.isActive ? "active" : "archived"),
          to: toStatus,
          ...(reason ? { reason } : {}),
        },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error(`[travel-sup] transition ${toStatus} error:`, e.message);
      res.status(500).json({ error: `Failed to transition supplier to ${toStatus}` });
    }
  };
}

router.post(
  "/suppliers/:id/pause",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  buildStateTransitionHandler({ toStatus: "paused", requireReason: false }),
);

router.post(
  "/suppliers/:id/block",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  buildStateTransitionHandler({ toStatus: "blocked_disputed", requireReason: true }),
);

router.post(
  "/suppliers/:id/archive",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  buildStateTransitionHandler({ toStatus: "archived", requireReason: false }),
);

router.post(
  "/suppliers/:id/reactivate",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  buildStateTransitionHandler({ toStatus: "active", requireReason: false }),
);

// ─── G043 — Credit utilization status endpoint ────────────────────────
//
// Lightweight endpoint that returns the supplier's current outstanding
// payable balance + configured creditLimit + 3-band advisory status.
// Wired into the frontend quote-builder / trip-list / trip-detail surfaces
// (G043 frontend chip) so operators see early warning before the booking
// confirm step actually fires the hard-block 409.
//
// Response shape: { current, limit, utilizationPct, status, currency }
//   status: "ok" | "warning" | "exceeded"
//     ok        — utilization < 80% OR no limit configured
//     warning   — 80% ≤ utilization < 100%
//     exceeded  — utilization ≥ 100%  (booking will be hard-blocked)
//
// Caching: this endpoint returns a 60-second Cache-Control header so the
// frontend chip can be polled without hammering the aggregate query.
// 60s is the right band — fresh enough for an operator's reading mid-quote;
// stale enough to amortise the SUM aggregate across multiple page loads.
const { checkCreditLimit, deriveCreditStatus } = require("../lib/supplierCreditCheck");

router.get(
  "/suppliers/:id/credit-status",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const supplier = await prisma.travelSupplier.findFirst({
        where: { id, tenantId: req.travelTenant.id },
        select: { id: true, subBrand: true, creditCurrency: true },
      });
      if (!supplier) {
        return res.status(404).json({ error: "Supplier not found", code: "NOT_FOUND" });
      }
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, supplier.subBrand)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const check = await checkCreditLimit({
        prisma,
        tenantId: req.travelTenant.id,
        supplierId: id,
        addAmount: 0,
      });
      const band = deriveCreditStatus({ current: check.current, limit: check.limit });

      res.set("Cache-Control", "private, max-age=60");
      res.json({
        supplierId: id,
        current: check.current,
        limit: check.limit,
        utilizationPct: band.utilizationPct,
        status: band.status,
        currency: supplier.creditCurrency || "INR",
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] credit-status error:", e.message);
      res.status(500).json({ error: "Failed to compute credit status" });
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

// ============================================================================
// GET /api/travel/suppliers/:id/payables/aging — Arc 2 #903 slice 17 —
// per-supplier aged-payable report (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d +
// FR-3.7.a per-supplier dashboard "credit utilization gauge").
//
// Mirrors the cross-supplier `/payables/aging` (slice 8) but scoped to ONE
// supplier — feeds the per-supplier detail-page "month-end close" widget so
// operators can pull a single supplier's aging without filtering through the
// tenant-wide aging report.
//
// Consumes backend/lib/payableAging.js — same `computeAgingReport(payables,
// { asOf })` helper used by slice 8. Bucket / exclusion rules enforced by
// the lib (current / 1-30 / 31-60 / 61-90 / 90+; paid+cancelled+no-due-date
// rows tallied as excluded with reason).
//
// Auth: any verified token; tenant + sub-brand access enforced via
// loadParentSupplier (returns SUPPLIER_NOT_FOUND / SUB_BRAND_DENIED).
//
// Query params (all optional):
//   ?asOf=ISODate     — age against this date (default: now). Invalid
//                       parseable date → 400 INVALID_ASOF (mirrors slice 8).
//
// Response shape:
//   {
//     supplier: { id, name, supplierCategory, subBrand },
//     asOf: "<ISO>",
//     bucketTotals: {
//       "current": { count, totalAmount },
//       "1-30":    { count, totalAmount },
//       "31-60":   { count, totalAmount },
//       "61-90":   { count, totalAmount },
//       "90+":     { count, totalAmount }
//     },
//     grandTotal: <number>,
//     excludedCount: <int>,
//     excludedReasons: { EXCLUDED_PAID: N, EXCLUDED_CANCELLED: N, ... }
//   }
//
// Decisions:
//   - Reuse loadParentSupplier so the 400/404/403 contract for parent
//     supplier matches the sibling /payables / payables CRUD routes.
//   - Same AGING_MAX_ROWS=10_000 sanity cap as slice 8.
//   - bucketTotals + grandTotal pass through the lib's number shape (round2
//     Numbers, not decimal strings).
//   - Error codes: INVALID_ID, SUPPLIER_NOT_FOUND, SUB_BRAND_DENIED,
//     INVALID_ASOF.
//   - Route ordering: registered BEFORE /suppliers/:id/payables/:payableId
//     (PUT/DELETE) so `aging` cannot be captured as a payableId — same
//     sub-paths-before-:id discipline used by slices 13-16.
// ============================================================================

router.get(
  "/suppliers/:id/payables/aging",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // asOf parsing — surface INVALID_ASOF (not INVALID_DATE) for caller
      // clarity, mirroring slice 8's cross-supplier /payables/aging.
      let asOf = new Date();
      if (req.query.asOf != null && req.query.asOf !== "") {
        const parsed = new Date(String(req.query.asOf));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "asOf must be a valid ISO date / parseable date string",
            code: "INVALID_ASOF",
          });
        }
        asOf = parsed;
      }

      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
        select: {
          id: true,
          dueDate: true,
          paidAt: true,
          status: true,
          amount: true,
        },
        take: AGING_MAX_ROWS,
      });

      const report = computeAgingReport(rows, { asOf });

      res.json({
        supplier: {
          id: supplier.id,
          name: supplier.name,
          supplierCategory: supplier.supplierCategory,
          subBrand: supplier.subBrand,
        },
        asOf: report.asOf,
        bucketTotals: report.bucketTotals,
        grandTotal: report.grandTotal,
        excludedCount: report.excludedCount,
        excludedReasons: report.excludedReasons,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] per-supplier aging error:", e.message);
      res.status(500).json({ error: "Failed to build per-supplier aging report" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/payables/monthly — Arc 2 #903 slice 18 —
// per-supplier monthly invoice rollup (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d +
// §3.5.b "commission ledger per FY" precursor — FY-wide rollup composes
// from monthly).
//
// Sibling to slice 17's /:id/payables/aging — same parent-supplier guard
// (loadParentSupplier) + same hard cap on payable rows fetched (10_000)
// + same lib-pure aggregation (computeMonthlyRollup in payableAging.js).
//
// Operator use-case: per-supplier detail page shows a "next 6 months
// payable schedule" widget. Each month displays total owed split by
// status — pending vs scheduled vs paid vs cancelled — so a glance
// answers "how much do we owe this supplier in March?" + "how much of
// that is still unpaid?".
//
// Optional ?from + ?to query bounds the result months (inclusive,
// YYYY-MM-DD form). When omitted, the route returns every month the
// supplier has a payable scheduled for. Bounds parse via
// parseDateBoundOrThrow (mirrors slice 7's /payables route).
//
// Route ordering: must register BEFORE /:id/payables/:payableId
//   (PUT/DELETE) so "monthly" cannot be captured as a payableId — same
//   sub-paths-before-:id discipline used by slices 13-17.
// ============================================================================

const { computeMonthlyRollup } = require("../lib/payableAging");
const MONTHLY_MAX_ROWS = 10_000;

router.get(
  "/suppliers/:id/payables/monthly",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Optional from / to bounds — applied at month-level after rollup.
      // Parsing happens BEFORE loadParentSupplier so an invalid date
      // surfaces 400 INVALID_FROM / INVALID_TO without a DB round-trip.
      let fromMonthKey = null;
      let toMonthKey = null;
      if (req.query.from != null && req.query.from !== "") {
        const parsed = new Date(String(req.query.from));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date / parseable date string",
            code: "INVALID_FROM",
          });
        }
        const y = parsed.getUTCFullYear();
        const m = parsed.getUTCMonth() + 1;
        fromMonthKey = `${y}-${String(m).padStart(2, "0")}`;
      }
      if (req.query.to != null && req.query.to !== "") {
        const parsed = new Date(String(req.query.to));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date / parseable date string",
            code: "INVALID_TO",
          });
        }
        const y = parsed.getUTCFullYear();
        const m = parsed.getUTCMonth() + 1;
        toMonthKey = `${y}-${String(m).padStart(2, "0")}`;
      }

      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
        select: {
          id: true,
          dueDate: true,
          status: true,
          amount: true,
        },
        take: MONTHLY_MAX_ROWS,
      });

      const rollup = computeMonthlyRollup(rows);

      // Apply from / to bounds (inclusive, YYYY-MM string compare).
      let months = rollup.months;
      if (fromMonthKey) months = months.filter((m) => m.month >= fromMonthKey);
      if (toMonthKey) months = months.filter((m) => m.month <= toMonthKey);

      // Recompute grandTotal + totalCount over the filtered window so the
      // caller's "this window's owed amount" matches the months array.
      let windowGrandTotal = 0;
      let windowTotalCount = 0;
      for (const m of months) {
        windowGrandTotal = Math.round((windowGrandTotal + m.totalAmount + Number.EPSILON) * 100) / 100;
        windowTotalCount += m.totalCount;
      }

      res.json({
        supplier: {
          id: supplier.id,
          name: supplier.name,
          supplierCategory: supplier.supplierCategory,
          subBrand: supplier.subBrand,
        },
        from: fromMonthKey,
        to: toMonthKey,
        months,
        grandTotal: windowGrandTotal,
        totalCount: windowTotalCount,
        excludedCount: rollup.excludedCount,
        excludedReasons: rollup.excludedReasons,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] per-supplier monthly rollup error:", e.message);
      res.status(500).json({ error: "Failed to build per-supplier monthly rollup" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/payables/quarterly — Arc 2 #903 slice 20 —
// per-supplier quarterly payable rollup (PRD_TRAVEL_SUPPLIER_MASTER FR-3.3.d
// + §3.5.b "commission ledger per FY" precursor — FY-wide rollup composes
// from quarterly which composes from monthly).
//
// Sibling to slice 18's /:id/payables/monthly — same parent-supplier guard
// (loadParentSupplier) + same hard cap on payable rows fetched
// (QUARTERLY_MAX_ROWS = 10_000) + same lib-pure aggregation
// (computeQuarterlyRollup in payableAging.js, which composes from
// computeMonthlyRollup so the per-status break is identical).
//
// Operator use-case: per-supplier detail page shows a "next 4 quarters
// payable schedule" widget. Quarters are calendar-based
// (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec). Each quarter
// displays total owed split by status — pending vs scheduled vs paid
// vs cancelled — so finance can plan cash-flow by quarter rather than
// scanning 12 monthly buckets at once.
//
// Optional ?from + ?to query bounds the result quarters (inclusive,
// YYYY-Qn lexical compare works because Q1 < Q2 < Q3 < Q4). When
// omitted, the route returns every quarter the supplier has a payable
// scheduled for. Bounds are dates (YYYY-MM-DD form) — same parser as
// the monthly route — that get mapped to their enclosing quarter.
//
// Route ordering: must register BEFORE /:id/payables/:payableId
//   (PUT/DELETE) so "quarterly" cannot be captured as a payableId — same
//   sub-paths-before-:id discipline used by slices 13-18.
// ============================================================================

const { computeQuarterlyRollup } = require("../lib/payableAging");
const QUARTERLY_MAX_ROWS = 10_000;

function dateToQuarterKey(d) {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

router.get(
  "/suppliers/:id/payables/quarterly",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Optional from / to bounds — applied at quarter-level after rollup.
      // Parsing happens BEFORE loadParentSupplier so an invalid date
      // surfaces 400 INVALID_FROM / INVALID_TO without a DB round-trip.
      let fromQuarterKey = null;
      let toQuarterKey = null;
      if (req.query.from != null && req.query.from !== "") {
        const parsed = new Date(String(req.query.from));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "from must be a valid ISO date / parseable date string",
            code: "INVALID_FROM",
          });
        }
        fromQuarterKey = dateToQuarterKey(parsed);
      }
      if (req.query.to != null && req.query.to !== "") {
        const parsed = new Date(String(req.query.to));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "to must be a valid ISO date / parseable date string",
            code: "INVALID_TO",
          });
        }
        toQuarterKey = dateToQuarterKey(parsed);
      }

      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
        select: {
          id: true,
          dueDate: true,
          status: true,
          amount: true,
        },
        take: QUARTERLY_MAX_ROWS,
      });

      const rollup = computeQuarterlyRollup(rows);

      // Apply from / to bounds (inclusive, YYYY-Qn lexical compare —
      // works because Q1 < Q2 < Q3 < Q4 sort lexically within a year
      // and years are zero-padded year-first).
      let quarters = rollup.quarters;
      if (fromQuarterKey) {
        quarters = quarters.filter((q) => q.quarter >= fromQuarterKey);
      }
      if (toQuarterKey) {
        quarters = quarters.filter((q) => q.quarter <= toQuarterKey);
      }

      // Recompute grandTotal + totalCount over the filtered window so the
      // caller's "this window's owed amount" matches the quarters array.
      let windowGrandTotal = 0;
      let windowTotalCount = 0;
      for (const q of quarters) {
        windowGrandTotal =
          Math.round((windowGrandTotal + q.totalAmount + Number.EPSILON) * 100) /
          100;
        windowTotalCount += q.totalCount;
      }

      res.json({
        supplier: {
          id: supplier.id,
          name: supplier.name,
          supplierCategory: supplier.supplierCategory,
          subBrand: supplier.subBrand,
        },
        from: fromQuarterKey,
        to: toQuarterKey,
        quarters,
        grandTotal: windowGrandTotal,
        totalCount: windowTotalCount,
        excludedCount: rollup.excludedCount,
        excludedReasons: rollup.excludedReasons,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] per-supplier quarterly rollup error:", e.message);
      res.status(500).json({ error: "Failed to build per-supplier quarterly rollup" });
    }
  },
);

// POST /api/travel/suppliers/:id/payables — ADMIN/MANAGER only.
// Required: description, amount. Optional: poNumber, currency, dueDate, notes, status.
router.post(
  "/suppliers/:id/payables",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "write"),
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
  requireTravelTenant,
  requirePermission("suppliers", "update"),
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
  requireTravelTenant,
  requirePermission("suppliers", "delete"),
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

// ============================================================================
// GET /api/travel/payables/aging — aged-payable report (Arc 2 #903 slice 8 —
// PRD_TRAVEL_BILLING UC-2.5 month-end-close aged-payable bucket report).
//
// Consumes backend/lib/payableAging.js (commit 7ba550d4) — the pure helper
// `computeAgingReport(payables, { asOf })` does the bucketing math. This
// route's job is just: load the right TravelSupplierPayable rows (tenant +
// sub-brand-access scoped, optionally filtered by sub-brand / supplier
// category), hand them to the helper, and surface its return shape.
//
// Buckets (lib enforces): current / 1-30 / 31-60 / 61-90 / 90+.
// Excluded (lib enforces): paid + cancelled (settled / voided liabilities
// do not appear on aged-payable reports) + missing/invalid dueDate.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees payables for suppliers in their allowed sub-brands.
//
// Query params (all optional):
//   ?asOf=ISODate                                  — age against this date
//                                                    (default: now)
//   ?subBrand=tmc|rfu|travelstall|visasure         — filter to one sub-brand
//                                                    (within the caller's
//                                                    allowed set; outside-
//                                                    allowed → empty)
//   ?supplierCategory=hotel|flight|transport|      — filter via join on
//                       visa-consul|other            TravelSupplier
//
// Response shape (mirrors computeAgingReport + echoes filters):
//   {
//     asOf: "<ISO>",
//     subBrand: "tmc" | null,
//     supplierCategory: "hotel" | null,
//     bucketTotals: {
//       "current": { count, totalAmount },
//       "1-30":    { count, totalAmount },
//       "31-60":   { count, totalAmount },
//       "61-90":   { count, totalAmount },
//       "90+":     { count, totalAmount }
//     },
//     grandTotal: <number>,
//     excludedCount: <int>,
//     excludedReasons: { EXCLUDED_PAID: N, EXCLUDED_CANCELLED: N, NO_DUE_DATE: N, ... }
//   }
//
// Decisions:
//   - Sub-brand filtering mirrors the cross-supplier `/payables` endpoint
//     above (slice 5): joins through supplier.is.subBrand, restricted
//     callers requesting a sub-brand they can't see get "__none__"
//     substituted (silent empty rather than 403). Same shape as slice-7
//     /payment-schedules/upcoming + /payables.
//   - Pagination is intentionally NOT exposed here: aging reports are
//     aggregate-by-design. The lib's reducer iterates the full set; the
//     route hard-caps the prisma findMany to a generous take=10_000 as a
//     sanity guard against runaway tenants (a single travel tenant with
//     >10K open payables would be an outlier — the cap surfaces such a
//     case as a missing tail rather than a runaway query).
//   - asOf parsing reuses parseDateBoundOrThrow shape but maps the
//     thrown INVALID_DATE to INVALID_ASOF for caller clarity.
//   - bucketTotals + grandTotal pass through the lib's number shape
//     (round2'd Numbers, not decimal strings). Frontend tooltip + the
//     planned month-end-close report consume the numeric form directly.
//   - Error codes: INVALID_ASOF, INVALID_SUB_BRAND, INVALID_SUPPLIER_CATEGORY.
// ============================================================================

const { computeAgingReport } = require("../lib/payableAging");
const AGING_MAX_ROWS = 10_000;

router.get(
  "/payables/aging",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // asOf — parse first so an invalid date surfaces INVALID_ASOF rather
      // than INVALID_DATE (cleaner error mapping for the caller).
      let asOf = new Date();
      if (req.query.asOf != null && req.query.asOf !== "") {
        const parsed = new Date(String(req.query.asOf));
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "asOf must be a valid ISO date / parseable date string",
            code: "INVALID_ASOF",
          });
        }
        asOf = parsed;
      }

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const supplierCategory = req.query.supplierCategory
        ? String(req.query.supplierCategory)
        : null;
      if (supplierCategory) assertValidSupplierCategory(supplierCategory);

      const where = { tenantId: req.travelTenant.id };

      // Sub-brand + supplierCategory filtering joins through the parent
      // supplier. Same pattern as cross-supplier /payables above.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const supplierFilter = {};
      if (subBrand) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrand)) {
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

      const rows = await prisma.travelSupplierPayable.findMany({
        where,
        select: {
          id: true,
          dueDate: true,
          paidAt: true,
          status: true,
          amount: true,
        },
        take: AGING_MAX_ROWS,
      });

      const report = computeAgingReport(rows, { asOf });

      res.json({
        asOf: report.asOf,
        subBrand,
        supplierCategory,
        bucketTotals: report.bucketTotals,
        grandTotal: report.grandTotal,
        excludedCount: report.excludedCount,
        excludedReasons: report.excludedReasons,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] aged payables error:", e.message);
      res.status(500).json({ error: "Failed to build aged-payable report" });
    }
  },
);

// ============================================================================
// GET /api/travel/suppliers/:id/payables/yearly — Arc 2 #903 slice 22 —
// per-supplier annual payable rollup (PRD_TRAVEL_SUPPLIER_MASTER §3.7).
//
// Completes the time-series triplet alongside slice 18's
// /:id/payables/monthly and slice 20's /:id/payables/quarterly. Returns
// calendar-year buckets (YYYY, UTC) so a per-supplier dashboard can show
// "what did we owe / pay this supplier each year" for the standard
// 10-year decade lookback widget.
//
// Same parent-supplier guard (loadParentSupplier) — same 400 INVALID_ID /
// 404 SUPPLIER_NOT_FOUND / 403 SUB_BRAND_DENIED contract.
//
// Aggregation differs intentionally from monthly/quarterly:
//   - Bucket key is `createdAt` UTC year (when the payable was BOOKED),
//     not `dueDate`. Yearly rollups are the historical "supplier spend
//     report" surface; finance teams care when the obligation was
//     INCURRED for that year's budget reconciliation, not when it was
//     due. Monthly/quarterly use dueDate because they feed cash-flow
//     planning ("what's owed THIS month" vs "what was booked LAST
//     year").
//   - Paid-vs-open split via `paidAt non-null` rather than a 4-way
//     status break. Matches the timeline event (slice 21) + payable
//     PATCH (slice 6) conventions: status=paid implies paidAt=now() if
//     unset, so paidAt is the canonical paid signal.
//   - `unknown` bucket for null/invalid createdAt — defensive against
//     rows where the createdAt column was stripped by an old import.
//     Sorted lexicographically; "unknown" sorts after numeric years
//     when ASC.
//
// Query surface (all optional):
//   ?from=YYYY / ?to=YYYY   — inclusive year bounds (regex /^\d{4}$/).
//                             Unparseable → 400 INVALID_YEAR_FORMAT
//                             (supplier lookup NOT attempted).
//   ?orderBy=<field>:<dir>  — default year:asc. Valid fields:
//                             year, totalAmount, payableCount.
//                             Valid dirs: asc, desc. Unknown token
//                             silently degrades to default.
//   ?limit=N                — default 10 (a decade), max 30.
//   ?offset=N               — default 0.
//
// Response shape:
//   {
//     supplierId, supplierName,
//     years: [ { year, payableCount, totalAmount, paidAmount, openAmount } ],
//     totalYears,             // count BEFORE limit/offset, AFTER from/to
//     grandTotalAmount,       // sum across windowed years
//     grandPaidAmount,
//     grandOpenAmount,
//     limit, offset,
//   }
//
// Defensive math: null/NaN/non-finite `amount` → 0 contribution. Sort is
// AFTER aggregate + from/to filter; pagination is the final step.
//
// Route ordering: placed at end-of-file is safe because the colliding
// candidate /:id/payables/:payableId is PUT/DELETE-only (no GET shape).
// ============================================================================

const YEARLY_MAX_ROWS = 10_000;
const YEARLY_DEFAULT_LIMIT = 10;
const YEARLY_MAX_LIMIT = 30;
const YEARLY_VALID_ORDER_FIELDS = new Set(["year", "totalAmount", "payableCount"]);
const YEARLY_VALID_ORDER_DIRS = new Set(["asc", "desc"]);
const YEARLY_DEFAULT_ORDER_FIELD = "year";
const YEARLY_DEFAULT_ORDER_DIR = "asc";
const YEAR_FORMAT_RE = /^\d{4}$/;

function parseYearlyOrderBy(input) {
  if (input == null || String(input).trim() === "") {
    return { field: YEARLY_DEFAULT_ORDER_FIELD, dir: YEARLY_DEFAULT_ORDER_DIR };
  }
  const raw = String(input).trim();
  const parts = raw.split(":");
  if (parts.length !== 2) {
    return { field: YEARLY_DEFAULT_ORDER_FIELD, dir: YEARLY_DEFAULT_ORDER_DIR };
  }
  const [field, dir] = parts;
  if (!YEARLY_VALID_ORDER_FIELDS.has(field) || !YEARLY_VALID_ORDER_DIRS.has(dir)) {
    return { field: YEARLY_DEFAULT_ORDER_FIELD, dir: YEARLY_DEFAULT_ORDER_DIR };
  }
  return { field, dir };
}

function safeAmount(v) {
  if (v == null) return 0;
  // Prisma Decimal serializes to string in some configurations; Number()
  // handles both number + numeric-string inputs.
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function yearKeyOf(createdAt) {
  if (createdAt == null) return "unknown";
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return String(d.getUTCFullYear());
}

router.get(
  "/suppliers/:id/payables/yearly",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Year-format validation runs BEFORE loadParentSupplier so invalid
      // bounds surface 400 without a DB round-trip.
      let fromYear = null;
      let toYear = null;
      if (req.query.from != null && req.query.from !== "") {
        const raw = String(req.query.from).trim();
        if (!YEAR_FORMAT_RE.test(raw)) {
          return res.status(400).json({
            error: "from must be a 4-digit year (YYYY)",
            code: "INVALID_YEAR_FORMAT",
          });
        }
        fromYear = raw;
      }
      if (req.query.to != null && req.query.to !== "") {
        const raw = String(req.query.to).trim();
        if (!YEAR_FORMAT_RE.test(raw)) {
          return res.status(400).json({
            error: "to must be a 4-digit year (YYYY)",
            code: "INVALID_YEAR_FORMAT",
          });
        }
        toYear = raw;
      }

      const { field: orderField, dir: orderDir } = parseYearlyOrderBy(req.query.orderBy);

      let limit = YEARLY_DEFAULT_LIMIT;
      if (req.query.limit != null && req.query.limit !== "") {
        const v = Number(req.query.limit);
        if (Number.isInteger(v) && v >= 1) {
          limit = Math.min(v, YEARLY_MAX_LIMIT);
        }
      }
      let offset = 0;
      if (req.query.offset != null && req.query.offset !== "") {
        const v = Number(req.query.offset);
        if (Number.isInteger(v) && v >= 0) {
          offset = v;
        }
      }

      const supplier = await loadParentSupplier(req, res);
      if (!supplier) return;

      const rows = await prisma.travelSupplierPayable.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
        },
        select: {
          id: true,
          createdAt: true,
          paidAt: true,
          amount: true,
        },
        take: YEARLY_MAX_ROWS,
      });

      // Aggregate per year.
      const byYear = new Map();
      for (const r of rows) {
        const yk = yearKeyOf(r.createdAt);
        if (!byYear.has(yk)) {
          byYear.set(yk, {
            year: yk,
            payableCount: 0,
            totalAmount: 0,
            paidAmount: 0,
            openAmount: 0,
          });
        }
        const bucket = byYear.get(yk);
        const amt = safeAmount(r.amount);
        bucket.payableCount += 1;
        bucket.totalAmount = Math.round((bucket.totalAmount + amt + Number.EPSILON) * 100) / 100;
        if (r.paidAt != null) {
          bucket.paidAmount = Math.round((bucket.paidAmount + amt + Number.EPSILON) * 100) / 100;
        } else {
          bucket.openAmount = Math.round((bucket.openAmount + amt + Number.EPSILON) * 100) / 100;
        }
      }

      // Apply from/to filter (string compare — "2026" >= "2024" is correct
      // for YYYY zero-padded strings; "unknown" is excluded from any
      // bounded window since it doesn't satisfy /^\d{4}$/).
      let years = Array.from(byYear.values());
      if (fromYear) years = years.filter((y) => y.year !== "unknown" && y.year >= fromYear);
      if (toYear) years = years.filter((y) => y.year !== "unknown" && y.year <= toYear);

      // Sort AFTER filter, BEFORE pagination. Lexicographic for `year`
      // (numeric YYYY sorts correctly as strings; "unknown" sorts after
      // numeric in ASC, before in DESC).
      years.sort((a, b) => {
        let cmp;
        if (orderField === "year") {
          cmp = a.year < b.year ? -1 : a.year > b.year ? 1 : 0;
        } else {
          // numeric fields
          const av = a[orderField];
          const bv = b[orderField];
          cmp = av < bv ? -1 : av > bv ? 1 : 0;
        }
        return orderDir === "desc" ? -cmp : cmp;
      });

      const totalYears = years.length;

      // Compute grand totals over the filtered window (BEFORE pagination
      // so the grand totals reflect the full filtered set, not just the
      // current page).
      let grandTotalAmount = 0;
      let grandPaidAmount = 0;
      let grandOpenAmount = 0;
      for (const y of years) {
        grandTotalAmount = Math.round((grandTotalAmount + y.totalAmount + Number.EPSILON) * 100) / 100;
        grandPaidAmount = Math.round((grandPaidAmount + y.paidAmount + Number.EPSILON) * 100) / 100;
        grandOpenAmount = Math.round((grandOpenAmount + y.openAmount + Number.EPSILON) * 100) / 100;
      }

      // Paginate.
      const paged = years.slice(offset, offset + limit);

      res.json({
        supplierId: supplier.id,
        supplierName: supplier.name,
        years: paged,
        totalYears,
        grandTotalAmount,
        grandPaidAmount,
        grandOpenAmount,
        limit,
        offset,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-sup] per-supplier yearly rollup error:", e.message);
      res.status(500).json({ error: "Failed to build per-supplier yearly rollup" });
    }
  },
);

// ─── PRD_TRAVEL_SUPPLIER_MASTER G038 — KYC + onboarding checklist ─────
//
// Per FR-3.1.h, every TravelSupplier gets a 1-to-1 KYC record + a default
// onboarding checklist (pan_card / gstin_cert / bank_proof / iata_cert
// (flight suppliers only) / contract / insurance).
//
// PAN encryption: stored via backend/lib/fieldEncryption.js (AES-256-GCM,
// no-op when WELLNESS_FIELD_KEY isn't set). The list/detail endpoints
// return the masked form (last-4 visible).
//
// State flow on the KYC top-level status:
//   pending   → submitted (POST /:id/kyc/submit, ADMIN/MANAGER)
//   submitted → verified  (POST /:id/kyc/verify, ADMIN only)
//   submitted → rejected  (POST /:id/kyc/reject, ADMIN only, with reason)
//   rejected  → submitted (re-submit via /submit)

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function assertValidPan(p) {
  if (p == null || p === "") return;
  if (typeof p !== "string" || !PAN_REGEX.test(p.toUpperCase())) {
    const err = new Error("panNumber must match Indian PAN format: AAAAA9999A");
    err.status = 400;
    err.code = "INVALID_PAN";
    throw err;
  }
}

function maskPan(plain) {
  if (!plain || typeof plain !== "string" || plain.length < 4) return null;
  const tail = plain.slice(-4);
  return `XXXXX${tail.padStart(5, "X")}`.slice(0, 10);
}

function defaultChecklistSeed(supplierCategory) {
  const items = [
    { itemKey: "pan_card",   itemLabel: "PAN card",          required: true, sortOrder: 0 },
    { itemKey: "gstin_cert", itemLabel: "GSTIN certificate", required: true, sortOrder: 1 },
    { itemKey: "bank_proof", itemLabel: "Bank account proof", required: true, sortOrder: 2 },
  ];
  if (supplierCategory === "flight") {
    items.push({ itemKey: "iata_cert", itemLabel: "IATA certificate", required: true, sortOrder: 3 });
  }
  items.push({ itemKey: "contract",  itemLabel: "Signed contract",         required: true,  sortOrder: 4 });
  items.push({ itemKey: "insurance", itemLabel: "Insurance certificate",   required: false, sortOrder: 5 });
  return items;
}

async function loadSupplierForKyc(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const supplier = await prisma.travelSupplier.findFirst({
    where: { id, tenantId: req.travelTenant.id },
  });
  if (!supplier) {
    const err = new Error("Supplier not found");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, supplier.subBrand)) {
    const err = new Error("Sub-brand access denied");
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
  return supplier;
}

function projectKyc(kyc, checklistItems) {
  if (!kyc) return null;
  return {
    id: kyc.id,
    supplierId: kyc.supplierId,
    status: kyc.status,
    panNumberMasked: kyc.panNumber ? maskPan(decrypt(kyc.panNumber)) : null,
    panOnFile: Boolean(kyc.panNumber),
    gstinVerified: kyc.gstinVerified,
    bankAccountVerified: kyc.bankAccountVerified,
    iataNumber: kyc.iataNumber,
    iataExpiry: kyc.iataExpiry,
    tafiNumber: kyc.tafiNumber,
    contractSigned: kyc.contractSigned,
    contractSignedAt: kyc.contractSignedAt,
    contractDocumentUrl: kyc.contractDocumentUrl,
    submittedAt: kyc.submittedAt,
    verifiedAt: kyc.verifiedAt,
    verifiedBy: kyc.verifiedBy,
    rejectedAt: kyc.rejectedAt,
    rejectionReason: kyc.rejectionReason,
    notes: kyc.notes,
    createdAt: kyc.createdAt,
    updatedAt: kyc.updatedAt,
    checklistItems: (checklistItems || []).map((i) => ({
      id: i.id,
      itemKey: i.itemKey,
      itemLabel: i.itemLabel,
      required: i.required,
      status: i.status,
      documentUrl: i.documentUrl,
      notes: i.notes,
      submittedAt: i.submittedAt,
      verifiedAt: i.verifiedAt,
      verifiedBy: i.verifiedBy,
      sortOrder: i.sortOrder,
    })),
  };
}

// GET /api/travel/suppliers/:id/kyc — read KYC + checklist.
router.get(
  "/suppliers/:id/kyc",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.json({ supplierId: supplier.id, kyc: null });
      }
      const checklistItems = await prisma.travelSupplierKycChecklistItem.findMany({
        where: { kycId: kyc.id, tenantId: req.travelTenant.id },
        orderBy: { sortOrder: "asc" },
      });
      res.json({ supplierId: supplier.id, kyc: projectKyc(kyc, checklistItems) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc get error:", e.message);
      res.status(500).json({ error: "Failed to load KYC record" });
    }
  },
);

// POST /api/travel/suppliers/:id/kyc — initialize KYC record + seed default
// checklist. Idempotent.
router.post(
  "/suppliers/:id/kyc",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "write"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const existing = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (existing) {
        const checklistItems = await prisma.travelSupplierKycChecklistItem.findMany({
          where: { kycId: existing.id, tenantId: req.travelTenant.id },
          orderBy: { sortOrder: "asc" },
        });
        return res.json({
          supplierId: supplier.id,
          kyc: projectKyc(existing, checklistItems),
          alreadyInitialised: true,
        });
      }
      const created = await prisma.travelSupplierKyc.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
          status: "pending",
        },
      });
      const seed = defaultChecklistSeed(supplier.supplierCategory);
      const checklistItems = [];
      for (const item of seed) {
        const row = await prisma.travelSupplierKycChecklistItem.create({
          data: {
            tenantId: req.travelTenant.id,
            kycId: created.id,
            itemKey: item.itemKey,
            itemLabel: item.itemLabel,
            required: item.required,
            sortOrder: item.sortOrder,
          },
        });
        checklistItems.push(row);
      }
      await writeAudit(
        "TravelSupplierKyc",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: supplier.id, seededItems: checklistItems.length },
      );
      res.status(201).json({ supplierId: supplier.id, kyc: projectKyc(created, checklistItems) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc init error:", e.message);
      res.status(500).json({ error: "Failed to initialize KYC" });
    }
  },
);

// PUT /api/travel/suppliers/:id/kyc — update editable KYC fields.
router.put(
  "/suppliers/:id/kyc",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.status(404).json({ error: "KYC not initialised; POST first", code: "KYC_NOT_INITIALISED" });
      }
      const {
        panNumber, gstinVerified, bankAccountVerified,
        iataNumber, iataExpiry, tafiNumber,
        contractSigned, contractSignedAt, contractDocumentUrl,
        notes,
      } = req.body || {};

      const data = {};
      if (panNumber !== undefined) {
        if (panNumber == null || panNumber === "") {
          data.panNumber = null;
        } else {
          assertValidPan(panNumber);
          data.panNumber = encrypt(String(panNumber).toUpperCase());
        }
      }
      if (gstinVerified !== undefined) data.gstinVerified = Boolean(gstinVerified);
      if (bankAccountVerified !== undefined) data.bankAccountVerified = Boolean(bankAccountVerified);
      if (iataNumber !== undefined) data.iataNumber = iataNumber ? String(iataNumber) : null;
      if (iataExpiry !== undefined) data.iataExpiry = iataExpiry ? new Date(iataExpiry) : null;
      if (tafiNumber !== undefined) data.tafiNumber = tafiNumber ? String(tafiNumber) : null;
      if (contractSigned !== undefined) data.contractSigned = Boolean(contractSigned);
      if (contractSignedAt !== undefined) data.contractSignedAt = contractSignedAt ? new Date(contractSignedAt) : null;
      if (contractDocumentUrl !== undefined) data.contractDocumentUrl = contractDocumentUrl ? String(contractDocumentUrl) : null;
      if (notes !== undefined) data.notes = notes ? String(notes) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelSupplierKyc.update({
        where: { id: kyc.id },
        data,
      });
      const checklistItems = await prisma.travelSupplierKycChecklistItem.findMany({
        where: { kycId: updated.id, tenantId: req.travelTenant.id },
        orderBy: { sortOrder: "asc" },
      });
      await writeAudit(
        "TravelSupplierKyc",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data), panChanged: data.panNumber !== undefined },
      );
      res.json({ supplierId: supplier.id, kyc: projectKyc(updated, checklistItems) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc update error:", e.message);
      res.status(500).json({ error: "Failed to update KYC" });
    }
  },
);

// POST /api/travel/suppliers/:id/kyc/submit
router.post(
  "/suppliers/:id/kyc/submit",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.status(404).json({ error: "KYC not initialised", code: "KYC_NOT_INITIALISED" });
      }
      if (kyc.status === "submitted" || kyc.status === "verified") {
        return res.status(409).json({
          error: `Cannot submit from status=${kyc.status}`,
          code: "INVALID_STATE_TRANSITION",
        });
      }
      const updated = await prisma.travelSupplierKyc.update({
        where: { id: kyc.id },
        data: {
          status: "submitted",
          submittedAt: new Date(),
          rejectedAt: null,
          rejectionReason: null,
        },
      });
      await writeAudit(
        "TravelSupplierKyc",
        "SUBMIT",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { previousStatus: kyc.status },
      );
      res.json({
        supplierId: supplier.id,
        status: updated.status,
        submittedAt: updated.submittedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc submit error:", e.message);
      res.status(500).json({ error: "Failed to submit KYC" });
    }
  },
);

// POST /api/travel/suppliers/:id/kyc/verify
router.post(
  "/suppliers/:id/kyc/verify",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.status(404).json({ error: "KYC not initialised", code: "KYC_NOT_INITIALISED" });
      }
      if (kyc.status !== "submitted") {
        return res.status(409).json({
          error: `Can only verify from status=submitted (was ${kyc.status})`,
          code: "INVALID_STATE_TRANSITION",
        });
      }
      const updated = await prisma.travelSupplierKyc.update({
        where: { id: kyc.id },
        data: {
          status: "verified",
          verifiedAt: new Date(),
          verifiedBy: req.user.userId,
        },
      });
      await writeAudit(
        "TravelSupplierKyc",
        "VERIFY",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { verifiedBy: req.user.userId },
      );
      res.json({
        supplierId: supplier.id,
        status: updated.status,
        verifiedAt: updated.verifiedAt,
        verifiedBy: updated.verifiedBy,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc verify error:", e.message);
      res.status(500).json({ error: "Failed to verify KYC" });
    }
  },
);

// POST /api/travel/suppliers/:id/kyc/reject
router.post(
  "/suppliers/:id/kyc/reject",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const { rejectionReason } = req.body || {};
      if (!rejectionReason || !String(rejectionReason).trim()) {
        return res.status(400).json({ error: "rejectionReason required", code: "MISSING_FIELDS" });
      }
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.status(404).json({ error: "KYC not initialised", code: "KYC_NOT_INITIALISED" });
      }
      if (kyc.status !== "submitted") {
        return res.status(409).json({
          error: `Can only reject from status=submitted (was ${kyc.status})`,
          code: "INVALID_STATE_TRANSITION",
        });
      }
      const updated = await prisma.travelSupplierKyc.update({
        where: { id: kyc.id },
        data: {
          status: "rejected",
          rejectedAt: new Date(),
          rejectionReason: String(rejectionReason).trim(),
        },
      });
      await writeAudit(
        "TravelSupplierKyc",
        "REJECT",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { rejectionReason: updated.rejectionReason },
      );
      res.json({
        supplierId: supplier.id,
        status: updated.status,
        rejectedAt: updated.rejectedAt,
        rejectionReason: updated.rejectionReason,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc reject error:", e.message);
      res.status(500).json({ error: "Failed to reject KYC" });
    }
  },
);

// PUT /api/travel/suppliers/:id/kyc/checklist/:itemId
router.put(
  "/suppliers/:id/kyc/checklist/:itemId",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const itemId = parseInt(req.params.itemId, 10);
      if (!Number.isFinite(itemId)) {
        return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ID" });
      }
      const kyc = await prisma.travelSupplierKyc.findUnique({
        where: { supplierId: supplier.id },
      });
      if (!kyc) {
        return res.status(404).json({ error: "KYC not initialised", code: "KYC_NOT_INITIALISED" });
      }
      const item = await prisma.travelSupplierKycChecklistItem.findFirst({
        where: { id: itemId, kycId: kyc.id, tenantId: req.travelTenant.id },
      });
      if (!item) {
        return res.status(404).json({ error: "Checklist item not found", code: "NOT_FOUND" });
      }

      const { status, documentUrl, notes } = req.body || {};
      const VALID_ITEM_STATUS = ["pending", "submitted", "verified", "rejected"];
      const data = {};
      if (status !== undefined) {
        if (!VALID_ITEM_STATUS.includes(status)) {
          return res.status(400).json({
            error: `status must be one of: ${VALID_ITEM_STATUS.join(", ")}`,
            code: "INVALID_STATUS",
          });
        }
        if (status === "verified" && req.user.role !== "ADMIN") {
          return res.status(403).json({
            error: "Only ADMIN can mark items verified",
            code: "ADMIN_REQUIRED",
          });
        }
        data.status = status;
        if (status === "submitted") data.submittedAt = new Date();
        if (status === "verified") {
          data.verifiedAt = new Date();
          data.verifiedBy = req.user.userId;
        }
      }
      if (documentUrl !== undefined) data.documentUrl = documentUrl ? String(documentUrl) : null;
      if (notes !== undefined) data.notes = notes ? String(notes) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelSupplierKycChecklistItem.update({
        where: { id: item.id },
        data,
      });
      await writeAudit(
        "TravelSupplierKycChecklistItem",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { itemKey: item.itemKey, fields: Object.keys(data) },
      );
      res.json({
        supplierId: supplier.id,
        item: {
          id: updated.id,
          itemKey: updated.itemKey,
          itemLabel: updated.itemLabel,
          required: updated.required,
          status: updated.status,
          documentUrl: updated.documentUrl,
          notes: updated.notes,
          submittedAt: updated.submittedAt,
          verifiedAt: updated.verifiedAt,
          verifiedBy: updated.verifiedBy,
          sortOrder: updated.sortOrder,
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] kyc checklist update error:", e.message);
      res.status(500).json({ error: "Failed to update checklist item" });
    }
  },
);

// ─── PRD_TRAVEL_SUPPLIER_MASTER G039 — Dispute history + chargeback log ──
//
// Polymorphic ledger for disputes between operator and supplier.
//   - direction: outbound = operator → supplier; inbound = supplier → operator
//   - Optional payableId / invoiceId tie a dispute to a specific A/P entry
//     or customer invoice (customer-side chargeback).
//
// Status flow: open → in_review → resolved (or → rejected → escalated)

const VALID_DISPUTE_DIRECTION = ["outbound", "inbound"];
const VALID_DISPUTE_TYPE = [
  "service_failure", "overbill", "duplicate",
  "no_show", "refund_chargeback", "other",
];
const VALID_DISPUTE_STATUS = ["open", "in_review", "resolved", "rejected", "escalated"];

function assertValidDirection(d) {
  if (!VALID_DISPUTE_DIRECTION.includes(d)) {
    const err = new Error(`direction must be one of: ${VALID_DISPUTE_DIRECTION.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_DIRECTION";
    throw err;
  }
}

function assertValidType(t) {
  if (!VALID_DISPUTE_TYPE.includes(t)) {
    const err = new Error(`type must be one of: ${VALID_DISPUTE_TYPE.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_TYPE";
    throw err;
  }
}

function assertValidDisputeAmount(a) {
  const v = typeof a === "number" ? a : Number(a);
  if (!Number.isFinite(v) || v < 0) {
    const err = new Error("amount must be a non-negative number");
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
}

function projectDispute(d) {
  return {
    id: d.id,
    supplierId: d.supplierId,
    payableId: d.payableId,
    invoiceId: d.invoiceId,
    direction: d.direction,
    type: d.type,
    status: d.status,
    amount: d.amount,
    currency: d.currency,
    description: d.description,
    evidenceUrls: d.evidenceUrls,
    raisedBy: d.raisedBy,
    raisedAt: d.raisedAt,
    resolvedAt: d.resolvedAt,
    resolvedBy: d.resolvedBy,
    resolution: d.resolution,
    refundedAmount: d.refundedAmount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// POST /api/travel/suppliers/:id/disputes
router.post(
  "/suppliers/:id/disputes",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "write"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const {
        payableId, invoiceId,
        direction, type, amount, currency,
        description, evidenceUrls,
      } = req.body || {};

      if (!direction) {
        return res.status(400).json({ error: "direction required", code: "MISSING_FIELDS" });
      }
      assertValidDirection(direction);
      if (!type) {
        return res.status(400).json({ error: "type required", code: "MISSING_FIELDS" });
      }
      assertValidType(type);
      if (amount == null) {
        return res.status(400).json({ error: "amount required", code: "MISSING_FIELDS" });
      }
      assertValidDisputeAmount(amount);
      if (!description || !String(description).trim()) {
        return res.status(400).json({ error: "description required", code: "MISSING_FIELDS" });
      }

      if (payableId != null) {
        const pid = parseInt(payableId, 10);
        if (!Number.isFinite(pid)) {
          return res.status(400).json({ error: "payableId must be a number", code: "INVALID_ID" });
        }
        const payable = await prisma.travelSupplierPayable.findFirst({
          where: { id: pid, tenantId: req.travelTenant.id, supplierId: supplier.id },
          select: { id: true },
        });
        if (!payable) {
          return res.status(400).json({ error: "payableId not found for this supplier", code: "PAYABLE_NOT_FOUND" });
        }
      }
      if (invoiceId != null) {
        const iid = parseInt(invoiceId, 10);
        if (!Number.isFinite(iid)) {
          return res.status(400).json({ error: "invoiceId must be a number", code: "INVALID_ID" });
        }
        const invoice = await prisma.travelInvoice.findFirst({
          where: { id: iid, tenantId: req.travelTenant.id },
          select: { id: true },
        });
        if (!invoice) {
          return res.status(400).json({ error: "invoiceId not found", code: "INVOICE_NOT_FOUND" });
        }
      }

      let evidenceBlob = null;
      if (evidenceUrls !== undefined && evidenceUrls !== null) {
        if (!Array.isArray(evidenceUrls)) {
          return res.status(400).json({ error: "evidenceUrls must be an array of strings", code: "INVALID_EVIDENCE" });
        }
        if (evidenceUrls.some((u) => typeof u !== "string")) {
          return res.status(400).json({ error: "evidenceUrls must be an array of strings", code: "INVALID_EVIDENCE" });
        }
        evidenceBlob = JSON.stringify(evidenceUrls);
      }

      const created = await prisma.travelSupplierDispute.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: supplier.id,
          payableId: payableId != null ? parseInt(payableId, 10) : null,
          invoiceId: invoiceId != null ? parseInt(invoiceId, 10) : null,
          direction,
          type,
          status: "open",
          amount: String(amount),
          currency: currency ? String(currency) : "INR",
          description: String(description).trim(),
          evidenceUrls: evidenceBlob,
          raisedBy: req.user.userId,
        },
      });
      await writeAudit(
        "TravelSupplierDispute",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: supplier.id, direction, type, amount: String(amount) },
      );
      res.status(201).json(projectDispute(created));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute create error:", e.message);
      res.status(500).json({ error: "Failed to create dispute" });
    }
  },
);

// GET /api/travel/suppliers/:id/disputes
router.get(
  "/suppliers/:id/disputes",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const where = { tenantId: req.travelTenant.id, supplierId: supplier.id };
      if (req.query.status) {
        if (!VALID_DISPUTE_STATUS.includes(String(req.query.status))) {
          return res.status(400).json({ error: "invalid status filter", code: "INVALID_STATUS" });
        }
        where.status = String(req.query.status);
      }
      if (req.query.direction) {
        if (!VALID_DISPUTE_DIRECTION.includes(String(req.query.direction))) {
          return res.status(400).json({ error: "invalid direction filter", code: "INVALID_DIRECTION" });
        }
        where.direction = String(req.query.direction);
      }
      if (req.query.type) {
        if (!VALID_DISPUTE_TYPE.includes(String(req.query.type))) {
          return res.status(400).json({ error: "invalid type filter", code: "INVALID_TYPE" });
        }
        where.type = String(req.query.type);
      }
      const [total, rows] = await Promise.all([
        prisma.travelSupplierDispute.count({ where }),
        prisma.travelSupplierDispute.findMany({
          where,
          orderBy: [{ raisedAt: "desc" }],
          take: limit,
          skip: offset,
        }),
      ]);
      res.json({
        supplierId: supplier.id,
        disputes: rows.map(projectDispute),
        total,
        limit,
        offset,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute list error:", e.message);
      res.status(500).json({ error: "Failed to list disputes" });
    }
  },
);

// GET /api/travel/suppliers/:id/disputes/:disputeId
router.get(
  "/suppliers/:id/disputes/:disputeId",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const disputeId = parseInt(req.params.disputeId, 10);
      if (!Number.isFinite(disputeId)) {
        return res.status(400).json({ error: "disputeId must be a number", code: "INVALID_ID" });
      }
      const dispute = await prisma.travelSupplierDispute.findFirst({
        where: { id: disputeId, tenantId: req.travelTenant.id, supplierId: supplier.id },
      });
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found", code: "NOT_FOUND" });
      }
      res.json(projectDispute(dispute));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute get error:", e.message);
      res.status(500).json({ error: "Failed to get dispute" });
    }
  },
);

// PUT /api/travel/suppliers/:id/disputes/:disputeId
router.put(
  "/suppliers/:id/disputes/:disputeId",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const disputeId = parseInt(req.params.disputeId, 10);
      if (!Number.isFinite(disputeId)) {
        return res.status(400).json({ error: "disputeId must be a number", code: "INVALID_ID" });
      }
      const dispute = await prisma.travelSupplierDispute.findFirst({
        where: { id: disputeId, tenantId: req.travelTenant.id, supplierId: supplier.id },
      });
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found", code: "NOT_FOUND" });
      }
      if (dispute.status === "resolved" || dispute.status === "rejected") {
        return res.status(409).json({
          error: `Cannot edit a ${dispute.status} dispute`,
          code: "DISPUTE_CLOSED",
        });
      }
      const { status, type, description, evidenceUrls, amount } = req.body || {};
      const data = {};
      if (status !== undefined) {
        if (!["open", "in_review"].includes(status)) {
          return res.status(400).json({
            error: "status here may only flip between open and in_review",
            code: "INVALID_STATUS_TRANSITION",
          });
        }
        data.status = status;
      }
      if (type !== undefined) {
        assertValidType(type);
        data.type = type;
      }
      if (description !== undefined) {
        if (!String(description).trim()) {
          return res.status(400).json({ error: "description must be non-empty", code: "INVALID_DESCRIPTION" });
        }
        data.description = String(description).trim();
      }
      if (amount !== undefined) {
        assertValidDisputeAmount(amount);
        data.amount = String(amount);
      }
      if (evidenceUrls !== undefined) {
        if (evidenceUrls === null) {
          data.evidenceUrls = null;
        } else {
          if (!Array.isArray(evidenceUrls) || evidenceUrls.some((u) => typeof u !== "string")) {
            return res.status(400).json({ error: "evidenceUrls must be an array of strings", code: "INVALID_EVIDENCE" });
          }
          data.evidenceUrls = JSON.stringify(evidenceUrls);
        }
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelSupplierDispute.update({
        where: { id: dispute.id },
        data,
      });
      await writeAudit(
        "TravelSupplierDispute",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );
      res.json(projectDispute(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute update error:", e.message);
      res.status(500).json({ error: "Failed to update dispute" });
    }
  },
);

// POST /api/travel/suppliers/:id/disputes/:disputeId/resolve
router.post(
  "/suppliers/:id/disputes/:disputeId/resolve",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const disputeId = parseInt(req.params.disputeId, 10);
      if (!Number.isFinite(disputeId)) {
        return res.status(400).json({ error: "disputeId must be a number", code: "INVALID_ID" });
      }
      const dispute = await prisma.travelSupplierDispute.findFirst({
        where: { id: disputeId, tenantId: req.travelTenant.id, supplierId: supplier.id },
      });
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found", code: "NOT_FOUND" });
      }
      if (["resolved", "rejected"].includes(dispute.status)) {
        return res.status(409).json({
          error: `Cannot resolve a ${dispute.status} dispute`,
          code: "DISPUTE_CLOSED",
        });
      }
      const { resolution, refundedAmount, rejected } = req.body || {};
      if (!resolution || !String(resolution).trim()) {
        return res.status(400).json({ error: "resolution required", code: "MISSING_FIELDS" });
      }
      if (refundedAmount != null) {
        assertValidDisputeAmount(refundedAmount);
      }
      const newStatus = rejected ? "rejected" : "resolved";
      const updated = await prisma.travelSupplierDispute.update({
        where: { id: dispute.id },
        data: {
          status: newStatus,
          resolvedAt: new Date(),
          resolvedBy: req.user.userId,
          resolution: String(resolution).trim(),
          refundedAmount: refundedAmount != null ? String(refundedAmount) : null,
        },
      });
      await writeAudit(
        "TravelSupplierDispute",
        newStatus === "rejected" ? "REJECT" : "RESOLVE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { resolvedBy: req.user.userId, refundedAmount: refundedAmount != null ? String(refundedAmount) : null },
      );
      res.json(projectDispute(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute resolve error:", e.message);
      res.status(500).json({ error: "Failed to resolve dispute" });
    }
  },
);

// POST /api/travel/suppliers/:id/disputes/:disputeId/escalate
router.post(
  "/suppliers/:id/disputes/:disputeId/escalate",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "update"),
  async (req, res) => {
    try {
      const supplier = await loadSupplierForKyc(req);
      const disputeId = parseInt(req.params.disputeId, 10);
      if (!Number.isFinite(disputeId)) {
        return res.status(400).json({ error: "disputeId must be a number", code: "INVALID_ID" });
      }
      const dispute = await prisma.travelSupplierDispute.findFirst({
        where: { id: disputeId, tenantId: req.travelTenant.id, supplierId: supplier.id },
      });
      if (!dispute) {
        return res.status(404).json({ error: "Dispute not found", code: "NOT_FOUND" });
      }
      if (["resolved", "rejected", "escalated"].includes(dispute.status)) {
        return res.status(409).json({
          error: `Cannot escalate from status=${dispute.status}`,
          code: "INVALID_STATE_TRANSITION",
        });
      }
      const updated = await prisma.travelSupplierDispute.update({
        where: { id: dispute.id },
        data: { status: "escalated" },
      });
      await writeAudit(
        "TravelSupplierDispute",
        "ESCALATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { previousStatus: dispute.status },
      );
      res.json(projectDispute(updated));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup] dispute escalate error:", e.message);
      res.status(500).json({ error: "Failed to escalate dispute" });
    }
  },
);

// GET /api/travel/disputes/stats — tenant-wide rollup.
router.get(
  "/disputes/stats",
  verifyToken,
  requireTravelTenant,
  requirePermission("suppliers", "read"),
  async (req, res) => {
    try {
      const all = await prisma.travelSupplierDispute.findMany({
        where: { tenantId: req.travelTenant.id },
        select: { status: true, amount: true, raisedAt: true, resolvedAt: true },
      });
      const byStatus = { open: 0, in_review: 0, resolved: 0, rejected: 0, escalated: 0 };
      let openAmount = 0;
      let openCount = 0;
      let resolvedDays = 0;
      let resolvedCount = 0;
      for (const d of all) {
        if (byStatus[d.status] !== undefined) byStatus[d.status] += 1;
        if (d.status === "open" || d.status === "in_review" || d.status === "escalated") {
          openCount += 1;
          openAmount = Math.round((openAmount + Number(d.amount) + Number.EPSILON) * 100) / 100;
        }
        if (d.resolvedAt && (d.status === "resolved" || d.status === "rejected")) {
          const ms = new Date(d.resolvedAt).getTime() - new Date(d.raisedAt).getTime();
          resolvedDays += ms / 86_400_000;
          resolvedCount += 1;
        }
      }
      const avgResolutionDays = resolvedCount > 0
        ? Math.round((resolvedDays / resolvedCount) * 100) / 100
        : null;
      res.json({
        byStatus,
        openCount,
        openAmount,
        resolvedCount,
        avgResolutionDays,
        total: all.length,
      });
    } catch (e) {
      console.error("[travel-sup] dispute stats error:", e.message);
      res.status(500).json({ error: "Failed to compute dispute stats" });
    }
  },
);

module.exports = router;
