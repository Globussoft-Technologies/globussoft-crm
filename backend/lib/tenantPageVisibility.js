/**
 * Per-tenant page availability.
 *
 * Tenant page availability is deliberately separate from RBAC. A page that
 * is unavailable for a tenant is an upper bound for every user in that
 * tenant; a role can grant less, but never more. The configuration is stored
 * in the existing TenantSetting table so new tenants and existing tenants
 * default to the current behaviour (all catalog pages enabled).
 */

const prisma = require('./prisma');
const {
  getCatalogForVertical,
} = require('./pageCatalog');

const SETTING_KEY = 'navigation.hiddenPages';
const SETTING_CATEGORY = 'feature-flag';
const CACHE_TTL_MS = 30_000;

// These routes are safe landing surfaces. Keeping them enabled prevents a
// tenant configuration from creating a redirect loop or leaving a user with
// no authenticated starting page.
const REQUIRED_PAGE_PATHS = new Set(['/home', '/dashboard', '/wellness', '/travel']);

// A small set of generic routes still uses the legacy hardcoded sidebar
// renderer and therefore is not part of the vertical page catalog. Keep
// those routes in the tenant-visibility catalog until their navigation is
// migrated, otherwise Super Admin can see the link but cannot configure it.
// These entries are generic-only; wellness/travel catalog boundaries remain
// unchanged.
const LEGACY_GENERIC_PAGE_CATALOG = [
  {
    path: '/invoices',
    label: 'Invoices',
    description: 'Invoice ledger + payment links',
    category: 'Finance',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
  },
  {
    path: '/signatures',
    label: 'E-Signatures',
    description: 'Signature request queue',
    category: 'Documents & Delivery',
    requiredPermissions: [{ module: 'signatures', action: 'read' }],
  },
  {
    path: '/sales-teams',
    label: 'Sales Teams',
    description: 'Manage sales team membership and ownership',
    category: 'Team & Access',
    requiredPermissions: [{ module: 'staff', action: 'read' }],
  },
  {
    path: '/pickup-plot-inventory',
    label: 'Pickup & Plot Inventory',
    description: 'Manage pickup locations and available plots or sites',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/pickup-inventory',
    label: 'Pickup Inventory',
    description: 'View pickup-address capacity, assignments, dates, and map locations',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/transport-persons',
    label: 'Transport Persons',
    description: 'Manage drivers, vehicles, and pickup-location assignments',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/plot-brokers',
    label: 'Sales Executives',
    description: 'Manage sales executive contacts, commissions, site visits, and plot assignments',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/billing-persons',
    label: 'Billing Persons',
    description: 'Manage billing staff, customers, and plot assignments',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/pickup-customers',
    label: 'Customer Status',
    description: 'Track customer progress from pickup through broker and billing',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/admin/status',
    label: 'Status',
    description: 'Platform status admin',
    category: 'Administration',
    requiredPermissions: [{ module: 'settings', action: 'manage' }],
  },
  {
    path: '/commission-profiles',
    label: 'Commission Profiles',
    description: 'Commission rule configuration',
    category: 'Administration',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/revenue-goals',
    label: 'Revenue Goals',
    description: 'Revenue target configuration',
    category: 'Analytics & Reports',
    requiredPermissions: [{ module: 'reports', action: 'write' }],
  },
];

const visibilityCache = new Map();

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || !path.startsWith('/') || path.includes('?') || path.includes('#')) {
    return null;
  }
  return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function catalogPathsForVertical(vertical) {
  return new Set(getTenantPageVisibilityCatalog(vertical).map((page) => page.path));
}

function getTenantPageVisibilityCatalog(vertical) {
  const catalog = getCatalogForVertical(vertical);
  if (vertical !== 'generic') return catalog;
  return [
    ...catalog,
    ...LEGACY_GENERIC_PAGE_CATALOG.map((page) => ({
      ...page,
      requiredPermissions: page.requiredPermissions.map((permission) => ({ ...permission })),
    })),
  ];
}

function normalizeHiddenPaths(input, vertical) {
  const allowed = catalogPathsForVertical(vertical);
  const values = Array.isArray(input) ? input : [];
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const path = normalizePath(value);
    if (!path || REQUIRED_PAGE_PATHS.has(path) || !allowed.has(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }

  return result.sort();
}

function parseHiddenPaths(rawValue, vertical) {
  if (!rawValue) return [];
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) return normalizeHiddenPaths(parsed, vertical);
  if (!parsed || typeof parsed !== 'object') return [];
  return normalizeHiddenPaths(parsed.hiddenPaths || parsed.disabledPaths, vertical);
}

function isPathHidden(path, hiddenPaths) {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return (Array.isArray(hiddenPaths) ? hiddenPaths : []).some(
    (hiddenPath) => normalized === hiddenPath || normalized.startsWith(`${hiddenPath}/`),
  );
}

function cloneVisibility(visibility) {
  return {
    tenantId: visibility.tenantId,
    vertical: visibility.vertical,
    hiddenPaths: [...visibility.hiddenPaths],
  };
}

async function getTenantPageVisibility(tenantId, { vertical = null } = {}) {
  const numericTenantId = Number(tenantId);
  if (!Number.isInteger(numericTenantId) || numericTenantId <= 0) {
    return { tenantId: numericTenantId, vertical: vertical || 'generic', hiddenPaths: [] };
  }

  const cached = visibilityCache.get(numericTenantId);
  if (cached && cached.expiresAt > Date.now() && (!vertical || cached.value.vertical === vertical)) {
    return cloneVisibility(cached.value);
  }

  let resolvedVertical = vertical;
  if (!resolvedVertical) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: numericTenantId },
      select: { vertical: true },
    });
    resolvedVertical = tenant?.vertical || 'generic';
  }

  let setting = null;
  try {
    setting = await prisma.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: numericTenantId, key: SETTING_KEY } },
      select: { value: true },
    });
  } catch (err) {
    // The setting is additive and absent on older deployments during a
    // rolling rollout. Preserve the pre-feature all-enabled behaviour until
    // the storage surface is available rather than taking down navigation.
    console.error('[tenantPageVisibility] setting read failed:', err.message);
  }
  const value = {
    tenantId: numericTenantId,
    vertical: resolvedVertical,
    hiddenPaths: parseHiddenPaths(setting?.value, resolvedVertical),
  };
  visibilityCache.set(numericTenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return cloneVisibility(value);
}

function clearTenantPageVisibilityCache(tenantId) {
  const numericTenantId = Number(tenantId);
  if (Number.isInteger(numericTenantId) && numericTenantId > 0) {
    visibilityCache.delete(numericTenantId);
  }
}

function filterPagesByTenantVisibility(pages, visibility) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((page) => !isPathHidden(page?.path, visibility?.hiddenPaths));
}

function permissionKey(permission) {
  if (!permission?.module || !permission?.action) return null;
  return `${permission.module}.${permission.action}`;
}

function referencedPermissionKeys(pages) {
  const keys = new Set();
  for (const page of pages) {
    for (const permission of page.requiredPermissions || []) {
      const key = permissionKey(permission);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * Hide a permission module only when none of the tenant-enabled pages uses it.
 * This keeps shared modules (for example reports or marketing) available when
 * another page in the same module is still enabled.
 */
function filterPermissionCatalogForTenant(catalog, vertical, hiddenPaths) {
  const pages = getTenantPageVisibilityCatalog(vertical);
  const knownKeys = referencedPermissionKeys(pages);
  const enabledKeys = referencedPermissionKeys(
    filterPagesByTenantVisibility(pages, { hiddenPaths }),
  );
  const unavailableModules = getUnavailablePermissionModules(
    catalog,
    knownKeys,
    enabledKeys,
  );
  const filtered = {};

  for (const [module, actions] of Object.entries(catalog || {})) {
    if (!unavailableModules.includes(module)) {
      filtered[module] = [...actions];
    }
  }

  return filtered;
}

function getUnavailablePermissionModules(catalog, knownKeys, enabledKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set();
  const enabled = enabledKeys instanceof Set ? enabledKeys : new Set();
  return Object.keys(catalog || {}).filter((module) => {
    const moduleIsKnown = Array.from(known).some((key) => key.startsWith(`${module}.`));
    const moduleIsEnabled = Array.from(enabled).some((key) => key.startsWith(`${module}.`));
    return moduleIsKnown && !moduleIsEnabled;
  });
}

function getUnavailablePermissionModulesForTenant(catalog, vertical, hiddenPaths) {
  const pages = getTenantPageVisibilityCatalog(vertical);
  const knownKeys = referencedPermissionKeys(pages);
  const enabledKeys = referencedPermissionKeys(
    filterPagesByTenantVisibility(pages, { hiddenPaths }),
  );
  return getUnavailablePermissionModules(catalog, knownKeys, enabledKeys);
}

function filterPermissionDomainsForTenant(domains, catalog) {
  const allowedModules = new Set(Object.keys(catalog || {}));
  return (Array.isArray(domains) ? domains : [])
    .map((domain) => ({
      ...domain,
      modules: (domain.modules || []).filter((module) => allowedModules.has(module)),
    }))
    .filter((domain) => domain.modules.length > 0);
}

/**
 * Permission middleware uses this conservative feature check for API routes.
 * If every catalog page that relies on a permission is hidden, the permission
 * is unavailable for the tenant even when stale RolePermission rows remain.
 * Shared permissions stay usable for the tenant's still-visible pages.
 */
async function isPermissionAvailableForTenant(tenantId, module, action) {
  const visibility = await getTenantPageVisibility(tenantId);
  const pages = getTenantPageVisibilityCatalog(visibility.vertical);
  const matchingPages = pages.filter((page) =>
    (page.requiredPermissions || []).some(
      (permission) => permission.module === module && permission.action === action,
    ),
  );
  if (matchingPages.length === 0) return true;
  return matchingPages.some((page) => !isPathHidden(page.path, visibility.hiddenPaths));
}

module.exports = {
  SETTING_KEY,
  SETTING_CATEGORY,
  REQUIRED_PAGE_PATHS,
  LEGACY_GENERIC_PAGE_CATALOG,
  getTenantPageVisibilityCatalog,
  normalizeHiddenPaths,
  parseHiddenPaths,
  isPathHidden,
  getTenantPageVisibility,
  clearTenantPageVisibilityCache,
  filterPagesByTenantVisibility,
  filterPermissionCatalogForTenant,
  getUnavailablePermissionModulesForTenant,
  filterPermissionDomainsForTenant,
  isPermissionAvailableForTenant,
};
