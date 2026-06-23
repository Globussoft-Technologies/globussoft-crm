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
        // #936: catch the destructure-rename form too —
        //   const { id: userId } = req.user
        // is the SAME bug class (id is undefined on req.user; the JWT payload
        // key is userId). The bare-MemberExpression selector above doesn't
        // see this form because it never reads `req.user.id` directly.
        {
          selector: "VariableDeclarator[init.type='MemberExpression'][init.object.name='req'][init.property.name='user'] > ObjectPattern > Property[key.name='id']",
          message: "Don't destructure `id` from req.user — the JWT payload key is 'userId', so `{ id } = req.user` (or `{ id: foo } = req.user`) is always undefined. Use `{ userId } = req.user`. See issue #936.",
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
      // All `no-restricted-syntax` selectors for routes/**/*.js live in
      // this ONE rule definition because ESLint flat config replaces
      // the rule entirely when a later override re-defines it (the LAST
      // matching override wins for a given file — there is no additive
      // merge across overrides for selectors-of-the-same-rule). Severity
      // is therefore SHARED across all selectors below: `error`. The new
      // #918/#919 FR-3.4 tenant-scope heuristic lives in a SIBLING
      // override below at a SEPARATE rule key (gbscrm/tenant-scope-
      // heuristic — defined via inline plugin) so it can ship at `warn`
      // severity without forcing the #646 selectors to warn-level too.
      'no-restricted-syntax': [
        'error',
        // Keep the req.user.id rule from above — overriding `no-restricted-syntax`
        // replaces the rule entirely, so we re-include the original selector.
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='req'][object.property.name='user'][property.name='id']",
          message: "Use req.user.userId, not req.user.id. The JWT payload key set by verifyToken is 'userId' — bare req.user.id is undefined. See commit 6b1470f.",
        },
        // #936: same bug class, destructure-rename form
        {
          selector: "VariableDeclarator[init.type='MemberExpression'][init.object.name='req'][init.property.name='user'] > ObjectPattern > Property[key.name='id']",
          message: "Don't destructure `id` from req.user — the JWT payload key is 'userId', so `{ id } = req.user` (or `{ id: foo } = req.user`) is always undefined. Use `{ userId } = req.user`. See issue #936.",
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
    // ──────────────────────────────────────────────────────────────────
    // #918 / #919 (FR-3.4) — Tenant-scope heuristic for Prisma calls
    // inside route handlers. WARN-level by design.
    //
    // Why this rule lives in a SEPARATE inline plugin rather than as
    // another `no-restricted-syntax` selector: ESLint flat config does
    // NOT additively merge `no-restricted-syntax` selectors across
    // overrides for the same file. The LAST matching override REPLACES
    // the rule entirely. Adding the heuristic at warn-level would force
    // the #646 + req.user.id selectors above to demote to warn too, OR
    // we'd have to ship the heuristic at error and break CI on ~60-70
    // pre-existing callsites. The inline plugin sidesteps both: a
    // separate rule key (`gbscrm/tenant-scope-finder-heuristic`) carries
    // its own severity independent of the built-in `no-restricted-
    // syntax` rule.
    //
    // What it flags:
    //   `prisma.<Model>.findMany({ where: { ...properties... } })` where
    //   the `where` ObjectExpression has at least one Property, has NO
    //   Property named `tenantId`, AND has NO Property named `id`. The
    //   `id` escape hatch reduces the false-positive class for
    //   by-primary-key lookups that are tenant-safe by virtue of a
    //   prior tenant-scoped fetch of that id.
    //
    // Why ONLY `findMany`:
    //   List endpoints are the highest-risk class for cross-tenant
    //   leakage — they return an array of rows. `findFirst` /
    //   `findUnique` / `update` / `delete` by primary key after a prior
    //   tenant-scoped fetch dominate the noise floor when the selector
    //   is widened. Narrowing to `findMany` lifts signal:noise from
    //   roughly 1:25 to roughly 1:5 on the existing 102-route surface.
    //
    // What it WON'T catch (cron-callsite review separately — see
    // [docs/gaps/cross-tenant-coverage-audit.md]):
    //   - Prisma calls inside `backend/cron/*.js` engines (different
    //     scope; the engine loops per-tenant or carries `tenantId` in
    //     local scope explicitly).
    //   - Prisma calls inside `backend/lib/*.js` / `services/*.js`
    //     helpers (most accept a `tenantId` arg from the caller; the
    //     caller is responsible for scoping).
    //   - Raw SQL via `$queryRaw` / `$executeRaw`.
    //   - Calls where `where` is computed dynamically (`where:
    //     buildWhere(req)` or `where: { ...tenantWhere(req) }`) — the
    //     AST can't see into the builder or spread expression.
    //   - `findFirst` / `findUnique` / `update` / `delete` (intentional
    //     narrowing — false-positive rate too high to justify the
    //     signal).
    //
    // Suppress with `// eslint-disable-next-line gbscrm/tenant-scope-
    // finder-heuristic` + a one-line comment explaining why the call is
    // tenant-safe (e.g. "// safe: ADMIN-only route, verified by
    // verifyRole guard at top" or "// safe: list scoped by prior tenant-
    // scoped contactId fetch").
    //
    // The companion gate spec
    // [`e2e/tests/cross-tenant-coverage-audit.spec.js`] provides the
    // runtime check: cross-tenant Bearer tokens against GET / detail
    // endpoints for the highest-risk models. The two layers are
    // complementary — ESLint catches it at write-time (warn), the gate
    // spec catches it at deploy-time (error).
    //
    // Tightening path: if a third instance of cross-tenant leak is
    // surfaced in a model NOT covered by the gate spec, widen the
    // selector to also flag `findFirst` and `findUnique`, then promote
    // severity from `warn` to `error` after sweeping the existing
    // ~60-70 callsites with audit-backed `// eslint-disable-next-line`
    // directives.
    // ──────────────────────────────────────────────────────────────────
    files: ['routes/**/*.js'],
    plugins: {
      gbscrm: {
        rules: {
          // Inline custom rule. Takes a single options object with
          // { selector, message } and reports the message on every
          // node matching the selector. Effectively a clone of the
          // built-in `no-restricted-syntax` rule but registered under
          // a separate key so it can carry its own severity.
          'tenant-scope-finder-heuristic': {
            meta: {
              type: 'problem',
              docs: {
                description: 'FR-3.4 tenant-scope heuristic for Prisma findMany calls in route handlers.',
              },
              schema: [{
                type: 'object',
                properties: {
                  selector: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['selector', 'message'],
                additionalProperties: false,
              }],
              messages: { restricted: '{{message}}' },
            },
            create(context) {
              const opts = context.options[0];
              return {
                [opts.selector](node) {
                  context.report({
                    node,
                    messageId: 'restricted',
                    data: { message: opts.message },
                  });
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'gbscrm/tenant-scope-finder-heuristic': ['warn', {
        selector: "CallExpression[callee.object.object.name='prisma'][callee.property.name='findMany'] > ObjectExpression > Property[key.name='where'] > ObjectExpression:has(Property):not(:has(Property[key.name='tenantId'])):not(:has(Property[key.name='id']))",
        message: "FR-3.4 (#918 / #919): prisma.<Model>.findMany inside routes/ is missing `tenantId` in its WHERE clause. List endpoints are the highest-risk class for cross-tenant data leak — they return arrays of rows. Either (a) add `tenantId: req.user.tenantId` to the WHERE, (b) use the `tenantWhere(req)` helper if/when introduced, or (c) suppress with `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic` + a one-line comment explaining why the call is tenant-safe (e.g. ADMIN-only route, parent-row tenant-scoped, lookup model with no PII). See docs/gaps/cross-tenant-coverage-audit.md.",
      }],
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
    // Browser-side assets shipped under backend/services/templates/. Files
    // like wanderlux/support.js are generated from dc-runtime TypeScript and
    // served as static JS to the browser — so window / document / DOMParser /
    // customElements / HTMLElement / Node / location are all valid. The
    // "GENERATED — do not edit" header means inline directives would be
    // wiped on regen; the override has to live here.
    files: ['services/templates/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
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
