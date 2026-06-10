/**
 * Widget catalogue + the per-user "my widgets" endpoint.
 *
 * Routes:
 *   GET /api/widgets/catalog — returns the static widget metadata so the
 *      frontend can render the configurator (RolesAdmin) and the /home
 *      dashboard's widget chrome (titles, descriptions, categories).
 *      Mirrors /api/roles/catalog's permission-catalog endpoint pattern.
 *
 *   GET /api/widgets/me — returns the signed-in user's effective widget
 *      layout, intersected with their permissions. Each entry:
 *        { widgetKey, position, isEnabled, settings, meta: { title, ... } }
 *      Widgets the user lacks a required permission for are stripped here
 *      (defence in depth against an out-of-date RoleWidget row). The list
 *      is sorted by position. OWNER short-circuits to "all enabled
 *      widgets, no per-role layout" because OWNER bypasses permissions
 *      and isn't tenant-scoped.
 *
 * Per-role layout CRUD lives on /api/roles/:id/widgets (in routes/roles.js)
 * — same as PermissionsModal lives next to /api/roles/:id/permissions there.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { getCatalog, getWidget } = require('../lib/widgetCatalog');
const { getUserPermissions } = require('../middleware/requirePermission');

// Public-ish: any logged-in user can read the catalogue (it's UI metadata,
// nothing tenant-sensitive). This matches /api/roles/catalog which is also
// readable by anyone with roles.read.
router.get('/catalog', verifyToken, (req, res) => {
  const catalog = getCatalog();
  const categories = Array.from(new Set(catalog.map((w) => w.category)));
  res.json({ catalog, categories });
});

// GET /api/widgets/me — what should this user see on /home?
router.get('/me', verifyToken, async (req, res) => {
  try {
    // OWNER bypasses permission checks elsewhere; surface every enabled
    // widget in catalogue order so they can preview the full dashboard.
    if (req.user.isOwner) {
      const all = getCatalog().map((w, idx) => ({
        widgetKey: w.key,
        position: idx * 10,
        isEnabled: true,
        settings: null,
        meta: { title: w.title, description: w.description, category: w.category },
      }));
      return res.json({ widgets: all });
    }

    // Resolve the user's primary role. /home is a single-role surface;
    // multi-role users get their oldest assignment's widgets (orderBy
    // assignedAt asc) for stability, but per the single-role-per-user
    // contract this should always be one row.
    const userRole = await prisma.userRole.findFirst({
      where: { userId: req.user.userId },
      include: { role: { include: { widgets: true } } },
      orderBy: { assignedAt: 'desc' },
    });

    let rows = [];
    if (userRole && userRole.role && Array.isArray(userRole.role.widgets)) {
      rows = userRole.role.widgets.filter((w) => w.isEnabled !== false);
    }

    // Intersect with this user's effective permissions. A widget whose
    // catalogue entry requires `patients.read` but the user lacks it is
    // dropped here — protects against a stale RoleWidget row after perms
    // were pared back via the matrix UI.
    const userPerms = await getUserPermissions(req.user.tenantId, req.user.userId);

    const filtered = rows
      .map((row) => {
        const meta = getWidget(row.widgetKey);
        if (!meta) return null; // catalogue removed this widget
        const ok = meta.requiredPermissions.every(({ module, action }) =>
          userPerms.has(`${module}.${action}`),
        );
        if (!ok) return null;
        return {
          widgetKey: row.widgetKey,
          position: row.position,
          isEnabled: row.isEnabled,
          settings: row.settings || null,
          meta: { title: meta.title, description: meta.description, category: meta.category },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.position - b.position);

    res.json({ widgets: filtered, role: userRole?.role ? { id: userRole.role.id, key: userRole.role.key, name: userRole.role.name } : null });
  } catch (err) {
    console.error('[widgets/me] error:', err);
    res.status(500).json({ error: 'Failed to load widget layout' });
  }
});

module.exports = router;
