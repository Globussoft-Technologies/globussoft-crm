/**
 * Enterprise RBAC — Roles API
 *
 * Provides CRUD operations for roles, role permissions, and user-role assignments.
 * All endpoints require 'roles' permission (read for GET, manage for mutations).
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const {
  requirePermission,
  requireAnyPermission,
  clearUserCache,
  clearTenantCache,
} = require("../middleware/requirePermission");

// Settings-side recovery surface: the /settings Role Recovery section
// reuses these endpoints via the OR-gate below. Permission keys held
// in one place so the four endpoints share a single source of truth.
//
// Read endpoints (GET /api/roles, version list, single version): any
// admin who can administer tenant-wide settings OR who can read roles
// can call them — needed so the recovery surface remains reachable
// even if roles.read is lost.
//
// Restore endpoint (POST /restore): same OR, but with the write tier
// on each side. The lockout guard inside the PUT handler runs
// regardless, so widening the gate doesn't widen the destructive
// surface.
const ROLES_LIST_OR_RECOVERY = [
  { module: "roles", action: "read" },
  { module: "settings", action: "manage" },
];
const ROLES_VERSION_READ_OR_RECOVERY = [
  { module: "roles", action: "read" },
  { module: "settings", action: "manage" },
];
const ROLES_VERSION_RESTORE_OR_RECOVERY = [
  { module: "roles", action: "manage" },
  { module: "settings", action: "manage" },
];
const { clearCustomerRoleCache } = require("../lib/portalPermissions");
const { syncWellnessRoleFromRbacRoles } = require("../lib/wellnessRoleSync");
const {
  isValidPermission,
  validatePermissionForVertical,
  getCatalog,
  getGroupedCatalog,
  getCatalogForVertical,
  getGroupedCatalogForVertical,
} = require("../lib/permissionCatalog");
const { validateRoleKey } = require("../lib/roleKey");
const { writeAudit } = require("../lib/audit");
const {
  validateLandingPath,
  normalizeLandingPath,
} = require("../lib/landingPath");
const {
  checkLockout,
  CRITICAL_RBAC_PERMISSIONS,
  getCriticalPermissions,
  intersectCritical,
} = require("../lib/rbacLockoutGuard");
const {
  ensureInitialSnapshot,
  snapshotRolePermissions,
  listRolePermissionVersions,
  getRolePermissionVersion,
} = require("../lib/rolePermissionVersions");

// Bug 4 — strict per-vertical permission validation. Off by default
// (back-compat with pre-cleanup state where roles legitimately carry
// foreign perms). Set RBAC_STRICT_VERTICAL_VALIDATION=1 in the env
// AFTER running cleanup-foreign-perms-report.js --apply for every
// dirty tenant; the route then rejects any POST/PUT that would write a
// foreign permission. See backend/lib/permissionCatalog.js for the
// validator.
//
// Read per-request, NOT captured at module load — operators flip the
// flag after running the cleanup script and we don't want to require a
// pm2 restart for it to take effect. The vitest in
// test/routes/roles-system-protection.test.js also relies on per-request
// reads to toggle the flag between tests.
function strictVerticalValidationOn() {
  return (
    process.env.RBAC_STRICT_VERTICAL_VALIDATION === "1" ||
    process.env.RBAC_STRICT_VERTICAL_VALIDATION === "true"
  );
}

// Resolve the active tenant's vertical for vertical-aware validation.
// Looked up per request (not cached) because tenant.vertical CAN change
// during a migration. Falls through to 'generic' if the tenant has no
// vertical set — the generic catalog is a strict subset of every
// vertical catalog so this is safe.
async function getTenantVertical(tenantId) {
  if (!tenantId) return "generic";
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    return (tenant && tenant.vertical) || "generic";
  } catch {
    return "generic";
  }
}
const { isValidWidgetKey } = require("../lib/widgetCatalog");
const { getAccessiblePages, canAccessPath } = require("../lib/pageCatalog");
const { getNewlyGrantedSensitive } = require("../lib/sensitivePermissions");

// Count how many users currently hold the ADMIN role within a tenant.
// Used by the last-admin guards on assign / unassign / permission-strip.
// Implemented as a fresh COUNT so a concurrent re-assign by a peer admin
// can't race past the guard with a stale local read. Returns 0 if no
// ADMIN role exists for the tenant (shouldn't happen post-bootstrap, but
// don't fault — bail early instead).
async function countAdminUsersForTenant(tenantId) {
  const adminRole = await prisma.role.findFirst({
    where: { tenantId, key: "ADMIN" },
    select: { id: true },
  });
  if (!adminRole) return 0;
  return prisma.userRole.count({ where: { roleId: adminRole.id } });
}

// Build the Set<"module.action"> a role currently holds. Re-used by the
// accessible-pages endpoint + the landingPath validator + the auto-clear
// hook after a permissions bulk-update. Returns an empty Set if the role
// has no permissions; the caller is responsible for OWNER short-circuits.
async function permissionSetForRole(roleId) {
  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { module: true, action: true },
  });
  return new Set(rows.map((r) => `${r.module}.${r.action}`));
}

// GET /api/roles — list roles for the active tenant.
//
// Tenant scoping (2026-06-15):
//   • STAFF — always scoped to req.user.tenantId (JWT-bound). The
//     X-Active-Tenant header is a no-op for STAFF (the existing auth
//     middleware drops any cross-tenant value before this handler
//     fires — see middleware/auth.js#L106).
//   • OWNER — scoped to the requesting client's "active tenant"
//     context: the X-Active-Tenant request header takes precedence,
//     then the ?tenantId query parameter, finally a fallback to the
//     JWT's tenantId. This stops the Roles & Permissions page from
//     surfacing every tenant's roles in one ungrouped list when an
//     OWNER user opens it (the canonical "I switched to Travel Stall
//     in the tenant picker but the page still shows wellness clinical
//     roles" UX bug). OWNER can still administer any tenant's roles —
//     they just need to switch the SPA tenant picker first.
//
// Validation: when OWNER supplies an unknown tenantId, fall back to
// the JWT's tenantId rather than 404. Stale localStorage from a prior
// session shouldn't break the page; the page just shows the OWNER's
// home tenant instead.
//
// Response now echoes `tenantId` so the client (or tests) can confirm
// which tenant's roles are being shown — useful for verifying the
// scope landed correctly when debugging cross-tenant view bugs.
router.get(
  "/",
  verifyToken,
  // OR-gate so the /settings Role Recovery section can call this
  // endpoint via settings.manage when roles.read has been lost.
  requireAnyPermission(ROLES_LIST_OR_RECOVERY),
  async (req, res) => {
    try {
      let tenantId = req.user.tenantId;

      if (req.user.isOwner) {
        const headerVal = req.headers["x-active-tenant"];
        const queryVal = req.query.tenantId;
        const candidate = parseInt(headerVal || queryVal, 10);
        if (Number.isInteger(candidate) && candidate > 0) {
          // Confirm the tenant exists before scoping to it. Avoids
          // returning an empty list (and the resulting "no roles
          // found" empty state) when a stale localStorage value or a
          // typo in the query param points at a deleted tenant.
          const tenant = await prisma.tenant.findUnique({
            where: { id: candidate },
            select: { id: true },
          });
          if (tenant) tenantId = candidate;
        }
      }

      const roles = await prisma.role.findMany({
        where: { tenantId },
        include: {
          permissions: true,
          _count: { select: { userRoles: true } },
        },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      });

      // Bug 5 — count consistency. The Roles table badge previously
      // rendered `role.permissions.length` (raw count including
      // foreign perms left over from the v3.8.x wellness-flavored
      // baseline), while the PermissionsModal editor's `initial` Set
      // filtered through the per-vertical catalog. Result: table read
      // 74 / editor read 58 for the same role — admins thought the
      // editor had silently lost grants. We surface BOTH counts here:
      //   • permissionCount         — raw DB row count
      //   • visiblePermissionCount  — count after vertical-catalog filter
      //                               (matches what the editor renders)
      // The table renders visiblePermissionCount as the badge with a
      // hover-title showing the raw count when the two differ, so the
      // admin can see "16 hidden by current catalog" without the
      // disorienting number-jump between the table and the editor.
      // Post-cleanup, the two values are equal and the warning hover
      // text disappears naturally.
      let visibleCatalog = null;
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { vertical: true },
        });
        const vertical = (tenant && tenant.vertical) || "generic";
        visibleCatalog = getCatalogForVertical(vertical);
      } catch {
        // DB blip — fall through to union (no filter). Worst case the
        // counts agree as before this change.
      }
      const isVisible = (module, action) => {
        if (!visibleCatalog) return true;
        const actions = visibleCatalog[module];
        return !!(actions && actions.includes(action));
      };

      res.json({
        roles: roles.map((role) => {
          const visible = (role.permissions || []).filter((p) =>
            isVisible(p.module, p.action),
          );
          return {
            ...role,
            userCount: role._count.userRoles,
            permissionCount: role.permissions.length,
            visiblePermissionCount: visible.length,
            hiddenPermissionCount: role.permissions.length - visible.length,
            _count: undefined,
          };
        }),
        tenantId,
      });
    } catch (err) {
      console.error("[roles] list error:", err);
      res.status(500).json({ error: "Failed to list roles" });
    }
  },
);

// GET /api/roles/catalog — the permission catalog (module → [actions]).
// Source of truth for the role-editor matrix; prevents UI/server drift.
// `domains` groups the modules by domain (CRM Core / Communications /
// Wellness Inventory / etc.) so the Permissions modal can render section
// headers instead of a flat grid — keep an existing client compatible by
// also returning the plain `modules` array.
//
// Vertical-aware (Phase 1, 2026-06-15): the catalog returned here is
// filtered by the requesting tenant's `Tenant.vertical` so wellness
// tenants don't see travel-only modules (itineraries / suppliers / etc.)
// and travel tenants don't see wellness-only modules (patients /
// prescriptions / inventory / etc.). Existing RolePermission rows are
// NOT pruned — see permissionCatalog.js for the soft-hide rationale.
// `vertical` is echoed in the response for client-side observability /
// debugging; absence falls through to the generic catalog.
router.get(
  "/catalog",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    let vertical = null;
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = tenant?.vertical || null;
    } catch (err) {
      // DB blip — fall through to the generic catalog rather than 500.
      // Worst case the matrix shows fewer modules until the next request.
      console.error(
        "[roles.catalog] tenant vertical lookup failed:",
        err && err.message,
      );
    }
    const catalog = vertical ? getCatalogForVertical(vertical) : getCatalog();
    const modules = Object.entries(catalog).map(([module, actions]) => ({
      module,
      actions,
    }));
    const domains = vertical
      ? getGroupedCatalogForVertical(vertical)
      : getGroupedCatalog();
    res.json({ catalog, modules, domains, vertical });
  },
);

// GET /api/roles/:id — single role with permissions and user count
router.get(
  "/:id",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: {
          permissions: true,
          _count: { select: { userRoles: true } },
        },
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check for non-OWNER users
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({
        ...role,
        userCount: role._count.userRoles,
        _count: undefined,
      });
    } catch (err) {
      console.error("[roles] get error:", err);
      res.status(500).json({ error: "Failed to fetch role" });
    }
  },
);

// POST /api/roles — create a new role
router.post(
  "/",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const { name, description, key, userType, landingPath } = req.body;

      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "Role name is required" });
      }

      // Bug 6 — shared validator. The regex + helper text live in
      // backend/lib/roleKey.js and frontend/src/utils/roleKey.js so
      // the form helper string can't drift from the validator regex.
      const keyError = validateRoleKey(key);
      if (keyError) {
        return res.status(400).json({ error: keyError });
      }

      const landingPathErr = validateLandingPath(landingPath);
      if (landingPathErr) {
        return res.status(400).json({ error: landingPathErr });
      }

      // Check if key already exists in this tenant
      const existingRole = await prisma.role.findFirst({
        where: {
          tenantId: req.user.tenantId,
          key,
        },
      });

      if (existingRole) {
        return res
          .status(409)
          .json({ error: "Role key already exists in this tenant" });
      }

      const role = await prisma.role.create({
        data: {
          tenantId: req.user.tenantId,
          key,
          name,
          description: description || null,
          isSystem: false,
          userType: userType || "STAFF",
          isActive: true,
          landingPath: normalizeLandingPath(landingPath),
        },
        include: { permissions: true },
      });

      await writeAudit(
        "Role",
        "CREATE_ROLE",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId: role.id,
          key: role.key,
          name: role.name,
        },
      );

      res.status(201).json(role);
    } catch (err) {
      console.error("[roles] create error:", err);
      res.status(500).json({ error: "Failed to create role" });
    }
  },
);

// PUT /api/roles/:id — update role (not key/isSystem). landingPath IS
// editable on system roles so admins can re-point ADMIN / CUSTOMER landings
// without recreating the row. Bug 2 — Key + userType on a system role
// are explicitly rejected here even though the destructure ignores
// them, so a future contributor who adds `key`/`userType` to the
// update payload can't silently change system role identity.
router.put(
  "/:id",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { name, description, landingPath } = req.body;

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Bug 2 — System role identity is immutable. Block any attempt
      // to change `key` or `userType` on ADMIN / CUSTOMER / OWNER even
      // if those fields are in the body. The destructure above
      // already ignores them so today's API silently no-ops, but
      // surfacing 403 makes the contract explicit + protects against
      // a future contributor extending the destructure.
      if (role.isSystem) {
        const bodyKey =
          req.body && Object.prototype.hasOwnProperty.call(req.body, "key");
        const bodyUserType =
          req.body &&
          Object.prototype.hasOwnProperty.call(req.body, "userType");
        if (bodyKey || bodyUserType) {
          return res.status(403).json({
            error: "System role identity cannot be modified",
            code: "SYSTEM_ROLE_IDENTITY_LOCKED",
            roleKey: role.key,
            fields: [bodyKey && "key", bodyUserType && "userType"].filter(
              Boolean,
            ),
          });
        }
      }

      if (landingPath !== undefined) {
        const landingPathErr = validateLandingPath(landingPath);
        if (landingPathErr) {
          return res.status(400).json({ error: landingPathErr });
        }
        // If a non-empty landingPath was provided, also confirm the role
        // has permissions to access that page. /home is permission-free
        // (always allowed) so the typical "park new role at /home until
        // we configure widgets" flow still works.
        const normalized = normalizeLandingPath(landingPath);
        if (normalized) {
          const perms = await permissionSetForRole(roleId);
          if (!canAccessPath(normalized, perms)) {
            return res.status(400).json({
              error:
                "Landing page is not accessible by this role. Grant the required permissions first, or pick a page the role already has access to.",
              code: "LANDING_PATH_NOT_ACCESSIBLE",
              path: normalized,
            });
          }
        }
      }

      const updated = await prisma.role.update({
        where: { id: roleId },
        data: {
          name: name !== undefined ? name : role.name,
          description:
            description !== undefined ? description : role.description,
          landingPath:
            landingPath !== undefined
              ? normalizeLandingPath(landingPath)
              : role.landingPath,
        },
        include: { permissions: true },
      });

      await writeAudit(
        "Role",
        "UPDATE_ROLE",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId: updated.id,
          key: updated.key,
          changes: { name, description, landingPath },
        },
      );

      res.json(updated);
    } catch (err) {
      console.error("[roles] update error:", err);
      res.status(500).json({ error: "Failed to update role" });
    }
  },
);

// DELETE /api/roles/:id — delete role (409 if users assigned)
router.delete(
  "/:id",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: { _count: { select: { userRoles: true } } },
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // SPEC §C3 + §F + Bug 2 — system roles (ADMIN, CUSTOMER, OWNER)
      // are immutable identity. Their key and is_system flag never
      // change; they cannot be deleted. Admins can still tune their
      // grants / widgets / landingPath via the OTHER endpoints — only
      // the row identity is protected. Returns 403 with the exact
      // error string the QA spec pins, plus the legacy
      // SYSTEM_ROLE_PROTECTED code + roleKey so existing frontend
      // switch-on-code branches keep working.
      if (role.isSystem) {
        return res.status(403).json({
          error: "System role identity cannot be modified",
          code: "SYSTEM_ROLE_PROTECTED",
          roleKey: role.key,
          detail: `System role "${role.key}" cannot be deleted. Its permissions can be tuned, but the role itself stays.`,
        });
      }

      // Cannot delete role with assigned users
      if (role._count.userRoles > 0) {
        return res.status(409).json({
          error: `Cannot delete role with ${role._count.userRoles} assigned users`,
          code: "ROLE_IN_USE",
          userCount: role._count.userRoles,
        });
      }

      await prisma.role.delete({ where: { id: roleId } });

      await writeAudit(
        "Role",
        "DELETE_ROLE",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          key: role.key,
          name: role.name,
        },
      );

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] delete error:", err);
      res.status(500).json({ error: "Failed to delete role" });
    }
  },
);

// GET /api/roles/:id/permissions — list role's permissions
router.get(
  "/:id/permissions",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: { permissions: true },
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ roleId, permissions: role.permissions });
    } catch (err) {
      console.error("[roles] permissions list error:", err);
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  },
);

// POST /api/roles/:id/permissions — grant one permission to role
router.post(
  "/:id/permissions",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { module, action } = req.body;

      if (!module || !action) {
        return res
          .status(400)
          .json({ error: "module and action are required" });
      }

      if (!isValidPermission(module, action)) {
        return res
          .status(400)
          .json({ error: "Invalid module.action permission" });
      }

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Bug 4 — Strict per-vertical validation (env-gated). Enable
      // RBAC_STRICT_VERTICAL_VALIDATION=1 AFTER running the foreign-
      // perms cleanup script for every dirty tenant. Once on, the
      // route refuses cross-vertical grants (e.g. patients.read on a
      // travel tenant) with the exact 400 shape the QA spec pins.
      if (strictVerticalValidationOn()) {
        const vertical = await getTenantVertical(role.tenantId);
        const verticalCheck = validatePermissionForVertical(
          module,
          action,
          vertical,
        );
        if (!verticalCheck.ok) {
          return res.status(400).json({
            error: verticalCheck.error,
            code: verticalCheck.code,
            module,
            action,
            vertical,
          });
        }
      }

      // Check if permission already exists
      const existing = await prisma.rolePermission.findUnique({
        where: {
          roleId_module_action: { roleId, module, action },
        },
      });

      if (existing) {
        return res
          .status(409)
          .json({ error: "Permission already granted to this role" });
      }

      const permission = await prisma.rolePermission.create({
        data: { roleId, module, action },
      });

      // Clear permission cache for all users with this role + the
      // patient-portal CUSTOMER-role cache (lib/portalPermissions.js).
      clearTenantCache(role.tenantId);
      if (role.key === "CUSTOMER") clearCustomerRoleCache(role.tenantId);

      await writeAudit(
        "Role",
        "GRANT_PERMISSION",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          permission: `${module}.${action}`,
        },
      );

      res.status(201).json(permission);
    } catch (err) {
      console.error("[roles] grant permission error:", err);
      res.status(500).json({ error: "Failed to grant permission" });
    }
  },
);

// DELETE /api/roles/:id/permissions/:module/:action — revoke permission
router.delete(
  "/:id/permissions/:module/:action",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { module, action } = req.params;

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const permission = await prisma.rolePermission.findUnique({
        where: {
          roleId_module_action: { roleId, module, action },
        },
      });

      if (!permission) {
        return res
          .status(404)
          .json({ error: "Permission not found on this role" });
      }

      // RBAC Hardening — lockout invariant on the per-perm DELETE path.
      // Pre-fix this endpoint deleted the row directly without consulting
      // checkLockout, so a scripted client could fire
      //   DELETE /api/roles/<adminRoleId>/permissions/roles/read
      // and bypass the bulk-PUT save's guard entirely (the actual
      // tester-incident scenario on tenant 11 was reachable here).
      // Same invariant as the PUT path: simulate the post-delete state
      // and reject if zero active users retain critical perms. Reuses
      // the existing simulateAdminCount/checkLockout via the same
      // rolePermissionOverride-shape input — no new abstraction.
      const currentRolePerms = await prisma.rolePermission.findMany({
        where: { roleId },
        select: { module: true, action: true },
      });
      const proposedPerms = currentRolePerms.filter(
        (p) => !(p.module === module && p.action === action),
      );
      const lockout = await checkLockout({
        tenantId: role.tenantId,
        roleId,
        proposedPermissions: proposedPerms,
      });
      if (lockout) {
        // Same Phase 6 audit shape as the bulk-PUT lockout retort so the
        // audit viewer can collate both reject paths under one query.
        await writeAudit(
          "Role",
          "LOCKOUT_PREVENTED",
          req.user.userId,
          req.user.userId,
          req.user.tenantId,
          {
            roleId,
            roleKey: role.key,
            attemptedPermissionCount: proposedPerms.length,
            criticalPermissions: lockout.body.criticalPermissions,
            qualifyingUserCount: lockout.body.qualifyingUserCount,
            via: "per_perm_delete",
            attemptedRemoval: `${module}.${action}`,
          },
        );
        return res.status(lockout.status).json(lockout.body);
      }

      await prisma.rolePermission.delete({
        where: {
          roleId_module_action: { roleId, module, action },
        },
      });

      // Clear permission cache for all users with this role + the
      // patient-portal CUSTOMER-role cache (lib/portalPermissions.js).
      clearTenantCache(role.tenantId);
      if (role.key === "CUSTOMER") clearCustomerRoleCache(role.tenantId);

      await writeAudit(
        "Role",
        "REVOKE_PERMISSION",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          permission: `${module}.${action}`,
        },
      );

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] revoke permission error:", err);
      res.status(500).json({ error: "Failed to revoke permission" });
    }
  },
);

// PUT /api/roles/:id/permissions — bulk-set permissions (replace all)
router.put(
  "/:id/permissions",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { permissions } = req.body; // Array of {module, action}

      if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: "permissions must be an array" });
      }

      // Validate + dedupe in one pass. Server-side dedup is defensive —
      // the matrix UI uses a Set so it shouldn't send duplicates, but if
      // any do leak through, the composite (roleId, module, action)
      // unique constraint would race the parallel inserts and leave the
      // role half-applied.
      const normalized = [];
      const seen = new Set();
      for (const perm of permissions) {
        if (!perm || typeof perm !== "object") {
          return res.status(400).json({
            error: "Each permission must be an object {module, action}",
          });
        }
        const { module, action } = perm;
        if (!module || !action) {
          return res.status(400).json({
            error: "Each permission requires both module and action",
          });
        }
        if (!isValidPermission(module, action)) {
          return res.status(400).json({
            error: `Invalid permission: ${module}.${action}`,
          });
        }
        const key = `${module}.${action}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ roleId, module, action });
      }

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: { permissions: true },
      });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Bug 4 — Strict per-vertical validation (env-gated). Reject
      // the whole submission with the first foreign entry so the
      // admin sees ONE error to fix rather than a chain of 400s.
      // Same env flag + same error shape as POST /:id/permissions.
      // Once enabled, the catalog endpoint's vertical filter and the
      // editor's catalog filter mean a well-behaved client never
      // submits a foreign perm — this guard catches scripted clients
      // and legacy round-trips.
      if (strictVerticalValidationOn()) {
        const vertical = await getTenantVertical(role.tenantId);
        for (const p of normalized) {
          const verticalCheck = validatePermissionForVertical(
            p.module,
            p.action,
            vertical,
          );
          if (!verticalCheck.ok) {
            return res.status(400).json({
              error: verticalCheck.error,
              code: verticalCheck.code,
              module: p.module,
              action: p.action,
              vertical,
            });
          }
        }
      }

      // RBAC Hardening — General self-lockout prevention (replaces the
      // pre-fix LAST_ADMIN_PROTECTION which was hardcoded to
      // `role.key === "ADMIN"` + the single `roles.manage` permission).
      // The general guard is role-name agnostic: it simulates the
      // resulting permission state of every active user in the tenant
      // and rejects if zero users would retain BOTH critical perms
      // (roles.read + roles.manage). See lib/rbacLockoutGuard.js.
      //
      // This catches the tester scenario where `roles.read` was
      // removed (hiding the page) while `roles.manage` survived —
      // the old guard didn't even look at `roles.read`.
      const lockout = await checkLockout({
        tenantId: role.tenantId,
        roleId,
        proposedPermissions: normalized,
      });
      if (lockout) {
        // RBAC Hardening Phase 6 — audit the prevention so the
        // attempt is visible in the audit log even though the write
        // didn't land.
        await writeAudit(
          "Role",
          "LOCKOUT_PREVENTED",
          req.user.userId,
          req.user.userId,
          req.user.tenantId,
          {
            roleId,
            roleKey: role.key,
            attemptedPermissionCount: normalized.length,
            criticalPermissions: lockout.body.criticalPermissions,
            qualifyingUserCount: lockout.body.qualifyingUserCount,
          },
        );
        return res.status(lockout.status).json(lockout.body);
      }

      // SPEC §6a — detect newly-granted sensitive permissions so the
      // audit log records WHICH grants the admin signed off on. The
      // frontend PermissionsModal shows a confirmation modal listing
      // these BEFORE invoking save; the audit metadata captures what
      // they confirmed.
      const newlySensitive = getNewlyGrantedSensitive(
        role.permissions,
        normalized,
      );

      // Atomic replace. If the bulk insert fails for any reason
      // (connection pool, unique-constraint race, transient lock),
      // the deleteMany rolls back and the role keeps its prior
      // permissions — no more "half-applied + 500" state.
      //
      // Also clears Role.landingPath when the new permission set no
      // longer grants access to the saved page. Without this, an admin
      // who revokes (e.g.) appointments.read leaves the role's
      // landingPath pointing at /wellness/calendar, and the next user
      // who logs in is redirected to a page they immediately 403 on.
      // Same transaction so a failed clear rolls back the perms too.
      //
      // RBAC Hardening Phase 4 — within the same transaction we (a)
      // backfill a v1 INITIAL snapshot for legacy roles that have no
      // history yet (preserves the PRE-save state), then (b) write a
      // new UPDATE snapshot of the resulting state. Restore (Phase 5)
      // appends a RESTORE snapshot via the same helper. History is
      // append-only — never updated, never deleted. The
      // restoredFromVersionId field is optionally surfaced by the
      // restore endpoint via _restoreContext on req (a lightweight
      // hand-off that avoids re-deriving it inside the transaction).
      const { restoredFromVersionId = null, restoreNote = null } =
        req._restoreContext || {};
      const changeType = req._restoreContext ? "RESTORE" : "UPDATE";
      const noteForVersion = req._restoreContext
        ? restoreNote
        : req.body && typeof req.body.note === "string"
          ? req.body.note
          : null;
      const { newPermissions, landingPathCleared, newVersion } =
        await prisma.$transaction(async (tx) => {
          // (a) Backfill INITIAL snapshot of pre-save state ONLY for
          // legacy roles. Idempotent — no-op if a version already exists.
          await ensureInitialSnapshot({
            roleId,
            changedById: req.user.userId,
            tx,
          });
          await tx.rolePermission.deleteMany({ where: { roleId } });
          if (normalized.length > 0) {
            await tx.rolePermission.createMany({
              data: normalized,
              skipDuplicates: true,
            });
          }
          const newPerms = await tx.rolePermission.findMany({
            where: { roleId },
          });

          // (b) Snapshot the resulting state. Even if the post-save
          // set is identical to the pre-save set, we still append a
          // row — preserves the "who saved when, even no-op" audit
          // semantics callers expect.
          const versionRow = await snapshotRolePermissions({
            roleId,
            permissions: newPerms,
            changeType,
            changedById: req.user.userId,
            restoredFromVersionId,
            note: noteForVersion,
            tx,
          });

          // Auto-clear landingPath if it's no longer accessible. /home is
          // permission-free so it always survives.
          let cleared = false;
          if (role.landingPath) {
            const permSet = new Set(
              newPerms.map((p) => `${p.module}.${p.action}`),
            );
            if (!canAccessPath(role.landingPath, permSet)) {
              await tx.role.update({
                where: { id: roleId },
                data: { landingPath: null },
              });
              cleared = true;
            }
          }
          return {
            newPermissions: newPerms,
            landingPathCleared: cleared,
            newVersion: versionRow,
          };
        });

      // Clear permission cache for all users with this role + the
      // patient-portal CUSTOMER-role cache (lib/portalPermissions.js).
      clearTenantCache(role.tenantId);
      if (role.key === "CUSTOMER") clearCustomerRoleCache(role.tenantId);

      await writeAudit(
        "Role",
        changeType === "RESTORE"
          ? "RESTORE_ROLE_PERMISSIONS"
          : "BULK_UPDATE_PERMISSIONS",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          permissionCount: newPermissions.length,
          landingPathCleared,
          previousLandingPath: landingPathCleared ? role.landingPath : null,
          // SPEC §6a — record the sensitive grants admin confirmed in this
          // save so an auditor can trace WHO granted WHAT WHEN. Empty
          // array if no new sensitive grants were added.
          newlyGrantedSensitive: newlySensitive,
          // RBAC Hardening Phase 4/5 — version-history breadcrumb so
          // the audit log carries the version number the snapshot
          // landed at (handy for cross-referencing the "Role History"
          // UI with the audit viewer). restoredFromVersionId surfaces
          // the source version on restore actions.
          newVersionNumber: newVersion ? newVersion.versionNumber : null,
          restoredFromVersionId,
        },
      );

      res.json({
        roleId,
        permissions: newPermissions,
        landingPathCleared,
        // Returned to the frontend so the success toast can mention how
        // many sensitive grants just landed — supplementary signal; the
        // pre-save confirmation modal is the load-bearing gate.
        newlyGrantedSensitive: newlySensitive,
        // Phase 4 — let the frontend show the new version number in
        // the success toast and refresh its history list cheaply.
        newVersion: newVersion
          ? {
              id: newVersion.id,
              versionNumber: newVersion.versionNumber,
              changeType,
            }
          : null,
      });
    } catch (err) {
      console.error("[roles] bulk update permissions error:", err);
      res.status(500).json({ error: "Failed to update permissions" });
    }
  },
);

// GET /api/roles/:id/users — list users assigned to this role
router.get(
  "/:id/users",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: {
          userRoles: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                  userType: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const users = role.userRoles.map((ur) => ({
        ...ur.user,
        assignedAt: ur.assignedAt,
      }));

      res.json({ roleId, users });
    } catch (err) {
      console.error("[roles] users list error:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  },
);

// POST /api/roles/:id/assign/:userId — assign user to role
router.post(
  "/:id/assign/:userId",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const userId = parseInt(req.params.userId);

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId: role.tenantId },
      });
      if (!user) {
        return res.status(404).json({ error: "User not found in this tenant" });
      }

      // Single-role-per-user contract: replace any existing UserRole row(s)
      // for this user with the new one. Application-enforced for now (the
      // schema's @@unique([userId, roleId]) only blocks dup pairs, not dup
      // users). Surfacing previous-role swaps in the audit log gives the
      // admin a clear escalation trail.
      const previousAssignments = await prisma.userRole.findMany({
        where: { userId },
        orderBy: { assignedAt: "desc" },
      });

      if (
        previousAssignments.length === 1 &&
        previousAssignments[0].roleId === roleId
      ) {
        return res.status(409).json({ error: "User already has this role" });
      }

      // SPEC §3 — Last-Admin protection. Assigning a non-ADMIN role to
      // a user who is currently the only ADMIN in their tenant would
      // demote the last admin — block it. Skip when the user is being
      // assigned the ADMIN role itself (no demotion happens) and when
      // the user already has multiple role rows that include ADMIN
      // (defensive — the contract says single-role-per-user but the
      // schema-level invariant isn't enforced yet).
      if (role.tenantId && role.key !== "ADMIN") {
        const adminRoleHere = await prisma.role.findFirst({
          where: { tenantId: role.tenantId, key: "ADMIN" },
          select: { id: true },
        });
        if (adminRoleHere) {
          const userHoldsAdmin = previousAssignments.some(
            (a) => a.roleId === adminRoleHere.id,
          );
          if (userHoldsAdmin) {
            const adminUserCount = await countAdminUsersForTenant(
              role.tenantId,
            );
            if (adminUserCount <= 1) {
              return res.status(409).json({
                error:
                  "Cannot demote the only ADMIN — assign ADMIN to another user first, then change this user's role.",
                code: "LAST_ADMIN_PROTECTION",
              });
            }
          }
        }
      }

      const userRole = await prisma.$transaction(async (tx) => {
        if (previousAssignments.length > 0) {
          await tx.userRole.deleteMany({ where: { userId } });
        }
        const created = await tx.userRole.create({
          data: { userId, roleId, assignedById: req.user.userId },
        });
        // Wellness-tenant sync: derive User.wellnessRole from the new
        // RBAC role so /api/wellness/doctors/availability picks the
        // user up. No-op for generic/travel tenants.
        await syncWellnessRoleFromRbacRoles(tx, {
          userId,
          tenantId: role.tenantId,
        });
        return created;
      });

      // Clear this user's permission cache
      clearUserCache(userId, role.tenantId);

      await writeAudit(
        "Role",
        "ASSIGN_ROLE_TO_USER",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          targetUserId: userId,
          targetEmail: user.email,
          previousRoleIds: previousAssignments.map((a) => a.roleId),
        },
      );

      res.status(201).json(userRole);
    } catch (err) {
      console.error("[roles] assign error:", err);
      res.status(500).json({ error: "Failed to assign role" });
    }
  },
);

// DELETE /api/roles/:id/assign/:userId — remove user from role
router.delete(
  "/:id/assign/:userId",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const userId = parseInt(req.params.userId);

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const userRole = await prisma.userRole.findUnique({
        where: {
          userId_roleId: { userId, roleId },
        },
      });

      if (!userRole) {
        return res.status(404).json({ error: "User does not have this role" });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      // SPEC §3 — Last-Admin protection. Don't let an admin revoke the
      // ADMIN role from the only admin in their tenant — that bricks
      // the tenant's role-management surface entirely. The tenant-scoped
      // check is intentional: the platform OWNER role is unaffected.
      if (role.tenantId && role.key === "ADMIN") {
        const adminUserCount = await countAdminUsersForTenant(role.tenantId);
        if (adminUserCount <= 1) {
          return res.status(409).json({
            error:
              "Cannot remove the only ADMIN — assign ADMIN to another user first, then revoke this one.",
            code: "LAST_ADMIN_PROTECTION",
          });
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.userRole.delete({
          where: {
            userId_roleId: { userId, roleId },
          },
        });
        // Wellness-tenant sync: clear User.wellnessRole if the revoked
        // role was the one driving it (Sankar's case in reverse —
        // revoking DOCTOR should remove him from the bookable list).
        await syncWellnessRoleFromRbacRoles(tx, {
          userId,
          tenantId: role.tenantId,
        });
      });

      // Clear this user's permission cache
      clearUserCache(userId, role.tenantId);

      await writeAudit(
        "Role",
        "REVOKE_ROLE_FROM_USER",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          targetUserId: userId,
          targetEmail: user?.email,
        },
      );

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] unassign error:", err);
      res.status(500).json({ error: "Failed to remove role from user" });
    }
  },
);

// ─────────── User-centric multi-role assignment (SPEC §C3) ───────────
// POST /api/roles/users/:userId/roles — replace a user's role set with
// the supplied roleIds array. Multi-role-aware: the resolver UNIONs
// permissions across all assigned roles (SPEC §B3), so admins can
// compose access from multiple roles instead of being forced into the
// single-role delete-then-create flow of POST /:id/assign/:userId.
//
// The pre-existing single-role endpoint stays live so the role-editor
// UI and any external callers using it continue to work unchanged.
//
// Body: { roleIds: number[] }   — list of role IDs to assign. Empty
//                                 array unassigns all roles (subject
//                                 to last-admin protection).
//
// Mounted under /api/roles/users/:userId/roles instead of
// /api/users/:userId/roles so this file stays the canonical RBAC
// surface. The SPEC-named path /api/users/:id/roles can be added in
// routes/users.js as a thin forwarder if call-sites need the exact
// SPEC URL.
router.post(
  "/users/:userId/roles",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const { roleIds } = req.body || {};

      if (!Array.isArray(roleIds)) {
        return res.status(400).json({
          error: "roleIds must be an array of role IDs",
        });
      }
      // De-dup + validate ID shape. We accept an empty array (unassign
      // all) — the last-admin guard below catches the dangerous edge.
      const targetRoleIds = Array.from(
        new Set(
          roleIds.map((r) => parseInt(r, 10)).filter((n) => Number.isFinite(n)),
        ),
      );

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, tenantId: true, userType: true },
      });
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!req.user.isOwner && targetUser.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Resolve target roles + tenant-scope check. OWNER may assign
      // any role; STAFF admins may only assign roles within their
      // tenant. Platform-level (tenantId=null) roles (e.g. OWNER)
      // cannot be assigned via this endpoint — block them defensively.
      let targetRoles = [];
      if (targetRoleIds.length > 0) {
        targetRoles = await prisma.role.findMany({
          where: { id: { in: targetRoleIds } },
          select: { id: true, key: true, tenantId: true, isActive: true },
        });
        if (targetRoles.length !== targetRoleIds.length) {
          return res
            .status(400)
            .json({ error: "One or more role IDs not found" });
        }
        for (const r of targetRoles) {
          if (!req.user.isOwner && r.tenantId !== req.user.tenantId) {
            return res.status(403).json({
              error: `Cannot assign role ${r.key} — outside your tenant`,
            });
          }
          if (r.tenantId === null && r.key === "OWNER") {
            return res.status(403).json({
              error:
                "OWNER is a platform-level role and cannot be assigned via this endpoint",
              code: "OWNER_ROLE_PROTECTED",
            });
          }
        }
      }

      // SPEC §3 — Last-Admin protection. If the target user currently
      // holds ADMIN AND the new role set doesn't include ADMIN AND the
      // user is the only admin in their tenant → block.
      const previous = await prisma.userRole.findMany({
        where: { userId },
        include: { role: { select: { id: true, key: true, tenantId: true } } },
      });
      const previousAdminRole = previous.find(
        (a) =>
          a.role &&
          a.role.key === "ADMIN" &&
          a.role.tenantId === targetUser.tenantId,
      );
      const newSetIncludesAdmin = targetRoles.some(
        (r) => r.key === "ADMIN" && r.tenantId === targetUser.tenantId,
      );
      if (previousAdminRole && !newSetIncludesAdmin && targetUser.tenantId) {
        const adminUserCount = await countAdminUsersForTenant(
          targetUser.tenantId,
        );
        if (adminUserCount <= 1) {
          return res.status(409).json({
            error:
              "Cannot demote the only ADMIN — assign ADMIN to another user first, then change this user's role set.",
            code: "LAST_ADMIN_PROTECTION",
          });
        }
      }

      // Atomic replace. deleteMany + createMany inside a transaction so
      // a failed insert rolls back the delete and the user keeps their
      // prior role set.
      const newAssignments = await prisma.$transaction(async (tx) => {
        await tx.userRole.deleteMany({ where: { userId } });
        if (targetRoleIds.length === 0) {
          // Empty set → sync helper will clear any stale catalog-derived
          // wellnessRole. No-op for non-wellness tenants.
          await syncWellnessRoleFromRbacRoles(tx, {
            userId,
            tenantId: targetUser.tenantId,
          });
          return [];
        }
        await tx.userRole.createMany({
          data: targetRoleIds.map((roleId) => ({
            userId,
            roleId,
            assignedById: req.user.userId,
          })),
          // Schema has @@unique([userId, roleId]) so a duplicated row
          // would fail; the dedup above already prevents that.
          skipDuplicates: true,
        });
        await syncWellnessRoleFromRbacRoles(tx, {
          userId,
          tenantId: targetUser.tenantId,
        });
        return tx.userRole.findMany({
          where: { userId },
          include: {
            role: {
              select: { id: true, key: true, name: true, landingPath: true },
            },
          },
        });
      });

      // Bust the cache so the next requirePermission read pulls the new
      // grant set immediately (avoids the 30s stale window).
      clearUserCache(userId, targetUser.tenantId);

      await writeAudit(
        "Role",
        "REPLACE_USER_ROLES",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          targetUserId: userId,
          targetEmail: targetUser.email,
          previousRoleIds: previous.map((a) => a.roleId),
          newRoleIds: targetRoleIds,
          previousRoleKeys: previous
            .map((a) => a.role && a.role.key)
            .filter(Boolean),
          newRoleKeys: targetRoles.map((r) => r.key),
        },
      );

      res.json({
        userId,
        roles: newAssignments.map((a) => ({
          roleId: a.roleId,
          key: a.role && a.role.key,
          name: a.role && a.role.name,
          landingPath: a.role && a.role.landingPath,
          assignedAt: a.assignedAt,
        })),
      });
    } catch (err) {
      console.error("[roles] replace user roles error:", err);
      res.status(500).json({ error: "Failed to replace user roles" });
    }
  },
);

// ─────────────────── Per-role widget layout ──────────────────────────

// GET /api/roles/:id/widgets — current widget layout for a role
router.get(
  "/:id/widgets",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: { widgets: true },
      });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const widgets = (role.widgets || [])
        .slice()
        .sort((a, b) => a.position - b.position);
      res.json({ roleId, widgets });
    } catch (err) {
      console.error("[roles] widgets list error:", err);
      res.status(500).json({ error: "Failed to fetch role widgets" });
    }
  },
);

// PUT /api/roles/:id/widgets — bulk-set the widget layout (replace all).
// Body shape: { widgets: [{ widgetKey, position, isEnabled?, settings? }, ...] }
// Mirrors the bulk-permissions PUT pattern: atomic deleteMany +
// createMany inside one transaction. Validates every widgetKey against
// the static catalogue so an unknown key can never land in the table.
router.put(
  "/:id/widgets",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { widgets } = req.body;

      if (!Array.isArray(widgets)) {
        return res.status(400).json({ error: "widgets must be an array" });
      }

      const normalized = [];
      const seen = new Set();
      for (let i = 0; i < widgets.length; i++) {
        const w = widgets[i];
        if (!w || typeof w !== "object") {
          return res.status(400).json({
            error: "Each widget must be an object { widgetKey, position }",
          });
        }
        const { widgetKey } = w;
        if (!isValidWidgetKey(widgetKey)) {
          return res.status(400).json({
            error: `Invalid widget key: ${widgetKey}`,
          });
        }
        if (seen.has(widgetKey)) continue;
        seen.add(widgetKey);
        const position = Number.isFinite(w.position)
          ? Math.floor(w.position)
          : i * 10;
        const isEnabled = w.isEnabled === false ? false : true;
        let settings = null;
        if (w.settings != null && w.settings !== "") {
          if (typeof w.settings === "string") {
            settings = w.settings.slice(0, 4000);
          } else {
            try {
              settings = JSON.stringify(w.settings).slice(0, 4000);
            } catch {
              return res
                .status(400)
                .json({
                  error: `widget settings not serialisable: ${widgetKey}`,
                });
            }
          }
        }
        normalized.push({ roleId, widgetKey, position, isEnabled, settings });
      }

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const newWidgets = await prisma.$transaction(async (tx) => {
        await tx.roleWidget.deleteMany({ where: { roleId } });
        if (normalized.length > 0) {
          await tx.roleWidget.createMany({
            data: normalized,
            skipDuplicates: true,
          });
        }
        return tx.roleWidget.findMany({
          where: { roleId },
          orderBy: { position: "asc" },
        });
      });

      await writeAudit(
        "Role",
        "UPDATE_ROLE_WIDGETS",
        req.user.userId,
        req.user.userId,
        req.user.tenantId,
        {
          roleId,
          roleKey: role.key,
          widgetCount: newWidgets.length,
        },
      );

      res.json({ roleId, widgets: newWidgets });
    } catch (err) {
      console.error("[roles] bulk update widgets error:", err);
      res.status(500).json({ error: "Failed to update widgets" });
    }
  },
);

// ─────────────────── Per-role accessible pages ───────────────────────
//
// GET /api/roles/:id/accessible-pages — returns the subset of the static
// page catalog that this role's current permissions grant access to.
// Drives the landingPath dropdown in the Roles & Permissions admin UI —
// no admin can pick a page the role doesn't already have permission for.
router.get(
  "/:id/accessible-pages",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const perms = await permissionSetForRole(roleId);
      // Pass the role's tenant vertical so wellness pages don't bleed
      // into the Edit-role landing-page dropdown on a travel tenant
      // (or vice-versa) when a role happens to hold a cross-vertical
      // permission (legacy grants, migration artifacts). Matches the
      // vertical filter used by GET /api/pages/catalog for the
      // Create-role dropdown — both surfaces stay consistent.
      const vertical = await getTenantVertical(role.tenantId);
      const pages = getAccessiblePages(perms, { isOwner: false, vertical });
      res.json({ roleId, pages });
    } catch (err) {
      console.error("[roles] accessible-pages error:", err);
      res.status(500).json({ error: "Failed to compute accessible pages" });
    }
  },
);

// ─────────────────── RBAC Hardening Phase 4/5 ─────────────────────
// Role permission version history + restore.

// GET /api/roles/:id/permissions/versions — list snapshots, newest
// first. Pagination via ?take=&skip=. Gated on roles.read so any
// user who can see the matrix can inspect the history.
router.get(
  "/:id/permissions/versions",
  verifyToken,
  // OR-gate so the /settings Role Recovery section can fetch history
  // via settings.manage when roles.read has been lost.
  requireAnyPermission(ROLES_VERSION_READ_OR_RECOVERY),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return res.status(404).json({ error: "Role not found" });
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const versions = await listRolePermissionVersions({
        roleId,
        take: req.query.take,
        skip: req.query.skip,
      });
      // Mark the most-recent version as the current head so the UI
      // can label it "Version N (Current)" without a separate fetch.
      const latest = versions[0] ? versions[0].versionNumber : null;
      res.json({
        roleId,
        versions: versions.map((v) => ({
          ...v,
          isCurrent: v.versionNumber === latest,
        })),
      });
    } catch (err) {
      console.error("[roles] list versions error:", err);
      res.status(500).json({ error: "Failed to list permission versions" });
    }
  },
);

// GET /api/roles/:id/permissions/versions/:versionId — single version
// (full permission set). Useful for the "Compare with current" widget
// in the history UI.
router.get(
  "/:id/permissions/versions/:versionId",
  verifyToken,
  // OR-gate — same rationale as the versions list endpoint above.
  requireAnyPermission(ROLES_VERSION_READ_OR_RECOVERY),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return res.status(404).json({ error: "Role not found" });
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const version = await getRolePermissionVersion({
        versionId: req.params.versionId,
        roleId,
      });
      if (!version) {
        return res
          .status(404)
          .json({ error: "Version not found for this role" });
      }
      res.json({ roleId, version });
    } catch (err) {
      console.error("[roles] get version error:", err);
      res.status(500).json({ error: "Failed to fetch version" });
    }
  },
);

// POST /api/roles/:id/permissions/restore — apply a previous version
// as the new current. Implemented as a delegated PUT call: we load
// the version, hand off to the PUT handler via internal redispatch,
// and the existing lockout guard + atomic transaction + snapshot
// machinery handles the rest. The new snapshot has changeType=RESTORE
// and restoredFromVersionId pointing at the source.
//
// Body: { versionId: number, note?: string }
//
// Why redispatch instead of a separate handler: the PUT path already
// runs every guard (lockout, vertical-validation, landingPath
// auto-clear, sensitive-grant audit) and appends a version row. A
// separate restore handler would have to duplicate every one of those
// guards. The req._restoreContext hand-off below tells the PUT
// handler "this save is a restore" so it tags the snapshot correctly.
router.post(
  "/:id/permissions/restore",
  verifyToken,
  // OR-gate: roles.manage OR settings.manage. The destructive surface
  // here is unchanged — the PUT handler this delegates to still runs
  // checkLockout regardless, so widening the gate does not widen the
  // attack surface.
  requireAnyPermission(ROLES_VERSION_RESTORE_OR_RECOVERY),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { versionId, note } = req.body || {};
      if (!Number.isFinite(parseInt(versionId, 10))) {
        return res.status(400).json({ error: "versionId is required" });
      }
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return res.status(404).json({ error: "Role not found" });
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      const version = await getRolePermissionVersion({
        versionId: parseInt(versionId, 10),
        roleId,
      });
      if (!version) {
        return res
          .status(404)
          .json({ error: "Version not found for this role" });
      }
      // Hand-off context for the PUT handler so the snapshot it
      // writes has changeType=RESTORE + restoredFromVersionId.
      req._restoreContext = {
        restoredFromVersionId: version.id,
        restoreNote:
          typeof note === "string" && note.trim().length > 0
            ? note.trim().slice(0, 500)
            : `Restored from v${version.versionNumber}`,
      };
      // Repackage the body as a PUT permissions payload + invoke the
      // PUT handler directly. The PUT handler reads req.body.permissions
      // and req._restoreContext.
      req.body = { permissions: version.permissions };
      req.method = "PUT";
      // The PUT handler is mounted at PUT /:id/permissions. Express's
      // router stack matches on method + path; the simplest reliable
      // dispatch is to call the handler function directly. We grab it
      // by walking the router stack.
      const layer = router.stack.find(
        (l) =>
          l.route &&
          l.route.path === "/:id/permissions" &&
          l.route.methods &&
          l.route.methods.put,
      );
      if (!layer) {
        return res
          .status(500)
          .json({ error: "Restore dispatch failed: PUT handler not found" });
      }
      // Run the handler chain (verifyToken + requirePermission + body).
      // We've already passed the same gates above, so call the final
      // handler directly. Layer's route.stack carries the middleware
      // sequence; the actual route handler is the last entry.
      const handlers = layer.route.stack.map((l) => l.handle);
      const finalHandler = handlers[handlers.length - 1];
      return finalHandler(req, res, (err) => {
        if (err) {
          console.error("[roles] restore dispatch err:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to restore version" });
          }
        }
      });
    } catch (err) {
      console.error("[roles] restore error:", err);
      res.status(500).json({ error: "Failed to restore version" });
    }
  },
);

module.exports = router;
