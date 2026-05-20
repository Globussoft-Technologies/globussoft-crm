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
  isValidPermission,
  getModules,
  getActions,
  getCatalog,
};
