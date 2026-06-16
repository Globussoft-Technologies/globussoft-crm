/**
 * backup-tenant-rbac.js — dump a tenant's full RBAC state to a JSON
 * file BEFORE running cleanup-foreign-perms-report.js --apply.
 *
 * Bug 3 Step 2 (Backup mechanism) in the QA punch-list. The companion
 * cleanup script's docstring previously said "take a mysqldump backup
 * first" — fine for operators with mysqldump access, but the
 * deployment box restricts CLI mysqldump for compliance reasons and
 * the wellness vertical's PHI rows don't belong in dumps anyway. This
 * dump is tenant-scoped, RBAC-only (Role + RolePermission + UserRole),
 * so it's safe to email / Slack / persist alongside the cleanup run.
 *
 * Usage:
 *   node backend/scripts/backup-tenant-rbac.js --tenant 11
 *     → writes rbac-backup-tenant-11-<iso>.json to cwd
 *
 *   node backend/scripts/backup-tenant-rbac.js --tenant 11 --out /tmp/foo.json
 *     → writes to the specified path
 *
 *   node backend/scripts/backup-tenant-rbac.js --tenant 11 --json
 *     → emits the backup JSON on stdout (also writes the file)
 *
 * Reversal (operator-driven, in the unlikely event the cleanup
 * removes a perm someone wanted to keep):
 *
 *   1. Open backup file. Find the deleted RolePermission row in
 *      `roles[].permissions[]`.
 *   2. Re-grant via the Roles & Permissions UI (matrix → checkbox →
 *      Save) — system audit captures the re-grant.
 *
 *   We deliberately do NOT ship a JSON-replay tool: each re-grant is
 *   a deliberate admin decision and should go through the same audit
 *   path as the original grant.
 *
 * Exit codes:
 *   0 — backup written
 *   1 — missing --tenant, tenant not found, or write failure
 *
 * Filename collisions: a second run at the same wall-clock second
 * appends `-2`, `-3`, etc. so concurrent runs by two operators don't
 * stomp.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

function parseArgs(argv) {
  const args = { tenant: null, out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') {
      const id = parseInt(argv[++i], 10);
      if (!Number.isFinite(id)) {
        process.stderr.write('Error: --tenant requires a numeric id\n');
        process.exit(1);
      }
      args.tenant = id;
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node backend/scripts/backup-tenant-rbac.js --tenant <id> [--out path] [--json]\n',
      );
      process.exit(0);
    }
  }
  if (args.tenant === null) {
    process.stderr.write(
      'Error: --tenant <id> is required (tenant scope is mandatory; this script does NOT support all-tenant dumps).\n',
    );
    process.exit(1);
  }
  return args;
}

function resolveOutPath(args) {
  if (args.out) return path.resolve(args.out);
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `rbac-backup-tenant-${args.tenant}-${iso}.json`;
  let candidate = path.resolve(process.cwd(), base);
  let seq = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.resolve(
      process.cwd(),
      `rbac-backup-tenant-${args.tenant}-${iso}-${seq}.json`,
    );
    seq++;
  }
  return candidate;
}

async function buildBackup(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, vertical: true },
  });
  if (!tenant) {
    throw new Error(`Tenant id=${tenantId} not found.`);
  }

  const roles = await prisma.role.findMany({
    where: { tenantId },
    include: {
      permissions: {
        // RolePermission has no createdAt column (see schema.prisma:5324) —
        // the row's age is tracked via the parent Role.createdAt + the
        // AuditLog GRANT_PERMISSION / STRIP_FOREIGN_PERM trail.
        select: { id: true, module: true, action: true },
        orderBy: [{ module: 'asc' }, { action: 'asc' }],
      },
      userRoles: {
        select: {
          userId: true,
          assignedAt: true,
          assignedById: true,
        },
      },
      widgets: {
        select: {
          id: true,
          widgetKey: true,
          position: true,
          isEnabled: true,
          settings: true,
        },
        orderBy: { position: 'asc' },
      },
    },
    orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
  });

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    tenant,
    roleCount: roles.length,
    permissionRowCount: roles.reduce((n, r) => n + r.permissions.length, 0),
    userRoleRowCount: roles.reduce((n, r) => n + r.userRoles.length, 0),
    widgetRowCount: roles.reduce((n, r) => n + r.widgets.length, 0),
    roles: roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      isActive: r.isActive,
      userType: r.userType,
      landingPath: r.landingPath,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      permissions: r.permissions,
      userRoles: r.userRoles,
      widgets: r.widgets,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  let backup;
  try {
    backup = await buildBackup(args.tenant);
  } catch (err) {
    process.stderr.write(`[backup-tenant-rbac] ${err.message}\n`);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  const outPath = resolveOutPath(args);
  try {
    fs.writeFileSync(outPath, JSON.stringify(backup, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[backup-tenant-rbac] write failed: ${err.message}\n`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(backup, null, 2) + '\n');
  } else {
    process.stdout.write(
      `Backup written: ${outPath}\n` +
        `  tenant=${backup.tenant.id} (${backup.tenant.name}, vertical=${backup.tenant.vertical})\n` +
        `  roles=${backup.roleCount}  perms=${backup.permissionRowCount}  userRoles=${backup.userRoleRowCount}  widgets=${backup.widgetRowCount}\n` +
        `\nNext: review the JSON, then run\n` +
        `  node backend/scripts/cleanup-foreign-perms-report.js --tenant ${args.tenant}\n` +
        `to preview the cleanup. Add --apply to execute.\n`,
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { buildBackup };
