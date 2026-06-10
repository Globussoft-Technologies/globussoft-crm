// T40 — Vitest config for integration tests that need REAL @prisma/client.
//
// Scope: tests under `backend/test/integration/` that tap Prisma's internals
// (e.g. prisma.$parent._engine) and therefore can't run under T39's
// `prismaSurfaceGuard()` proxy. Currently: just `prisma-extends.test.js`.
//
// The main `vitest.config.js` excludes this file's target spec so the two
// configs don't double-run anything. Other integration tests
// (stripe-webhook, route-mount-audit) use the singleton-monkey-patch
// pattern and stay in the main config — they continue to run under
// `npm test` and don't need PRISMA_ALLOW_REAL_CALLS.
//
// Run with: `npm run test:integration`
//
// The main `npm test` script does NOT invoke this config; CI's
// `unit_tests` gate runs `npm test`. If you add deploy-gate coverage for
// these integration specs, wire `npm run test:integration` into the
// `deploy.yml` `unit_tests` step as a second invocation.
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/prisma-extends.test.js'],
    // T35/T39 escape hatches are set BEFORE the main setup.js runs.
    // integration-setup.js writes the env vars; setup.js then reads them
    // and early-returns from both guards.
    setupFiles: ['./test/integration-setup.js', './test/setup.js'],
    exclude: ['node_modules/**', 'e2e/**', 'coverage/**', '.c8tmp/**'],
    retry: 0,
    testTimeout: 5000,
    server: {
      deps: {
        inline: [
          /backend\/lib\//,
          /backend\/middleware\//,
          /backend\/services\//,
          /backend\/utils\//,
          /backend\/cron\//,
          /backend\/scripts\//,
          /backend\/routes\//,
        ],
      },
    },
  },
});
