/**
 * rbacLockoutGuard.js — prevent a tenant from administratively
 * locking itself out of RBAC.
 *
 * Why this exists
 * ───────────────
 * Before this guard, an admin could uncheck `roles.manage` on the
 * ADMIN role itself (or remove `roles.read` to hide the page), save,
 * and the tenant would have zero active users with RBAC-administration
 * grants. Without superuser/OWNER override, nobody could re-grant
 * permissions through the UI.
 *
 * The previous protection (LAST_ADMIN_PROTECTION at routes/roles.js
 * pre-fix) was hardcoded to `role.key === "ADMIN"` + the single
 * `roles.manage` perm. That:
 *   • assumed the ADMIN-key role was always the recovery surface
 *     (broken once tenants started using custom recovery roles —
 *     e.g. "PLATFORM_OWNER" or "TENANT_ROOT")
 *   • didn't catch removal of `roles.read` (which hides the page
 *     even with roles.manage intact — the tester's actual lockout)
 *   • didn't consider whether the ADMIN role even had any users
 *     assigned (an empty ADMIN role can't recover the tenant)
 *
 * This guard is role-name agnostic. It simulates the resulting
 * permission state of every active user in the tenant after the
 * proposed save, and rejects if zero users retain BOTH critical
 * permissions.
 *
 * Critical permissions
 * ────────────────────
 * The minimum set required to recover from any other broken RBAC
 * configuration through the UI:
 *   • roles.read   — see the Roles & Permissions page
 *   • roles.manage — mutate roles/permissions
 *
 * staff.* perms are NOT in the critical set: a user with
 * roles.read + roles.manage can re-grant staff.* to themselves
 * (or to another role) and recover staff administration.
 *
 * This guard is invoked from PUT /api/roles/:id/permissions BEFORE
 * the atomic deleteMany+createMany transaction. If it rejects, no
 * write happens.
 */

const prisma = require("./prisma");

// Critical permissions. Frozen so callers can't accidentally mutate
// the set. To extend (e.g. add staff.manage), update this list AND
// the Phase 1 inventory in the PR description.
const CRITICAL_RBAC_PERMISSIONS = Object.freeze([
  { module: "roles", action: "read" },
  { module: "roles", action: "manage" },
]);

const CRITICAL_KEY_SET = new Set(
  CRITICAL_RBAC_PERMISSIONS.map((p) => `${p.module}.${p.action}`),
);

/**
 * Returns the canonical critical permission list (defensive copy so
 * callers can sort/filter without poisoning the source).
 */
function getCriticalPermissions() {
  return CRITICAL_RBAC_PERMISSIONS.map((p) => ({ ...p }));
}

/**
 * Returns the subset of `proposedPermissions` that overlaps the
 * critical set. Used by the frontend warning modal (Phase 3) to
 * decide whether to surface a critical-removal warning.
 *
 * @param {Array<{module: string, action: string}>} proposedPermissions
 * @returns {Array<{module: string, action: string}>}
 */
function intersectCritical(proposedPermissions) {
  return CRITICAL_RBAC_PERMISSIONS.filter((c) =>
    proposedPermissions.some(
      (p) => p.module === c.module && p.action === c.action,
    ),
  );
}

/**
 * Simulate the permission-set every active user in the tenant would
 * hold IF the proposed save lands, and return the count of users who
 * retain BOTH critical permissions.
 *
 * Active user definition: `User.deactivatedAt IS NULL`. Soft-
 * deactivated users (set to a timestamp by the Staff Directory's
 * Deactivate button) can't log in so they don't count toward
 * recovery capacity. The User schema has no isActive boolean —
 * deactivation is timestamp-based to preserve the audit trail.
 *
 * Note on multi-role users: the resolver UNIONs permissions across
 * every assigned role (see middleware/requirePermission.js). So a
 * user with `STAFF_PRO + RECOVERY` holds the union of both.
 *
 * @param {Object} args
 * @param {number} args.tenantId     — the tenant being administered
 * @param {number} args.roleId       — the role whose perms are being saved
 * @param {Array<{module: string, action: string}>} args.proposedPermissions
 * @returns {Promise<{ count: number, qualifyingUserIds: number[] }>}
 */
async function simulateAdminCount({ tenantId, roleId, proposedPermissions }) {
  // Build a fast lookup for what the role being saved WILL grant.
  const proposedSet = new Set(
    proposedPermissions.map((p) => `${p.module}.${p.action}`),
  );

  // Pull every active user in the tenant + their role assignments +
  // each assigned role's current permissions. We swap in the proposed
  // set for the role being saved. User.deactivatedAt null = active.
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      deactivatedAt: null,
    },
    select: {
      id: true,
      deactivatedAt: true,
      userRoles: {
        select: {
          roleId: true,
          role: {
            select: {
              id: true,
              isActive: true,
              permissions: { select: { module: true, action: true } },
            },
          },
        },
      },
    },
  });

  const qualifying = [];

  for (const user of users) {
    // Aggregate the effective permission set across every assigned
    // active role. For the role being saved, substitute the proposed
    // permissions (the post-save view).
    const effective = new Set();
    for (const ur of user.userRoles) {
      const r = ur.role;
      if (!r || r.isActive === false) continue;
      if (r.id === roleId) {
        for (const k of proposedSet) effective.add(k);
      } else {
        for (const p of r.permissions) effective.add(`${p.module}.${p.action}`);
      }
    }

    // Holds-all-critical check
    let holdsAll = true;
    for (const key of CRITICAL_KEY_SET) {
      if (!effective.has(key)) {
        holdsAll = false;
        break;
      }
    }
    if (holdsAll) qualifying.push(user.id);
  }

  return { count: qualifying.length, qualifyingUserIds: qualifying };
}

/**
 * Guard for PUT /api/roles/:id/permissions. Runs the simulation; if
 * the post-save state would leave zero users with the critical perms,
 * returns a structured rejection object. Otherwise returns null.
 *
 * @param {Object} args — same as simulateAdminCount
 * @returns {Promise<null | { status: number, body: object }>}
 */
async function checkLockout(args) {
  const { count, qualifyingUserIds } = await simulateAdminCount(args);
  if (count > 0) return null;
  return {
    status: 409,
    body: {
      error:
        "This change would remove RBAC administration access from all active users.",
      code: "LOCKOUT_PREVENTED",
      criticalPermissions: CRITICAL_RBAC_PERMISSIONS.map(
        (p) => `${p.module}.${p.action}`,
      ),
      qualifyingUserCount: count,
      qualifyingUserIds,
    },
  };
}

module.exports = {
  CRITICAL_RBAC_PERMISSIONS,
  CRITICAL_KEY_SET,
  getCriticalPermissions,
  intersectCritical,
  simulateAdminCount,
  checkLockout,
};
