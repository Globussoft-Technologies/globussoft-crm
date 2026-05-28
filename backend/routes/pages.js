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
const { getCatalog, getAccessiblePages } = require('../lib/pageCatalog');
const { getUserPermissions } = require('../middleware/requirePermission');

router.get('/catalog', verifyToken, (req, res) => {
  const catalog = getCatalog();
  const categories = Array.from(new Set(catalog.map((p) => p.category)));
  res.json({ catalog, categories });
});

router.get('/me', verifyToken, async (req, res) => {
  try {
    if (req.user.isOwner) {
      return res.json({ pages: getCatalog() });
    }
    const perms = await getUserPermissions(req.user.tenantId, req.user.userId);
    const pages = getAccessiblePages(perms, { isOwner: false });
    res.json({ pages });
  } catch (err) {
    console.error('[pages/me] error:', err);
    res.status(500).json({ error: 'Failed to load accessible pages' });
  }
});

module.exports = router;
