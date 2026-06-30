/**
 * Page catalog endpoints.
 *
 *   GET /api/pages/catalog        — full catalog metadata (admin UI uses
 *                                   this to render the picker).
 *   GET /api/pages/me             — pages the SIGNED-IN user can access,
 *                                   given their effective permissions.
 *                                   Drives the QuickLinks /home widget.
 *
 * Per-role accessible-pages live on /api/roles/:id/accessible-pages
 * (routes/roles.js) so the role-edit modal can pre-compute "the user
 * picked these permissions, here's the legal landingPath dropdown".
 */

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { getCatalog, getCatalogForVertical, getAccessiblePages } = require('../lib/pageCatalog');
const { getUserPermissions } = require('../middleware/requirePermission');

// GET /api/pages/catalog — page catalog metadata.
//
// Vertical-aware (Phase 1, 2026-06-15): a travel tenant only sees travel
// + cross-vertical pages; a wellness tenant only sees wellness + cross-
// vertical. The Create-role landingPath dropdown in RolesAdmin.jsx
// fetches this BEFORE a new role has any saved permissions, so the
// usual perm-based filter (/api/roles/:id/accessible-pages) can't yet
// help — this is the pre-save fallback that needs to stay
// vertical-relevant. DB blip → fall back to the full union catalog
// (better-than-empty UX; worst case the dropdown shows a cross-vertical
// page that the post-save perm-based view will drop).
router.get('/catalog', verifyToken, async (req, res) => {
  let vertical = null;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    vertical = tenant?.vertical || null;
  } catch (err) {
    console.error('[pages.catalog] tenant vertical lookup failed:', err && err.message);
  }
  const catalog = vertical ? getCatalogForVertical(vertical) : getCatalog();
  const categories = Array.from(new Set(catalog.map((p) => p.category)));
  res.json({ catalog, categories, vertical });
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    let vertical = null;
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { vertical: true },
      });
      vertical = tenant?.vertical || null;
    } catch (err) {
      console.error('[pages/me] tenant vertical lookup failed:', err && err.message);
    }
    if (req.user.isOwner) {
      return res.json({ pages: getCatalogForVertical(vertical) });
    }
    const perms = await getUserPermissions(req.user.tenantId, req.user.userId);
    const pages = getAccessiblePages(perms, { isOwner: false, vertical });
    res.json({ pages });
  } catch (err) {
    console.error('[pages/me] error:', err);
    res.status(500).json({ error: 'Failed to load accessible pages' });
  }
});

module.exports = router;
