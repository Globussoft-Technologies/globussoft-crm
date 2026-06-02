/**
 * Patient-portal RBAC resolver.
 *
 * Patient-portal routes don't run under verifyToken + requirePermission
 * because the patient is a Patient row, not a User row, and so has no
 * UserRole assignment. Instead, every patient on a tenant implicitly
 * inherits that tenant's CUSTOMER system role — whatever permissions
 * the admin grants on the CUSTOMER row in the Roles & Permissions matrix
 * apply to ALL portal users on that tenant.
 *
 * Defence in depth: the handler itself ALSO scopes data by
 * `patientId: req.patient.id`, so even if RBAC misconfigures the grant,
 * a patient still can't see another patient's records.
 */

const prisma = require('./prisma');
const { isValidPermission } = require('./permissionCatalog');

const CACHE = new Map();
const CACHE_TTL_MS = 30_000;

async function loadCustomerRolePermissions(tenantId) {
  const role = await prisma.role.findFirst({
    where: { tenantId, key: 'CUSTOMER' },
    select: {
      id: true,
      permissions: { select: { module: true, action: true } },
    },
  });
  if (!role) return new Set();
  const set = new Set();
  for (const p of role.permissions) set.add(`${p.module}.${p.action}`);
  return set;
}

async function getCustomerRolePermissions(tenantId) {
  const cached = CACHE.get(tenantId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.permissions;
  }
  const permissions = await loadCustomerRolePermissions(tenantId);
  CACHE.set(tenantId, { permissions, timestamp: Date.now() });
  return permissions;
}

function clearCustomerRoleCache(tenantId) {
  if (tenantId == null) {
    CACHE.clear();
  } else {
    CACHE.delete(tenantId);
  }
}

/**
 * Express middleware factory. Only valid AFTER verifyPatientToken has
 * populated req.patient with { id, tenantId }.
 */
function requirePortalPermission(module, action) {
  if (!isValidPermission(module, action)) {
    throw new Error(
      `Invalid permission in requirePortalPermission('${module}', '${action}'). ` +
        `Check backend/lib/permissionCatalog.js`,
    );
  }
  const required = `${module}.${action}`;
  return async (req, res, next) => {
    try {
      if (!req.patient || !req.patient.id || !req.patient.tenantId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const perms = await getCustomerRolePermissions(req.patient.tenantId);
      if (perms.has(required)) return next();
      return res.status(403).json({
        error: `Access denied: requires ${module}.${action}`,
        code: 'PORTAL_RBAC_DENIED',
        required,
      });
    } catch (err) {
      console.error('[portalPermissions] middleware error:', err.message);
      // Fail closed.
      return res.status(403).json({
        error: 'Permission check failed',
        code: 'PORTAL_PERMISSION_CHECK_FAILED',
      });
    }
  };
}

module.exports = {
  requirePortalPermission,
  getCustomerRolePermissions,
  loadCustomerRolePermissions,
  clearCustomerRoleCache,
  // exported for tests
  _CACHE: CACHE,
};
