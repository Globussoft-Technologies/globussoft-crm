const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Real browser layout and the production synchronizer, with synthetic rows.
// No backend, authentication, customer data, or external network is used.
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(Boolean(process.env.BASE_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.BASE_URL), 'Requires local source files');

for (const vertical of ['generic', 'wellness', 'travel']) {
  for (const width of [375, 1280]) {
    test(`Contacts panes align through content and viewport changes: ${vertical}, ${width}px`, async ({ page }) => {
      const root = path.resolve(__dirname, '../..');
      const css = fs.readFileSync(path.join(root, 'frontend/src/index.css'), 'utf8');
      const helper = fs.readFileSync(path.join(root, 'frontend/src/utils/splitTableRowHeights.js'), 'utf8')
        .replace(/export function /g, 'function ');
      await page.route('**/*', route => route.abort());
      await page.setViewportSize({ width, height: 800 });
      const left = [1, 2, 3].map(id => `<tr data-id="${id}"><td style="padding:1rem;white-space:nowrap"><a style="display:block;font-weight:600">Contact ${id}</a><div style="font-size:.75rem">Sales Director</div></td></tr>`).join('');
      const right = [1, 2, 3].map(id => `<tr data-id="${id}"><td style="padding:1rem;white-space:nowrap">contact${id}@example.test</td></tr>`).join('');
      await page.setContent(`<style>${css}</style><body data-vertical="${vertical}"><div class="contacts-split-table" style="display:flex;width:640px"><table id="left" class="stable-table" style="width:320px;border-spacing:0"><thead><tr><th>Name</th></tr></thead><tbody>${left}</tbody></table><table id="right" class="stable-table" style="width:320px;border-spacing:0"><thead><tr><th>Email</th></tr></thead><tbody>${right}</tbody></table></div></body>`);
      // Prove the fixture exercises the regression, rather than coincidentally
      // giving both panes equal natural heights before synchronization.
      expect(await page.evaluate(() => Math.abs(
        document.querySelector('#left tbody tr').getBoundingClientRect().height
        - document.querySelector('#right tbody tr').getBoundingClientRect().height,
      ))).toBeGreaterThan(1);
      await page.addScriptTag({ content: helper + '\nwindow.cleanupRows = observeSplitTableRowHeights(document.querySelector("#left"), document.querySelector("#right"));' });
      const alignmentError = () => page.evaluate(() => {
        const leftRows = [...document.querySelectorAll('#left tr')];
        const rightRows = [...document.querySelectorAll('#right tr')];
        return Math.max(...leftRows.flatMap((row, index) => {
          const a = row.getBoundingClientRect();
          const b = rightRows[index].getBoundingClientRect();
          return [Math.abs(a.top - b.top), Math.abs(a.height - b.height)];
        }));
      });
      await expect.poll(alignmentError).toBeLessThanOrEqual(1);
      const originalHeight = await page.locator('#left tbody tr').first().evaluate(row => row.getBoundingClientRect().height);
      await page.locator('#right tbody td').first().evaluate(cell => {
        cell.insertAdjacentHTML('beforeend', '<div id="editor" style="height:120px">Custom-field editor</div>');
      });
      await expect.poll(alignmentError).toBeLessThanOrEqual(1);
      await expect.poll(() => page.locator('#left tbody tr').first().evaluate(row => row.getBoundingClientRect().height)).toBeGreaterThan(originalHeight);
      await page.locator('#editor').evaluate(editor => editor.remove());
      await expect.poll(() => page.locator('#left tbody tr').first().evaluate(row => row.getBoundingClientRect().height)).toBe(originalHeight);
      await page.setViewportSize({ width: width === 375 ? 1280 : 375, height: 800 });
      await expect.poll(alignmentError).toBeLessThanOrEqual(1);
      await page.evaluate(() => window.cleanupRows());
      expect(await page.locator('#left tbody tr').first().evaluate(row => row.style.height)).toBe('');
    });
  }
}
