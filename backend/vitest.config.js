// Vitest config for backend unit tests.
//
// Scope: pure unit tests over backend/lib/, backend/middleware/,
// backend/services/, backend/utils/. NO database, NO server boot, NO
// network. Anything that needs a real Prisma/MySQL/HTTP layer belongs
// in the e2e Playwright specs (see e2e/tests/*-api.spec.js).
//
// Pattern: every test imports the SUT module, mocks `../lib/prisma` (and
// any other I/O dep) via `vi.mock()`, then asserts pure-input/output or
// mock-call shapes. Fault-injection: have the prisma mock throw → assert
// the route handler / lib function returns the error envelope or fails
// gracefully.
//
// Runtime budget: this whole suite must run in under ~30s on the CI box
// (no MySQL, no Playwright). It's gated by deploy.yml's unit_tests job
// on every push.
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    // T35: guard against real-DB fall-through. test/setup.js refuses to start
    // the suite if DATABASE_URL points at a non-local host (unless
    // ALLOW_REMOTE_DB_IN_TESTS=1 is set as an explicit override).
    setupFiles: ['./test/setup.js'],
    // Don't accidentally pick up the Playwright specs in the e2e/ folder.
    // Also exclude `test/integration/prisma-extends.test.js` — that spec
    // taps `prisma.$parent._engine` to exercise the real $extends machinery
    // and can't run under T39's `prismaSurfaceGuard()` proxy. It runs under
    // `backend/vitest.integration.config.js` (npm run test:integration)
    // which sets PRISMA_ALLOW_REAL_CALLS=1 before setup.js fires. See
    // PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §10 T40 for the rationale.
    exclude: [
      'node_modules/**',
      'e2e/**',
      'coverage/**',
      '.c8tmp/**',
      'test/integration/prisma-extends.test.js',
    ],
    // CI gate stability: a small number of singleton-patch route tests
    // exhibit cross-worker pollution under the full parallel suite. One
    // retry gives those specs a clean second chance without masking
    // deterministic failures (a failing test will still fail twice).
    retry: 1,
    // Per-test timeout. Pure-fn tests are sub-millisecond; 5s gives
    // ample room for a Prisma mock + async-await chain.
    testTimeout: 5000,
    // CJS source under test + ESM tests. Without inlining the lib/middleware/
    // services/utils modules, the SUT's `require('./prisma')` bypasses vitest's
    // module loader and `vi.mock('../../lib/prisma')` factories never run —
    // tests then hit the real DB. Inlining forces vitest to transform the SUT
    // through its ESM resolver so vi.mock hooks fire correctly.
    server: {
      deps: {
        inline: [
          /backend\/lib\//,
          /backend\/middleware\//,
          /backend\/services\//,
          /backend\/utils\//,
          /backend\/cron\//,
          // scripts/ is inlined for unit tests over operator/forensic
          // CLI tools (e.g. verify-audit-chain.js for #558). Same reason
          // as cron: the script's `require('../lib/prisma')` must
          // resolve through vitest's loader to see the test's mocked
          // singleton, not the real Prisma client.
          /backend\/scripts\//,
          // routes/ is inlined for the integration tier under
          // test/integration/, which mounts single route handlers
          // into a fresh express app + supertest to drive end-to-end
          // (signature verification → DB-mock side effects) flows
          // without booting MySQL. See test/integration/stripe-webhook.test.js
          // (G-22) for the canonical use case. The cost is small:
          // routes/ inlining only matters for files that are
          // actually imported by a test, so the rest of the unit
          // suite is unaffected.
          /backend\/routes\//,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: [
        'lib/**/*.js',
        'middleware/**/*.js',
        'services/**/*.js',
        'utils/**/*.js',
        'cron/**/*.js',
      ],
      exclude: [
        'node_modules/**',
        'test/**',
        'coverage/**',
        '**/*.test.js',
      ],
    },
  },
});
