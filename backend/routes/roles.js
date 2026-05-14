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
const { isValidPermission } = require("../lib/permissionCatalog");
const { writeAudit } = require("../lib/audit");

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
      const { name, description, key, userType } = req.body;

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
          isActive: true
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

// PUT /api/roles/:id — update role (not key/isSystem)
router.put(
  "/:id",
  verifyToken,
  requirePermission("roles", "manage"),
  async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { name, description } = req.body;

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Cannot modify system roles
      if (role.isSystem) {
        return res.status(409).json({ error: "Cannot modify system roles" });
      }

      const updated = await prisma.role.update({
        where: { id: roleId },
        data: {
          name: name !== undefined ? name : role.name,
          description: description !== undefined ? description : role.description
        },
        include: { permissions: true }
      });

      await writeAudit("Role", "UPDATE_ROLE", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId: updated.id,
        key: updated.key,
        changes: { name, description }
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

      // Cannot delete system roles
      if (role.isSystem) {
        return res.status(409).json({ error: "Cannot delete system roles" });
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

      // Validate all permissions
      for (const perm of permissions) {
        if (!isValidPermission(perm.module, perm.action)) {
          return res.status(400).json({
            error: `Invalid permission: ${perm.module}.${perm.action}`
          });
        }
      }

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tenant-scoping check
      if (!req.user.isOwner && role.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Delete all existing permissions
      await prisma.rolePermission.deleteMany({ where: { roleId } });

      // Create new permissions
      const newPermissions = await Promise.all(
        permissions.map(perm =>
          prisma.rolePermission.create({
            data: { roleId, module: perm.module, action: perm.action }
          })
        )
      );

      // Clear permission cache for all users with this role
      clearTenantCache(role.tenantId);

      await writeAudit("Role", "BULK_UPDATE_PERMISSIONS", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        permissionCount: newPermissions.length
      });

      res.json({ roleId, permissions: newPermissions });
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

      // Check if assignment already exists
      const existing = await prisma.userRole.findUnique({
        where: {
          userId_roleId: { userId, roleId }
        }
      });

      if (existing) {
        return res.status(409).json({ error: "User already has this role" });
      }

      const userRole = await prisma.userRole.create({
        data: { userId, roleId, assignedById: req.user.userId }
      });

      // Clear this user's permission cache
      clearUserCache(userId, role.tenantId);

      await writeAudit("Role", "ASSIGN_ROLE_TO_USER", req.user.userId, req.user.userId, req.user.tenantId, {
        roleId,
        roleKey: role.key,
        targetUserId: userId,
        targetEmail: user.email
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

module.exports = router;
