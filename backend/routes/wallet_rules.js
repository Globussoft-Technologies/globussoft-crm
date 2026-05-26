// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 slice 5b (admin bonus-rule CRUD).
 *
 * PRD: docs/PRD_WALLET_TOPUP.md §3.6 (admin rules CRUD).
 *
 * Backs the frontend admin page `frontend/src/pages/admin/WalletRules.jsx`
 * (scaffolded last tick, commit c8326773) which currently 404s against
 * /api/wallet/rules — this slice ships the route so the page starts
 * working.
 *
 * Surface
 * ───────
 *   GET    /api/wallet/rules                     ADMIN/MANAGER list
 *   GET    /api/wallet/rules?includeInactive=1   includes inactive rows
 *   POST   /api/wallet/rules                     ADMIN-only create
 *   PUT    /api/wallet/rules/:id                 ADMIN-only update
 *   DELETE /api/wallet/rules/:id                 ADMIN-only SOFT-delete
 *                                                (sets active=false; the
 *                                                row stays referenced by
 *                                                WalletCreditBatch.sourceRuleId
 *                                                so we never hard-delete).
 *
 * Schema (WalletBonusRule, schema.prisma:3563+ tick #1 commit 37db68e6):
 *   id, tenantId, name (VarChar 100), minAmountCents, bonusPercent
 *   (Decimal(5,2)), validityMonths, active (default true), validFrom?,
 *   validTo?, createdAt, updatedAt.
 *
 * Validation (mirrored from frontend WalletRules.jsx client-side guard
 * for fast-fail symmetry):
 *   name           — 1..100 chars after trim
 *   minAmountCents — integer > 0 (0 means "always trigger" which the PRD
 *                    explicitly disallows — every rule needs a threshold)
 *   bonusPercent   — number 0..100 (0 allowed for "placeholder" rule rows)
 *   validityMonths — integer 1..60 (5-year hard ceiling; auditor-friendly)
 *
 * RBAC:
 *   GET                — verifyToken + role ∈ {ADMIN, MANAGER}
 *   POST / PUT / DELETE — verifyToken + verifyRole(['ADMIN'])
 *
 * Always tenant-scoped via req.user.tenantId. Cross-tenant probes return
 * 404 (matches the wallet.js read-pattern; never leaks the existence of
 * a rule that lives in a different tenant).
 *
 * Audit:
 *   POST   → WALLET_RULE_CREATED       (entity 'WalletBonusRule', entityId = new row id)
 *   PUT    → WALLET_RULE_UPDATED       (details: { before, after, changed: [keys] })
 *   DELETE → WALLET_RULE_DEACTIVATED   (details: { name, deactivatedFrom: true })
 *   GET reads do NOT audit (low-sensitivity config table; PHI lives one
 *   layer up in routes/wallet.js where balance reads DO audit).
 *
 * Mount order in server.js MUST come BEFORE `app.use('/api/wallet', ...)`
 * so that `/api/wallet/rules` doesn't get caught by the `:patientId`
 * dynamic segment in routes/wallet.js (which would parse 'rules' as a
 * patientId and trip an "Invalid patientId" 400).
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

const tenantWhere = (req, extra = {}) => ({
  tenantId: req.user.tenantId,
  ...extra,
});

/**
 * Permissive read-role gate — ADMIN / MANAGER can list bonus rules. The
 * page is operator-facing config; non-managers don't see it in the sidebar
 * but we still defend at the route layer.
 */
const readRoleGate = (req, res, next) => {
  if (!req.user) {
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!["ADMIN", "MANAGER"].includes(req.user.role)) {
    return res.status(403).json({
      error: "You don't have permission to perform this action. Contact your administrator.",
      code: "RBAC_DENIED",
    });
  }
  return next();
};

/**
 * Shared field validator used by both POST (require all four core fields)
 * and PUT (each field optional but each presented value must validate).
 * Returns `null` on success or `{ field, error }` on first failure.
 *
 * `partial=true` lets PUT omit fields; POST always supplies all four.
 */
function validateRuleFields(input, { partial = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has("name")) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length < 1 || name.length > 100) {
      return { field: "name", error: "name must be 1-100 characters" };
    }
  }
  if (!partial || has("minAmountCents")) {
    const n = Number(input.minAmountCents);
    if (!Number.isInteger(n) || n <= 0) {
      return { field: "minAmountCents", error: "minAmountCents must be a positive integer" };
    }
  }
  if (!partial || has("bonusPercent")) {
    const n = Number(input.bonusPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { field: "bonusPercent", error: "bonusPercent must be between 0 and 100" };
    }
  }
  if (!partial || has("validityMonths")) {
    const n = Number(input.validityMonths);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return { field: "validityMonths", error: "validityMonths must be an integer 1-60" };
    }
  }
  // Optional dates (best-effort parse; reject only on malformed strings).
  if (has("validFrom") && input.validFrom !== null && input.validFrom !== undefined) {
    const d = new Date(input.validFrom);
    if (Number.isNaN(d.getTime())) {
      return { field: "validFrom", error: "validFrom must be a valid date" };
    }
  }
  if (has("validTo") && input.validTo !== null && input.validTo !== undefined) {
    const d = new Date(input.validTo);
    if (Number.isNaN(d.getTime())) {
      return { field: "validTo", error: "validTo must be a valid date" };
    }
  }
  return null;
}

/**
 * GET /api/wallet/rules?includeInactive=0|1
 * Returns { rules: WalletBonusRule[] } scoped to caller's tenant.
 * Default lists only active=true rows; ?includeInactive=1 includes
 * soft-deleted ones (for the admin "show all" toggle).
 */
router.get("/", verifyToken, readRoleGate, async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || "") === "1";
    const where = includeInactive ? tenantWhere(req) : tenantWhere(req, { active: true });
    const rules = await prisma.walletBonusRule.findMany({
      where,
      orderBy: [{ active: "desc" }, { bonusPercent: "desc" }, { id: "desc" }],
    });
    return res.json({ rules });
  } catch (e) {
    console.error("[wallet_rules] list error:", e.message);
    return res.status(500).json({ error: "Failed to list wallet bonus rules" });
  }
});

/**
 * POST /api/wallet/rules
 * ADMIN-only. Body: { name, minAmountCents, bonusPercent, validityMonths,
 *                     active?, validFrom?, validTo? }
 * → 201 { rule }
 */
router.post("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const v = validateRuleFields(req.body, { partial: false });
    if (v) return res.status(400).json({ error: v.error, field: v.field });

    const name = String(req.body.name).trim();
    const created = await prisma.walletBonusRule.create({
      data: {
        tenantId: req.user.tenantId,
        name,
        minAmountCents: Number(req.body.minAmountCents),
        bonusPercent: Number(req.body.bonusPercent),
        validityMonths: Number(req.body.validityMonths),
        active: req.body.active === undefined ? true : Boolean(req.body.active),
        validFrom: req.body.validFrom ? new Date(req.body.validFrom) : null,
        validTo: req.body.validTo ? new Date(req.body.validTo) : null,
      },
    });

    writeAudit(
      "WalletBonusRule",
      "WALLET_RULE_CREATED",
      created.id,
      req.user.userId,
      req.user.tenantId,
      {
        name: created.name,
        minAmountCents: created.minAmountCents,
        bonusPercent: created.bonusPercent,
        validityMonths: created.validityMonths,
      },
    ).catch((auditErr) => {
      console.warn("[wallet_rules] audit WALLET_RULE_CREATED failed:", auditErr.message);
    });

    return res.status(201).json({ rule: created });
  } catch (e) {
    console.error("[wallet_rules] create error:", e.message);
    return res.status(500).json({ error: "Failed to create wallet bonus rule" });
  }
});

/**
 * PUT /api/wallet/rules/:id
 * ADMIN-only. Partial-update. Tenant-scoped lookup; 404 if not found in
 * caller's tenant (cross-tenant probes can't see the row).
 */
router.put("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid rule id" });
    }

    const v = validateRuleFields(req.body, { partial: true });
    if (v) return res.status(400).json({ error: v.error, field: v.field });

    const before = await prisma.walletBonusRule.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!before) return res.status(404).json({ error: "Wallet bonus rule not found" });

    /** @type {Record<string, any>} */
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.minAmountCents !== undefined)
      data.minAmountCents = Number(req.body.minAmountCents);
    if (req.body.bonusPercent !== undefined) data.bonusPercent = Number(req.body.bonusPercent);
    if (req.body.validityMonths !== undefined)
      data.validityMonths = Number(req.body.validityMonths);
    if (req.body.active !== undefined) data.active = Boolean(req.body.active);
    if (req.body.validFrom !== undefined)
      data.validFrom = req.body.validFrom === null ? null : new Date(req.body.validFrom);
    if (req.body.validTo !== undefined)
      data.validTo = req.body.validTo === null ? null : new Date(req.body.validTo);

    const updated = await prisma.walletBonusRule.update({
      where: { id },
      data,
    });

    const changed = Object.keys(data);
    writeAudit(
      "WalletBonusRule",
      "WALLET_RULE_UPDATED",
      id,
      req.user.userId,
      req.user.tenantId,
      { changed, before: pickAuditFields(before), after: pickAuditFields(updated) },
    ).catch((auditErr) => {
      console.warn("[wallet_rules] audit WALLET_RULE_UPDATED failed:", auditErr.message);
    });

    return res.json({ rule: updated });
  } catch (e) {
    console.error("[wallet_rules] update error:", e.message);
    return res.status(500).json({ error: "Failed to update wallet bonus rule" });
  }
});

/**
 * DELETE /api/wallet/rules/:id
 * ADMIN-only SOFT-delete — flips active=false. WalletCreditBatch rows
 * reference rules via sourceRuleId so hard-delete is forbidden (would
 * break the audit chain for already-issued bonus batches).
 *
 * Idempotent: deleting an already-inactive rule is a no-op 200, not 404
 * (the row still exists; "delete" is just "make inactive" here).
 */
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid rule id" });
    }

    const before = await prisma.walletBonusRule.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!before) return res.status(404).json({ error: "Wallet bonus rule not found" });

    if (before.active === false) {
      // Already deactivated — return current state without re-firing audit.
      return res.json({ rule: before, alreadyInactive: true });
    }

    const updated = await prisma.walletBonusRule.update({
      where: { id },
      data: { active: false },
    });

    writeAudit(
      "WalletBonusRule",
      "WALLET_RULE_DEACTIVATED",
      id,
      req.user.userId,
      req.user.tenantId,
      { name: before.name, deactivatedFrom: true },
    ).catch((auditErr) => {
      console.warn("[wallet_rules] audit WALLET_RULE_DEACTIVATED failed:", auditErr.message);
    });

    return res.json({ rule: updated });
  } catch (e) {
    console.error("[wallet_rules] delete error:", e.message);
    return res.status(500).json({ error: "Failed to deactivate wallet bonus rule" });
  }
});

/**
 * Audit-payload helper — keep audit `details` rows small + structured.
 * Mirrors the diffFields shape used elsewhere in the codebase (lib/audit.js).
 */
function pickAuditFields(row) {
  if (!row) return null;
  return {
    name: row.name,
    minAmountCents: row.minAmountCents,
    bonusPercent: row.bonusPercent,
    validityMonths: row.validityMonths,
    active: row.active,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

module.exports = router;
