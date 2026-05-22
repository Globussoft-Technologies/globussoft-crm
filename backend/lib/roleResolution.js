/**
 * Single-source role resolution for a user.
 *
 * The CRM still has a legacy `User.role` string column ("ADMIN", "MANAGER",
 * "USER", "CUSTOMER") AND a newer `UserRole` join table that is the
 * forward-looking source of truth. New code should look at the UserRole
 * row to find the canonical role (key, landingPath, etc.); legacy code
 * keeps reading `User.role`. This helper resolves the primary role + its
 * landing path so the login + auth/me endpoints can return one consistent
 * shape regardless of which mechanism populated the user.
 *
 * Single-role-per-user is enforced structurally by @@unique([userId]) on
 * UserRole, so "primary" here is the unique row (if any). If no UserRole
 * row exists (most wellness staff today), fall back to matching the legacy
 * `User.role` string against `Role.key` within the user's tenant. If THAT
 * also yields nothing (e.g. tenant predates the Role seed), return null
 * and let the caller fall through to vertical defaults.
 */

const prisma = require("./prisma");

/**
 * Resolve the primary role for a user.
 *
 * @param {{ id: number, role: string|null, tenantId: number|null }} user
 *        A user row already loaded by the caller. Pass at minimum the id,
 *        role (legacy string), and tenantId.
 * @returns {Promise<{ id: number, key: string, name: string, landingPath: string|null } | null>}
 */
async function resolvePrimaryRole(user) {
  if (!user || !user.id) return null;

  // Defensive: this helper is called inline by /auth/login + /auth/me + the
  // /me/permissions endpoint. Login must NEVER fail because of an ancillary
  // role lookup — if the Prisma client and the DB schema disagree (e.g. the
  // landingPath column doesn't exist yet because `prisma db push` hasn't
  // been run after pulling these changes), we still want the user to log in.
  // Swallow any prisma error and fall through to null; the frontend falls
  // back to its vertical-default routing when landingPath is null.
  try {
    // Use findFirst rather than findUnique because the @@unique([userId])
    // constraint is application-enforced for now (see schema.prisma comment).
    // Order by most-recent assignment so a user with legacy 2+ rows resolves
    // to the latest one — once the dedupe-then-add-unique migration lands
    // this can flip back to findUnique.
    const userRole = await prisma.userRole.findFirst({
      where: { userId: user.id },
      include: { role: true },
      orderBy: { assignedAt: 'desc' },
    });

    if (userRole && userRole.role) {
      return {
        id: userRole.role.id,
        key: userRole.role.key,
        name: userRole.role.name,
        landingPath: userRole.role.landingPath || null,
      };
    }

    // Fallback: match legacy User.role string against Role.key within tenant.
    // Keeps existing wellness staff (User.role='USER', no UserRole row) routing
    // through the configured landingPath on the tenant's USER role without
    // having to backfill UserRole entries for them all at once.
    if (user.role && user.tenantId) {
      const role = await prisma.role.findFirst({
        where: { tenantId: user.tenantId, key: user.role },
        select: { id: true, key: true, name: true, landingPath: true },
      });
      if (role) {
        return {
          id: role.id,
          key: role.key,
          name: role.name,
          landingPath: role.landingPath || null,
        };
      }
    }

    return null;
  } catch (err) {
    // Most likely cause: DB schema is out of sync (landingPath column missing).
    // Log once and return null so login + /me proceed normally.
    console.warn(
      '[roleResolution] failed to resolve primary role; falling back to null. ' +
        'Run `npx prisma db push` if the schema is out of sync. ' +
        (err && err.message ? `Cause: ${err.message}` : ''),
    );
    return null;
  }
}

module.exports = { resolvePrimaryRole };
