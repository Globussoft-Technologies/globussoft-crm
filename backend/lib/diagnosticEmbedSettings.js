/**
 * Admin-configurable styling for the third-party-embeddable diagnostic
 * widget (2026-09-08) — lets a tenant give the embed its own look (to match
 * a partner site's colors/fonts) independent of the tenant's own brand kit
 * used on the CRM-hosted public form.
 *
 * Deliberately does NOT use a dedicated Prisma table/column — reuses the
 * generic TenantSetting key-value store (same mechanism as
 * diagnosticNotificationSettings.js / diagnosticRecommendationSettings.js),
 * keeping this fully additive with zero schema migrations.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.diagnostics.embedConfig.<subBrand>`,
 * category: "travel-diagnostic-embed-settings", value: JSON.stringify(config) }.
 *
 * Read by TWO callers with different trust levels:
 *   - the authed admin panel (GET/PUT /api/travel/diagnostics/embed-settings)
 *   - the embedded widget itself, no-auth (GET /api/travel/diagnostics/public/embed-config/:tenantSlug/:subBrand)
 * so the config an admin saves takes effect on every already-embedded
 * widget the next time it loads — nothing gets frozen into a copied
 * snippet (that was the bug this replaces: the old embed baked the full
 * config into a `?config=` URL param at copy time).
 */

const prisma = require("./prisma");

const CATEGORY = "travel-diagnostic-embed-settings";
const KEY_PREFIX = "travel.diagnostics.embedConfig.";

// Generous but bounded — this is admin-authored styling (colors, copy
// strings, numeric layout knobs), never user-generated content, so a few KB
// is more than enough while still guarding against an accidental/malicious
// oversized payload landing in a TenantSetting row.
const MAX_CONFIG_BYTES = 8192;

function keyFor(subBrand) {
  return `${KEY_PREFIX}${String(subBrand || "").toLowerCase()}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Saved embed styling config for a tenant/subBrand — {} when never
 * configured, so callers can always spread sensible defaults over it.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @returns {Promise<object>}
 */
async function getEmbedConfig({ tenantId, subBrand }) {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: keyFor(subBrand) } },
    });
    if (!row) return {};
    const parsed = JSON.parse(row.value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist the embed styling config for a tenant/subBrand (full replace).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {object} opts.config
 * @returns {Promise<object>} the config actually saved
 */
async function setEmbedConfig({ tenantId, subBrand, config }) {
  if (!isPlainObject(config)) {
    const err = new Error("config must be an object");
    err.status = 400;
    err.code = "INVALID_CONFIG";
    throw err;
  }
  const value = JSON.stringify(config);
  if (value.length > MAX_CONFIG_BYTES) {
    const err = new Error(`config is too large (max ${MAX_CONFIG_BYTES} bytes)`);
    err.status = 400;
    err.code = "CONFIG_TOO_LARGE";
    throw err;
  }
  const key = keyFor(subBrand);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  return config;
}

module.exports = {
  getEmbedConfig,
  setEmbedConfig,
  MAX_CONFIG_BYTES,
  CATEGORY,
};
