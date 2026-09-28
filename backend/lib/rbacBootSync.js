const { ensureRbacOnBoot } = require("../scripts/ensureRbacOnBoot");

/**
 * Reconcile RBAC state before the HTTP server accepts authenticated traffic.
 *
 * The optional dependency injection keeps the startup contract unit-testable
 * without opening a database connection. A failed reconciliation remains
 * non-fatal for local installs whose database is not ready yet.
 */
async function runRbacBootSync({ sync = ensureRbacOnBoot } = {}) {
  try {
    const stats = await sync();
    if (!stats) return null;

    const wrote =
      stats.rolesCreated + stats.permsCreated + stats.assignmentsCreated;
    if (wrote > 0) {
      console.log(
        `[rbac-boot] backfilled — roles:${stats.rolesCreated} perms:${stats.permsCreated} assignments:${stats.assignmentsCreated} (skipped users:${stats.usersSkipped})`,
      );
    } else {
      console.log("[rbac-boot] RBAC state already compatible — no changes.");
    }
    return stats;
  } catch (err) {
    console.error(
      "[rbac-boot] non-fatal error:",
      err && err.message ? err.message : err,
    );
    return null;
  }
}

module.exports = { runRbacBootSync };
