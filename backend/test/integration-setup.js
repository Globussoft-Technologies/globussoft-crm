/**
 * T40 — vitest setup file for the integration-prisma config.
 *
 * Some tests under `backend/test/integration/` intentionally exercise REAL
 * Prisma machinery (e.g. `prisma-extends.test.js` taps `prisma.$parent._engine`
 * to swap engine.request to assert the wellness-PII encrypt/decrypt walker).
 * Those tests cannot run under T39's `prismaSurfaceGuard()` because the
 * guard wraps `PrismaClient` with a Proxy that has no `_engine` to tap.
 *
 * This file sets both T35 and T39 escape hatches BEFORE the main
 * `test/setup.js` runs. T35's `dbFallthroughGuard()` and T39's
 * `prismaSurfaceGuard()` both early-return on their respective env vars,
 * so they become structural no-ops for this config.
 *
 * This file is named `integration-setup.js` (not `*.test.js`) so it is NOT
 * picked up as a test file by the main vitest config's
 * `include: ['test/**\/*.test.js']` glob.
 *
 * NOTE: only the `prisma-extends.test.js` integration spec actually needs
 * these escape hatches. The other integration tests (stripe-webhook,
 * route-mount-audit) use the singleton-monkey-patch pattern and work fine
 * under the main `test/setup.js` guards — they continue to run under the
 * main `npm test` config, not this one.
 */

// T39 — skip prismaSurfaceGuard so prisma.$parent._engine is reachable.
process.env.PRISMA_ALLOW_REAL_CALLS = '1';

// T35 — skip dbFallthroughGuard. The prisma-extends test never makes a real
// connection (it stubs engine.request before any query), so DATABASE_URL
// pointing at the demo box is harmless. Without this, the guard refuses to
// start the run on dev machines where backend/.env points at demo.
process.env.ALLOW_REMOTE_DB_IN_TESTS = '1';
