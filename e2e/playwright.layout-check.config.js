const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: ['estimates-responsive-layout.spec.js', 'contacts-split-layout.spec.js'],
  use: { browserName: 'chromium', headless: true },
});
