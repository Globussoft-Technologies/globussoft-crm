const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// CSS-only browser regression: no backend, authentication, or tenant data.
// Source files must be available locally; do not run against the live demo.
test.skip(Boolean(process.env.BASE_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.BASE_URL), 'Requires local source files');

for (const width of [375, 768, 1280]) {
  test(`estimate actions remain reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const root = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(path.join(root, 'frontend/src/pages/Estimates.jsx'), 'utf8');
    const css = source.match(/<style>\{`([\s\S]*?)`\}<\/style>/)[1];
    const globalCss = fs.readFileSync(path.join(root, 'frontend/src/styles/generic-global-scaling.css'), 'utf8');
    await page.setContent(`<style>body{margin:0}.app-shell,.app-main{width:100%}main{min-width:0}*{box-sizing:border-box}button{display:flex;align-items:center}table{border-collapse:collapse}</style>
      <style>${globalCss}</style><style>${css}</style>
      <body data-vertical="generic"><div class="app-shell"><div class="app-main"><main class="generic-page-content"><div class="estimates-page"><div class="estimate-ledger-card"><div class="estimates-ledger-scroll">
      <table class="estimates-ledger-table" style="width:100%;table-layout:fixed"><colgroup>${[10,18,11,10,9,10,6,26].map((value) => `<col style="width:${value}%">`).join('')}</colgroup><tbody><tr>${Array.from({ length: 7 }, () => '<td>Value</td>').join('')}<td><div style="display:flex;flex-wrap:nowrap;gap:.4rem">${['PDF','Email','Convert','Delete'].map((label) => `<button aria-label="${label}"><svg width="14" height="14"></svg><span>${label}</span></button>`).join('')}</div></td></tr></tbody></table>
      </div></div></div></main></div></div></body>`);
    const scroll = page.locator('.estimates-ledger-scroll');
    expect(await page.locator('table').evaluate((table) => table.getBoundingClientRect().width)).toBeGreaterThanOrEqual(760);
    for (const label of ['PDF', 'Email', 'Convert', 'Delete']) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click({ trial: true });
    }
    if (width === 375) expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  });
}
