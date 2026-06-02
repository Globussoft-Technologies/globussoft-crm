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
  // `billing` was decomposed in v3.8.x → invoices / gift_cards /
  // patient_wallets. MANAGER inherits read across all three.
  'invoices.read',
  'gift_cards.read',
  'patient_wallets.read',
  'staff.read',
  // Roles read-only — Manager can SEE the role matrix (audit trail / who
  // has what) but cannot grant or revoke (manage stays with Admin).
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
  // Wellness oversight surfaces — Manager needs READ on clinical / inventory
  // / POS to triage and report, but no clinical-mutation rights (that's
  // Doctor / Nurse / Receptionist). Spec §2 MANAGER row.
  'patients.read',
  'appointments.read',
  'services.read',
  'inventory.read',
  'pos.read',
  // Wellness master catalog — Manager curates products + auto-consumption
  // rules so they can keep what's billable in sync with what's actually
  // delivered. (Inventory ledger ops are still admin-only by default.)
  'products.read', 'products.write', 'products.update',
  // Staff self-service — Manager clocks in/out, submits their own leave,
  // and has manage-tier on both surfaces (view other staff's attendance,
  // approve/reject leave requests).
  'attendance.read', 'attendance.write', 'attendance.manage',
  'leave.read', 'leave.write', 'leave.manage',
];

const CUSTOMER_PERMISSIONS = [
  // Spec §2 CUSTOMER row — patient/customer portal access. LEADS-read so a
  // customer can view their own enquiry record. VISITS + PAYMENTS read so
  // they can see prior visits and what they've paid. CONSENTS write is the
  // sign-on-canvas action — needed for the patient-portal consent flow.
  // `my_prescriptions.read` is the patient-scoped counterpart to staff-
  // wide `prescriptions.read`; CUSTOMER never gets the tenant-wide grant.
  'leads.read',
  'appointments.read',
  'services.read',
  // `billing` decomposed in v3.8.x; CUSTOMER gets invoices.read so they
  // can still see their own invoice list.
  'invoices.read',
  'payments.read',
  'documents.read',
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
  // Spec §2 USER row — base staff member needs to view + create their own
  // appointments. Roles.read is intentionally omitted (spec asks to remove
  // it from USER); was never granted here anyway, so this stays clean.
  'appointments.read', 'appointments.write',
  // Staff self-service — every staff USER needs to clock in and request
  // leave for themselves. Approval-tier (`.manage`) stays with manager/
  // admin via verifyRole in routes/leave.js + routes/attendance.js.
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

// Wellness vertical-specific custom roles. Each one carries the
// permissions its day-to-day workflow needs — defined here so the seed
// + boot-time ensure script + admin UI all converge on the same starting
// state. Admins can pare these back per-tenant via the Roles &
// Permissions UI; the ensure step won't overwrite existing roles, only
// create-if-missing.

const DOCTOR_PERMISSIONS = [
  // Spec §2 DOCTOR row — clinical owner. R/W/U/D on patients +
  // appointments + visits + prescriptions so the doctor can fully manage
  // their patient records. Delete is intentional: a doctor may need to
  // void an erroneous prescription / cancel a visit they own.
  'patients.read', 'patients.write', 'patients.update', 'patients.delete',
  'appointments.read', 'appointments.write', 'appointments.update', 'appointments.delete',
  // `appointments` was split into per-page modules in v3.8.x —
  // `my_appointments` for the practitioner's own-slot view (the page
  // doctors actually use day-to-day) and `waitlist` for the open-slot
  // queue. Doctors get both .read grants since they were implied by the
  // pre-split contract. `book_appointment` is intentionally omitted —
  // doctors don't book on behalf of patients (that's receptionist /
  // telecaller work); admins can grant it later if a clinic flips that
  // convention.
  'my_appointments.read',
  'waitlist.read',
  // `calendar` is a sibling-permission to `appointments` — separated so
  // admins can grant view-only Calendar access independently of the
  // Appointments list / Book Appointment form. Doctors get both since
  // they live in the Calendar day-grid view.
  'calendar.read', 'calendar.write',
  'visits.read', 'visits.write', 'visits.update', 'visits.delete',
  'prescriptions.read', 'prescriptions.write', 'prescriptions.update', 'prescriptions.delete',
  'consents.read', 'consents.write',
  'services.read',
  // Doctor sees the product catalog (to know what's available to order)
  // and the inventory level (to know what's in stock), but doesn't write
  // either — that's Nurse + storeroom work.
  'products.read',
  'inventory.read',
  'documents.read', 'documents.write',
  // Spec §2 DOCTOR row — read-only access to reports / dashboards /
  // contacts. No reports.write/delete (those stay with manager-tier).
  'reports.read',
  'dashboards.read',
  'contacts.read',
  // Staff self-service — doctor clocks in/out + manages their own leave.
  // Approval is manager-tier and stays with verifyRole(ADMIN/MANAGER).
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const NURSE_PERMISSIONS = [
  'patients.read', 'patients.update',
  'appointments.read', 'appointments.update',
  // Post-split (v3.8.x): nurse keeps waitlist visibility (queue is a
  // viewing surface — promote / disposition is gated separately on
  // `waitlist.write` which nurse doesn't get). No `my_appointments` or
  // `book_appointment` — nurses don't own slots or book on behalf of
  // patients.
  'waitlist.read',
  // Nurse views the Calendar day-grid for context but doesn't book or
  // reschedule (that's Doctor / Receptionist work). Read-only on calendar.
  'calendar.read',
  'visits.read', 'visits.write', 'visits.update',
  // Nurse manages BOTH catalog (recording new products as they arrive)
  // AND ledger (logging receipts + adjustments on consumption). They're
  // the day-to-day stockroom operator. Manage-tier (category taxonomy,
  // vendor master, auto-consumption rules) stays with admin.
  'products.read', 'products.write', 'products.update',
  'inventory.read', 'inventory.write', 'inventory.update',
  'services.read',
  // Spec §2 NURSE row — nurse witnesses and helps obtain consent
  // signatures during procedures, and needs prescription read so they
  // can prep medication ordered by the doctor.
  'consents.read', 'consents.write',
  'prescriptions.read',
  // Staff self-service.
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const RECEPTIONIST_PERMISSIONS = [
  'patients.read', 'patients.write',
  'appointments.read', 'appointments.write', 'appointments.update', 'appointments.delete',
  // Post-split (v3.8.x): receptionist runs the booking workflow end-to-
  // end. `book_appointment.write` for the booking form, `waitlist.*` for
  // queue management (promote / disposition), `my_appointments.read` for
  // their own follow-ups when listed as the assigned point-of-contact.
  'book_appointment.write',
  'waitlist.read', 'waitlist.write',
  'my_appointments.read',
  // Receptionist is THE primary calendar user — books slots, reschedules,
  // cancels via drag-to-reschedule and right-click-cancel.
  'calendar.read', 'calendar.write',
  'services.read',
  // Receptionist views the product catalog to look up items for POS
  // sales but doesn't edit it; no stock-ledger access.
  'products.read',
  // `billing` decomposed in v3.8.x. Receptionist needs read+write on
  // invoices (they raise + collect them at the front desk). Gift cards
  // + patient wallets stay read-only by default — the front-desk POS
  // flow handles top-ups through the dedicated POS surface, not direct
  // ledger writes.
  'invoices.read', 'invoices.write',
  'gift_cards.read',
  'patient_wallets.read',
  // Spec §2 RECEPTIONIST row — payments visibility for "pending payments
  // at POS" widget + reconciliation. Payments catalog only has read +
  // export (no .write), so .read is the full grant available.
  'payments.read',
  'pos.read', 'pos.write', 'pos.manage',
  'contacts.read', 'contacts.write',
  'leads.read', 'leads.write',
  'communications.read', 'communications.write',
  'email.read', 'email.write',
  'sms.read', 'sms.write',
  'whatsapp.read', 'whatsapp.write',
  // Staff self-service.
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

const TELECALLER_PERMISSIONS = [
  'leads.read', 'leads.write', 'leads.update',
  'contacts.read', 'contacts.write',
  'appointments.read', 'appointments.write',
  // Post-split (v3.8.x): telecaller books from outbound calls and works
  // the waitlist queue. `book_appointment.write` for the booking form,
  // `waitlist.*` for queue dispositioning (their primary surface).
  // `my_appointments.read` preserves the pre-split practical access —
  // telecallers occasionally show up as the assigned contact and want
  // to see those follow-ups.
  'book_appointment.write',
  'waitlist.read', 'waitlist.write',
  'my_appointments.read',
  // Telecaller books appointments from outbound calls — they need
  // calendar read+write to pick a slot during the call.
  'calendar.read', 'calendar.write',
  'communications.read', 'communications.write',
  'sms.read', 'sms.write',
  'whatsapp.read', 'whatsapp.write',
  'email.read', 'email.write',
  'reports.read',
  // Spec §2 TELECALLER row — tasks read/write so the telecaller can log
  // and pick up follow-up tasks tied to each lead they're working.
  'tasks.read', 'tasks.write',
  // Staff self-service.
  'attendance.read', 'attendance.write',
  'leave.read', 'leave.write',
];

async function ensureRole(stats, { tenantId, key, name, description, isSystem, userType, landingPath }) {
  const existing = await prisma.role.findFirst({ where: { tenantId, key } });
  if (existing) {
    stats.rolesExisting++;
    // PRINCIPLE: never touch existing rows. An operator who has cleared
    // landingPath (or edited it via the Roles & Permissions UI) should
    // keep their choice across boots. A null landingPath is now safe
    // anyway — Login.jsx's smart-fallback resolves it via /api/pages/me
    // → first accessible page → /home. No backfill needed.
    return { role: existing, wasCreated: false };
  }
  const created = await prisma.role.create({
    data: { tenantId, key, name, description, isSystem, isActive: true, userType, landingPath: landingPath || null },
  });
  stats.rolesCreated++;
  return { role: created, wasCreated: true };
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
  // Backfill semantics only: if the user has ANY UserRole row already,
  // leave it alone — admins may have re-assigned them to a custom role
  // via the Roles & Permissions UI, and silently overwriting that would
  // destroy their work. Single-role-per-user enforcement happens at the
  // assign endpoint (routes/roles.js delete-then-create), not here.
  const existingCount = await prisma.userRole.count({ where: { userId } });
  if (existingCount > 0) {
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
    landingPath: '/dashboard',
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

  // Per-tenant default landing paths. Only set for ADMIN + MANAGER because
  // those map cleanly to a single page (owner dashboard or generic dash).
  // CUSTOMER + USER stay null so the App.jsx fallback (wellnessLandingFor)
  // can keep using legacy wellnessRole-based routing — a wellness telecaller
  // is currently User.role='USER' + wellnessRole='telecaller' and routes to
  // /wellness/telecaller; pinning USER.landingPath='/wellness/calendar'
  // would silently break that. Once admins create per-function roles
  // (DOCTOR / TELECALLER / RECEPTIONIST / NURSE) with their own landingPath
  // and reassign users, this fallback drops out naturally.
  const wellnessTenantIds = new Set(
    (
      await prisma.tenant.findMany({
        where: { vertical: 'wellness' },
        select: { id: true },
      })
    ).map((t) => t.id),
  );

  for (const t of tenants) {
    const isWellness = wellnessTenantIds.has(t.id);
    await provisionTenantRbacInternal(stats, t.id, isWellness);
  }

  return stats;
}

/**
 * Provision the canonical role set for a single tenant.
 *
 *   - ADMIN  (all permissions)
 *   - MANAGER, CUSTOMER, USER (preset permission lists)
 *   - if wellness: DOCTOR, NURSE, RECEPTIONIST, TELECALLER + default widgets
 *
 * Idempotent — uses ensureRole / ensureRolePermission find-first-then-create
 * semantics. After this returns, every staff/customer user assigned to
 * the tenant gets a UserRole row matching their legacy User.role string
 * (so existing users immediately resolve to the right grant set).
 *
 * Exposed so the /api/auth/register + /api/auth/signup endpoints can
 * provision a new tenant's RBAC inline at signup time — without this,
 * the boot script's per-tenant loop only fires on server start, leaving
 * brand-new signup admins with ZERO permissions until the next reboot.
 * That was the canonical "I created an admin account and the sidebar is
 * almost empty" symptom — the user holds User.role='ADMIN' (so the
 * legacy isAdmin gate passes for hardcoded items) but the resolver
 * returns an empty Set (so /api/pages/me returns nothing and the
 * catalog-driven sidebar collapses).
 *
 * Returns the stats object (created counts) so callers can log.
 */
async function provisionTenantRbac(tenantId, opts = {}) {
  const stats = {
    rolesCreated: 0,
    rolesExisting: 0,
    permsCreated: 0,
    permsExisting: 0,
    assignmentsCreated: 0,
    assignmentsExisting: 0,
    usersSkipped: 0,
  };

  let isWellness = opts.isWellness;
  if (typeof isWellness !== 'boolean') {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
    isWellness = t?.vertical === 'wellness';
  }

  await provisionTenantRbacInternal(stats, tenantId, isWellness);
  return stats;
}

/**
 * Inner provisioning routine — shared by the boot loop and the inline
 * signup path. Mutates the passed-in `stats` accumulator so the boot
 * script can report aggregate counts.
 */
async function provisionTenantRbacInternal(stats, tenantId, isWellness) {
  {
    const adminLanding = isWellness ? '/wellness' : '/dashboard';
    const managerLanding = isWellness ? '/wellness' : '/dashboard';

    // Seed-on-creation only: permissions are granted to a system role
    // ONLY the FIRST time we provision it. On subsequent boots, we leave
    // the role's existing grants alone — operators can fine-tune them
    // through Roles & Permissions and our scheduled re-runs won't undo
    // their edits. This was a real bug: removing inventory.read from
    // ADMIN, restarting the backend, then refreshing the browser would
    // show inventory back because the boot script re-granted everything.
    // The seed (`prisma/seed.js`) handles the first-time provisioning
    // for the demo seed; this script handles tenants that pre-date the
    // RBAC migration by creating the role then backfilling perms once.
    const { role: adminRole, wasCreated: adminCreated } = await ensureRole(stats, {
      tenantId,
      key: 'ADMIN',
      name: 'Admin',
      description: 'Full access to all features within the organization',
      isSystem: true,
      userType: 'STAFF',
      landingPath: adminLanding,
    });
    if (adminCreated) await grantAllPermissions(stats, adminRole.id);

    const { role: managerRole, wasCreated: managerCreated } = await ensureRole(stats, {
      tenantId,
      key: 'MANAGER',
      name: 'Manager',
      description: 'Manager role with broad staff access',
      isSystem: false,
      userType: 'STAFF',
      landingPath: managerLanding,
    });
    if (managerCreated) await grantPermissionList(stats, managerRole.id, MANAGER_PERMISSIONS);

    const { role: customerRole, wasCreated: customerCreated } = await ensureRole(stats, {
      tenantId,
      key: 'CUSTOMER',
      name: 'Customer',
      description: 'Customer access to booking and appointments only',
      isSystem: true,
      userType: 'CUSTOMER',
      landingPath: null, // fallback to vertical default (wellness: book-appointment, generic: dashboard)
    });
    if (customerCreated) await grantPermissionList(stats, customerRole.id, CUSTOMER_PERMISSIONS);

    const { role: userRole, wasCreated: userCreated } = await ensureRole(stats, {
      tenantId,
      key: 'USER',
      name: 'User',
      description: 'Basic user role with limited CRM access',
      isSystem: false,
      userType: 'STAFF',
      landingPath: null, // fallback honours legacy wellnessRole-based routing
    });
    if (userCreated) await grantPermissionList(stats, userRole.id, USER_PERMISSIONS);

    // Wellness-vertical custom roles. Auto-provisioned only for wellness
    // tenants so a generic CRM tenant doesn't end up with empty Doctor /
    // Nurse roles cluttering its Roles & Permissions matrix. Admins can
    // still create them manually via the UI.
    if (isWellness) {
      const { role: doctorRole, wasCreated: doctorCreated } = await ensureRole(stats, {
        tenantId,
        key: 'DOCTOR',
        name: 'Doctor',
        description: 'Clinical practitioner — patients, prescriptions, consents, visits',
        isSystem: false,
        userType: 'STAFF',
        landingPath: '/home',
      });
      if (doctorCreated) await grantPermissionList(stats, doctorRole.id, DOCTOR_PERMISSIONS);

      const { role: nurseRole, wasCreated: nurseCreated } = await ensureRole(stats, {
        tenantId,
        key: 'NURSE',
        name: 'Nurse',
        description: 'Clinical assistant — patient prep, procedures, inventory',
        isSystem: false,
        userType: 'STAFF',
        landingPath: '/home',
      });
      if (nurseCreated) await grantPermissionList(stats, nurseRole.id, NURSE_PERMISSIONS);

      const { role: receptionistRole, wasCreated: receptionistCreated } = await ensureRole(stats, {
        tenantId,
        key: 'RECEPTIONIST',
        name: 'Receptionist',
        description: 'Front desk — calendar, walk-ins, POS, birthdays',
        isSystem: false,
        userType: 'STAFF',
        landingPath: '/home',
      });
      if (receptionistCreated) await grantPermissionList(stats, receptionistRole.id, RECEPTIONIST_PERMISSIONS);

      const { role: telecallerRole, wasCreated: telecallerCreated } = await ensureRole(stats, {
        tenantId,
        key: 'TELECALLER',
        name: 'Telecaller',
        description: 'Outbound calls + lead conversion',
        isSystem: false,
        userType: 'STAFF',
        landingPath: '/home',
      });
      if (telecallerCreated) await grantPermissionList(stats, telecallerRole.id, TELECALLER_PERMISSIONS);

      // Seed default home widget layout for each clinical role only if it
      // has none. Admins can re-arrange via the Widgets modal — we won't
      // overwrite an existing layout. Picks widgets whose
      // catalogue.defaultRoleKeys list contains this role's key.
      //
      // Wrapped in try/catch because the RoleWidget table is new — if a
      // tenant deploy lands this code BEFORE `prisma db push` runs, the
      // table won't exist and the create() throws. We don't want server
      // boot to fail over a deferred feature; log once and continue. The
      // next boot after the migration applies will pick up the seeding.
      try {
        const { WIDGET_CATALOG } = require('../lib/widgetCatalog');
        // Same wasCreated discipline as role permissions: seed default
        // widgets ONLY on first creation of the role. If an operator has
        // ever curated the home layout (including deleting every widget),
        // their choice sticks across boots — we don't re-seed.
        const seedDefaultWidgets = async (role, wasCreated) => {
          if (!wasCreated) return;
          const defaults = WIDGET_CATALOG.filter((w) =>
            w.defaultRoleKeys.includes(role.key),
          );
          for (let i = 0; i < defaults.length; i++) {
            await prisma.roleWidget.create({
              data: {
                roleId: role.id,
                widgetKey: defaults[i].key,
                position: (i + 1) * 10,
                isEnabled: true,
              },
            });
          }
          if (defaults.length > 0) {
            stats.widgetsCreated = (stats.widgetsCreated || 0) + defaults.length;
          }
        };
        await seedDefaultWidgets(doctorRole, doctorCreated);
        await seedDefaultWidgets(nurseRole, nurseCreated);
        await seedDefaultWidgets(receptionistRole, receptionistCreated);
        await seedDefaultWidgets(telecallerRole, telecallerCreated);
        await seedDefaultWidgets(adminRole, adminCreated);
        await seedDefaultWidgets(managerRole, managerCreated);
        await seedDefaultWidgets(customerRole, customerCreated);
      } catch (err) {
        console.warn(
          '[ensureRbacOnBoot] widget seeding skipped — RoleWidget table missing? ' +
            'Run `npx prisma db push` to apply the new schema. ' +
            (err && err.message ? `Cause: ${err.message}` : ''),
        );
        stats.widgetsSkipped = (stats.widgetsSkipped || 0) + 1;
      }
    }

    const users = await prisma.user.findMany({ where: { tenantId } });
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
}

module.exports = { ensureRbacOnBoot, provisionTenantRbac };
