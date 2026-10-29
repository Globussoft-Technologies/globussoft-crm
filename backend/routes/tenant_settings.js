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
const SENSITIVE_KEYS = new Set([
  KEYS.GENERIC_RECAPTCHA_SECRET_KEY,
  KEYS.TRAVEL_RECAPTCHA_SECRET_KEY,
  // This key is deliberately managed only by the Travel promotional-site
  // admin route. It is not part of KEYS because the generic settings editor
  // must never write it, but GET /tenant-settings historically listed every
  // row in the tenant and therefore also needs to redact it.
  "travel.promotionalWebsite.sftp",
  // Managed only by /api/travel/email-provider. The value is encrypted at
  // rest, but the generic TenantSetting API must not expose the ciphertext.
  "travel.email.sendgrid",
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(key);
}

function publicDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? null : value,
    ]),
  );
}

function sensitiveDefaultState() {
  return Object.fromEntries(
    [...SENSITIVE_KEYS].map((key) => [key, Boolean(DEFAULTS[key])]),
  );
}

function auditValue(key, value) {
  if (value == null) return null;
  return isSensitiveKey(key) ? "[REDACTED]" : String(value);
}

function isKnownKey(key) {
  return ALLOWED_KEYS.includes(key);
}

// Default category inference: budgetCap_* rows belong to "budget"; other
// keys default to "general". Callers may override via body.category.
function defaultCategoryFor(key) {
  if (typeof key === "string" && key.startsWith("budgetCap_")) return "budget";
  return "general";
}

// Per-key validation for operator-facing toggles/numbers. Returns
// { ok: true } or { ok: false, code, error } so callers can return 400
// with a canonical envelope before touching the DB.
function validateTenantSettingValue(key, rawValue) {
  if (key === KEYS.GENERIC_CONTACT_LIFECYCLE_STAGES) {
    let stages;
    try {
      stages = JSON.parse(String(rawValue));
    } catch {
      return { ok: false, code: "INVALID_LIFECYCLE_STAGES", error: "Lifecycle stages must be valid JSON." };
    }
    if (!Array.isArray(stages) || stages.length < 1 || stages.length > 20) {
      return { ok: false, code: "INVALID_LIFECYCLE_STAGES", error: "Lifecycle stages must contain between 1 and 20 stages." };
    }
    const stageIds = new Set();
    const optionIds = new Set();
    const allowedStatuses = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);
    for (const stage of stages) {
      const id = String(stage?.id || "").trim();
      const title = String(stage?.title || "").trim();
      const options = Array.isArray(stage?.options) ? stage.options : [];
      if (!id || id.length > 80 || stageIds.has(id) || !title || title.length > 80 || options.length < 1 || options.length > 5) {
        return { ok: false, code: "INVALID_LIFECYCLE_STAGES", error: "Each lifecycle stage needs a unique id, a title, and between 1 and 5 outcomes." };
      }
      stageIds.add(id);
      for (const option of options) {
        const optionId = String(option?.id || "").trim();
        const label = String(option?.label || "").trim();
        if (!optionId || optionId.length > 80 || optionIds.has(optionId) || !label || label.length > 80 || !allowedStatuses.has(option?.status)) {
          return { ok: false, code: "INVALID_LIFECYCLE_STAGES", error: "Each lifecycle outcome needs a unique id, a label, and a valid CRM status." };
        }
        optionIds.add(optionId);
      }
    }
  }
  if (key === KEYS.GENERIC_DEAL_TYPES) {
    let types;
    try {
      types = JSON.parse(String(rawValue));
    } catch {
      return { ok: false, code: "INVALID_DEAL_TYPES", error: "Deal types must be valid JSON." };
    }
    if (!Array.isArray(types) || types.length < 1 || types.length > 50) {
      return { ok: false, code: "INVALID_DEAL_TYPES", error: "Deal types must contain between 1 and 50 types." };
    }
    const typeIds = new Set();
    const typeNames = new Set();
    for (const type of types) {
      const id = String(type?.id || "").trim();
      const name = String(type?.name || "").trim();
      const stages = Array.isArray(type?.stages) ? type.stages : [];
      if (!id || id.length > 80 || typeIds.has(id) || !name || name.length > 80 || typeNames.has(name.toLowerCase()) || stages.length < 1 || stages.length > 50) {
        return { ok: false, code: "INVALID_DEAL_TYPES", error: "Each deal type needs a unique id, a name, and between 1 and 50 stages." };
      }
      typeIds.add(id);
      typeNames.add(name.toLowerCase());
      const stageIds = new Set();
      for (const stage of stages) {
        const stageId = String(stage?.id || "").trim();
        const stageName = String(stage?.name || "").trim();
        if (!stageId || stageId.length > 80 || stageIds.has(stageId) || !stageName || stageName.length > 80) {
          return { ok: false, code: "INVALID_DEAL_TYPES", error: "Each deal type stage needs a unique id and name." };
        }
        stageIds.add(stageId);
      }
    }
  }
  if (key === KEYS.CALLIFIED_DNP_RETRY_MAX_RETRIES) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return { ok: false, code: "INVALID_DNP_MAX_RETRIES", error: "DNP max retries must be an integer between 1 and 10." };
    }
  }
  if (key === KEYS.CALLIFIED_PENDING_RETRY_MAX_RETRIES) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return { ok: false, code: "INVALID_PENDING_MAX_RETRIES", error: "Pending max retries must be an integer between 1 and 10." };
    }
  }
  if (key === KEYS.CALLIFIED_DNP_RETRY_INTERVAL_MINUTES) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 5 || n > 30 * 24 * 60) {
      return { ok: false, code: "INVALID_DNP_INTERVAL", error: "DNP retry interval must be between 5 minutes and 30 days." };
    }
  }
  if (key === KEYS.CALLIFIED_PENDING_RETRY_INTERVAL_MINUTES) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 5 || n > 30 * 24 * 60) {
      return { ok: false, code: "INVALID_PENDING_INTERVAL", error: "Pending retry interval must be between 5 minutes and 30 days." };
    }
  }
  if ([KEYS.CALLIFIED_DNP_RETRY_MODE, KEYS.CALLIFIED_PENDING_RETRY_MODE].includes(key) && !["delay", "scheduled"].includes(String(rawValue))) {
    return { ok: false, code: "INVALID_RETRY_MODE", error: "Retry mode must be delay or scheduled." };
  }
  if ([KEYS.CALLIFIED_DNP_RETRY_DAY_INTERVAL, KEYS.CALLIFIED_PENDING_RETRY_DAY_INTERVAL].includes(key)) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return { ok: false, code: "INVALID_RETRY_DAY_INTERVAL", error: "Retry day interval must be between 1 and 30 days." };
    }
  }
  if ([KEYS.CALLIFIED_DNP_RETRY_TIME_LOCAL, KEYS.CALLIFIED_PENDING_RETRY_TIME_LOCAL].includes(key) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rawValue))) {
    return { ok: false, code: "INVALID_RETRY_TIME", error: "Retry time must use HH:mm format." };
  }
  if (key === KEYS.CALLIFIED_RETRY_TIMEZONE) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: String(rawValue) }).format(new Date());
    } catch {
      return { ok: false, code: "INVALID_RETRY_TIMEZONE", error: "Retry timezone must be a valid IANA timezone." };
    }
  }
  return { ok: true };
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
      settings: rows.map((row) => isSensitiveKey(row.key)
        ? { ...row, value: "", hasValue: Boolean(row.value) }
        : row),
      defaults: publicDefaults(),
      sensitiveDefaults: sensitiveDefaultState(),
      allowedKeys: ALLOWED_KEYS,
    });
  } catch (e) {
    console.error("[tenant-settings] list error:", e.message);
    res.status(500).json({ error: "Failed to list tenant settings" });
  }
});

// ─── PUT /callified — atomically save the Generic CRM Callified panel ──
//
// The Leads dialog presents these values as one form. Persist them in one DB
// transaction so a validation/database failure cannot leave a partially
// updated retry policy behind.
router.put("/callified", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    if (!tenant || tenant.vertical !== "generic") {
      return res.status(404).json({
        error: "Callified lead settings are unavailable for this tenant",
        code: "CALLIFIED_SETTINGS_NOT_AVAILABLE",
      });
    }
    const settings = Array.isArray(req.body?.settings) ? req.body.settings : null;
    if (!settings || settings.length === 0 || settings.length > 30) {
      return res.status(400).json({
        error: "settings must be a non-empty array with at most 30 entries",
        code: "INVALID_SETTINGS_BATCH",
      });
    }

    const seen = new Set();
    const normalized = [];
    for (const entry of settings) {
      const key = String(entry?.key || "");
      if (!key.startsWith("feature.callified.") || !isKnownKey(key)) {
        return res.status(400).json({ error: `Invalid Callified setting key: ${key}`, code: "INVALID_SETTING_KEY" });
      }
      if (seen.has(key)) {
        return res.status(400).json({ error: `Duplicate setting key: ${key}`, code: "DUPLICATE_SETTING_KEY" });
      }
      if (entry?.value === undefined || entry?.value === null || entry?.value === "") {
        return res.status(400).json({ error: `value is required for ${key}`, code: "MISSING_VALUE" });
      }
      const validation = validateTenantSettingValue(key, entry.value);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error, code: validation.code });
      }
      seen.add(key);
      normalized.push({ key, value: String(entry.value), category: "feature-flag" });
    }

    const changes = await prisma.$transaction(async (tx) => {
      const saved = [];
      for (const entry of normalized) {
        const prior = await tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId, key: entry.key } },
          select: { value: true },
        });
        const row = await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key: entry.key } },
          create: { tenantId, ...entry },
          update: { value: entry.value, category: entry.category },
        });
        saved.push({ row, priorValue: prior?.value ?? null });
      }
      return saved;
    });

    for (const { row, priorValue } of changes) {
      await writeAudit(
        "TenantSetting",
        priorValue == null ? "CREATE" : "UPDATE",
        row.id,
        req.user.userId,
        tenantId,
        { key: row.key, oldValue: priorValue, newValue: row.value },
      );
    }

    return res.json({
      success: true,
      settings: changes.map(({ row }) => ({ key: row.key, value: row.value, category: row.category })),
    });
  } catch (e) {
    console.error("[tenant-settings] Callified batch put error:", e.message);
    return res.status(500).json({ error: "Failed to save Callified settings", code: "CALLIFIED_SETTINGS_SAVE_FAILED" });
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
    let rawDefaultValue = DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
    let defaultValue = isSensitiveKey(key) ? null : rawDefaultValue;

    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { key: true, value: true, category: true },
    });

    // Generic CRM starts without a built-in deal type/stage model. Preserve
    // the historical virtual default for tenants that already contain deals,
    // so existing tenants and records keep their current behavior.
    if (!row && key === KEYS.GENERIC_DEAL_TYPES) {
      try {
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
        if (tenant?.vertical === "generic") {
          const existingDeals = await prisma.deal.count({ where: { tenantId, deletedAt: null } });
          if (!existingDeals) rawDefaultValue = "[]";
        }
      } catch (_error) {
        // Keep the existing default fallback if the compatibility probe fails.
      }
    }
    defaultValue = isSensitiveKey(key) ? null : rawDefaultValue;

    if (!row) {
      return res.json({
        key,
        value: isSensitiveKey(key)
          ? ""
          : (defaultValue == null ? null : String(defaultValue)),
        ...(isSensitiveKey(key) ? { hasValue: Boolean(rawDefaultValue) } : {}),
        defaultValue,
        isOverride: false,
        category: defaultCategoryFor(key),
      });
    }
    res.json({
      key: row.key,
      value: isSensitiveKey(row.key) ? "" : row.value,
      ...(isSensitiveKey(row.key)
        ? { hasValue: Boolean(row.value || rawDefaultValue) }
        : {}),
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

    if (key === KEYS.GENERIC_CONTACT_LIFECYCLE_STAGES) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { vertical: true },
      });
      if (tenant?.vertical !== "generic") {
        return res.status(404).json({
          error: "Lifecycle stage customization is available only for Generic CRM",
          code: "GENERIC_ONLY",
        });
      }
    }

    const body = req.body || {};
    if (body.value === undefined || body.value === null || body.value === "") {
      return res.status(400).json({
        error: "value is required",
        code: "MISSING_VALUE",
      });
    }

    const validation = validateTenantSettingValue(key, body.value);
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.error,
        code: validation.code,
      });
    }

    // Look up the prior value for audit details (and to decide
    // CREATE vs UPDATE action).
    const prior = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { value: true },
    });

    const category = body.category ? String(body.category) : defaultCategoryFor(key);
    let updated;
    if (key === KEYS.GENERIC_DEAL_TYPES) {
      const oldTypes = JSON.parse(prior?.value || DEFAULTS[key]);
      const newTypes = JSON.parse(String(body.value));
      const renames = oldTypes.flatMap((oldType) => {
        const next = newTypes.find((type) => type.id === oldType.id);
        return next && next.name !== oldType.name ? [{ oldName: oldType.name, newName: next.name }] : [];
      });
      // Prevent sequential renames from capturing another type's rows.
      if (renames.some(({ oldName, newName }) => oldTypes.some((type) => type.name !== oldName && type.name.toLowerCase() === newName.toLowerCase()))) {
        return res.status(409).json({ error: 'A deal type with that name already exists.', code: 'DEAL_TYPE_NAME_CONFLICT' });
      }
      updated = await prisma.$transaction(async (tx) => {
        for (const { oldName, newName } of renames) {
          await tx.deal.updateMany({
            where: { tenantId, ...(oldName === 'New Business' ? { OR: [{ dealType: oldName }, { dealType: null }] } : { dealType: oldName }) },
            data: { dealType: newName },
          });
        }
        return tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: { tenantId, key, value: String(body.value), category },
          update: { value: String(body.value), category },
        });
      });
    } else {
      updated = await setSetting(tenantId, key, body.value, { category });
    }

    await writeAudit(
      "TenantSetting",
      prior ? "UPDATE" : "CREATE",
      updated.id,
      req.user.userId,
      tenantId,
      {
        key,
        oldValue: auditValue(key, prior ? prior.value : null),
        newValue: auditValue(key, body.value),
      },
    );

    res.json({
      key: updated.key,
      value: isSensitiveKey(key) ? "" : updated.value,
      ...(isSensitiveKey(key) ? { hasValue: Boolean(updated.value) } : {}),
      defaultValue: isSensitiveKey(key)
        ? null
        : (DEFAULTS[key] !== undefined ? DEFAULTS[key] : null),
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
      { key, oldValue: auditValue(key, existing.value), newValue: null },
    );

    res.status(204).end();
  } catch (e) {
    console.error("[tenant-settings] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete tenant setting" });
  }
});

module.exports = router;
