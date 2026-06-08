/**
 * Test-harness guard against real-DB fall-through (T35).
 *
 * Background: prisma calls in route handlers that aren't covered by a test's
 * `vi.mock()` surface (or singleton patch) silently fall through to the real
 * `PrismaClient` and hit whatever `DATABASE_URL` is pointing at. On dev
 * machines `backend/.env` typically points at the demo MySQL
 * (163.227.174.141:3306) so tests then pass "by accident" against real data —
 * they're structurally integration tests in mock's clothing. T24 was a case
 * of this; T27's audit found 11 more.
 *
 * Guard: when running under vitest (process.env.VITEST === 'true'), if
 * DATABASE_URL resolves to a non-local host, refuse to start. Devs override
 * by:
 *   (a) Setting DATABASE_URL to a local mysql:// (Docker stack, etc.), OR
 *   (b) Setting ALLOW_REMOTE_DB_IN_TESTS=1 explicitly for the rare legit case
 *       (e.g. backend/test/integration/ supertest specs that intentionally
 *       wire up a real DB).
 *
 * Wired in via backend/vitest.config.js `setupFiles: ['./test/setup.js']`.
 */

function dbFallthroughGuard() {
  if (process.env.VITEST !== 'true') return; // only fire under vitest
  if (process.env.ALLOW_REMOTE_DB_IN_TESTS === '1') return; // explicit override

  const url = process.env.DATABASE_URL || '';
  if (!url) return; // no URL set — prisma will throw its own clear error; we don't pre-empt

  // Parse the host out of mysql:// / postgres:// URLs.
  let host = '';
  try {
    const u = new URL(url);
    host = u.hostname;
  } catch {
    return; // unparseable URL — let prisma surface the error
  }

  // WHATWG URL preserves brackets around IPv6 hosts (e.g. "[::1]") — strip
  // them so the bracketed and bare loopback forms both match.
  const bareHost = host.replace(/^\[/, '').replace(/\]$/, '');

  const isLocal =
    bareHost === 'localhost' ||
    bareHost === '127.0.0.1' ||
    bareHost === '::1' ||
    bareHost.endsWith('.local') ||
    bareHost === 'mysql' || // common docker-compose service name
    bareHost === 'db';      // ditto

  if (!isLocal) {
    throw new Error(
      `[db-fallthrough-guard] DATABASE_URL points at remote host "${bareHost}". ` +
      `Tests in this repo mock prisma; falling through to a real DB makes ` +
      `mock-coverage gaps invisible (a test passes today against real data ` +
      `but the mock never covered the surface). Override with ` +
      `ALLOW_REMOTE_DB_IN_TESTS=1 if intentional (e.g. an integration spec), ` +
      `or set DATABASE_URL=mysql://root@localhost:3306/gbscrm (or equivalent ` +
      `local Docker stack) before re-running.`
    );
  }
}

dbFallthroughGuard();

module.exports = { dbFallthroughGuard };
