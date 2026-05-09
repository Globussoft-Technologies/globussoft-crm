// ESLint 9 flat config for backend/.
//
// Goal: catch the class of bugs that `node --check` misses — semantic
// issues, undefined identifiers, and project-specific patterns we've been
// burned by (e.g. bare `req.user.id`).
//
// Strategy: most rules are `warn` so legacy code doesn't drown CI. The
// rules promoted to `error` are ones whose violations are real bugs:
//   - `no-undef`           — typos / missing imports
//   - `no-restricted-syntax` for `req.user.id` — the JWT payload key is
//                              `userId`, NOT `id`. Bare `req.user.id`
//                              evaluates to undefined and silently breaks
//                              tenant-scoped queries / audit rows / etc.
//                              See commit 6b1470f for the recent sweep.
//   - `no-restricted-syntax` for `req.body.{id,userId,tenantId,createdAt,
//                              updatedAt}` in routes/ — the global
//                              `stripDangerous` middleware deletes those
//                              fields from every request body BEFORE any
//                              route handler runs. Reading them yields
//                              undefined and silently falls through to a
//                              default-tenant fallback (= cross-tenant
//                              write) or a no-op. Use a non-stripped name
//                              (`targetUserId`, `siteTenantId`,
//                              `previewTenantId`, etc.) and surface a 400
//                              if missing instead of silently defaulting.
//                              See issue #646 for the 4-route sweep
//                              (web_visitors, live_chat, chatbots,
//                              telephony) where this class of bug
//                              landed cross-tenant writes in production.
//                              Suppress per-line with
//                              `// eslint-disable-next-line no-restricted-syntax`
//                              + a comment explaining why the exception
//                              is safe (see routes/quotas.js:69 for the
//                              one legitimate workaround — userId is read
//                              from BOTH query string AND body so the
//                              `req.body.userId` read is a defensive
//                              fallback that's documented to never
//                              succeed in practice).
//   - `no-unreachable`     — dead code after a return/throw
//
// Apply locally: `npm run lint`. The CI gate (deploy.yml `lint` job) runs
// the same with `--max-warnings 0` only on the small surface where we've
// triaged warnings to zero (start: lib/ + middleware/). The wider tree
// allows warnings until they're cleaned up incrementally.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2024,
        // Express adds these to req at runtime; they're not in
        // globals.node but appear inside route handlers via destructure.
        // (Add only if needed; for now they aren't.)
      },
    },
    rules: {
      // Project-specific: catch the req.user.id bug class. The JWT payload
      // sets req.user.userId; bare req.user.id is always undefined.
      // Tolerated patterns (req.user.userId || req.user.id || ...) still
      // trigger this rule — that's intentional, the fallback is a smell.
      // If a tolerated fallback is genuinely required, suppress with a
      // line-level disable + a comment explaining why.
      //
      // Note on `req.body.{id|userId|tenantId|createdAt|updatedAt}`: a
      // separate per-file block below applies the stripDangerous-aware
      // selectors ONLY to routes/**/*.js (those fields are legitimate to
      // read in lib/ / services/ / middleware/ — only the global request
      // body has them stripped).
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='user'][property.name='id']",
          message: "Use req.user.userId, not req.user.id. The JWT payload key set by verifyToken is 'userId' — bare req.user.id is undefined. See commit 6b1470f.",
        },
      ],

      // Hard errors — real bugs:
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // Warnings — legacy code may have these; clean up incrementally:
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
    },
  },
  {
    // #646 defense-in-depth: in routes/, ban reads of stripDangerous-deleted
    // body fields. The global stripDangerous middleware (server.js +
    // middleware/security.js) deletes req.body.{id,userId,tenantId,
    // createdAt,updatedAt} BEFORE any route handler runs, so any code
    // reading those values gets undefined and silently falls into either
    // a default-tenant write (cross-tenant data corruption) or a no-op
    // path (assignee=null, broadcast-instead-of-targeted, etc.). Routes
    // that legitimately need to scope to a body-supplied tenant should
    // use a non-stripped name like `targetUserId`, `siteTenantId`,
    // `previewTenantId`, then 400 if missing.
    //
    // Scope is `routes/**/*.js` only — lib/, services/, middleware/, cron/
    // can read these fields freely (e.g. middleware/validateInput.js IS
    // the stripper; it must read the field to delete it).
    //
    // To suppress on a single line where the exception is genuinely
    // safe (e.g. quotas.js:69 reads `req.body.userId` as a defensive
    // fallback to a query-string read), add:
    //   // eslint-disable-next-line no-restricted-syntax
    // immediately above the line, plus a comment explaining why the
    // read is safe.
    files: ['routes/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Keep the req.user.id rule from above — overriding `no-restricted-syntax`
        // replaces the rule entirely, so we re-include the original selector.
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='user'][property.name='id']",
          message: "Use req.user.userId, not req.user.id. The JWT payload key set by verifyToken is 'userId' — bare req.user.id is undefined. See commit 6b1470f.",
        },
        // #646: req.body.id / userId / tenantId / createdAt / updatedAt are
        // stripped before any handler runs. Reading them yields undefined.
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='body'][property.name='id']",
          message: "Don't read req.body.id — the global stripDangerous middleware deletes it. Use a non-stripped name (e.g. `targetId`) and 400 if missing. See issue #646.",
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='body'][property.name='userId']",
          message: "Don't read req.body.userId — the global stripDangerous middleware deletes it. Use `targetUserId` (or similar) instead. See issue #646 / notifications.js for the canonical pattern.",
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='body'][property.name='tenantId']",
          message: "Don't read req.body.tenantId — the global stripDangerous middleware deletes it. Use `siteTenantId` / `previewTenantId` (or similar) and 400 if missing. See issue #646 / web_visitors.js for the canonical pattern.",
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='body'][property.name='createdAt']",
          message: "Don't read req.body.createdAt — the global stripDangerous middleware deletes it. The DB sets createdAt automatically; if you need a client-supplied timestamp use a non-stripped name (e.g. `eventAt`). See issue #646.",
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='body'][property.name='updatedAt']",
          message: "Don't read req.body.updatedAt — the global stripDangerous middleware deletes it. The DB sets updatedAt automatically. See issue #646.",
        },
      ],
    },
  },
  {
    // Vitest tests are ESM (vitest 4 requires it). Override sourceType
    // here so the parser accepts `import` syntax.
    files: ['test/**/*.test.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'coverage-snapshot/**',
      '.c8tmp/**',
      'prisma/migrations/**',
      'dist/**',
      'scripts/**', // local one-shot scripts; not worth linting
    ],
  },
];
