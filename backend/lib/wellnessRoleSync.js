/**
 * Sync User.wellnessRole from a user's current RBAC role set.
 *
 * Background: wellness tenants have TWO orthogonal role fields on User:
 *   - RBAC role (via UserRole junction)     — drives permissions
 *   - wellnessRole ("doctor"/"professional"/…) — drives clinical surfaces
 *     like /api/wellness/doctors/availability (book-appointment dropdown),
 *     auto-router, reports/per-professional, etc.
 *
 * The Staff Edit form derives wellnessRole client-side from the picked
 * RBAC role and POSTs both, but the Roles & Permissions UI assigns RBAC
 * roles directly via /api/roles/:id/assign/:userId (and the multi-role
 * variant) which never touch wellnessRole. Net effect was: an admin who
 * promoted Sankar to DOCTOR via Roles & Permissions got primaryRole set
 * but wellnessRole stayed null, so Sankar never appeared in the doctor
 * dropdown. Same hazard for the Staff form when the wellnessRoleType
 * catalog fetch raced the modal save (frontend sent wellnessRole=null).
 *
 * This helper closes both gaps by deriving wellnessRole on the backend
 * from the user's current UserRole row(s), matched against the tenant's
 * wellnessRoleType catalog by lowercased role.key.
 */

const prisma = require("./prisma");

// Pick a single catalog key from the user's RBAC role set. RBAC keys
// are uppercase ("DOCTOR"); catalog keys are lowercase ("doctor"). The
// catalog rows are walked in sortOrder so a user holding multiple RBAC
// roles (e.g. DOCTOR + MANAGER) deterministically resolves to the
// earliest-sorted catalog match — by default that's "doctor" (sortOrder
// 10) which is what every existing flow assumes.
function pickCatalogKey(catalog, assignedRoleKeysLc) {
  for (const c of catalog) {
    if (assignedRoleKeysLc.has(c.key)) return c.key;
  }
  return null;
}

/**
 * Sync User.wellnessRole from the user's currently-assigned RBAC roles.
 *
 * @param {object} client    Prisma client OR a $transaction tx — pass tx
 *                           when the caller is already inside a transaction
 *                           so the sync is part of the same atomic write.
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.tenantId
 * @param {boolean} [params.onlyIfEmpty=false]
 *                  When true (staff.js fallback), only writes if the
 *                  user's current wellnessRole is null — preserves an
 *                  explicit value the admin set via the Staff Edit
 *                  form. When false (roles.js callers), always reconciles
 *                  because the Roles & Permissions UI is the canonical
 *                  role-assignment surface and should win.
 * @returns {Promise<string|null>} the derived wellnessRole (or null when
 *                  no catalog match exists / non-wellness tenant).
 */
async function syncWellnessRoleFromRbacRoles(
  client,
  { userId, tenantId, onlyIfEmpty = false } = {},
) {
  if (!userId || !tenantId) return null;
  const db = client || prisma;

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { vertical: true },
  });
  if (!tenant || tenant.vertical !== "wellness") return null;

  const [user, assignments, catalog] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { wellnessRole: true, tenantId: true },
    }),
    db.userRole.findMany({
      where: { userId },
      include: { role: { select: { key: true, tenantId: true } } },
    }),
    db.wellnessRoleType.findMany({
      where: { tenantId, isActive: true },
      select: { key: true, sortOrder: true },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
  ]);
  if (!user || user.tenantId !== tenantId) return null;
  if (onlyIfEmpty && user.wellnessRole != null) return user.wellnessRole;

  const assignedKeysLc = new Set(
    assignments
      .filter((a) => a.role && (a.role.tenantId == null || a.role.tenantId === tenantId))
      .map((a) => String(a.role.key).toLowerCase()),
  );
  const catalogKeys = new Set(catalog.map((c) => c.key));
  const derived = pickCatalogKey(catalog, assignedKeysLc);

  let next;
  if (derived) {
    // Canonical case: at least one assigned RBAC role maps to a catalog
    // key → wellnessRole MUST reflect it (the bug Sankar hit).
    next = derived;
  } else if (user.wellnessRole && catalogKeys.has(user.wellnessRole)) {
    // No assigned RBAC role maps to the catalog, but the user still has
    // a stale catalog-derived wellnessRole (e.g. RBAC was just changed
    // from Doctor → Receptionist). Clear it so the user no longer shows
    // up in the bookable-doctors list.
    next = null;
  } else {
    // No catalog match AND wellnessRole is already null OR not a
    // catalog key. Leave alone.
    return user.wellnessRole || null;
  }

  if (next === user.wellnessRole) return next;

  await db.user.update({
    where: { id: userId },
    data: { wellnessRole: next },
  });
  return next;
}

/**
 * Boot-time reconciliation — walk every user in every wellness tenant
 * and re-derive User.wellnessRole from their currently-assigned RBAC
 * role(s). Idempotent: users already in sync are no-op reads.
 *
 * Why this exists despite the per-user sync at every assignment site:
 * the routes/roles.js + routes/staff.js call sites only fire on WRITES.
 * Any user whose RBAC role was attached via a path that bypassed the
 * helper (legacy data created before the helper existed, direct SQL,
 * future code paths that forget to call it, partial seeds, restored
 * backups, etc.) drifts silently. The /doctors/availability picker
 * relies on User.wellnessRole as its sole source of truth, so drift
 * makes the affected user invisible to scheduling.
 *
 * Uses onlyIfEmpty=true so this is strictly an additive fill — it
 * derives wellnessRole when null, never overwrites or clears an
 * existing value. Critical for seeds like enhanced-wellness where
 * clinical staff are set up with legacy role=USER + wellnessRole=
 * 'doctor' deliberately (no matching RBAC role yet); we must not
 * interpret that as "stale" and wipe their clinical tag.
 *
 * Wired into server.js's server.listen callback alongside
 * ensureRbacOnBoot. Set DISABLE_WELLNESS_ROLE_BOOT_SYNC=1 to skip.
 *
 * @returns {Promise<{tenantsScanned:number,usersScanned:number,changed:number,set:number,cleared:number}>}
 */
async function backfillWellnessRolesOnBoot() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness" },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const stats = {
    tenantsScanned: tenants.length,
    usersScanned: 0,
    changed: 0,
    set: 0,
    cleared: 0,
  };

  for (const t of tenants) {
    const users = await prisma.user.findMany({
      where: { tenantId: t.id },
      select: { id: true, wellnessRole: true },
    });
    stats.usersScanned += users.length;
    for (const u of users) {
      const before = u.wellnessRole;
      const after = await syncWellnessRoleFromRbacRoles(prisma, {
        userId: u.id,
        tenantId: t.id,
        onlyIfEmpty: true,
      });
      if (after !== before) {
        stats.changed++;
        if (after && !before) stats.set++;
        else if (!after && before) stats.cleared++;
      }
    }
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────
// Reverse direction: wellnessRole → RBAC role
// ─────────────────────────────────────────────────────────────────────
//
// The forward sync above handles "admin promoted a user via Roles &
// Permissions → clinical tag follows". The reverse handles "admin set
// the clinical tag via the Staff form (or it was seeded that way) →
// matching RBAC role gets attached so the user actually has the
// clinical permission grants".
//
// Without this, users with role=USER + wellnessRole='doctor' (e.g. the
// enhanced-wellness seed for Dr Harsh / Dr Meena / Dr Vikas) appear in
// the Calendar's doctor picker but can't read the clinical surfaces
// the DOCTOR permission unlocks (patients.*, visits.*, prescriptions.*,
// my_appointments.read, etc.) — they're "doctors in name only".
//
// Two safety rails on this direction:
//   1) Only auto-promote from USER / CUSTOMER / no-role. Never override
//      ADMIN or MANAGER — those were explicit admin choices and a clinic
//      manager who happens to also be tagged 'doctor' should stay
//      MANAGER, not get silently demoted.
//   2) Only fires when the tenant has the matching RBAC role provisioned
//      (DOCTOR / NURSE / TELECALLER — ensureRbacOnBoot creates these on
//      every wellness tenant). For catalog-only keys like 'professional'
//      / 'stylist' / 'helper' there's no RBAC role to promote to, so the
//      helper no-ops cleanly.

const PROMOTABLE_FROM = new Set(["USER", "CUSTOMER"]);

/**
 * Promote a user's RBAC role to match their wellnessRole, if one exists
 * and the user is currently on a promotable tier.
 *
 * @param {object} client    Prisma client OR $transaction tx.
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.tenantId
 * @returns {Promise<string|null>} the assigned RBAC role key, or null
 *                  when nothing was changed (already on target, no
 *                  matching role exists, user holds a privileged role
 *                  we won't override, non-wellness tenant, etc.)
 */
async function syncRbacRoleFromWellnessRole(
  client,
  { userId, tenantId } = {},
) {
  if (!userId || !tenantId) return null;
  const db = client || prisma;

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { vertical: true },
  });
  if (!tenant || tenant.vertical !== "wellness") return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { wellnessRole: true, tenantId: true, userType: true },
  });
  if (!user || user.tenantId !== tenantId) return null;
  if (user.userType !== "STAFF") return null;
  if (!user.wellnessRole) return null;

  const targetKey = String(user.wellnessRole).toUpperCase();
  const targetRole = await db.role.findFirst({
    where: { tenantId, key: targetKey, isActive: true },
    select: { id: true, key: true },
  });
  if (!targetRole) return null;

  const existing = await db.userRole.findFirst({
    where: { userId },
    include: { role: { select: { id: true, key: true } } },
  });

  if (existing && existing.roleId === targetRole.id) return targetRole.key;
  if (existing && !PROMOTABLE_FROM.has(existing.role.key)) return null;

  // Schema enforces @@unique([userId]) on UserRole, so replacement is
  // delete-then-create within the same transaction. Boot caller has no
  // human assigner, so assignedById stays null (the field is nullable).
  if (existing) {
    await db.userRole.delete({ where: { id: existing.id } });
  }
  await db.userRole.create({
    data: { userId, roleId: targetRole.id, assignedById: null },
  });
  return targetRole.key;
}

/**
 * Boot-time reverse reconciliation — walk every wellness-tenant user
 * and ensure that anyone with wellnessRole='doctor' / 'nurse' /
 * 'telecaller' AND a promotable current RBAC role gets the matching
 * permission role attached. Idempotent.
 *
 * Pairs with backfillWellnessRolesOnBoot — together they make both
 * directions self-heal on every deploy, so a tenant that was seeded
 * before either sync existed converges to consistent state without any
 * manual ops.
 *
 * @returns {Promise<{tenantsScanned:number,usersScanned:number,promoted:number}>}
 */
async function backfillRbacRolesFromWellnessRolesOnBoot() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness" },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const stats = {
    tenantsScanned: tenants.length,
    usersScanned: 0,
    promoted: 0,
  };

  for (const t of tenants) {
    const users = await prisma.user.findMany({
      where: { tenantId: t.id, wellnessRole: { not: null } },
      select: { id: true },
    });
    stats.usersScanned += users.length;
    for (const u of users) {
      const assigned = await syncRbacRoleFromWellnessRole(prisma, {
        userId: u.id,
        tenantId: t.id,
      });
      if (assigned) stats.promoted++;
    }
  }
  return stats;
}

module.exports = {
  syncWellnessRoleFromRbacRoles,
  backfillWellnessRolesOnBoot,
  syncRbacRoleFromWellnessRole,
  backfillRbacRolesFromWellnessRolesOnBoot,
};
