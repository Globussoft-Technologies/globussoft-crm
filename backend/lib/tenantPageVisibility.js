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

// These Generic routes are mounted in the SPA and remain available by direct
// URL, but the canonical Generic navigation catalog deliberately marks them
// `sidebarHidden` (or omits them entirely). Organization Page Visibility is a
// navigation control, so presenting these routes there would create switches
// for links that can never appear in the sidebar. Keep this deny-list aligned
// with GENERIC_SIDEBAR_PAGE_SPECS in frontend/src/utils/sidebarSearch.js.
const GENERIC_NON_SIDEBAR_PAGE_PATHS = new Set([
  '/converted-leads',
  '/callified-data',
  '/lead-routing',
  '/estimates',
  '/sequences',
  '/surveys',
  '/knowledge-base',
  '/dashboards',
  '/approvals',
  '/clients',
  '/forecasting',
  '/quotas',
  '/gmail',
  '/shared-inbox',
  '/support',
  '/workflows',
  '/field-permissions',
  '/custom-reports',
  '/lead-scoring',
  '/booking-pages',
]);

// Generic CRM Page Visibility mirrors the actual rendered sidebar, including
// its order, section names and labels. The route remains the catalog page's
// canonical `path`; these overrides are presentation-only and do not change
// routing, RBAC or API behaviour. Wellness and Travel continue to use their
// existing vertical catalogs unchanged.
const GENERIC_SIDEBAR_PRESENTATION = [
  { path: '/home', label: 'Home', category: 'Core' },
  { path: '/dashboard', label: 'Dashboard', category: 'Core' },
  { path: '/integrations/adsgpt', label: 'AdsGPT', category: 'Core' },
  { path: '/integrations/callified', label: 'Callified', category: 'Core' },

  { path: '/contacts', label: 'Contacts', category: 'Sales' },
  { path: '/pipeline', label: 'Deals and Pipeline', category: 'Sales' },
  { path: '/deal-insights', label: 'Deal Insights', category: 'Sales' },
  { path: '/playbooks', label: 'Playbooks', category: 'Sales' },

  { path: '/leads', label: 'All Leads', category: 'Leads' },
  { path: '/lead-reports', label: 'Lead Reports', category: 'Leads' },

  { path: '/inbox', label: 'Inbox', category: 'Communication' },
  { path: '/whatsapp', label: 'WhatsApp', category: 'Communication' },
  { path: '/calendar-sync', label: 'Calendar Sync', category: 'Communication' },
  { path: '/live-chat', label: 'Live Chat', category: 'Communication' },

  { path: '/tasks', label: 'Task Queue', category: 'Work Management' },

  { path: '/tickets', label: 'Tickets', category: 'Customer Support' },
  { path: '/sla', label: 'SLA Policies', category: 'Customer Support' },

  { path: '/forms', label: 'Web Forms', category: 'Marketing & Automation' },
  { path: '/landing-sites', label: 'Landing Sites', category: 'Marketing & Automation' },
  { path: '/marketing', label: 'Marketing Campaign', category: 'Marketing & Automation' },
  { path: '/ab-tests', label: 'A/B Tests', category: 'Marketing & Automation' },
  { path: '/web-visitors', label: 'Web Visitors', category: 'Marketing & Automation' },
  { path: '/chatbots', label: 'Chatbots', category: 'Marketing & Automation' },
  { path: '/social', label: 'Social Media', category: 'Marketing & Automation' },

  { path: '/signatures', label: 'E-Signatures', category: 'Documents & Delivery' },
  { path: '/document-templates', label: 'Doc Templates', category: 'Documents & Delivery' },
  { path: '/document-tracking', label: 'Doc Tracking', category: 'Documents & Delivery' },
  { path: '/contracts', label: 'Contracts', category: 'Documents & Delivery' },
  { path: '/projects', label: 'Projects', category: 'Documents & Delivery' },

  { path: '/invoices', label: 'Invoices', category: 'Finance' },
  { path: '/expenses', label: 'Expenses', category: 'Finance' },
  { path: '/payments', label: 'Payments', category: 'Finance' },
  { path: '/cpq', label: 'CPQ', category: 'Finance' },

  { path: '/reports', label: 'Reports', category: 'Analytics & Reports' },
  { path: '/agent-reports', label: 'Agent Reports', category: 'Analytics & Reports' },
  { path: '/revenue-goals', label: 'Revenue Goals', category: 'Analytics & Reports' },

  { path: '/sales-teams', label: 'Sales Teams', category: 'Team & Access' },
  { path: '/staff', label: 'Staff', category: 'Team & Access' },
  { path: '/settings/roles', label: 'Roles', category: 'Team & Access' },
  { path: '/territories', label: 'Territories', category: 'Team & Access' },

  { path: '/pickup-plot-inventory', label: 'Plot Inventory', category: 'Pickup & Plot' },
  { path: '/pickup-inventory', label: 'Pickup Inventory', category: 'Pickup & Plot' },
  { path: '/pickup-customers', label: 'Customer Workflows', category: 'Pickup & Plot' },
  { path: '/transport-persons', label: 'Transport Persons', category: 'Pickup & Plot' },
  { path: '/plot-brokers', label: 'Sales Executives', category: 'Pickup & Plot' },
  { path: '/billing-persons', label: 'Billing Persons', category: 'Pickup & Plot' },
  { path: '/pickup-work-assignments', label: 'Assign Staff Work', category: 'Pickup & Plot' },
  { path: '/transport-workspace', label: 'Transport Work', category: 'Pickup & Plot' },
  { path: '/sales-workspace', label: 'Site Visits', category: 'Pickup & Plot' },

  { path: '/audit-log', label: 'Audit Log', category: 'Administration' },
  { path: '/privacy', label: 'Privacy', category: 'Administration' },
  { path: '/admin/csp-violations', label: 'CSP Violations', category: 'Administration' },
  { path: '/admin/embed-allowlist', label: 'Embed Allowlist', category: 'Administration' },
  { path: '/admin/status', label: 'Status', category: 'Administration' },
  { path: '/commission-profiles', label: 'Commission Profiles', category: 'Administration' },
  { path: '/commission-data', label: 'Commission Data', category: 'Administration' },
  { path: '/channels', label: 'Channels', category: 'Administration' },
  { path: '/industry-templates', label: 'Industry Templates', category: 'Administration' },
  { path: '/currencies', label: 'Currencies', category: 'Administration' },
  { path: '/data-import-export', label: 'Import / Export', category: 'Administration' },

  { path: '/sandbox', label: 'Sandbox', category: 'Platform' },
  { path: '/objects', label: 'App Builder', category: 'Platform' },
  { path: '/zapier', label: 'Zapier', category: 'Platform' },
  { path: '/developer', label: 'Developers', category: 'Platform' },

  { path: '/settings', label: 'Settings', category: 'Settings' },
  { path: '/notification-settings', label: 'Notification Settings', category: 'User' },
];

// A small set of generic routes still uses the legacy hardcoded sidebar
// renderer and therefore is not part of the vertical page catalog. Keep
// those routes in the tenant-visibility catalog until their navigation is
// migrated, otherwise Super Admin can see the link but cannot configure it.
// These entries are generic-only; wellness/travel catalog boundaries remain
// unchanged.
const LEGACY_GENERIC_PAGE_CATALOG = [
  {
    path: '/reports',
    label: 'Reports',
    description: 'CRM reports',
    category: 'Analytics & Reports',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/pickup-work-assignments',
    label: 'Assign Staff Work',
    description: 'Assign customers and plots to operational staff',
    category: 'Pickup & Plot',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  // Visibility keys for external launchers, not internal SPA destinations.
  // They control navigation only; integration credentials and APIs retain
  // their existing authorization rules.
  {
    path: '/integrations/adsgpt',
    label: 'AdsGPT',
    description: 'Show the AdsGPT external dashboard shortcut',
    category: 'Integrations',
    requiredPermissions: [],
  },
  {
    path: '/integrations/callified',
    label: 'Callified',
    description: 'Show the Callified external dashboard shortcut',
    category: 'Integrations',
    requiredPermissions: [],
  },
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
  const catalogByPath = new Map([
    ...catalog,
    ...LEGACY_GENERIC_PAGE_CATALOG.map((page) => ({
      ...page,
      requiredPermissions: page.requiredPermissions.map((permission) => ({ ...permission })),
    })),
  ].map((page) => [page.path, page]));

  return GENERIC_SIDEBAR_PRESENTATION.flatMap((sidebarPage) => {
    const page = catalogByPath.get(sidebarPage.path);
    return page ? [{ ...page, label: sidebarPage.label, category: sidebarPage.category }] : [];
  });
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

// Permission filtering needs to know about every mounted page, including a
// route intentionally omitted from the sidebar. Otherwise a hidden route such
// as Generic CRM `/estimates` looks like an unrelated API-only permission and
// its module incorrectly survives in the role editor. The enabled side still
// comes from getTenantPageVisibilityCatalog(), so only sidebar-capable pages
// can keep a page-backed permission module visible.
function getPermissionReferenceCatalogForVertical(vertical) {
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

/**
 * Hide a permission module only when none of the tenant-enabled pages uses it.
 * This keeps shared modules (for example reports or marketing) available when
 * another page in the same module is still enabled.
 */
function filterPermissionCatalogForTenant(catalog, vertical, hiddenPaths) {
  const pages = getTenantPageVisibilityCatalog(vertical);
  const knownKeys = referencedPermissionKeys(getPermissionReferenceCatalogForVertical(vertical));
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
  const knownKeys = referencedPermissionKeys(getPermissionReferenceCatalogForVertical(vertical));
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
      modules: (domain.modules || []).filter((module) =>
        allowedModules.has(typeof module === 'string' ? module : module?.module)),
    }))
    .filter((domain) => domain.modules.length > 0);
}

/**
 * Permission middleware uses this conservative feature check for API routes.
 * If every catalog page that relies on a permission is hidden, the permission
 * is unavailable for the tenant even when stale RolePermission rows remain.
 * Shared permissions stay usable for the tenant's still-visible pages.
 */
async function isPermissionAvailableForTenant(tenantId, module, _action) {
  const visibility = await getTenantPageVisibility(tenantId);
  const pages = getTenantPageVisibilityCatalog(visibility.vertical);
  const matchingPages = pages.filter((page) =>
    (page.requiredPermissions || []).some(
      // Availability is a module-wide ceiling, including mutations. Catalog
      // pages often declare only read; hidden pages must not leave update open.
      (permission) => permission.module === module,
    ),
  );
  if (matchingPages.length === 0) return true;
  return matchingPages.some((page) => !isPathHidden(page.path, visibility.hiddenPaths));
}

module.exports = {
  SETTING_KEY,
  SETTING_CATEGORY,
  REQUIRED_PAGE_PATHS,
  GENERIC_NON_SIDEBAR_PAGE_PATHS,
  GENERIC_SIDEBAR_PRESENTATION,
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
