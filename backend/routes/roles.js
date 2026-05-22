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
const { requirePermission, clearUserCache, clearTenantCache } = require("../middleware/requirePermission");
const {
  isValidPermission,
  getCatalog,
  getGroupedCatalog,
} = require("../lib/permissionCatalog");
const { writeAudit } = require("../lib/audit");
const { validateLandingPath, normalizeLandingPath } = require("../lib/landingPath");
const { isValidWidgetKey } = require("../lib/widgetCatalog");
const {
  getAccessiblePages,
  canAccessPath,
} = require("../lib/pageCatalog");

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

// GET /api/roles — list all roles (tenant-scoped; OWNER sees all)
router.get(
  "/",
  verifyToken,
  requirePermission("roles", "read"),
  async (req, res) => {
    try {
      const where = req.user.isOwner
        ? {} // OWNER sees all roles across all tenants
        : { tenantId: req.user.tenantId }; // STAFF sees tenant-scoped roles only

      const roles = await prisma.role.findMany({
        where,
        include: {
          permissions: true,
          _count: { select: { userRoles: true } }
        },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }]
      });

      res.json({
        roles: roles.map(role => ({
          ...role,
          userCount: role._count.userRoles,
          _count: undefined
        }))
      });
    } catch (err) {
      console.error("[roles] list error:", err);
      res.status(500).json({ error: "Failed to list roles" });
    }
  }
);

// GET /api/roles/catalog — the permission catalog (module → [actions]).
// Source of truth for the role-editor matrix; prevents UI/server drift.
// `domains` groups the modules by domain (CRM Core / Communications /
// Wellness Inventory / etc.) so the Permissions modal can render section
// headers instead of a flat grid — keep an existing client compatible by
// also returning the plain `modules` array.
router.get(
  "/catalog",
  verifyToken,
  requirePermission("roles", "read"),
  (req, res) => {
    const catalog = getCatalog();
    const modules = Object.entries(catalog).map(([module, actions]) => ({
      module,
      actions,
    }));
    const domains = getGroupedCatalog();
    res.json({ catalog, modules, domains });
  }
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
          _count: { select: { userRoles: true } }
        }
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
        _count: undefined
      });
    } catch (err) {
      console.error("[roles] get error:", err);
      res.status(500).json({ error: "Failed to fetch role" });
    }
  }
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

      if (!key || typeof key !== "string") {
        return res.status(400).json({ error: "Role key is required" });
      }

      // Keys must be uppercase alphanumeric_underscore
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        return res.status(400).json({ error: "Role key must start with letter and contain only A-Z, 0-9, _" });
      }

      const landingPathErr = validateLandingPath(landingPath);
      if (landingPathErr) {
        return res.status(400).json({ error: landingPathErr });
      }

      // Check if key already exists in this tenant
      const existingRole = await prisma.role.findFirst({
        where: {
          tenantId: req.user.tenantId,
          key
        }
      });

      if (existingRole) {
        return res.status(409).json({ error: "Role key already exists in this tenant" });
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
        include: { permissions: true }
      });

      await writeAudit("Role", "CREATE_ROLE", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId: role.id,
        key: role.key,
        name: role.name
      });

      res.status(201).json(role);
    } catch (err) {
      console.error("[roles] create error:", err);
      res.status(500).json({ error: "Failed to create role" });
    }
  }
);

// PUT /api/roles/:id — update role (not key/isSystem). landingPath IS
// editable on system roles so admins can re-point ADMIN / CUSTOMER landings
// without recreating the row.
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
          description: description !== undefined ? description : role.description,
          landingPath: landingPath !== undefined ? normalizeLandingPath(landingPath) : role.landingPath,
        },
        include: { permissions: true }
      });

      await writeAudit("Role", "UPDATE_ROLE", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId: updated.id,
        key: updated.key,
        changes: { name, description, landingPath }
      });

      res.json(updated);
    } catch (err) {
      console.error("[roles] update error:", err);
      res.status(500).json({ error: "Failed to update role" });
    }
  }
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
        include: { _count: { select: { userRoles: true } } }
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Cannot delete role with assigned users
      if (role._count.userRoles > 0) {
        return res.status(409).json({
          error: `Cannot delete role with ${role._count.userRoles} assigned users`,
          code: "ROLE_IN_USE",
          userCount: role._count.userRoles
        });
      }

      await prisma.role.delete({ where: { id: roleId } });

      await writeAudit("Role", "DELETE_ROLE", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        key: role.key,
        name: role.name
      });

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] delete error:", err);
      res.status(500).json({ error: "Failed to delete role" });
    }
  }
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
        include: { permissions: true }
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
  }
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
        return res.status(400).json({ error: "module and action are required" });
      }

      if (!isValidPermission(module, action)) {
        return res.status(400).json({ error: "Invalid module.action permission" });
      }

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if permission already exists
      const existing = await prisma.rolePermission.findUnique({
        where: {
          roleId_module_action: { roleId, module, action }
        }
      });

      if (existing) {
        return res.status(409).json({ error: "Permission already granted to this role" });
      }

      const permission = await prisma.rolePermission.create({
        data: { roleId, module, action }
      });

      // Clear permission cache for all users with this role
      clearTenantCache(role.tenantId);

      await writeAudit("Role", "GRANT_PERMISSION", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        permission: `${module}.${action}`
      });

      res.status(201).json(permission);
    } catch (err) {
      console.error("[roles] grant permission error:", err);
      res.status(500).json({ error: "Failed to grant permission" });
    }
  }
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
          roleId_module_action: { roleId, module, action }
        }
      });

      if (!permission) {
        return res.status(404).json({ error: "Permission not found on this role" });
      }

      await prisma.rolePermission.delete({
        where: {
          roleId_module_action: { roleId, module, action }
        }
      });

      // Clear permission cache for all users with this role
      clearTenantCache(role.tenantId);

      await writeAudit("Role", "REVOKE_PERMISSION", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        permission: `${module}.${action}`
      });

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] revoke permission error:", err);
      res.status(500).json({ error: "Failed to revoke permission" });
    }
  }
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
            error: "Each permission must be an object {module, action}"
          });
        }
        const { module, action } = perm;
        if (!module || !action) {
          return res.status(400).json({
            error: "Each permission requires both module and action"
          });
        }
        if (!isValidPermission(module, action)) {
          return res.status(400).json({
            error: `Invalid permission: ${module}.${action}`
          });
        }
        const key = `${module}.${action}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ roleId, module, action });
      }

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

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
      const { newPermissions, landingPathCleared } = await prisma.$transaction(
        async (tx) => {
          await tx.rolePermission.deleteMany({ where: { roleId } });
          if (normalized.length > 0) {
            await tx.rolePermission.createMany({
              data: normalized,
              skipDuplicates: true,
            });
          }
          const newPerms = await tx.rolePermission.findMany({ where: { roleId } });

          // Auto-clear landingPath if it's no longer accessible. /home is
          // permission-free so it always survives.
          let cleared = false;
          if (role.landingPath) {
            const permSet = new Set(newPerms.map((p) => `${p.module}.${p.action}`));
            if (!canAccessPath(role.landingPath, permSet)) {
              await tx.role.update({
                where: { id: roleId },
                data: { landingPath: null },
              });
              cleared = true;
            }
          }
          return { newPermissions: newPerms, landingPathCleared: cleared };
        },
      );

      // Clear permission cache for all users with this role
      clearTenantCache(role.tenantId);

      await writeAudit("Role", "BULK_UPDATE_PERMISSIONS", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        permissionCount: newPermissions.length,
        landingPathCleared,
        previousLandingPath: landingPathCleared ? role.landingPath : null,
      });

      res.json({ roleId, permissions: newPermissions, landingPathCleared });
    } catch (err) {
      console.error("[roles] bulk update permissions error:", err);
      res.status(500).json({ error: "Failed to update permissions" });
    }
  }
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
                  createdAt: true
                }
              }
            }
          }
        }
      });

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const users = role.userRoles.map(ur => ({
        ...ur.user,
        assignedAt: ur.assignedAt
      }));

      res.json({ roleId, users });
    } catch (err) {
      console.error("[roles] users list error:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  }
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
        where: { id: userId, tenantId: role.tenantId }
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
        orderBy: { assignedAt: 'desc' },
      });

      if (
        previousAssignments.length === 1 &&
        previousAssignments[0].roleId === roleId
      ) {
        return res.status(409).json({ error: "User already has this role" });
      }

      const userRole = await prisma.$transaction(async (tx) => {
        if (previousAssignments.length > 0) {
          await tx.userRole.deleteMany({ where: { userId } });
        }
        return tx.userRole.create({
          data: { userId, roleId, assignedById: req.user.userId }
        });
      });

      // Clear this user's permission cache
      clearUserCache(userId, role.tenantId);

      await writeAudit("Role", "ASSIGN_ROLE_TO_USER", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        targetUserId: userId,
        targetEmail: user.email,
        previousRoleIds: previousAssignments.map((a) => a.roleId),
      });

      res.status(201).json(userRole);
    } catch (err) {
      console.error("[roles] assign error:", err);
      res.status(500).json({ error: "Failed to assign role" });
    }
  }
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
          userId_roleId: { userId, roleId }
        }
      });

      if (!userRole) {
        return res.status(404).json({ error: "User does not have this role" });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true }
      });

      await prisma.userRole.delete({
        where: {
          userId_roleId: { userId, roleId }
        }
      });

      // Clear this user's permission cache
      clearUserCache(userId, role.tenantId);

      await writeAudit("Role", "REVOKE_ROLE_FROM_USER", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        targetUserId: userId,
        targetEmail: user?.email
      });

      res.json({ success: true });
    } catch (err) {
      console.error("[roles] unassign error:", err);
      res.status(500).json({ error: "Failed to remove role from user" });
    }
  }
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
                .json({ error: `widget settings not serialisable: ${widgetKey}` });
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
      const pages = getAccessiblePages(perms, { isOwner: false });
      res.json({ roleId, pages });
    } catch (err) {
      console.error("[roles] accessible-pages error:", err);
      res.status(500).json({ error: "Failed to compute accessible pages" });
    }
  },
);

module.exports = router;
