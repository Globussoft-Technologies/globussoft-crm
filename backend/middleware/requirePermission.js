/**
 * Enterprise RBAC Middleware — Multi-Role Permission Checking
 *
 * Usage:
 *   router.delete('/:id', verifyToken, requirePermission('deals', 'delete'), handler)
 *
 * Permission Resolution:
 * 1. OWNER (isOwner: true) → always pass (short-circuit)
 * 2. Load all UserRole assignments for the user
 * 3. Load RolePermission grants for each assigned role
 * 4. Merge into Set<"module.action">
 * 5. Check merged set includes requested permission
 * 6. 30-second cache per user + tenant to avoid repeated DB lookups
 * 7. Fail-open on DB errors (log + next()) for availability
 */

const prisma = require('../lib/prisma');
const { isValidPermission } = require('../lib/permissionCatalog');

// Per-user permission cache: Map<`${tenantId}::${userId}` → Set<"module.action">>
// Each entry has a timestamp; entries older than 30s are refreshed.
const PERMISSION_CACHE = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Load the user's effective permissions from the database.
 * Returns a Set<"module.action"> representing the union of all assigned roles' permissions.
 */
async function loadUserPermissions(tenantId, userId) {
  try {
    // Find all roles assigned to this user via UserRole junction table
    const userRoles = await prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          where: {
            OR: [
              { tenantId: tenantId },  // Tenant-scoped roles
              { tenantId: null },      // Platform-level roles (e.g., OWNER)
            ],
          },
          include: { permissions: true },
        },
      },
    });

    // Collect all permissions from all assigned roles
    const permSet = new Set();
    for (const { role } of userRoles) {
      for (const perm of role.permissions) {
        permSet.add(`${perm.module}.${perm.action}`);
      }
    }

    return permSet;
  } catch (err) {
    console.error(`[requirePermission] loadUserPermissions error:`, err);
    // Fail-open: return empty set so the request is denied but app keeps running
    return new Set();
  }
}

/**
 * Get cached permissions for a user, refreshing from DB if needed.
 */
async function getUserPermissions(tenantId, userId) {
  const cacheKey = `${tenantId}::${userId}`;
  const cached = PERMISSION_CACHE.get(cacheKey);

  // Check if cache exists and is fresh
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.permissions;
  }

  // Cache miss or expired: reload from DB
  const permissions = await loadUserPermissions(tenantId, userId);
  PERMISSION_CACHE.set(cacheKey, { permissions, timestamp: Date.now() });

  return permissions;
}

/**
 * Middleware factory: returns an Express middleware function that checks permission.
 */
function requirePermission(module, action) {
  // Validate permission at middleware creation time (fast-fail on typos)
  if (!isValidPermission(module, action)) {
    throw new Error(
      `Invalid permission in requirePermission('${module}', '${action}'). ` +
      `Check backend/lib/permissionCatalog.js`
    );
  }

  const requiredPerm = `${module}.${action}`;

  return async (req, res, next) => {
    try {
      // OWNER role short-circuit: unrestricted access across all tenants
      if (req.user?.isOwner) {
        return next();
      }

      // CUSTOMER userType is always denied staff-facing routes
      // (blockCustomers middleware handles this, but double-check here)
      if (req.user?.userType === 'CUSTOMER') {
        return res.status(403).json({
          error: 'Access denied',
          code: 'CUSTOMER_ACCESS_DENIED',
        });
      }

      // Require staff user with tenantId
      if (!req.user || !req.user.userId || !req.user.tenantId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Load user's merged permissions (with cache)
      const userPermissions = await getUserPermissions(
        req.user.tenantId,
        req.user.userId
      );

      // Check if user has the required permission
      if (userPermissions.has(requiredPerm)) {
        return next();
      }

      // Permission denied
      return res.status(403).json({
        error: `Access denied: requires ${module}.${action}`,
        code: 'RBAC_DENIED',
        required: requiredPerm,
      });
    } catch (err) {
      console.error(`[requirePermission] middleware error:`, err);
      // Fail-open on unexpected errors (but still deny the request)
      return res.status(403).json({
        error: 'Permission check failed',
        code: 'PERMISSION_CHECK_FAILED',
      });
    }
  };
}

/**
 * Async helper for conditional business logic within route handlers.
 * Returns true if the user has the specified permission, false otherwise.
 *
 * Usage:
 *   if (await userHasPermission(req.user, 'reports', 'export')) {
 *     // Show export button
 *   }
 */
async function userHasPermission(user, module, action) {
  if (!user || !user.userId || !user.tenantId) {
    return false;
  }

  // OWNER always has permission
  if (user.isOwner) {
    return true;
  }

  // CUSTOMER userType is always denied
  if (user.userType === 'CUSTOMER') {
    return false;
  }

  try {
    const permissions = await getUserPermissions(user.tenantId, user.userId);
    return permissions.has(`${module}.${action}`);
  } catch (err) {
    console.error('[userHasPermission] error:', err);
    return false; // Fail-safe
  }
}

/**
 * Clear cached permissions for a specific user.
 * Called after role assignments change.
 */
function clearUserCache(userId, tenantId) {
  if (tenantId) {
    const cacheKey = `${tenantId}::${userId}`;
    PERMISSION_CACHE.delete(cacheKey);
  } else {
    // If tenantId is not specified, clear all entries for this user across all tenants
    for (const key of PERMISSION_CACHE.keys()) {
      if (key.endsWith(`::${userId}`)) {
        PERMISSION_CACHE.delete(key);
      }
    }
  }
}

/**
 * Clear all cached permissions for a tenant.
 * Called after role permissions change.
 */
function clearTenantCache(tenantId) {
  for (const key of PERMISSION_CACHE.keys()) {
    if (key.startsWith(`${tenantId}::`)) {
      PERMISSION_CACHE.delete(key);
    }
  }
}

/**
 * Clear all cached permissions (debugging / testing only).
 */
function clearAllCache() {
  PERMISSION_CACHE.clear();
}

module.exports = {
  requirePermission,
  userHasPermission,
  clearUserCache,
  clearTenantCache,
  clearAllCache,
  // Exported for testing
  PERMISSION_CACHE,
  loadUserPermissions,
  getUserPermissions,
};
