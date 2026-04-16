/**
 * Field-level permission helpers.
 *
 * These are building blocks — route handlers can opt into using them to
 * strip restricted fields from read responses / write payloads based on
 * the caller's role + the FieldPermission table (per-tenant).
 *
 * Default (no rule in DB) is full access: canRead=true, canWrite=true.
 *
 * Usage:
 *   const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");
 *   const safe = await filterReadFields(deal, req.user.role, "Deal", req.user.tenantId);
 */

const prisma = require("../lib/prisma");

// Tiny in-process cache so hot paths don't hammer the DB.
// Keyed by `${role}::${entity}::${tenantId}`. Cleared via clearCache() when rules change.
const cache = new Map();
const CACHE_TTL_MS = 30_000;

function cacheKey(role, entity, tenantId) {
  return `${role}::${entity}::${tenantId}`;
}

function clearCache() {
  cache.clear();
}

/**
 * Returns map: { fieldName: { canRead, canWrite } } for rules present in DB.
 * Fields without any rule are NOT included — callers should treat missing
 * fields as fully permitted.
 */
async function getFieldPermissions(role, entity, tenantId) {
  if (!role || !entity) return {};
  const tid = tenantId || 1;
  const key = cacheKey(role, entity, tid);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let rules = [];
  try {
    rules = await prisma.fieldPermission.findMany({
      where: { role, entity, tenantId: tid },
    });
  } catch (err) {
    console.error("[fieldFilter][getFieldPermissions]", err);
    return {};
  }

  const map = {};
  rules.forEach((r) => {
    map[r.field] = { canRead: r.canRead, canWrite: r.canWrite };
  });

  cache.set(key, { value: map, expires: Date.now() + CACHE_TTL_MS });
  return map;
}

/**
 * Remove fields the given role is not allowed to READ.
 * Accepts a plain object (Prisma row) or an array of them.
 * Returns a shallow-cloned record with disallowed keys omitted.
 */
async function filterReadFields(record, role, entity, tenantId) {
  if (record == null) return record;
  if (Array.isArray(record)) {
    return Promise.all(record.map((r) => filterReadFields(r, role, entity, tenantId)));
  }
  if (typeof record !== "object") return record;

  const perms = await getFieldPermissions(role, entity, tenantId);
  const out = { ...record };
  for (const field of Object.keys(perms)) {
    if (perms[field].canRead === false && field in out) {
      delete out[field];
    }
  }
  return out;
}

/**
 * Strip fields the given role is not allowed to WRITE from an incoming payload.
 * Useful in POST/PUT handlers before handing the body to Prisma.
 */
async function filterWriteFields(payload, role, entity, tenantId) {
  if (!payload || typeof payload !== "object") return payload;

  const perms = await getFieldPermissions(role, entity, tenantId);
  const out = { ...payload };
  for (const field of Object.keys(perms)) {
    if (perms[field].canWrite === false && field in out) {
      delete out[field];
    }
  }
  return out;
}

module.exports = {
  getFieldPermissions,
  filterReadFields,
  filterWriteFields,
  clearCache,
};
