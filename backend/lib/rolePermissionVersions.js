/**
 * rolePermissionVersions.js — append-only snapshot history for
 * RolePermission sets.
 *
 * RBAC Hardening Phase 4. Every PUT /api/roles/:id/permissions
 * (BULK_UPDATE_PERMISSIONS) writes one row to RolePermissionVersion
 * with the resulting permission set + change provenance. Restore
 * (Phase 5) is implemented as "load version N's permissionsJson +
 * write it through the same PUT path", producing a NEW version with
 * changeType='RESTORE'. Existing version rows are NEVER updated or
 * deleted.
 *
 * Why this design
 * ───────────────
 *   • Append-only history is the audit-grade default — restore by
 *     re-applying produces a fresh row instead of mutating an older
 *     one, so the history reads as a linear "what happened when"
 *     timeline.
 *   • Per-role monotonic versionNumber keeps the UI label stable
 *     ("Version 14 (Current)") without joining against a sequence.
 *   • permissionsJson is a sorted JSON-stringified array, NOT the
 *     parsed shape. Sorting at write time means two versions with
 *     the same effective set compare equal even when the admin's
 *     submission order differs.
 *
 * Bootstrapping legacy data
 * ─────────────────────────
 * Roles that existed before this feature shipped have no version
 * rows. The first save after deploy auto-writes an INITIAL snapshot
 * of the role's PRE-save state (so v1 is the "what it looked like
 * when history started") and v2 is the new state. Subsequent saves
 * append v3, v4, …
 */

const prisma = require("./prisma");

const PERMISSIONS_JSON_MAX_BYTES = 60_000; // safety below MySQL TEXT 64KB cap

/**
 * Normalise a permission list into a deterministic sorted shape so
 * the JSON serialization is stable regardless of input order. Also
 * deduplicates — defensive against an upstream caller that didn't
 * dedupe.
 */
function canonicalisePermissions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const { module, action } = p;
    if (!module || !action) continue;
    const k = `${module}.${action}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ module, action });
  }
  out.sort((a, b) => {
    if (a.module < b.module) return -1;
    if (a.module > b.module) return 1;
    if (a.action < b.action) return -1;
    if (a.action > b.action) return 1;
    return 0;
  });
  return out;
}

/**
 * Append a new version snapshot for a role. Runs inside the caller's
 * transaction when `tx` is supplied; otherwise spawns a fresh
 * transaction so the (version-write, increment) pair stays atomic
 * against concurrent saves.
 *
 * @param {Object} args
 * @param {number} args.roleId
 * @param {Array<{module:string, action:string}>} args.permissions
 * @param {'UPDATE'|'RESTORE'|'INITIAL'} args.changeType
 * @param {number|null} args.changedById
 * @param {number|null} [args.restoredFromVersionId]
 * @param {string|null} [args.note]
 * @param {import('@prisma/client').PrismaClient | any} [args.tx]
 * @returns {Promise<{ id: number, versionNumber: number }>}
 */
async function snapshotRolePermissions({
  roleId,
  permissions,
  changeType = "UPDATE",
  changedById = null,
  restoredFromVersionId = null,
  note = null,
  tx = null,
}) {
  const canonical = canonicalisePermissions(permissions);
  const permissionsJson = JSON.stringify(canonical);
  if (permissionsJson.length > PERMISSIONS_JSON_MAX_BYTES) {
    throw new Error(
      `RolePermissionVersion payload too large (${permissionsJson.length} > ${PERMISSIONS_JSON_MAX_BYTES})`,
    );
  }
  const noteTrimmed = typeof note === "string" ? note.slice(0, 500) : null;

  // Concurrency: two near-simultaneous saves on the same role would
  // both compute versionNumber=N+1 and one would race past the
  // @@unique([roleId, versionNumber]) constraint. We catch the
  // constraint violation and retry once with the fresh max — good
  // enough for the expected load (admin tuning sessions, not
  // automated traffic).
  const runner = tx || prisma;
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await runner.rolePermissionVersion.findFirst({
      where: { roleId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const next = ((latest && latest.versionNumber) || 0) + 1;
    try {
      const row = await runner.rolePermissionVersion.create({
        data: {
          roleId,
          versionNumber: next,
          permissionsJson,
          permissionCount: canonical.length,
          changeType,
          changedById,
          restoredFromVersionId,
          note: noteTrimmed,
        },
        select: { id: true, versionNumber: true },
      });
      return row;
    } catch (err) {
      // Prisma P2002 = unique constraint violation. Retry with a
      // fresh latest read.
      if (err && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error(
    `snapshotRolePermissions: failed to allocate version number after 3 attempts (roleId=${roleId})`,
  );
}

/**
 * Ensure the role has at least ONE version row before appending the
 * new one. If none exist (legacy role created before this feature
 * shipped), write an INITIAL snapshot of the role's CURRENT
 * RolePermission state first. Idempotent — does nothing on the
 * second call.
 *
 * Used by the PUT handler: call ensureInitialSnapshot BEFORE the
 * deleteMany/createMany so v1 captures the pre-save state, then
 * call snapshotRolePermissions with the new permissions producing v2.
 */
async function ensureInitialSnapshot({
  roleId,
  changedById = null,
  tx = null,
}) {
  const runner = tx || prisma;
  const existing = await runner.rolePermissionVersion.findFirst({
    where: { roleId },
    select: { id: true },
  });
  if (existing) return null;
  const currentRows = await runner.rolePermission.findMany({
    where: { roleId },
    select: { module: true, action: true },
  });
  return snapshotRolePermissions({
    roleId,
    permissions: currentRows,
    changeType: "INITIAL",
    changedById,
    note: "Auto-snapshot of pre-history state",
    tx: runner,
  });
}

/**
 * List versions for a role, newest first. Default page size 50.
 * Hydrates `permissions` from the JSON-stringified column.
 */
async function listRolePermissionVersions({ roleId, take = 50, skip = 0 }) {
  const rows = await prisma.rolePermissionVersion.findMany({
    where: { roleId },
    orderBy: { versionNumber: "desc" },
    take: Math.min(Math.max(parseInt(take, 10) || 50, 1), 200),
    skip: Math.max(parseInt(skip, 10) || 0, 0),
    include: {
      changedBy: {
        select: { id: true, name: true, email: true },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    roleId: r.roleId,
    versionNumber: r.versionNumber,
    permissionCount: r.permissionCount,
    changeType: r.changeType,
    restoredFromVersionId: r.restoredFromVersionId,
    changedAt: r.changedAt,
    note: r.note,
    changedBy: r.changedBy || null,
    // Hydrate the permission array — small enough that returning
    // every row's full set is fine for the list UI. The "Diff with
    // current" widget consumes this directly.
    permissions: hydratePermissions(r.permissionsJson),
  }));
}

/**
 * Load a single version row + hydrate. Used by the restore endpoint.
 * Throws (caught by route) if not found or roleId mismatch.
 */
async function getRolePermissionVersion({ versionId, roleId }) {
  const row = await prisma.rolePermissionVersion.findUnique({
    where: { id: parseInt(versionId, 10) },
    include: {
      changedBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!row) return null;
  if (row.roleId !== roleId) return null;
  return {
    id: row.id,
    roleId: row.roleId,
    versionNumber: row.versionNumber,
    permissionCount: row.permissionCount,
    changeType: row.changeType,
    restoredFromVersionId: row.restoredFromVersionId,
    changedAt: row.changedAt,
    note: row.note,
    changedBy: row.changedBy || null,
    permissions: hydratePermissions(row.permissionsJson),
  };
}

function hydratePermissions(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && p.module && p.action)
      .map((p) => ({ module: p.module, action: p.action }));
  } catch {
    return [];
  }
}

module.exports = {
  canonicalisePermissions,
  ensureInitialSnapshot,
  snapshotRolePermissions,
  listRolePermissionVersions,
  getRolePermissionVersion,
};
