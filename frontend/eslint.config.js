import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Frontend ESLint flat config.
//
// Strategy mirrors backend/eslint.config.js:
//   - Hard errors are real bugs we want CI to block on.
//     The most important is no-undef + react/jsx-no-undef. Those
//     would have caught the `callifiedUrl is not defined` ReferenceError
//     that shipped to v3.3.0 and rendered the 'Something went wrong'
//     error boundary on the sidebar.
//   - Warnings are stylistic/legacy hygiene we clean up incrementally
//     so a CI gate at --max-warnings=0 isn't blocked by years of drift.
//
// Notable rule deviations from eslint:recommended + react:recommended:
//   - react/prop-types OFF — the codebase does not use PropTypes; enforcing
//     this rule means ~1,000 churn-only changes for no real type safety.
//     If we ever migrate to TypeScript, we get the safety natively.
//   - react/no-unescaped-entities WARN — minor; copy with apostrophes is
//     common in glassmorphism CRM UIs.
//   - no-unused-vars WARN — legacy; clean up via lint:fix incrementally.
export default [
  { ignores: ['dist', 'public', 'coverage', '.vite', 'patch_api.py'] },

  // SPA source: browser globals.
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        // #634: vite `define` injects these at build time (see vite.config.js).
        __APP_VERSION__: 'readonly',
        __APP_GIT_SHA__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '18.3' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,

      // ── HARD ERRORS — would have caught the callifiedUrl bug ──
      'no-undef': 'error',
      'react/jsx-no-undef': 'error',
      'react-hooks/rules-of-hooks': 'error',

      // ── DOWNGRADED to warn (legacy hygiene) ──
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      'react/no-unescaped-entities': 'warn',
      'react/display-name': 'warn',
      'react-hooks/exhaustive-deps': 'warn',

      // ── DISABLED — doesn't fit this codebase's conventions ──
      'react/prop-types': 'off',                  // not using PropTypes
      'react/jsx-no-target-blank': 'off',         // legacy convention
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // Test files: vitest in jsdom; needs both browser + node globals.
  {
    files: [
      'src/**/*.test.{js,jsx}',
      'src/**/__tests__/**/*.{js,jsx}',
      'vitest.setup.js',
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,         // global, process, etc. used by vitest setup
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
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
  },

  // Vite + ESLint config files run in Node.
  {
    files: ['vite.config.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
]
