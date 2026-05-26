/**
 * /api/tenant-settings — TenantSetting CRUD (admin override surface for the per-tenant cap pattern)
 *
 * Backs the operator UI (frontend page is a follow-up tick) for setting
 * per-tenant budget cap overrides that override the env-var defaults declared
 * in backend/lib/tenantSettings.js KEYS + DEFAULTS.
 *
 * Cross-cutting cap pattern resolved 2026-05-24 (DECISIONS_TRACKER commit
 * a8f24ca). Consumers using getBudgetCap:
 *   - backend/lib/llmRouter.js (live, commit cb0901f)
 *   - backend/services/adsGptClient.js (stub, commit 9f35040)
 *   - backend/services/ratehawkClient.js (stub, commit 2852b82)
 *   - backend/services/callifiedClient.js (stub, commit 9ec52df)
 *
 * Auth model: GET open to any authenticated user (operators can see caps);
 * PUT/DELETE ADMIN-only (cap changes are tenant-config changes).
 *
 * No sub-brand isolation: TenantSetting rows are tenant-wide.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { KEYS, DEFAULTS, setSetting } = require("../lib/tenantSettings");
const { writeAudit } = require("../lib/audit");

const ALLOWED_KEYS = Object.values(KEYS);

function isKnownKey(key) {
  return ALLOWED_KEYS.includes(key);
}

// Default category inference: budgetCap_* rows belong to "budget"; other
// keys default to "general". Callers may override via body.category.
function defaultCategoryFor(key) {
  if (typeof key === "string" && key.startsWith("budgetCap_")) return "budget";
  return "general";
}

// ─── GET / — list all overrides for caller's tenant + defaults map ────
//
// Returns BOTH the active rows AND the env-var defaults so the operator
// UI can show "currently overridden" vs "running on default" per key in a
// single response (no second round trip).
router.get("/", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rows = await prisma.tenantSetting.findMany({
      where: { tenantId },
      select: { key: true, value: true, category: true },
      orderBy: [{ category: "asc" }, { key: "asc" }],
    });
    res.json({
      settings: rows,
      defaults: { ...DEFAULTS },
      allowedKeys: ALLOWED_KEYS,
    });
  } catch (e) {
    console.error("[tenant-settings] list error:", e.message);
    res.status(500).json({ error: "Failed to list tenant settings" });
  }
});

// ─── GET /:key — single setting; returns default if no row exists ────
//
// `isOverride: true` means a TenantSetting row exists and is in force;
// `false` means the response reflects the env-var default.
router.get("/:key", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const key = String(req.params.key);
    const defaultValue = DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;

    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { key: true, value: true, category: true },
    });

    if (!row) {
      return res.json({
        key,
        value: defaultValue == null ? null : String(defaultValue),
        defaultValue,
        isOverride: false,
        category: defaultCategoryFor(key),
      });
    }
    res.json({
      key: row.key,
      value: row.value,
      defaultValue,
      isOverride: true,
      category: row.category,
    });
  } catch (e) {
    console.error("[tenant-settings] get error:", e.message);
    res.status(500).json({ error: "Failed to get tenant setting" });
  }
});

// ─── PUT /:key — upsert (ADMIN only) ──────────────────────────────────
//
// Body: { value, category? }. Validates `key` against the helper's KEYS
// allowlist. Audit writes capture { key, oldValue, newValue } so a chain
// reader can see exactly what changed.
router.put("/:key", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const key = String(req.params.key);

    if (!isKnownKey(key)) {
      return res.status(400).json({
        error: `Unknown setting key. Allowed: ${ALLOWED_KEYS.join(", ")}`,
        code: "INVALID_SETTING_KEY",
        allowedKeys: ALLOWED_KEYS,
      });
    }

    const body = req.body || {};
    if (body.value === undefined || body.value === null || body.value === "") {
      return res.status(400).json({
        error: "value is required",
        code: "MISSING_VALUE",
      });
    }

    // Look up the prior value for audit details (and to decide
    // CREATE vs UPDATE action).
    const prior = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { value: true },
    });

    const category = body.category ? String(body.category) : defaultCategoryFor(key);
    const updated = await setSetting(tenantId, key, body.value, { category });

    await writeAudit(
      "TenantSetting",
      prior ? "UPDATE" : "CREATE",
      updated.id,
      req.user.userId,
      tenantId,
      {
        key,
        oldValue: prior ? prior.value : null,
        newValue: String(body.value),
      },
    );

    res.json({
      key: updated.key,
      value: updated.value,
      defaultValue: DEFAULTS[key] !== undefined ? DEFAULTS[key] : null,
      isOverride: true,
      category: updated.category,
    });
  } catch (e) {
    console.error("[tenant-settings] put error:", e.message);
    res.status(500).json({ error: "Failed to set tenant setting" });
  }
});

// ─── DELETE /:key — remove override (ADMIN only) ─────────────────────
//
// 204 on success — the value reverts to the env-var default on next read.
// 404 if no row exists to delete (idempotent semantics — callers can
// distinguish "no-op" from "removed" via the status code).
router.delete("/:key", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const key = String(req.params.key);

    const existing = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { id: true, value: true },
    });
    if (!existing) {
      return res.status(404).json({
        error: "Tenant setting not found",
        code: "NOT_FOUND",
      });
    }

    await prisma.tenantSetting.delete({
      where: { tenantId_key: { tenantId, key } },
    });

    await writeAudit(
      "TenantSetting",
      "DELETE",
      existing.id,
      req.user.userId,
      tenantId,
      { key, oldValue: existing.value, newValue: null },
    );

    res.status(204).end();
  } catch (e) {
    console.error("[tenant-settings] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete tenant setting" });
  }
});

module.exports = router;
