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
const { verifyToken, verifyRole } = require('../middleware/auth');
const {
  requirePermission,
  getUserPermissions,
} = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/audit');

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
      const permissionArray = Array.from(permissions).sort((a, b) => a.localeCompare(b));

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

// SPEC §C3 — POST /api/users/:id/roles. Canonical URL alias of
// `POST /api/roles/users/:userId/roles` (defined in routes/roles.js).
// The canonical handler lives there so the RBAC code stays contiguous;
// this alias just forwards. Both URLs land on the same handler chain
// (same verifyToken + same requirePermission + same audit + same
// last-admin guard), so external callers using either URL get
// identical behaviour.
router.post(
  '/:userId/roles',
  (req, res, next) => {
    // Forward by re-emitting the request at the canonical URL. The
    // `roles` sub-router is mounted at /api/roles, so the canonical
    // path under that mount is /users/:userId/roles. req.params is
    // re-derived by the inner router from the rewritten URL.
    req.url = `/users/${encodeURIComponent(req.params.userId)}/roles`;
    return require('./roles')(req, res, next);
  },
);

// ─── Availability (PRD_TRAVEL_MULTICHANNEL_LEADS G008 — FR-3.3.5) ─────
//
// PUT /api/users/me/availability       — any authenticated user toggles
//                                        their OWN isAvailable flag.
// PUT /api/users/:userId/availability  — ADMIN/MANAGER toggles another
//                                        user's flag (same-tenant only).
//
// Body shape: { isAvailable: boolean }. Returns the post-update slice
// { id, name, email, isAvailable }. Both endpoints audit-log the flip
// so an ops review can reconstruct who was unavailable when an inbound
// lead bounced to the rule's fallbackUserId.
//
// Why two endpoints and not one with role-based behaviour: PRD §3.3.5
// distinguishes "I'm stepping away" (self-service, no privilege check)
// from "manage staff availability" (privileged, audited). Mirroring
// them lets the auth gate be a single verifyRole(['ADMIN','MANAGER'])
// on the latter without leaking a hole into the former.

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return null;
}

router.put('/me/availability', verifyToken, async (req, res) => {
  try {
    const isAvailable = coerceBool(req.body?.isAvailable);
    if (isAvailable === null) {
      return res.status(400).json({ error: 'isAvailable must be a boolean' });
    }
    const meId = req.user.userId;
    const updated = await prisma.user.update({
      where: { id: meId },
      data: { isAvailable },
      select: { id: true, name: true, email: true, isAvailable: true },
    });
    // Best-effort audit — never fails the request.
    try {
      await writeAudit(
        'User',
        'AVAILABILITY_SELF',
        meId,
        meId,
        req.user.tenantId,
        { isAvailable },
      );
    } catch (_e) { /* swallow */ }
    return res.json(updated);
  } catch (err) {
    console.error('[users/me/availability] error:', err);
    return res.status(500).json({ error: 'Failed to update availability' });
  }
});

router.put(
  '/:userId/availability',
  verifyToken,
  verifyRole(['ADMIN', 'MANAGER']),
  async (req, res) => {
    try {
      // body-stripped: id/userId/tenantId/createdAt/updatedAt deleted by
      // stripDangerous; the path param carries the target. Re-deriving
      // from req.params keeps the standing ESLint rule happy too.
      const targetUserId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      const isAvailable = coerceBool(req.body?.isAvailable);
      if (isAvailable === null) {
        return res.status(400).json({ error: 'isAvailable must be a boolean' });
      }

      // Same-tenant guard — admin / manager in tenant A cannot flip a
      // user's availability in tenant B.
      const target = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, tenantId: true },
      });
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (target.tenantId !== req.user.tenantId) {
        return res.status(403).json({
          error: 'Cross-tenant access denied',
          code: 'CROSS_TENANT_DENIED',
        });
      }

      const updated = await prisma.user.update({
        where: { id: targetUserId },
        data: { isAvailable },
        select: { id: true, name: true, email: true, isAvailable: true },
      });
      try {
        await writeAudit(
          'User',
          'AVAILABILITY_ADMIN',
          targetUserId,
          req.user.userId,
          req.user.tenantId,
          { isAvailable, targetUserId },
        );
      } catch (_e) { /* swallow */ }
      return res.json(updated);
    } catch (err) {
      console.error('[users/:userId/availability] error:', err);
      return res.status(500).json({ error: 'Failed to update availability' });
    }
  },
);

module.exports = router;
