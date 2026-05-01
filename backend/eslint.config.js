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
