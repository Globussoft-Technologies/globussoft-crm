/**
 * Boot-time RBAC backfill (idempotent).
 *
 * Wired into server.js's server.listen callback. On every server start, walks
 * the DB and ensures the canonical RBAC shape exists:
 *   - Platform-level OWNER role (tenantId = null), with every OWNER user
 *     assigned to it.
 *   - Per-tenant ADMIN / MANAGER / CUSTOMER / USER system roles, with the
 *     correct permission grants attached.
 *   - UserRole assignments for every staff/customer user, derived from the
 *     legacy User.role and User.userType columns.
 *
 * Mirrors the logic of scripts/seed-rbac-only.js (which stays as a manual CLI
 * tool for operators who want to run it explicitly) — but kept self-contained
 * so a refactor of one file can't silently break server boot. Both files are
 * idempotent: find-first → create, never TRUNCATE, never UPSERT, never touch
 * existing rows. The unique constraints (@@unique([tenantId, key]) on Role,
 * @@unique([roleId, module, action]) on RolePermission, @@unique([userId,
 * roleId]) on UserRole) guarantee no duplicates ever land.
 *
 * Set DISABLE_RBAC_BOOT_SYNC=1 to skip (useful for the side-by-side coverage
 * instance that already runs with DISABLE_CRONS=1).
 */

const prisma = require('../lib/prisma');
const { PERMISSION_CATALOG } = require('../lib/permissionCatalog');

const MANAGER_PERMISSIONS = [
  'contacts.read', 'contacts.write', 'contacts.update',
  'deals.read', 'deals.write', 'deals.update',
  'leads.read', 'leads.write', 'leads.update', 'leads.delete', 'leads.export',
  'tasks.read', 'tasks.write', 'tasks.update',
  'projects.read', 'projects.write', 'projects.update',
  'pipeline.read', 'pipeline.write', 'pipeline.update',
  'quotes.read', 'quotes.write', 'quotes.update',
  'reports.read', 'reports.export',
  'dashboards.read',
  'analytics.read', 'analytics.export',
  'billing.read',
  'staff.read',
  'communications.read', 'communications.write',
  'email.read', 'email.write',
  'sms.read', 'sms.write',
  'marketing.read', 'marketing.write', 'marketing.update',
  'tickets.read', 'tickets.write', 'tickets.update',
  'surveys.read', 'surveys.write', 'surveys.update',
  'documents.read', 'documents.write', 'documents.update',
  'contracts.read', 'contracts.write', 'contracts.update',
  'estimates.read', 'estimates.write', 'estimates.update', 'estimates.export',
];

const CUSTOMER_PERMISSIONS = [
  'appointments.read',
  'services.read',
  'billing.read',
  'documents.read',
  'prescriptions.read',
  'consents.read',
];

const USER_PERMISSIONS = [
  'contacts.read',
  'deals.read',
  'leads.read',
  'tasks.read',
  'projects.read',
  'pipeline.read',
  'quotes.read',
  'reports.read',
  'dashboards.read',
  'analytics.read',
  'communications.read',
  'email.read',
  'sms.read',
  'tickets.read',
  'surveys.read',
  'documents.read',
  'contracts.read',
  'estimates.read',
];

async function ensureRole(stats, { tenantId, key, name, description, isSystem, userType }) {
  const existing = await prisma.role.findFirst({ where: { tenantId, key } });
  if (existing) {
    stats.rolesExisting++;
    return existing;
  }
  const created = await prisma.role.create({
    data: { tenantId, key, name, description, isSystem, isActive: true, userType },
  });
  stats.rolesCreated++;
  return created;
}

async function ensureRolePermission(stats, roleId, module, action) {
  const existing = await prisma.rolePermission.findFirst({
    where: { roleId, module, action },
  });
  if (existing) {
    stats.permsExisting++;
    return;
  }
  await prisma.rolePermission.create({ data: { roleId, module, action } });
  stats.permsCreated++;
}

async function ensureUserRole(stats, userId, roleId) {
  const existing = await prisma.userRole.findFirst({ where: { userId, roleId } });
  if (existing) {
    stats.assignmentsExisting++;
    return;
  }
  await prisma.userRole.create({ data: { userId, roleId } });
  stats.assignmentsCreated++;
}

async function grantAllPermissions(stats, roleId) {
  for (const [module, actions] of Object.entries(PERMISSION_CATALOG)) {
    for (const action of actions) {
      await ensureRolePermission(stats, roleId, module, action);
    }
  }
}

async function grantPermissionList(stats, roleId, perms) {
  for (const perm of perms) {
    const [module, action] = perm.split('.');
    if (!module || !action) continue;
    await ensureRolePermission(stats, roleId, module, action);
  }
}

async function ensureRbacOnBoot() {
  if (process.env.DISABLE_RBAC_BOOT_SYNC === '1') return null;

  const stats = {
    rolesCreated: 0,
    rolesExisting: 0,
    permsCreated: 0,
    permsExisting: 0,
    assignmentsCreated: 0,
    assignmentsExisting: 0,
    usersSkipped: 0,
  };

  const ownerRole = await ensureRole(stats, {
    tenantId: null,
    key: 'OWNER',
    name: 'Platform Owner',
    description: 'Unrestricted access across all organizations',
    isSystem: true,
    userType: 'OWNER',
  });

  // OWNER users get the platform OWNER role. The role itself carries no
  // RolePermission rows because requirePermission.js short-circuits on
  // req.user.isOwner before consulting the permission set.
  const owners = await prisma.user.findMany({ where: { userType: 'OWNER' } });
  for (const u of owners) {
    await ensureUserRole(stats, u.id, ownerRole.id);
  }

  const tenants = await prisma.tenant.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  for (const t of tenants) {
    const adminRole = await ensureRole(stats, {
      tenantId: t.id,
      key: 'ADMIN',
      name: 'Admin',
      description: 'Full access to all features within the organization',
      isSystem: true,
      userType: 'STAFF',
    });
    await grantAllPermissions(stats, adminRole.id);

    const managerRole = await ensureRole(stats, {
      tenantId: t.id,
      key: 'MANAGER',
      name: 'Manager',
      description: 'Manager role with broad staff access',
      isSystem: false,
      userType: 'STAFF',
    });
    await grantPermissionList(stats, managerRole.id, MANAGER_PERMISSIONS);

    const customerRole = await ensureRole(stats, {
      tenantId: t.id,
      key: 'CUSTOMER',
      name: 'Customer',
      description: 'Customer access to booking and appointments only',
      isSystem: true,
      userType: 'CUSTOMER',
    });
    await grantPermissionList(stats, customerRole.id, CUSTOMER_PERMISSIONS);

    const userRole = await ensureRole(stats, {
      tenantId: t.id,
      key: 'USER',
      name: 'User',
      description: 'Basic user role with limited CRM access',
      isSystem: false,
      userType: 'STAFF',
    });
    await grantPermissionList(stats, userRole.id, USER_PERMISSIONS);

    const users = await prisma.user.findMany({ where: { tenantId: t.id } });
    for (const u of users) {
      if (u.userType === 'OWNER') continue;
      const legacy = String(u.role || '').toUpperCase();
      let target = null;
      if (legacy === 'ADMIN') target = adminRole;
      else if (legacy === 'MANAGER') target = managerRole;
      else if (legacy === 'USER') target = userRole;
      else if (u.userType === 'CUSTOMER') target = customerRole;
      if (!target) {
        stats.usersSkipped++;
        continue;
      }
      await ensureUserRole(stats, u.id, target.id);
    }
  }

  return stats;
}

module.exports = { ensureRbacOnBoot };
