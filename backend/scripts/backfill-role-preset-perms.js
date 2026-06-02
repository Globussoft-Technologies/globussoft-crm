#!/usr/bin/env node
// One-shot backfill — brings every already-existing canonical role on
// every tenant up to the v3.8.x wellness role-preset spec (CLAUDE.md ref:
// "CRM Role Preset Specification (Wellness vertical)" / SPEC §2).
//
// Why this exists: ensureRbacOnBoot.js seeds permissions ONLY on the
// FIRST creation of a role (the `wasCreated` guard, by design — operators
// who've fine-tuned grants via the Roles & Permissions UI must not have
// their edits silently rolled back on the next boot). When the spec
// grants list is widened (e.g. MANAGER gains roles.read + patients.read,
// DOCTOR gains contacts.read + reports.read), tenants whose roles were
// created BEFORE the widening keep their old grant set and the
// corresponding sidebar pages stay hidden.
//
// What it does:
//   - For each tenant, finds the canonical staff roles by key (ADMIN,
//     MANAGER, USER, DOCTOR, NURSE, RECEPTIONIST, TELECALLER, CUSTOMER).
//   - For each, ensures the role has the appropriate grants per the spec
//     constants in ensureRbacOnBoot.js.
//   - ADMIN is granted every permission in the catalogue (matches
//     grantAllPermissions in the boot script).
//   - OWNER + custom (admin-defined) roles are left untouched.
//   - Insertion is idempotent (composite unique on roleId+module+action),
//     so re-running is safe.
//   - NEVER REVOKES — only adds missing grants. If a tenant admin has
//     intentionally narrowed a role, that choice is preserved; the
//     backfill only widens to the new spec floor.
//
// Dry-run by default. Use --apply to actually persist.
//
// Usage:
//   node backend/scripts/backfill-role-preset-perms.js
//   node backend/scripts/backfill-role-preset-perms.js --apply
//   node backend/scripts/backfill-role-preset-perms.js --apply --tenant=3
//   node backend/scripts/backfill-role-preset-perms.js --apply --role=MANAGER

const { PrismaClient } = require('@prisma/client');
const { PERMISSION_CATALOG } = require('../lib/permissionCatalog');

const APPLY = process.argv.includes('--apply');
const tenantFilter = (() => {
  const arg = process.argv.find((a) => a.startsWith('--tenant='));
  if (!arg) return null;
  const parsed = parseInt(arg.split('=')[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
})();
const roleFilter = (() => {
  const arg = process.argv.find((a) => a.startsWith('--role='));
  if (!arg) return null;
  return arg.split('=')[1].toUpperCase();
})();

const prisma = new PrismaClient();

// Spec §2 permission floors — mirrored verbatim from ensureRbacOnBoot.js
// so the boot-time path and the backfill path are guaranteed to converge.
// Kept in sync by hand (intentionally — a shared import would couple the
// boot fast-path to the heavier backfill module's deps).

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
  // `billing` decomposed in v3.8.x → invoices / gift_cards / patient_wallets.
  'invoices.read',
  'gift_cards.read',
  'patient_wallets.read',
  'staff.read',
  'roles.read',
  'communications.read', 'communications.write',
  'email.read', 'email.write',
  'sms.read', 'sms.write',
  'whatsapp.read', 'whatsapp.write',
  'marketing.read', 'marketing.write', 'marketing.update',
  'tickets.read', 'tickets.write', 'tickets.update',
  'surveys.read', 'surveys.write', 'surveys.update',
  'documents.read', 'documents.write', 'documents.update',
  'contracts.read', 'contracts.write', 'contracts.update',
  'estimates.read', 'estimates.write', 'estimates.update', 'estimates.export',
  'patients.read',
  'appointments.read',
  'services.read',
  'inventory.read',
  'pos.read',
  'products.read', 'products.write', 'products.update',
  'attendance.read', 'attendance.write', 'attendance.manage',
  'leave.read', 'leave.write', 'leave.manage',
];

const CUSTOMER_PERMISSIONS = [
  'leads.read',
  'appointments.read',
  'services.read',
  // `billing` decomposed in v3.8.x; CUSTOMER gets invoices.read.
  'invoices.read',
  'payments.read',
  'documents.read',
  // Patient-portal-scoped Rx view — never the tenant-wide `prescriptions.read`.
  'my_prescriptions.read',
  'consents.read', 'consents.write',
  'visits.read',
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
  'appointments.read', 'appointments.write',
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const DOCTOR_PERMISSIONS = [
  'patients.read', 'patients.write', 'patients.update', 'patients.delete',
  'appointments.read', 'appointments.write', 'appointments.update', 'appointments.delete',
  'my_appointments.read',
  'waitlist.read',
  'calendar.read', 'calendar.write',
  'visits.read', 'visits.write', 'visits.update', 'visits.delete',
  'prescriptions.read', 'prescriptions.write', 'prescriptions.update', 'prescriptions.delete',
  'consents.read', 'consents.write',
  'services.read',
  'products.read',
  'inventory.read',
  'documents.read', 'documents.write',
  'reports.read',
  'dashboards.read',
  'contacts.read',
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const NURSE_PERMISSIONS = [
  'patients.read', 'patients.update',
  'appointments.read', 'appointments.update',
  'waitlist.read',
  'calendar.read',
  'visits.read', 'visits.write', 'visits.update',
  'products.read', 'products.write', 'products.update',
  'inventory.read', 'inventory.write', 'inventory.update',
  'services.read',
  'consents.read', 'consents.write',
  'prescriptions.read',
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const RECEPTIONIST_PERMISSIONS = [
  'patients.read', 'patients.write',
  'appointments.read', 'appointments.write', 'appointments.update', 'appointments.delete',
  'book_appointment.write',
  'waitlist.read', 'waitlist.write',
  'my_appointments.read',
  'calendar.read', 'calendar.write',
  'services.read',
  'products.read',
  // `billing` decomposed in v3.8.x. Receptionist gets read+write on
  // invoices (front-desk raise + collect); gift_cards + patient_wallets
  // stay read-only (top-ups go through POS, not direct ledger writes).
  'invoices.read', 'invoices.write',
  'gift_cards.read',
  'patient_wallets.read',
  'payments.read',
  'pos.read', 'pos.write', 'pos.manage',
  'contacts.read', 'contacts.write',
  'leads.read', 'leads.write',
  'communications.read', 'communications.write',
  'email.read', 'email.write',
  'sms.read', 'sms.write',
  'whatsapp.read', 'whatsapp.write',
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const TELECALLER_PERMISSIONS = [
  'leads.read', 'leads.write', 'leads.update',
  'contacts.read', 'contacts.write',
  'appointments.read', 'appointments.write',
  'book_appointment.write',
  'waitlist.read', 'waitlist.write',
  'my_appointments.read',
  'calendar.read', 'calendar.write',
  'communications.read', 'communications.write',
  'sms.read', 'sms.write',
  'whatsapp.read', 'whatsapp.write',
  'email.read', 'email.write',
  'reports.read',
  'tasks.read', 'tasks.write',
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

// ADMIN gets every permission in the catalogue — mirrors
// grantAllPermissions() in the boot script. Re-computed at runtime so
// that adding a new module to the catalogue widens ADMIN automatically
// without touching this file.
function buildAdminPermissions() {
  const out = [];
  for (const [module, actions] of Object.entries(PERMISSION_CATALOG)) {
    for (const action of actions) {
      out.push(`${module}.${action}`);
    }
  }
  return out;
}

const ROLE_GRANTS = {
  ADMIN: buildAdminPermissions(),
  MANAGER: MANAGER_PERMISSIONS,
  USER: USER_PERMISSIONS,
  CUSTOMER: CUSTOMER_PERMISSIONS,
  DOCTOR: DOCTOR_PERMISSIONS,
  NURSE: NURSE_PERMISSIONS,
  RECEPTIONIST: RECEPTIONIST_PERMISSIONS,
  TELECALLER: TELECALLER_PERMISSIONS,
};

// Permissions that should be EXPLICITLY removed from system roles during
// backfill. The default backfill pass is purely additive (preserves admin
// customisations) but a small set of renamed/replaced permissions need
// to be cleared on existing tenants. Each entry below is paired with a
// matching ADD in the role's PERMISSIONS list, so the net effect on a
// backfilled tenant is a rename, not a removal of capability.
//
//   CUSTOMER: prescriptions.read → my_prescriptions.read
//     The tenant-wide `prescriptions.read` was always a no-op for
//     CUSTOMER (their JWT can't reach the staff routes that check it).
//     Replaced by the patient-portal-scoped `my_prescriptions.read`
//     which gates the /portal/prescriptions endpoints.
//
//   * billing.* → invoices.* + gift_cards.* + patient_wallets.*
//     The `billing` module was removed from the catalogue in v3.8.x
//     and split per surface. Strip every legacy `billing.*` grant from
//     the system roles on existing tenants — the ADD pass above
//     re-grants the equivalent per-surface permissions in the right
//     shape for each role.
const BILLING_LEGACY = [
  'billing.read',
  'billing.write',
  'billing.update',
  'billing.delete',
  'billing.export',
  'billing.manage',
];

const ROLE_REMOVALS = {
  ADMIN: BILLING_LEGACY,
  MANAGER: BILLING_LEGACY,
  USER: BILLING_LEGACY,
  CUSTOMER: ['prescriptions.read', ...BILLING_LEGACY],
  DOCTOR: BILLING_LEGACY,
  NURSE: BILLING_LEGACY,
  RECEPTIONIST: BILLING_LEGACY,
  TELECALLER: BILLING_LEGACY,
};

async function main() {
  console.log(`[backfill-role-preset] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to persist)'}`);
  if (tenantFilter) console.log(`[backfill-role-preset] tenant filter: ${tenantFilter}`);
  if (roleFilter) console.log(`[backfill-role-preset] role filter: ${roleFilter}`);
  console.log('');

  const where = tenantFilter ? { id: tenantFilter } : {};
  const tenants = await prisma.tenant.findMany({
    where,
    select: { id: true, name: true, vertical: true },
    orderBy: { id: 'asc' },
  });
  console.log(`[backfill-role-preset] scanning ${tenants.length} tenant(s)`);
  console.log('');

  let totalRolesScanned = 0;
  let totalRolesUntouched = 0;
  let totalGrantsAdded = 0;
  let totalGrantsAlready = 0;
  let totalGrantsRemoved = 0;
  const perRoleKeySummary = {};

  const roleKeys = roleFilter
    ? Object.keys(ROLE_GRANTS).filter((k) => k === roleFilter)
    : Object.keys(ROLE_GRANTS);

  for (const tenant of tenants) {
    const roles = await prisma.role.findMany({
      where: { tenantId: tenant.id, key: { in: roleKeys } },
      select: { id: true, key: true, name: true },
    });

    if (roles.length === 0) {
      console.log(`  · tenant ${tenant.id} (${tenant.name}, ${tenant.vertical}) — no eligible roles`);
      continue;
    }

    for (const role of roles) {
      totalRolesScanned++;
      const wanted = ROLE_GRANTS[role.key];
      if (!wanted) continue;

      const existing = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
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
        `  + tenant ${tenant.id} (${tenant.name}) — role ${role.key} (${role.name}): ` +
          `adding ${missing.length} grant(s) → ${missing.join(', ')}`,
      );

      if (APPLY) {
        for (const perm of missing) {
          const [module, action] = perm.split('.');
          if (!module || !action) continue;
          // Idempotent insert: composite unique on (roleId, module,
          // action) means a duplicate just errors with P2002. Wrap in
          // try so a race or pre-existing row doesn't abort the batch.
          try {
            await prisma.rolePermission.create({
              data: { roleId: role.id, module, action },
            });
          } catch (err) {
            if (err && err.code === 'P2002') {
              // Already exists — likely raced with another write. Safe to ignore.
              continue;
            }
            throw err;
          }
        }
      }
      totalGrantsAdded += missing.length;
      perRoleKeySummary[role.key] = (perRoleKeySummary[role.key] || 0) + missing.length;

      // Targeted removals for renamed permissions. Only touches the exact
      // (roleKey, module, action) tuples in ROLE_REMOVALS — never blanket-
      // wipes a role.
      const removalList = ROLE_REMOVALS[role.key] || [];
      const removable = removalList.filter((perm) => existingSet.has(perm));
      if (removable.length > 0) {
        console.log(
          `  - tenant ${tenant.id} (${tenant.name}) — role ${role.key} (${role.name}): ` +
            `removing ${removable.length} obsolete grant(s) → ${removable.join(', ')}`,
        );
        if (APPLY) {
          for (const perm of removable) {
            const [module, action] = perm.split('.');
            if (!module || !action) continue;
            try {
              await prisma.rolePermission.deleteMany({
                where: { roleId: role.id, module, action },
              });
            } catch (err) {
              console.warn(`    (skip remove ${perm}: ${err.message})`);
            }
          }
        }
        totalGrantsRemoved += removable.length;
      }
    }
  }

  console.log('');
  console.log('[backfill-role-preset] summary');
  console.log(`  tenants scanned:        ${tenants.length}`);
  console.log(`  canonical roles scanned: ${totalRolesScanned}`);
  console.log(`  roles already up-to-date: ${totalRolesUntouched}`);
  console.log(`  grants already present:   ${totalGrantsAlready}`);
  console.log(`  grants ${APPLY ? 'added' : 'would-add'}:        ${totalGrantsAdded}`);
  console.log(`  grants ${APPLY ? 'removed' : 'would-remove'}:      ${totalGrantsRemoved}`);
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
    console.error('[backfill-role-preset] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
