const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!['localhost', '127.0.0.1'].includes(new URL(process.env.BASE_URL || 'http://localhost:5000').hostname),
  'Repository-local embed regression; do not run against a deployed build');

// Fully mocked embed: no CRM server, database, or external network is used.
test('Generic WhatsApp follows phone across viewport and host-device changes', async ({ page }) => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/public/embed/web-form.html'), 'utf8');
  const form = {
    id: 1, name: 'Responsive regression',
    settings: { whatsappEnabled: true },
    style: { layoutColumns: 'two', mobileLayoutColumns: 'one' },
    fields: ['name', 'phone', 'email'].map((sourceKey, index) => ({
      id: index + 1, sourceKey, label: sourceKey,
      fieldType: sourceKey === 'name' ? 'text' : sourceKey, width: 'half',
    })),
  };
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('https://embed-review.test/api/')) return route.fulfill({ json: form });
    if (url.startsWith('https://embed-review.test/')) return route.fulfill({ contentType: 'text/html', body: html });
    return route.abort();
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('https://embed-review.test/embed/web-form.html?id=1');
  const whatsapp = page.locator('.generic-whatsapp-section');
  await expect(whatsapp).toHaveCSS('grid-column-start', '2');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(whatsapp).toHaveCSS('grid-column-start', '1');
  await expect.poll(() => page.locator('.grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(whatsapp).toHaveCSS('grid-column-start', '2');
  await page.evaluate(() => window.postMessage({
    source: 'gbs-web-form-host', type: 'responsive-device', device: 'mobile',
  }, '*'));
  await expect(whatsapp).toHaveCSS('grid-column-start', '1');
  await expect.poll(() => page.locator('.grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.evaluate(() => window.postMessage({
    source: 'gbs-web-form-host', type: 'responsive-device', device: 'desktop',
  }, '*'));
  await expect(whatsapp).toHaveCSS('grid-column-start', '2');
});
