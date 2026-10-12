"use strict";

const { Prisma } = require("@prisma/client");

const MAX_CUSTOM_ROLE_LIMIT = 100000;

function normalizeCustomRoleLimit(value) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_CUSTOM_ROLE_LIMIT) {
    const error = new Error(`maxCustomRoles must be an integer between 0 and ${MAX_CUSTOM_ROLE_LIMIT}, or null for unlimited.`);
    error.code = "INVALID_CUSTOM_ROLE_LIMIT";
    throw error;
  }
  return parsed;
}

function createRoleLimitReachedError(customRoleCount, maxCustomRoles) {
  const error = new Error(`This organization has reached its custom role limit of ${maxCustomRoles}.`);
  error.code = "ROLE_LIMIT_REACHED";
  error.customRoleCount = customRoleCount;
  error.maxCustomRoles = maxCustomRoles;
  return error;
}

async function countCustomRoles(db, tenantId) {
  return db.role.count({
    where: {
      tenantId,
      // Count every active tenant-managed role. Older accounts were
      // provisioned before isCustom was introduced, so filtering only on
      // isCustom would incorrectly report zero for those accounts. System
      // roles such as ADMIN and CUSTOMER remain outside the account quota.
      isSystem: false,
      isActive: true,
    },
  });
}

async function getCustomRoleSummary(db, tenantId, tenant = null) {
  const resolvedTenant = tenant || await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, maxCustomRoles: true },
  });
  if (!resolvedTenant) {
    const error = new Error("Tenant not found");
    error.code = "TENANT_NOT_FOUND";
    throw error;
  }

  const customRoleCount = await countCustomRoles(db, tenantId);
  const maxCustomRoles = resolvedTenant.maxCustomRoles == null
    ? null
    : Number(resolvedTenant.maxCustomRoles);
  return {
    customRoleCount,
    maxCustomRoles,
    remainingCustomRoles: maxCustomRoles == null
      ? null
      : Math.max(maxCustomRoles - customRoleCount, 0),
    roleLimitReached: maxCustomRoles != null && customRoleCount >= maxCustomRoles,
  };
}

// The tenant row is locked for the duration of the caller's transaction. This
// serializes concurrent role creations for the same tenant so two requests
// cannot both observe the last available slot and create an over-limit role.
async function assertCustomRoleCreationAllowed(tx, tenantId) {
  const rows = await tx.$queryRaw(Prisma.sql`
    SELECT id, maxCustomRoles
    FROM Tenant
    WHERE id = ${tenantId}
    FOR UPDATE
  `);
  const tenant = rows?.[0];
  if (!tenant) {
    const error = new Error("Tenant not found");
    error.code = "TENANT_NOT_FOUND";
    throw error;
  }

  const customRoleCount = await countCustomRoles(tx, tenantId);
  const maxCustomRoles = tenant.maxCustomRoles == null ? null : Number(tenant.maxCustomRoles);
  if (maxCustomRoles != null && customRoleCount >= maxCustomRoles) {
    throw createRoleLimitReachedError(customRoleCount, maxCustomRoles);
  }

  return { customRoleCount, maxCustomRoles };
}

module.exports = {
  MAX_CUSTOM_ROLE_LIMIT,
  normalizeCustomRoleLimit,
  countCustomRoles,
  getCustomRoleSummary,
  assertCustomRoleCreationAllowed,
};
