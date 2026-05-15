/**
 * /api/users — user-scoped read endpoints.
 *
 * Today this file exposes a single endpoint: GET /:userId/permissions, which
 * returns the merged RBAC permissions for a *target* user (not the caller).
 * It's the per-target sister of /api/auth/me/permissions.
 *
 * Guards:
 *  - verifyToken: must be authenticated
 *  - requirePermission('roles', 'read'): only users with the roles.read grant
 *    (typically ADMIN, or OWNER who short-circuits everything) can view
 *    another user's permissions
 *  - same-tenant check: a non-OWNER caller can only view users in their own
 *    tenant. OWNER (isOwner=true) can view any user across tenants.
 *
 * Response shape: same as /api/auth/me/permissions, extended with `user` so
 * the StaffPermissions page can render account/email/role tiles in one trip.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const {
  requirePermission,
  getUserPermissions,
} = require('../middleware/requirePermission');

router.get(
  '/:userId/permissions',
  verifyToken,
  requirePermission('roles', 'read'),
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          wellnessRole: true,
          userType: true,
          tenantId: true,
          createdAt: true,
          deactivatedAt: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Same-tenant guard — OWNER bypasses because they're not tenant-scoped.
      // An ADMIN in tenant A cannot look up a user in tenant B; that would be
      // a cross-tenant info leak about who works at the other org.
      if (!req.user.isOwner && user.tenantId !== req.user.tenantId) {
        return res.status(403).json({
          error: 'Cross-tenant access denied',
          code: 'CROSS_TENANT_DENIED',
        });
      }

      // Target user is OWNER → mirror /auth/me/permissions short-circuit.
      // OWNER bypasses every permission gate at the middleware layer, so
      // returning an explicit permissions array would be misleading; report
      // it as the platform-owner condition instead.
      if (user.userType === 'OWNER') {
        return res.json({
          isOwner: true,
          userType: 'OWNER',
          roles: ['OWNER'],
          permissions: [],
          user,
        });
      }

      // Load merged permissions for the TARGET user via the same helper that
      // backs /auth/me/permissions. This guarantees the two endpoints stay
      // in lock-step — if the merge logic changes, both endpoints change.
      const permissions = await getUserPermissions(user.tenantId, user.id);
      const permissionArray = Array.from(permissions).sort();

      // Role names for the "Assigned roles" pill row in the UI.
      const userRoles = await prisma.userRole.findMany({
        where: { userId: user.id },
        include: { role: { select: { key: true } } },
      });
      const roleNames = userRoles.map((ur) => ur.role?.key).filter(Boolean);

      return res.json({
        isOwner: false,
        userType: user.userType || 'STAFF',
        roles: roleNames,
        permissions: permissionArray,
        user,
      });
    } catch (err) {
      console.error('[users/:userId/permissions] error:', err);
      return res.status(500).json({ error: 'Failed to fetch user permissions' });
    }
  },
);

module.exports = router;
