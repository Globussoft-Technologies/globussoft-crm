/**
 * SPEC §C3 — unified `GET /api/me` aggregator.
 *
 *   GET /api/me   → { user, roles, effectivePermissions, primaryRole,
 *                     landingPath, nav, widgets }
 *
 * Convenience surface that bundles what's otherwise spread across:
 *   - GET /api/auth/me               (user)
 *   - GET /api/auth/me/permissions   (roles + permissions + primaryRole)
 *   - GET /api/pages/me              (nav — accessible pages)
 *   - GET /api/roles/:id/widgets     (per-role widgets, looked up by primary role)
 *
 * The individual endpoints stay live for backward-compatibility; this one
 * just stitches them into one payload so a single round-trip can drive the
 * post-login UI hydration end-to-end. Permission resolution uses the SAME
 * loadUserPermissions path the requirePermission middleware uses, so the
 * UI's view of effectivePermissions matches what the backend enforces.
 *
 * Also exposes `GET /api/permissions` as a back-compat alias for
 * `GET /api/roles/catalog` — the SPEC §C3 endpoint list names
 * /api/permissions, the implementation lives under /api/roles/catalog.
 * Both are equivalent.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { getUserPermissions } = require('../middleware/requirePermission');
const { resolvePrimaryRole } = require('../lib/roleResolution');
const { getCatalog: getPageCatalog, getAccessiblePages } = require('../lib/pageCatalog');
const {
  getCatalog: getPermissionCatalog,
  getGroupedCatalog,
} = require('../lib/permissionCatalog');

router.get('/', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        tenant: { select: { id: true, name: true, vertical: true, defaultCurrency: true, locale: true } },
        userRoles: {
          include: {
            role: {
              select: { id: true, key: true, name: true, landingPath: true, isSystem: true, tenantId: true },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // OWNER short-circuit — unrestricted across all tenants. No
    // effectivePermissions enumeration (the middleware bypasses the
    // permission check entirely for OWNER), but UI gating helpers
    // shouldn't break — return `isOwner: true` so the frontend can treat
    // any hasPermission() call as `true`.
    if (req.user.isOwner) {
      return res.json({
        user: { ...user, password: undefined, tenantId: undefined },
        isOwner: true,
        roles: ['OWNER'],
        effectivePermissions: [],
        primaryRole: null,
        landingPath: '/dashboard',
        nav: getPageCatalog(),
        widgets: [],
      });
    }

    const primaryRole = await resolvePrimaryRole({
      id: user.id,
      role: user.role,
      tenantId: user.tenantId,
    });

    // SPEC §B3 — effectivePermissions comes from the SAME resolver the
    // requirePermission middleware uses, so the UI's view matches the
    // enforcement view exactly. ADMIN runtime shortcut fires inside
    // getUserPermissions when applicable.
    const permSet = await getUserPermissions(req.user.tenantId, req.user.userId);
    const effectivePermissions = Array.from(permSet).sort((a, b) => a.localeCompare(b));

    // Nav = accessible pages intersected with effective permissions. The
    // sidebar already consumes /api/pages/me with the same logic; this
    // is the same shape so the frontend can use either endpoint.
    const nav = getAccessiblePages(permSet, { isOwner: false });

    // Widgets — UNION across all roles the user holds, per SPEC §B4.
    // De-dup by widgetKey, preferring the lowest position so the home
    // dashboard renders the right ordering when multi-role users land.
    const roleIds = user.userRoles.map((ur) => ur.roleId).filter(Boolean);
    let widgets = [];
    if (roleIds.length > 0) {
      const rawWidgets = await prisma.roleWidget.findMany({
        where: { roleId: { in: roleIds }, isEnabled: true },
        orderBy: [{ position: 'asc' }],
      });
      const seen = new Set();
      for (const w of rawWidgets) {
        if (seen.has(w.widgetKey)) continue;
        seen.add(w.widgetKey);
        widgets.push({
          widgetKey: w.widgetKey,
          position: w.position,
          settings: w.settings || null,
        });
      }
    }

    const roleKeys = user.userRoles
      .map((ur) => ur.role && ur.role.key)
      .filter(Boolean);

    return res.json({
      user: { ...user, password: undefined, tenantId: undefined },
      isOwner: false,
      roles: roleKeys,
      effectivePermissions,
      primaryRole,
      landingPath: primaryRole?.landingPath || null,
      nav,
      widgets,
    });
  } catch (err) {
    console.error('[me] error:', err);
    return res.status(500).json({ error: 'Failed to load /api/me' });
  }
});

// GET /api/permissions — SPEC §C3 alias of /api/roles/catalog. Returns
// the 45-module catalogue + the domain grouping + per-module action
// list. Reuses the role-catalog response shape so any client targeting
// either path works.
const permissionsRouter = express.Router();
permissionsRouter.get('/', verifyToken, (req, res) => {
  const catalog = getPermissionCatalog();
  const modules = Object.entries(catalog).map(([module, actions]) => ({
    module,
    actions,
  }));
  const domains = getGroupedCatalog();
  res.json({ catalog, modules, domains });
});

// Two-router export: keeps the SPEC §C3 endpoint surface (/api/me and
// /api/permissions) contiguous in one module without splitting into
// two micro-files.
module.exports = { meRouter: router, permissionsRouter };
