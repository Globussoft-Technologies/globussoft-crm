// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const AUTH_STATE_PATH = 'playwright/.auth/user.json';

module.exports = defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 2 : undefined,
  expect: {
    timeout: 15000,
  },

  // Runs once after ALL tests finish. Deletes E2E-flavored rows from the DB
  // so the wellness Owner Dashboard doesn't accumulate fake patients/leads
  // across re-runs. Set E2E_SKIP_SCRUB=1 to opt out. See ./global-teardown.js.
  globalTeardown: require.resolve('./global-teardown.js'),

  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'playwright-report/junit.xml' }],
    ['list']
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },

  projects: [
    // Auth setup project — must run first
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
    },

    // Main test project using saved auth state
    {
      name: 'chromium',
      testDir: './tests',
      testIgnore: /.*(auth|api-health)\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },

    // Firefox
    {
      name: 'firefox',
      testDir: './tests',
      testIgnore: /.*(auth|api-health)\.spec\.js/,
      use: {
        ...devices['Desktop Firefox'],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },

    // WebKit (Safari engine) — mirrors firefox setup
    {
      name: 'webkit',
      testDir: './tests',
      testIgnore: /.*(auth|api-health)\.spec\.js/,
      use: {
        ...devices['Desktop Safari'],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },

    // Mobile viewport
    {
      name: 'mobile-chrome',
      testDir: './tests',
      testIgnore: /.*(auth|api-health)\.spec\.js/,
      use: {
        ...devices['Pixel 5'],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },

    // Auth tests run without saved state (they test the login flow itself)
    {
      name: 'auth-tests',
      testDir: './tests',
      testMatch: /auth\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },

    // API health tests use direct HTTP with auth token
    {
      name: 'api-health',
      testDir: './tests',
      testMatch: /api-health\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },
  ],

  outputDir: 'playwright-results',
});
