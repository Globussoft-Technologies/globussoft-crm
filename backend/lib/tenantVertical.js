const prisma = require('./prisma');

const VALID_TENANT_VERTICALS = new Set(['generic', 'wellness', 'travel']);

function normalizeTenantVertical(vertical) {
  const value = typeof vertical === 'string' ? vertical.trim().toLowerCase() : '';
  return VALID_TENANT_VERTICALS.has(value) ? value : null;
}

/**
 * Resolve the vertical from the tenant row. A fallback is used only when the
 * database lookup itself fails; a missing or malformed tenant row never
 * silently becomes another vertical.
 */
async function resolveTenantVerticalDetailed(tenantId, fallbackVertical = null) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    return {
      vertical: normalizeTenantVertical(tenant?.vertical),
      lookupFailed: false,
      error: null,
    };
  } catch (_err) {
    return {
      vertical: normalizeTenantVertical(fallbackVertical),
      lookupFailed: true,
      error: _err,
    };
  }
}

async function resolveTenantVertical(tenantId, fallbackVertical = null) {
  const result = await resolveTenantVerticalDetailed(tenantId, fallbackVertical);
  return result.vertical;
}

module.exports = {
  VALID_TENANT_VERTICALS,
  normalizeTenantVertical,
  resolveTenantVerticalDetailed,
  resolveTenantVertical,
};
