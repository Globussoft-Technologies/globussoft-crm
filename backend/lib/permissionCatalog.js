/**
 * Permission Catalog — Enterprise RBAC
 *
 * Defines all module × action permissions that can be granted to roles.
 * This is the source of truth for the RBAC system: only permissions listed
 * here can be assigned to roles. If a route checks a permission not in this
 * catalog, the middleware will reject it at validation time.
 *
 * Format: module (snake_case) → [ actions ]
 * Actions: read, write, update, delete, export, manage
 *
 * Multi-tenant: Each module is assumed tenant-scoped unless explicitly marked.
 */

const PERMISSION_CATALOG = {
  // ─────────────────────────────────────────────────────────────────────
  // CRM Core (10 modules)
  // ─────────────────────────────────────────────────────────────────────

  contacts: ['read', 'write', 'update', 'delete', 'export'],
  deals: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  leads: ['read', 'write', 'update', 'delete', 'export'],
  tasks: ['read', 'write', 'update', 'delete'],
  projects: ['read', 'write', 'update', 'delete'],
  pipeline: ['read', 'write', 'update', 'delete', 'manage'],
  quotes: ['read', 'write', 'update', 'delete', 'export'],
  forecasting: ['read', 'write', 'export'],
  quotas: ['read', 'write', 'update', 'delete'],

  // ─────────────────────────────────────────────────────────────────────
  // Communications (4 modules)
  // ─────────────────────────────────────────────────────────────────────

  communications: ['read', 'write', 'delete', 'export'],
  email: ['read', 'write', 'delete', 'export'],
  sms: ['read', 'write'],
  whatsapp: ['read', 'write'],

  // ─────────────────────────────────────────────────────────────────────
  // Marketing (1 module)
  // ─────────────────────────────────────────────────────────────────────

  marketing: ['read', 'write', 'update', 'delete', 'export', 'manage'],

  // ─────────────────────────────────────────────────────────────────────
  // Service & Support (4 modules)
  // ─────────────────────────────────────────────────────────────────────

  tickets: ['read', 'write', 'update', 'delete', 'export'],
  knowledge_base: ['read', 'write', 'update', 'delete'],
  surveys: ['read', 'write', 'update', 'delete', 'export'],
  chatbots: ['read', 'write', 'delete', 'manage'],

  // ─────────────────────────────────────────────────────────────────────
  // Financial (4 modules)
  // ─────────────────────────────────────────────────────────────────────

  billing: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  accounting: ['read', 'write', 'export'],
  payments: ['read', 'export'],
  expenses: ['read', 'write', 'update', 'delete', 'manage'],

  // ─────────────────────────────────────────────────────────────────────
  // Analytics (3 modules)
  // ─────────────────────────────────────────────────────────────────────

  reports: ['read', 'write', 'delete', 'export'],
  dashboards: ['read', 'write', 'delete'],
  analytics: ['read', 'export'],

  // ─────────────────────────────────────────────────────────────────────
  // Automation (2 modules)
  // ─────────────────────────────────────────────────────────────────────

  workflows: ['read', 'write', 'update', 'delete', 'manage'],
  sequences: ['read', 'write', 'update', 'delete'],

  // ─────────────────────────────────────────────────────────────────────
  // Documents (4 modules)
  // ─────────────────────────────────────────────────────────────────────

  documents: ['read', 'write', 'update', 'delete', 'export'],
  contracts: ['read', 'write', 'update', 'delete'],
  signatures: ['read', 'manage'],
  estimates: ['read', 'write', 'update', 'delete', 'export'],

  // ─────────────────────────────────────────────────────────────────────
  // Wellness Vertical (5 modules)
  // ─────────────────────────────────────────────────────────────────────

  patients: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  appointments: ['read', 'write', 'update', 'delete', 'export'],
  services: ['read', 'write', 'update', 'delete'],
  prescriptions: ['read', 'write', 'update', 'delete', 'export'],
  consents: ['read', 'write', 'update', 'delete'],
  visits: ['read', 'write', 'update', 'delete'],
  // `products` and `inventory` are deliberately separate modules. `products`
  // covers the master catalog (Product Categories, Product master, Auto-
  // consumption rules) — the "what" you can sell or consume. `inventory`
  // covers operational stock-movement (Vendors, Receipts, Adjustments) —
  // the "how much you have and how it changed". A clinic might grant
  // store managers `products.*` (curating the catalogue) without giving
  // them write access to the stock ledger, or vice-versa.
  products: ['read', 'write', 'update', 'delete', 'manage'],
  inventory: ['read', 'write', 'update', 'delete', 'manage'],
  pos: ['read', 'write', 'manage'],

  // ─────────────────────────────────────────────────────────────────────
  // Admin & Platform (6 modules)
  // ─────────────────────────────────────────────────────────────────────

  staff: ['read', 'write', 'update', 'delete', 'manage'],
  roles: ['read', 'manage'],
  settings: ['read', 'manage'],
  audit: ['read', 'export'],
  integrations: ['read', 'write', 'update', 'delete', 'manage'],
  developer: ['read', 'manage'],
};

// Domain grouping — the Roles & Permissions matrix renders modules
// clustered under these section headers so the long flat list (40+ boxes)
// becomes readable. Order matters; modules within each domain render in
// catalog order. Any module not listed here falls into the "Other"
// bucket at the bottom — keep this map current when adding new modules.
const PERMISSION_DOMAINS = [
  {
    domain: 'CRM Core',
    modules: ['contacts', 'deals', 'leads', 'tasks', 'projects', 'pipeline', 'quotes', 'forecasting', 'quotas'],
  },
  {
    domain: 'Communications',
    modules: ['communications', 'email', 'sms', 'whatsapp'],
  },
  {
    domain: 'Marketing',
    modules: ['marketing'],
  },
  {
    domain: 'Service & Support',
    modules: ['tickets', 'knowledge_base', 'surveys', 'chatbots'],
  },
  {
    domain: 'Financial',
    modules: ['billing', 'accounting', 'payments', 'expenses'],
  },
  {
    domain: 'Analytics',
    modules: ['reports', 'dashboards', 'analytics'],
  },
  {
    domain: 'Automation',
    modules: ['workflows', 'sequences'],
  },
  {
    domain: 'Documents',
    modules: ['documents', 'contracts', 'signatures', 'estimates'],
  },
  {
    domain: 'Wellness Clinical',
    modules: ['patients', 'appointments', 'services', 'prescriptions', 'consents', 'visits'],
  },
  {
    domain: 'Wellness Inventory',
    modules: ['products', 'inventory', 'pos'],
  },
  {
    domain: 'Admin & Platform',
    modules: ['staff', 'roles', 'settings', 'audit', 'integrations', 'developer'],
  },
];

/**
 * Returns the catalog with each module annotated by its domain. Used by
 * /api/roles/catalog so the Permissions modal can render section headers
 * instead of a flat grid of 40+ boxes. Modules not listed in
 * PERMISSION_DOMAINS land in a final "Other" bucket.
 */
function getGroupedCatalog() {
  const moduleToDomain = new Map();
  for (const { domain, modules } of PERMISSION_DOMAINS) {
    for (const m of modules) moduleToDomain.set(m, domain);
  }
  const groups = new Map();
  for (const { domain } of PERMISSION_DOMAINS) groups.set(domain, []);
  groups.set('Other', []);
  for (const [module, actions] of Object.entries(PERMISSION_CATALOG)) {
    const domain = moduleToDomain.get(module) || 'Other';
    groups.get(domain).push({ module, actions: [...actions] });
  }
  return Array.from(groups.entries())
    .filter(([, modules]) => modules.length > 0)
    .map(([domain, modules]) => ({ domain, modules }));
}

/**
 * Validate a (module, action) pair against the catalog.
 * Returns true if valid, false otherwise.
 */
function isValidPermission(module, action) {
  const actions = PERMISSION_CATALOG[module];
  if (!actions) return false;
  return actions.includes(action);
}

/**
 * Get all modules in the catalog.
 */
function getModules() {
  return Object.keys(PERMISSION_CATALOG);
}

/**
 * Get all valid actions for a module.
 */
function getActions(module) {
  return PERMISSION_CATALOG[module] || [];
}

/**
 * Get the entire catalog.
 */
function getCatalog() {
  return { ...PERMISSION_CATALOG };
}

module.exports = {
  PERMISSION_CATALOG,
  PERMISSION_DOMAINS,
  isValidPermission,
  getModules,
  getActions,
  getCatalog,
  getGroupedCatalog,
};
