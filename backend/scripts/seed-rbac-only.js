/**
 * Targeted, idempotent RBAC seed.
 *
 * Why this exists: `prisma/seed.js` TRUNCATEs the whole database before
 * re-seeding. If you have local data you want to keep (real contacts,
 * in-progress test data, anything not in the seed file), running the full
 * seed wipes it. This script ONLY touches:
 *   - Role
 *   - RolePermission
 *   - UserRole
 * ...and is safe to re-run any number of times. It uses lookup-then-create
 * (no TRUNCATE, no upsert that could clobber custom rows).
 *
 * Run with: `node scripts/seed-rbac-only.js` from the backend/ directory.
 *
 * What it does:
 *  1. For every tenant in the DB: ensure ADMIN / MANAGER / CUSTOMER / USER
 *     system roles exist (matches prisma/seed.js:898-1083).
 *  2. Ensure the platform-level OWNER role exists (tenantId = null).
 *  3. Grant ADMIN every permission in PERMISSION_CATALOG; grant MANAGER /
 *     CUSTOMER / USER the curated subsets that match the main seed.
 *  4. For every User with userType=OWNER: assign OWNER role.
 *  5. For every other User: assign the role matching User.role
 *     (ADMIN / MANAGER / USER). Users with role outside that set are
 *     skipped — wellness-specific roles (doctor/professional/etc.) live
 *     on User.wellnessRole and are out of scope here.
 *
 * Output is a short summary of what was created vs. what already existed.
 */

const prisma = require('../lib/prisma');
const { PERMISSION_CATALOG } = require('../lib/permissionCatalog');

// Curated permission subsets — mirror prisma/seed.js exactly so this stays
// consistent with the canonical seed when someone runs that on a fresh DB.
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

// Counters for the end-of-run summary.
const stats = {
  rolesCreated: 0,
  rolesExisting: 0,
  permsCreated: 0,
  permsExisting: 0,
  assignmentsCreated: 0,
  assignmentsExisting: 0,
  usersSkipped: 0,
};

// Lookup-then-create for Role. The schema's @@unique([tenantId, key]) lets
// us key on (tenantId, key). MySQL treats NULL as distinct in unique
// constraints, so OWNER (tenantId=null) needs a separate lookup path that
// doesn't go through the compound unique.
async function ensureRole({ tenantId, key, name, description, isSystem, userType }) {
  const existing = await prisma.role.findFirst({
    where: { tenantId: tenantId, key },
  });
  if (existing) {
    stats.rolesExisting++;
    return existing;
  }
  const created = await prisma.role.create({
    data: { tenantId, key, name, description, isSystem, isActive: true, userType },
  });
  stats.rolesCreated++;
  console.log(`  + Role created: tenant=${tenantId ?? 'null'} key=${key} (id=${created.id})`);
  return created;
}

// RolePermission has @@unique([roleId, module, action]) so we can rely on
// that to deduplicate. Use findFirst → create rather than upsert because
// upsert wants the unique key in a specific compound shape and the existing
// rows have everything we need already.
async function ensureRolePermission(roleId, module, action) {
  const existing = await prisma.rolePermission.findFirst({
    where: { roleId, module, action },
  });
  if (existing) {
    stats.permsExisting++;
    return existing;
  }
  const created = await prisma.rolePermission.create({
    data: { roleId, module, action },
  });
  stats.permsCreated++;
  return created;
}

async function ensureUserRole(userId, roleId) {
  const existing = await prisma.userRole.findFirst({
    where: { userId, roleId },
  });
  if (existing) {
    stats.assignmentsExisting++;
    return existing;
  }
  const created = await prisma.userRole.create({
    data: { userId, roleId },
  });
  stats.assignmentsCreated++;
  return created;
}

async function grantAllPermissions(roleId) {
  for (const [module, actions] of Object.entries(PERMISSION_CATALOG)) {
    for (const action of actions) {
      await ensureRolePermission(roleId, module, action);
    }
  }
}

async function grantPermissionList(roleId, perms) {
  for (const perm of perms) {
    const [module, action] = perm.split('.');
    if (!module || !action) continue;
    await ensureRolePermission(roleId, module, action);
  }
}

async function seedOwnerRole() {
  const ownerRole = await ensureRole({
    tenantId: null,
    key: 'OWNER',
    name: 'Platform Owner',
    description: 'Unrestricted access across all organizations',
    isSystem: true,
    userType: 'OWNER',
  });
  // OWNER short-circuits permission checks at the middleware level (see
  // requirePermission.js), so we deliberately do NOT grant the OWNER role
  // any permission rows. Leaving it empty matches prisma/seed.js.
  return ownerRole;
}

async function seedTenantRoles(tenantId) {
  console.log(`\n=== tenant=${tenantId} ===`);

  const adminRole = await ensureRole({
    tenantId,
    key: 'ADMIN',
    name: 'Admin',
    description: 'Full access to all features within the organization',
    isSystem: true,
    userType: 'STAFF',
  });
  await grantAllPermissions(adminRole.id);

  const managerRole = await ensureRole({
    tenantId,
    key: 'MANAGER',
    name: 'Manager',
    description: 'Manager role with broad staff access',
    isSystem: false,
    userType: 'STAFF',
  });
  await grantPermissionList(managerRole.id, MANAGER_PERMISSIONS);

  const customerRole = await ensureRole({
    tenantId,
    key: 'CUSTOMER',
    name: 'Customer',
    description: 'Customer access to booking and appointments only',
    isSystem: true,
    userType: 'CUSTOMER',
  });
  await grantPermissionList(customerRole.id, CUSTOMER_PERMISSIONS);

  const userRole = await ensureRole({
    tenantId,
    key: 'USER',
    name: 'User',
    description: 'Basic user role with limited CRM access',
    isSystem: false,
    userType: 'STAFF',
  });
  await grantPermissionList(userRole.id, USER_PERMISSIONS);

  return { adminRole, managerRole, customerRole, userRole };
}

async function assignUsersForTenant(tenantId, roles) {
  const users = await prisma.user.findMany({ where: { tenantId } });
  for (const u of users) {
    // OWNER users get the platform-level OWNER role (handled separately).
    if (u.userType === 'OWNER') continue;

    const legacy = String(u.role || '').toUpperCase();
    let target = null;
    if (legacy === 'ADMIN') target = roles.adminRole;
    else if (legacy === 'MANAGER') target = roles.managerRole;
    else if (legacy === 'USER') target = roles.userRole;
    else if (u.userType === 'CUSTOMER') target = roles.customerRole;

    if (!target) {
      stats.usersSkipped++;
      console.log(`  · Skipped user id=${u.id} email=${u.email} (legacy role=${legacy || 'none'}) — no matching RBAC role`);
      continue;
    }

    const before = stats.assignmentsCreated;
    await ensureUserRole(u.id, target.id);
    if (stats.assignmentsCreated > before) {
      console.log(`  + Assigned user id=${u.id} email=${u.email} -> role.key=${target.key}`);
    }
  }
}

async function assignOwnerUsers(ownerRole) {
  const owners = await prisma.user.findMany({
    where: { userType: 'OWNER' },
  });
  for (const u of owners) {
    const before = stats.assignmentsCreated;
    await ensureUserRole(u.id, ownerRole.id);
    if (stats.assignmentsCreated > before) {
      console.log(`  + Assigned OWNER user id=${u.id} email=${u.email} -> role.key=OWNER`);
    }
  }
}

async function main() {
  console.log('Seeding RBAC roles + permissions + user assignments (idempotent)...\n');

  const ownerRole = await seedOwnerRole();
  console.log(`  · OWNER role id=${ownerRole.id}`);
  await assignOwnerUsers(ownerRole);

  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, vertical: true },
    orderBy: { id: 'asc' },
  });
  if (tenants.length === 0) {
    console.log('\nNo tenants found in DB — nothing to seed for tenant-scoped roles.');
  }

  for (const t of tenants) {
    const roles = await seedTenantRoles(t.id);
    await assignUsersForTenant(t.id, roles);
  }

  console.log('\n--- Summary ---');
  console.log(`Roles:           created=${stats.rolesCreated}  existed=${stats.rolesExisting}`);
  console.log(`Permissions:     created=${stats.permsCreated}  existed=${stats.permsExisting}`);
  console.log(`User assignments: created=${stats.assignmentsCreated}  existed=${stats.assignmentsExisting}`);
  console.log(`Users skipped:   ${stats.usersSkipped}`);
  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
