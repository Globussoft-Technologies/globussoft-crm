const prisma = require('./prisma');
const { resolveTenantVerticalDetailed } = require('./tenantVertical');

async function resolveAuditTenantScope(tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const result = await resolveTenantVerticalDetailed(id);
  if (result.lookupFailed || !result.vertical) return null;

  return { tenantId: id, vertical: result.vertical };
}

function auditTenantWhere(scope, extra = {}) {
  return {
    ...extra,
    tenantId: scope.tenantId,
    tenant: { is: { vertical: scope.vertical } },
  };
}

async function loadTenantAuditActors(userIds, scope) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();

  const users = await prisma.user.findMany({
    where: {
      id: { in: ids },
      tenantId: scope.tenantId,
      tenant: { is: { vertical: scope.vertical } },
    },
    select: {
      id: true,
      name: true,
      email: true,
      tenantId: true,
      tenant: { select: { vertical: true } },
    },
  });

  const actors = new Map();
  for (const user of users) {
    // Keep this check even though the query is scoped. It makes the boundary
    // fail closed if a future query refactor or mock returns a foreign user.
    if (
      Number(user.tenantId) !== scope.tenantId ||
      user.tenant?.vertical !== scope.vertical
    ) continue;

    actors.set(user.id, { id: user.id, name: user.name, email: user.email });
  }
  return actors;
}

function attachTenantAuditActors(rows, actors) {
  return rows.map((row) => {
    const actor = actors.get(Number(row.userId)) || null;
    return {
      ...row,
      // Do not expose a foreign or missing actor's identifier either. This
      // also keeps a malformed audit row from becoming a cross-tenant hint.
      userId: actor ? row.userId : null,
      user: actor,
    };
  });
}

module.exports = {
  resolveAuditTenantScope,
  auditTenantWhere,
  loadTenantAuditActors,
  attachTenantAuditActors,
};
