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
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
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
  verifyRole(["ADMIN"]),
  requireTravelTenant,
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
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
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

module.exports = router;
