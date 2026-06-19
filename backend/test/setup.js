/* global afterEach */
/**
 * Test-harness guards against real-DB fall-through.
 *
 * Two layers — T35 (DATABASE_URL host check) + T39 (PrismaClient surface proxy).
 *
 * ─── T35: dbFallthroughGuard ──────────────────────────────────────────────
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
 * ─── T39: prismaSurfaceGuard ──────────────────────────────────────────────
 *
 * T35 closes the REMOTE-DB fallthrough. It does NOT catch the LOCAL-DB-with-
 * incomplete-mocks case — where `DATABASE_URL=mysql://localhost/...` AND a
 * route hits an unmocked Prisma surface, the test silently calls real Prisma
 * against local data. That's the Class B6 trap T37 just resolved across 5
 * files (auth + consent + wellness-xlsx).
 *
 * T39 closes that class structurally by wrapping `PrismaClient` (the class
 * exported from `@prisma/client`) so that any instance returned by
 * `new PrismaClient()` is a proxy that throws on every model.method() call.
 * Tests that properly `vi.mock('../../lib/prisma', ...)` never reach the
 * real class → no proxy fires. Tests that miss a mock surface fall through
 * to the wrapped client → loud "[prisma-surface-guard] unmocked prisma.X.Y()"
 * error instead of a silent real-DB call.
 *
 * Lifecycle methods ($connect / $disconnect / $on / $use / $extends /
 * $transaction) are no-op'd rather than thrown — `backend/lib/prisma.js`
 * calls `.$extends(...)` at module load time and we don't want to break the
 * import path itself (only the actual `prisma.<model>.<method>()` query
 * surface).
 *
 * Escape hatch: `PRISMA_ALLOW_REAL_CALLS=1` skips the wrap entirely. Pair
 * this with `ALLOW_REMOTE_DB_IN_TESTS=1` for integration specs (see
 * backend/test/integration/) that intentionally drive a real Prisma against
 * a local or test database.
 *
 * Wired in via backend/vitest.config.js `setupFiles: ['./test/setup.js']`.
 * The wrap MUST run before any test file imports `backend/lib/prisma` —
 * setupFiles run before test collection, so the ordering is guaranteed.
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

/**
 * T39 — wrap `@prisma/client`'s PrismaClient so that any test which forgets
 * to mock a Prisma surface gets a loud "unmocked surface" error instead of
 * a silent real-DB call.
 *
 * Design notes:
 * - Only fires under vitest. Production / dev / other test harnesses are
 *   untouched.
 * - Honors PRISMA_ALLOW_REAL_CALLS=1 as the escape hatch for integration
 *   tests that intentionally exercise real Prisma.
 * - Wraps the CLASS, not the singleton — `backend/lib/prisma.js` does
 *   `new PrismaClient()` at module load, so every fresh Prisma instance
 *   (singleton or otherwise) routes through our wrap.
 * - Lifecycle methods ($connect/$disconnect/$on/$use/$transaction) are
 *   no-op'd. `$extends` returns the proxy itself so chained calls work.
 *   Model.method() calls throw with a diagnostic message naming the
 *   offending surface (e.g. "prisma.contact.findUnique").
 * - Skips Symbol property access (Symbol.iterator, Symbol.toPrimitive, etc.)
 *   and `then` / `catch` / `finally` so the proxy doesn't masquerade as a
 *   thenable when accidentally returned from an async function.
 */
function prismaSurfaceGuard() {
  if (process.env.VITEST !== 'true') return;
  if (process.env.PRISMA_ALLOW_REAL_CALLS === '1') return;

  let prismaModule;
  try {
    prismaModule = require('@prisma/client');
  } catch {
    return; // @prisma/client not installed in this context — nothing to wrap
  }

  const RealPrismaClient = prismaModule.PrismaClient;
  if (typeof RealPrismaClient !== 'function') return; // unexpected shape; bail safely
  if (RealPrismaClient.__t39Wrapped) return; // idempotent — don't double-wrap on re-import

  function buildModelProxy(modelName) {
    // Underlying storage: tests that singleton-patch (prisma.user.findUnique
    // = vi.fn()) write to this object via the set trap; the get trap checks
    // here first and returns the stored value if present. Surfaces that were
    // never patched throw on access.
    const stored = Object.create(null);
    return new Proxy(stored, {
      get(target, method) {
        if (typeof method === 'symbol') return target[method];
        if (method === 'then' || method === 'catch' || method === 'finally') return undefined;
        if (method in target) return target[method];
        // Unmocked method on this model — throw a diagnostic that names
        // the model AND method so the dev can find the missing surface.
        return () => {
          throw new Error(
            `[prisma-surface-guard] Unmocked PrismaClient call: ` +
            `prisma.${String(modelName)}.${String(method)}() during vitest. ` +
            `Tests must mock the prisma module (vi.mock('../../lib/prisma', ...)) ` +
            `AND the mock surface must include this field. If this is an integration ` +
            `test that intentionally exercises real Prisma, set PRISMA_ALLOW_REAL_CALLS=1 ` +
            `before running. Discovered as the root cause of T24 + Class B6 silent-` +
            `fallthrough bugs (see docs/gaps/backend-test-routes-red-audit.md).`
          );
        };
      },
      set(target, method, value) {
        target[method] = value;
        return true;
      },
      has(target, method) {
        return method in target;
      },
      deleteProperty(target, method) {
        delete target[method];
        return true;
      },
    });
  }

  function buildSurfaceProxy() {
    // Top-level storage — tests that set `prisma.someModel = {...}` write
    // through here, and the get trap returns the stored object back. For
    // model-shaped properties (anything not starting with `$`), if there's
    // no stored value we lazily build a model-proxy and CACHE it so that
    // repeated reads return the same object (essential for the
    // `prisma.foo = prisma.foo || {}` idiom plus subsequent
    // `prisma.foo.bar = vi.fn()` patches that some test files use).
    const stored = Object.create(null);
    const modelProxyCache = Object.create(null);
    const proxy = new Proxy(stored, {
      get(target, model) {
        if (typeof model === 'symbol') return target[model];
        if (model === 'then' || model === 'catch' || model === 'finally') return undefined;
        // Anything explicitly set on the singleton wins (singleton-patch
        // tests stash either a vi.fn() mock object or an entire model
        // surface here).
        if (model in target) return target[model];
        // Lifecycle methods — async no-ops so the import path of
        // backend/lib/prisma.js (which calls .$extends) keeps working
        if (model === '$connect' || model === '$disconnect') {
          return async () => {};
        }
        if (model === '$on' || model === '$use') {
          return () => {};
        }
        if (model === '$transaction') {
          // $transaction throws — a test that's calling a real transaction
          // has clearly missed a mock surface. Tests that intentionally
          // exercise transactions should either mock $transaction directly
          // (prisma.$transaction = vi.fn()) or use the
          // PRISMA_ALLOW_REAL_CALLS=1 escape hatch.
          return () => {
            throw new Error(
              `[prisma-surface-guard] Unmocked PrismaClient call: prisma.$transaction() ` +
              `during vitest. Tests must mock the prisma module (vi.mock('../../lib/prisma', ...)). ` +
              `If this is an integration test that intentionally exercises real Prisma, set ` +
              `PRISMA_ALLOW_REAL_CALLS=1 before running.`
            );
          };
        }
        if (model === '$extends') {
          // $extends returns a new client — preserve chainability by
          // returning the same proxy. backend/lib/prisma.js calls this
          // at module load.
          return () => proxy;
        }
        if (model === '$queryRaw' || model === '$queryRawUnsafe' ||
            model === '$executeRaw' || model === '$executeRawUnsafe') {
          return () => {
            throw new Error(
              `[prisma-surface-guard] Unmocked PrismaClient call: prisma.${String(model)}() ` +
              `during vitest. Tests must mock the prisma module (vi.mock('../../lib/prisma', ...)). ` +
              `If this is an integration test that intentionally exercises real Prisma, set ` +
              `PRISMA_ALLOW_REAL_CALLS=1 before running.`
            );
          };
        }
        // Other $-prefixed surfaces ($metrics, etc.) — return a generic
        // thrower so unknown lifecycle calls don't silently no-op.
        if (typeof model === 'string' && model.startsWith('$')) {
          return () => {
            throw new Error(
              `[prisma-surface-guard] Unmocked PrismaClient call: prisma.${String(model)}() ` +
              `during vitest. Tests must mock the prisma module (vi.mock('../../lib/prisma', ...)). ` +
              `If this is an integration test that intentionally exercises real Prisma, set ` +
              `PRISMA_ALLOW_REAL_CALLS=1 before running.`
            );
          };
        }
        // Regular model surface — build a per-model proxy on first access
        // and CACHE it. Without caching, the `prisma.user = prisma.user
        // || {}` idiom (used by many singleton-patch tests) would assign
        // back a freshly-built proxy on every iteration, defeating any
        // method-level vi.fn() patches that follow.
        if (!modelProxyCache[model]) {
          modelProxyCache[model] = buildModelProxy(model);
        }
        return modelProxyCache[model];
      },
      set(target, model, value) {
        target[model] = value;
        return true;
      },
      has(target, model) {
        return model in target;
      },
      deleteProperty(target, model) {
        delete target[model];
        return true;
      },
    });
    return proxy;
  }

  function GuardedPrismaClient(/* ...args */) {
    return buildSurfaceProxy();
  }
  GuardedPrismaClient.prototype = RealPrismaClient.prototype;
  GuardedPrismaClient.__t39Wrapped = true;
  // Preserve the original constructor in case a test needs to access it
  // (e.g. to assert that the guard wrapped the right class).
  GuardedPrismaClient.__realPrismaClient = RealPrismaClient;
  prismaModule.PrismaClient = GuardedPrismaClient;
}

prismaSurfaceGuard();

/**
 * T40 — clear the RBAC permission cache between every test.
 *
 * The permission resolver caches effective grants per (tenantId, userId) for
 * 30 seconds. Singleton-patch route tests reuse the same userId (typically 7)
 * across many roles (ADMIN / MANAGER / USER) in the same file. Without a
 * teardown, a USER test that runs after an ADMIN test reuses the cached ADMIN
 * grants and gets allowed through routes it should be denied; conversely, a
 * MANAGER test after a USER test reuses an empty cache and gets spurious 403s.
 *
 * Clearing the cache after each test keeps the legacy role-derived fallback
 * deterministic and prevents cross-test pollution.
 */
if (process.env.VITEST === 'true') {
  try {
    const { clearAllCache } = require('../middleware/requirePermission');
    if (typeof afterEach === 'function') {
      afterEach(() => clearAllCache());
    }
  } catch {
    // If the middleware can't be loaded in this context, leave cache handling
    // to individual tests.
  }
}

module.exports = { dbFallthroughGuard, prismaSurfaceGuard };
