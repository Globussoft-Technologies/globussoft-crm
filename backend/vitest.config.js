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
    // Don't accidentally pick up the Playwright specs in the e2e/ folder.
    exclude: ['node_modules/**', 'e2e/**', 'coverage/**', '.c8tmp/**'],
    // Hard-fail on a flaky test rather than retrying — these are pure
    // unit tests, no flake should be tolerated.
    retry: 0,
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
