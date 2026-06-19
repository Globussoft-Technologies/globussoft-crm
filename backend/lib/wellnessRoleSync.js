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

module.exports = { syncWellnessRoleFromRbacRoles };
