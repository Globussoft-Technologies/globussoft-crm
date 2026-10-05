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
const { verifyToken } = require('../middleware/auth');
const { getCatalogForVertical, getAccessiblePages } = require('../lib/pageCatalog');
const { getUserPermissions } = require('../middleware/requirePermission');
const { resolveTenantVertical } = require('../lib/tenantVertical');

function filterPageSearch(pages, rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!query) return pages;
  return pages.filter((page) => [
    page.label,
    page.title,
    page.name,
    page.description,
    page.category,
    page.path,
    page.route,
    page.parent,
  ].some((value) => String(value || '').toLowerCase().includes(query)));
}

// GET /api/pages/catalog — page catalog metadata.
//
// Vertical-aware (Phase 1, 2026-06-15): a travel tenant only sees travel
// + cross-vertical pages; a wellness tenant only sees wellness + cross-
// vertical. The Create-role landingPath dropdown in RolesAdmin.jsx
// fetches this BEFORE a new role has any saved permissions, so the
// usual perm-based filter (/api/roles/:id/accessible-pages) can't yet
// help — this is the pre-save fallback that needs to stay
// vertical-relevant. If the tenant vertical cannot be resolved, fail closed
// rather than returning the union catalog to a different product vertical.
router.get('/catalog', verifyToken, async (req, res) => {
  const vertical = await resolveTenantVertical(req.user.tenantId);
  if (!vertical) {
    return res.status(503).json({
      error: 'Tenant vertical is unavailable',
      code: 'TENANT_VERTICAL_UNAVAILABLE',
    });
  }
  const catalog = getCatalogForVertical(vertical);
  const categories = Array.from(new Set(catalog.map((p) => p.category)));
  res.json({ catalog, categories, vertical });
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    const vertical = await resolveTenantVertical(req.user.tenantId);
    if (!vertical) {
      return res.status(503).json({
        error: 'Tenant vertical is unavailable',
        code: 'TENANT_VERTICAL_UNAVAILABLE',
      });
    }
    if (req.user.isOwner) {
      const catalogPages = getCatalogForVertical(vertical);
      return res.json({ pages: vertical === 'generic' ? filterPageSearch(catalogPages, req.query.q) : catalogPages });
    }
    const perms = await getUserPermissions(req.user.tenantId, req.user.userId);
    const pages = getAccessiblePages(perms, { isOwner: false, vertical });
    res.json({ pages: vertical === 'generic' ? filterPageSearch(pages, req.query.q) : pages });
  } catch (err) {
    console.error('[pages/me] error:', err);
    res.status(500).json({ error: 'Failed to load accessible pages' });
  }
});

module.exports = router;
