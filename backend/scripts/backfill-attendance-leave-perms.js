#!/usr/bin/env node
// One-shot backfill — adds the new `attendance.*` / `leave.*` permission
// grants to every already-existing staff role on every tenant.
//
// Why this exists: ensureRbacOnBoot.js seeds permissions ONLY on the FIRST
// creation of a role (the `wasCreated` guard). Roles that pre-date the
// attendance/leave permission split keep their old grant set forever, so
// the new /wellness/attendance + /wellness/leave page-catalog gates would
// hide the sidebar entries from every existing staff role even though the
// pages should still be reachable.
//
// What it does:
//   - For each tenant, finds the standard staff roles by key (ADMIN,
//     MANAGER, USER, DOCTOR, NURSE, RECEPTIONIST, TELECALLER).
//   - For each, ensures the role has the appropriate attendance + leave
//     grants (matching what ensureRbacOnBoot.js would seed today).
//   - CUSTOMER + OWNER + any custom role are left untouched.
//   - Insertion is idempotent (skips if the row already exists), so
//     re-running is safe.
//
// Dry-run by default. Use --apply to actually persist.
//
// Usage:
//   node backend/scripts/backfill-attendance-leave-perms.js
//   node backend/scripts/backfill-attendance-leave-perms.js --apply

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

// Per-role-key grant lists. Mirrors ensureRbacOnBoot.js exactly.
// ADMIN is intentionally absent — ADMIN is seeded via grantAllPermissions
// which walks the whole catalog, so it picks up new modules automatically
// on its next ensureRolePermission pass. We still backfill it explicitly
// here because existing ADMIN rows pre-date the catalog addition.
const ROLE_GRANTS = {
  ADMIN: ['attendance.read', 'attendance.write', 'attendance.manage', 'leave.read', 'leave.write', 'leave.manage'],
  MANAGER: ['attendance.read', 'attendance.write', 'attendance.manage', 'leave.read', 'leave.write', 'leave.manage'],
  USER: ['attendance.read', 'attendance.write', 'leave.read', 'leave.write'],
  DOCTOR: ['attendance.read', 'attendance.write', 'leave.read', 'leave.write'],
  NURSE: ['attendance.read', 'attendance.write', 'leave.read', 'leave.write'],
  RECEPTIONIST: ['attendance.read', 'attendance.write', 'leave.read', 'leave.write'],
  TELECALLER: ['attendance.read', 'attendance.write', 'leave.read', 'leave.write'],
};

async function main() {
  console.log(`[backfill-attendance-leave] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to persist)'}`);
  console.log('');

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`[backfill-attendance-leave] scanning ${tenants.length} tenants`);
  console.log('');

  let totalRolesScanned = 0;
  let totalRolesUntouched = 0;
  let totalGrantsAdded = 0;
  let totalGrantsAlready = 0;
  const perRoleKeySummary = {};

  for (const tenant of tenants) {
    const roles = await prisma.role.findMany({
      where: { tenantId: tenant.id, key: { in: Object.keys(ROLE_GRANTS) } },
      select: { id: true, key: true, name: true },
    });

    if (roles.length === 0) {
      console.log(`  · tenant ${tenant.id} (${tenant.name}) — no eligible staff roles`);
      continue;
    }

    for (const role of roles) {
      totalRolesScanned++;
      const wanted = ROLE_GRANTS[role.key];
      const existing = await prisma.rolePermission.findMany({
        where: { roleId: role.id, module: { in: ['attendance', 'leave'] } },
        select: { module: true, action: true },
      });
      const existingSet = new Set(existing.map((p) => `${p.module}.${p.action}`));

      const missing = wanted.filter((perm) => !existingSet.has(perm));
      totalGrantsAlready += wanted.length - missing.length;

      if (missing.length === 0) {
        totalRolesUntouched++;
        continue;
      }

      console.log(
        `  + tenant ${tenant.id} (${tenant.name}) — role ${role.key} (${role.name}): adding ${missing.length} grant(s) → ${missing.join(', ')}`,
      );

      if (APPLY) {
        for (const perm of missing) {
          const [module, action] = perm.split('.');
          // Defensive: createMany would let us skip duplicates with
          // skipDuplicates: true, but RolePermission has no unique constraint
          // we can rely on. Use the same per-row create pattern that
          // ensureRolePermission uses, gated by the pre-check above.
          await prisma.rolePermission.create({
            data: { roleId: role.id, module, action },
          });
        }
      }
      totalGrantsAdded += missing.length;
      perRoleKeySummary[role.key] = (perRoleKeySummary[role.key] || 0) + missing.length;
    }
  }

  console.log('');
  console.log('[backfill-attendance-leave] summary');
  console.log(`  tenants scanned:      ${tenants.length}`);
  console.log(`  staff roles scanned:  ${totalRolesScanned}`);
  console.log(`  roles already up-to-date: ${totalRolesUntouched}`);
  console.log(`  grants already present:   ${totalGrantsAlready}`);
  console.log(`  grants ${APPLY ? 'added' : 'would-add'}:        ${totalGrantsAdded}`);
  if (Object.keys(perRoleKeySummary).length > 0) {
    console.log('  per-role-key breakdown:');
    for (const [key, n] of Object.entries(perRoleKeySummary)) {
      console.log(`    ${key.padEnd(14)} ${n}`);
    }
  }
  if (!APPLY && totalGrantsAdded > 0) {
    console.log('');
    console.log('  Re-run with --apply to persist.');
  }
}

main()
  .catch((err) => {
    console.error('[backfill-attendance-leave] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
