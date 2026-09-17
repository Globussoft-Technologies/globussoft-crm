const prisma = require('../lib/prisma');
const { requirePermission } = require('./requirePermission');

// API prefixes backed by the generic-only permission modules. This gate is
// mounted after authentication at /api and deliberately bypasses non-generic
// tenants, preserving wellness and travel behavior.
const GENERIC_API_MODULES = new Map([
  ['/cpq', 'cpq'],
  ['/playbooks', 'playbooks'],
  ['/territories', 'territories'],
  ['/live-chat', 'live_chat'],
  ['/support', 'support'],
  ['/sla', 'sla'],
  ['/social', 'social'],
  ['/field-permissions', 'field_permissions'],
  ['/sandbox', 'sandbox'],
  ['/document-templates', 'document_templates'],
  ['/custom_objects', 'custom_objects'],
  ['/ai_scoring', 'lead_scoring'],
  ['/deal-insights', 'deal_insights'],
  ['/calendar', 'calendar'],
  ['/ab-tests', 'ab_tests'],
  ['/booking-pages', 'booking_pages'],
  ['/forms', 'web_forms'],
]);

const ACTION_BY_METHOD = {
  GET: 'read',
  HEAD: 'read',
  POST: 'write',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

function permissionForRequest(path, method) {
  const action = ACTION_BY_METHOD[String(method || '').toUpperCase()];
  if (!action) return null;
  for (const [prefix, module] of GENERIC_API_MODULES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return { module, action };
  }
  return null;
}

async function resolveVertical(req) {
  if (req.user?.vertical) return req.user.vertical;
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { vertical: true },
  });
  const vertical = tenant?.vertical || 'generic';
  req.user.vertical = vertical;
  return vertical;
}

async function genericPermissionGate(req, res, next) {
  // Public endpoints pass through the global auth allow-list without req.user.
  if (!req.user?.tenantId) return next();
  const requirement = permissionForRequest(req.path, req.method);
  if (!requirement) return next();

  try {
    if (await resolveVertical(req) !== 'generic') return next();
  } catch (err) {
    console.error('[genericPermissionGate] tenant lookup failed:', err?.message || err);
    return res.status(503).json({
      error: 'Unable to verify organization access.',
      code: 'TENANT_ACCESS_UNAVAILABLE',
    });
  }

  return requirePermission(requirement.module, requirement.action)(req, res, next);
}

module.exports = {
  genericPermissionGate,
  permissionForRequest,
};
