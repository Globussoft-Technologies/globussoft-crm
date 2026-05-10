/**
 * Field-level permission helpers.
 *
 * These are building blocks — route handlers can opt into using them to
 * strip restricted fields from read responses / write payloads based on
 * the caller's role + the FieldPermission table (per-tenant).
 *
 * Default (no rule in DB) is full access: canRead=true, canWrite=true.
 *
 * PRD Gap §1.3 — module × action permissions.
 * The FieldPermission table now carries an `action` column (READ | WRITE |
 * DELETE | EXPORT). Existing rows + the legacy filterReadFields /
 * filterWriteFields helpers continue to operate on the action='WRITE' bucket
 * (the implicit current semantics, where `canWrite=false` blocks the WRITE
 * action and `canRead=false` blocks reads via the same row). hasModuleAction()
 * is the new module-level gate — checks for a row with field='*' (or any field)
 * in the matching action and returns true unless the row explicitly denies.
 *
 * Usage:
 *   const { filterReadFields, filterWriteFields, hasModuleAction } = require("../middleware/fieldFilter");
 *   const safe = await filterReadFields(deal, req.user.role, "Deal", req.user.tenantId);
 *   const canDelete = await hasModuleAction(req.user, "Deal", "DELETE");
 */

const prisma = require("../lib/prisma");

// Tiny in-process cache so hot paths don't hammer the DB.
// Keyed by `${role}::${entity}::${tenantId}::${action}`. Cleared via clearCache() when rules change.
const cache = new Map();
const CACHE_TTL_MS = 30_000;

const VALID_ACTIONS = ["READ", "WRITE", "DELETE", "EXPORT"];

function cacheKey(role, entity, tenantId, action = "WRITE") {
  return `${role}::${entity}::${tenantId}::${action}`;
}

function clearCache() {
  cache.clear();
}

/**
 * Returns map: { fieldName: { canRead, canWrite } } for rules present in DB.
 * Fields without any rule are NOT included — callers should treat missing
 * fields as fully permitted.
 */
async function getFieldPermissions(role, entity, tenantId, action = "WRITE") {
  if (!role || !entity) return {};
  const tid = tenantId || 1;
  const act = action || "WRITE";
  const key = cacheKey(role, entity, tid, act);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let rules = [];
  try {
    rules = await prisma.fieldPermission.findMany({
      where: { role, entity, tenantId: tid, action: act },
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
 * PRD Gap §1.3 — module-level action gate.
 *
 * Returns true if `user` is permitted to perform `action` on `module`.
 * ADMIN + MANAGER bypass — they implicitly have every action on every
 * module. Other roles consult the FieldPermission table for a row with
 * field='*' (module-level rule) or any field (any explicit rule) on the
 * matching action. Default-allow when no rule exists.
 *
 * action: READ | WRITE | DELETE | EXPORT
 *
 * Usage:
 *   if (!(await hasModuleAction(req.user, "Deal", "DELETE"))) {
 *     return res.status(403).json({ error: "MODULE_ACTION_FORBIDDEN", code: "MODULE_ACTION_FORBIDDEN" });
 *   }
 */
async function hasModuleAction(user, module, action) {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  // MANAGER bypass kept narrow — only on READ/WRITE; DELETE / EXPORT still
  // checked so an admin can lock down sensitive exports per-tenant.
  if (user.role === "MANAGER" && (action === "READ" || action === "WRITE")) return true;
  const act = VALID_ACTIONS.includes(action) ? action : "WRITE";

  // Look for a module-level rule first (field='*'), fall back to any field
  // rule on the same module+action — if ANY rule denies, the action is denied.
  let rows = [];
  try {
    rows = await prisma.fieldPermission.findMany({
      where: {
        role: user.role,
        entity: module,
        tenantId: user.tenantId || 1,
        action: act,
      },
    });
  } catch (err) {
    console.error("[fieldFilter][hasModuleAction]", err);
    // Fail-closed only when an admin would expect a DENY signal — defaulting
    // to allow on DB error preserves availability of the historically-open
    // routes that this gate is being layered onto.
    return true;
  }

  if (rows.length === 0) return true; // default-allow

  // If a module-level row exists (field='*'), it's authoritative.
  const moduleRow = rows.find((r) => r.field === "*");
  if (moduleRow) {
    if (act === "READ") return moduleRow.canRead;
    return moduleRow.canWrite;
  }

  // Otherwise: every per-field rule must agree the action is allowed.
  // (Conservative — if any field is locked for the action, treat the module
  //  as gated. Admins should set field='*' explicitly when they want a
  //  blanket allow with per-field exceptions.)
  for (const r of rows) {
    if (act === "READ" && r.canRead === false) return false;
    if (act !== "READ" && r.canWrite === false) return false;
  }
  return true;
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
  hasModuleAction,
  clearCache,
  VALID_ACTIONS,
};
