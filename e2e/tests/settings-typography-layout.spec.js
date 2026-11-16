const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Filesystem-backed CSS regression: run locally, never against demo/production.
const IS_LOCAL_STACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.BASE_URL || '');
test.skip(!IS_LOCAL_STACK, 'Requires the local frontend stylesheet sources.');
test.use({ storageState: { cookies: [], origins: [] } });

function applicationStyles() {
  const root = path.resolve(__dirname, '../../frontend/src');
  const entry = fs.readFileSync(path.join(root, 'main.jsx'), 'utf8');
  const imports = [...entry.matchAll(/import\s+['"](.+?\.css)['"]/g)].map((match) => match[1]);
  // Use the real app import list, not an index.css-only approximation. Load
  // Settings first to ensure its contract survives later global density CSS.
  return ['components/settings/SettingsWorkspace.css', ...imports, 'theme/wellness.css', 'theme/travel.css']
    .map((file) => fs.readFileSync(path.resolve(root, file), 'utf8').replace(/@import[^;]+;/g, ''))
    .join('\n');
}

for (const width of [1440, 1024, 390, 320]) {
  test(`Generic settings aligns panels, password eye, and filled checkboxes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mountSettings(page, 'light');
    await page.locator('.gs-content').evaluate((content) => {
      content.insertAdjacentHTML('beforeend', `
        <div class="gs-section" data-settings-section="members"><div class="card"><form class="gs-invite" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
          <input class="input-field" placeholder="Full Name"><input class="input-field" placeholder="Email Address">
          <div style="position:relative;min-width:0"><input class="input-field gs-pass" type="password" placeholder="Temporary Password" style="padding-right:2.5rem"><button aria-label="Show password" type="button" style="position:absolute;right:0.6rem;top:50%;transform:translateY(-50%)">Eye</button></div>
          <select class="input-field"><option>Standard Rep</option></select>
        </form></div></div>
        <div class="gs-section"><div class="card"><div class="gs-br-grid" style="display:grid;grid-template-columns:repeat(3,1fr)">
          <div class="gs-br-logo"><div class="gs-field-label"><label>Logo</label></div><div>Upload logo</div></div>
          <div class="gs-br-color"><label>Brand color</label><div class="gs-br-inputs" style="display:flex"><input type="color"><input class="input-field" value="#13cdfb"><div class="gs-br-actions" style="display:flex"><button class="btn-primary">Save color</button></div></div></div>
          <div class="gs-br-color"><label>Theme color</label><div class="gs-br-inputs" style="display:flex"><input type="color"><input class="input-field" value="#405fff"><div class="gs-br-actions" style="display:flex"><button class="btn-primary">Save color</button><button>Reset to default</button></div></div></div>
        </div></div></div>
        <div class="gs-section" data-settings-section="notifications"><label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid grey"><input type="checkbox" checked aria-label="Notification category">Deals</label></div>
        <div class="gs-apps">${Array.from({ length: 5 }, (_, index) => `<button class="gs-app">Integration ${index + 1}</button>`).join('')}</div>`);
    });
    await expect(page.locator('.gs-pass')).toHaveCSS('padding-right', '48px');
    await expect(page.getByRole('button', { name: 'Show password' })).toHaveCSS('width', '32px');
    await expect(page.getByRole('button', { name: 'Show password' })).toHaveCSS('padding', '0px');
    const password = await page.locator('.gs-pass').boundingBox();
    const eye = await page.getByRole('button', { name: 'Show password' }).boundingBox();
    expect(eye.x + eye.width).toBeLessThanOrEqual(password.x + password.width);
    expect(eye.y).toBeGreaterThanOrEqual(password.y);
    await expect(page.locator('.gs-br-color').first()).toHaveCSS('padding-left', '0px');
    await expect(page.locator('.gs-br-inputs input.input-field').first()).toHaveCSS('max-width', '200px');
    const contentWidth = await page.locator('.gs-content').evaluate((element) => element.clientWidth);
    if (contentWidth > 560) {
      const logoControl = await page.locator('.gs-br-logo > div').last().boundingBox();
      const colorControl = await page.locator('.gs-br-inputs input[type="color"]').first().boundingBox();
      expect(Math.abs(logoControl.x - colorControl.x)).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('.gs-apps .gs-app').first()).toHaveCSS('padding-left', '24px');
    const checkbox = page.getByRole('checkbox', { name: 'Notification category' });
    await expect(checkbox).toHaveCSS('appearance', 'none');
    await expect(checkbox).toHaveCSS('width', '18px');
    const checkedFill = await checkbox.evaluate((element) => getComputedStyle(element).backgroundColor);
    await checkbox.uncheck();
    const uncheckedFill = await checkbox.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(uncheckedFill).not.toBe(checkedFill);
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    expect(await checkbox.evaluate((element) => getComputedStyle(element, '::after').borderLeftColor)).toBe('rgb(255, 255, 255)');
  });
}

async function mountSettings(page, theme, vertical = 'generic') {
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}" data-vertical="${vertical}">
    <head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${applicationStyles()}</style></head>
    <body data-vertical="${vertical}"><div class="app-shell${vertical === 'travel' ? ' travel-app-shell' : ''}" style="height:100vh;display:flex">
      <div class="app-main" style="width:100%;min-width:0;display:flex;flex-direction:column">
        <main class="${vertical === 'generic' ? 'generic-page-content' : ''}" style="flex:1;min-height:0;overflow-y:auto">
          ${vertical === 'travel' ? '<div class="travel-content-frame">' : ''}
          <div class="gs-page" data-settings-vertical="${vertical}" style="height:100%;overflow-y:auto;padding:32px">
            <header><h1>Organization Settings</h1><p>Manage team members, roles, and administrative security.</p></header>
            <div class="gs-workspace">
              <aside class="gs-navigation"><label class="gs-search"><input type="search" aria-label="Find a setting" placeholder="Find a setting"></label><label class="gs-mobile"><span>Settings section</span><select aria-label="Settings section"><option>General</option><option>Branding</option></select></label><nav aria-label="Settings sections"><button class="gs-nav-item">General</button></nav></aside>
              <div class="gs-content"><div class="gs-scroll"><div class="gs-section-heading"><div class="gs-heading-row"><div><h2>General</h2><p>Organization preferences</p></div></div></div>
                <div class="gs-section"><div class="card"><h3>Organization</h3>
                  <label for="org-name" style="font-size:0.875rem">Organization Name</label>
                  <input id="org-name" class="input-field" value="Default Org">
                  <p style="font-size:0.75rem"><span style="font-size:0.75rem">Review redirect helper text</span></p>
                  <label><input type="checkbox" checked> Store sent messages</label>
                </div></div>
                <button class="gs-app"><strong>Callified</strong><span class="gs-app-description">Configure AI calling, lead sync, and webhook credentials for your organization.</span></button></div>
              </div>
            </div>
          </div>
          ${vertical === 'travel' ? '</div>' : ''}
          <div class="density-sentinel"><input class="input-field" aria-label="Other page input"></div>
        </main>
      </div>
    </div></body></html>`);
}

for (const vertical of ['generic', 'travel', 'wellness']) {
  for (const width of [320, 1440]) {
    for (const theme of ['light', 'dark']) {
      test(`${vertical} keeps the page title and navigation fixed while section headings scroll: ${width}px ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        await mountSettings(page, theme, vertical);
        await page.locator('.gs-scroll').evaluate((pane) => {
          pane.insertAdjacentHTML('beforeend', '<div style="height:2400px">Long settings content</div>');
        });
        const selectors = ['.gs-page > header', '.gs-navigation'];
        const headingBefore = await page.locator('.gs-section-heading').boundingBox();
        const before = await Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
        expect(await page.locator('.gs-scroll').evaluate((pane) => pane.clientHeight)).toBeGreaterThan(100);
        await page.locator('.gs-scroll').evaluate((pane) => { pane.scrollTop = 400; });
        expect(await page.locator('.gs-scroll').evaluate((pane) => pane.scrollTop)).toBe(400);
        const after = await Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
        after.forEach((box, index) => expect(box.y).toBe(before[index].y));
        const headingAfter = await page.locator('.gs-section-heading').boundingBox();
        expect(headingAfter.y).toBe(headingBefore.y - 400);
        expect(await page.locator('main').evaluate((pane) => pane.scrollTop)).toBe(0);
        expect(await page.locator('.gs-page').evaluate((pane) => pane.scrollTop)).toBe(0);
      });
    }
  }
}

for (const vertical of ['travel', 'wellness']) {
  for (const width of [320, 768, 1440]) {
    for (const theme of ['light', 'dark']) {
      test(`${vertical} settings stays readable and responsive: ${width}px ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await mountSettings(page, theme, vertical);
        await expect(page.locator('#org-name')).toHaveCSS('font-size', '16px');
        await expect(page.locator('label[for="org-name"]')).toHaveCSS('font-size', '14px');
        await expect(page.locator('.gs-heading-row h2')).toHaveCSS('font-size', '24px');
        const mobile = page.getByRole('combobox', { name: 'Settings section' });
        const pageWidth = await page.locator('.gs-page').evaluate((element) => element.clientWidth);
        if (pageWidth <= 760) await expect(mobile).toBeVisible();
        else await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
        await page.locator('#org-name').focus();
        await expect(page.locator('#org-name')).toHaveCSS('outline-style', 'none');
        expect(await page.evaluate(() => [...document.querySelectorAll('main,.gs-page,.gs-workspace,.gs-content')].every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        await expect(page.locator('.gs-section input[type="checkbox"]')).toHaveCSS('appearance', 'none');
      });
    }
  }
}

for (const width of [390, 768, 1024, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`Travel integration cards contain their content and clear the footer: ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mountSettings(page, theme, 'travel');
      await page.locator('.gs-content').evaluate((content) => {
        const integrations = [
          ['Marketing', 'AdsGPT', 'Connect your marketing workspace with single sign-on.'],
          ['Email delivery', 'SendGrid', 'Configure your own email account and sender for Travel CRM.'],
        ];
        const connections = [['Gmail', '/gmail'], ['Google Drive', '/travel/trip-knowledge'], ['Google Calendar', '/calendar-sync'], ['WhatsApp Web', '/travel/whatsapp']];
        content.innerHTML = `<div class="gs-scroll"><div class="gs-section-heading"><h2>Integrations</h2></div><div class="gs-apps">${integrations.map(([category, name, description]) => `<button class="gs-app" type="button"><span class="gs-app-icon">Icon</span><span class="gs-app-category">${category}</span><span class="gs-app-title"><strong>${name}</strong><span class="gs-app-connection" data-status="connected">Connected</span></span><span class="gs-app-description">${description}</span><span class="gs-app-action">Manage integration</span></button>`).join('')}${connections.map(([name, url]) => `<a class="gs-app" href="${url}"><span class="gs-app-icon">Icon</span><span class="gs-app-category">Connection</span><span class="gs-app-title"><strong>${name}</strong><span class="gs-app-connection" data-status="disconnected">Not connected</span></span><span class="gs-app-description">Open the existing setup page to connect and manage this account.</span><span class="gs-app-action">Connect</span></a>`).join('')}</div><div class="gs-panels"></div><div class="gs-footer">Each section saves independently.</div></div>`;
      });
      const cards = page.locator('.gs-app');
      for (const selector of ['.gs-app-category', '.gs-app-title strong', '.gs-app-description', '.gs-app-action', '.gs-app-connection']) {
        const typography = (element) => {
          const style = getComputedStyle(element);
          return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'].map((property) => [property, style[property]]));
        };
        const reference = await cards.nth(2).locator(selector).evaluate(typography);
        for (const card of await cards.all()) expect(await card.locator(selector).evaluate(typography)).toEqual(reference);
      }
      for (const card of await cards.all()) {
        const bounds = await card.boundingBox();
        expect(bounds.height).toBeGreaterThan(150);
        for (const child of await card.locator(':scope > *').all()) {
          const childBounds = await child.boundingBox();
          expect(childBounds.y).toBeGreaterThanOrEqual(bounds.y);
          expect(childBounds.y + childBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        }
        await expect(card.locator('.gs-app-icon')).toHaveCSS('height', '44px');
      }
      const cardBottom = Math.max(...await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().bottom)));
      const footer = await page.locator('.gs-footer').boundingBox();
      expect(footer.y).toBeGreaterThanOrEqual(cardBottom + 12);
      expect(await page.locator('.gs-content').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
  }
}

for (const width of [390, 1024, 1440, 1920]) {
  for (const theme of ['light', 'dark']) {
    test(`Wellness settings retains the page gutter: ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mountSettings(page, theme, 'wellness');
      await page.locator('main').evaluate((main) => {
        const reference = document.createElement('div');
        reference.className = 'wellness-vendors-page';
        reference.style.padding = '2rem';
        main.appendChild(reference);
      });
      const spacing = await page.evaluate(() => {
        const root = document.querySelector('.gs-page');
        const style = getComputedStyle(root);
        const header = root.querySelector('header').getBoundingClientRect();
        const workspace = root.querySelector('.gs-workspace').getBoundingClientRect();
        return {
          padding: parseFloat(style.paddingLeft),
          reference: parseFloat(getComputedStyle(document.querySelector('.wellness-vendors-page')).paddingLeft),
          headerInset: header.left - root.getBoundingClientRect().left,
          navigationAligned: Math.abs(workspace.left - header.left) < 1,
          noOverflow: root.scrollWidth <= root.clientWidth + 1,
        };
      });
      if (width >= 900) expect(spacing.padding).toBeCloseTo(spacing.reference, 1);
      else {
        expect(spacing.padding).toBeGreaterThanOrEqual(12);
        expect(spacing.padding).toBeLessThanOrEqual(20);
      }
      expect(spacing.headerInset).toBeCloseTo(spacing.padding, 1);
      expect(spacing.navigationAligned).toBe(true);
      expect(spacing.noOverflow).toBe(true);
    });
  }
}

for (const width of [800, 1024, 1440]) {
  test(`Settings keeps Appearance and tours on one line when selected at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mountSettings(page, 'light');
    if (await page.getByRole('combobox', { name: 'Settings section' }).isVisible()) {
      await expect(page.getByRole('combobox', { name: 'Settings section' })).toBeVisible();
      return;
    }
    await page.getByRole('navigation', { name: 'Settings sections' }).evaluate((nav) => {
      nav.innerHTML = '<button class="gs-nav-item" type="button"><svg width="17" height="17" aria-hidden="true"></svg><span>Appearance &amp; tours</span><svg class="gs-nav-chevron" width="14" height="14" aria-hidden="true"></svg></button>';
    });
    const button = page.getByRole('button', { name: 'Appearance & tours' });
    const label = button.locator('span');
    const before = await label.boundingBox();
    await button.evaluate((element) => element.setAttribute('aria-current', 'page'));
    const after = await label.boundingBox();
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
    await expect(label).toHaveCSS('white-space', 'nowrap');
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(button.locator('.gs-nav-chevron')).toBeVisible();
  });
}

for (const vertical of ['generic', 'travel']) {
  test(`${vertical} settings retains its existing outer spacing`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mountSettings(page, 'light', vertical);
    const root = page.locator('.gs-page');
    if (vertical === 'generic') {
      await expect(root).toHaveCSS('padding-left', '0px');
      await expect(root).toHaveCSS('padding-top', '0px');
    } else {
      // Travel already inherits its own content-frame inset. The new
      // Wellness-specific page rule must not change that inherited spacing.
      const spacing = await root.evaluate((element) => getComputedStyle(element).padding);
      await root.evaluate((element) => element.removeAttribute('data-settings-vertical'));
      await expect(root).toHaveCSS('padding', spacing);
    }
  });
}

for (const width of [1920, 1440, 1024, 768, 390, 320]) {
  for (const theme of ['light', 'dark']) {
    test(`Generic settings keeps readable fonts and a single focus treatment: ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await mountSettings(page, theme);
      await expect(page.locator('#org-name')).toHaveCSS('font-size', '16px');
      await expect(page.locator('label[for="org-name"]')).toHaveCSS('font-size', '14px');
      await expect(page.locator('.gs-section p span')).toHaveCSS('font-size', '14px');
      await expect(page.locator('.gs-heading-row h2')).toHaveCSS('font-size', '24px');
      await expect(page.locator('.gs-section h3')).toHaveCSS('font-size', '18px');
      await expect(page.locator('.gs-page')).toHaveCSS('overflow-y', 'hidden');
      const search = page.getByRole('searchbox');
      await search.focus();
      await expect(search).toHaveCSS('font-size', '15px');
      await expect(search).toHaveCSS('outline-style', 'none');
      await expect(search).toHaveCSS('padding-left', '0px');
      await page.locator('#org-name').focus();
      await expect(page.locator('#org-name')).toHaveCSS('outline-style', 'none');
      const layout = await page.evaluate(() => [...document.querySelectorAll('main,.gs-page,.gs-content')].every((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollLeft === 0));
      expect(layout).toBe(true);
      // Settings' exception must not change the rest of Generic CRM.
      const outsideSize = await page.getByRole('textbox', { name: 'Other page input' }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(outsideSize).toBeLessThan(16);
    });
  }
}

test('Settings uses the available width and aligns its navigation with the page heading', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1200 });
  await mountSettings(page, 'light');
  const alignment = await page.evaluate(() => {
    const heading = document.querySelector('.gs-page > header').getBoundingClientRect();
    const workspace = document.querySelector('.gs-workspace').getBoundingClientRect();
    return { left: Math.abs(workspace.left - heading.left), width: Math.abs(workspace.width - heading.width) };
  });
  expect(alignment.left).toBeLessThanOrEqual(1);
  expect(alignment.width).toBeLessThanOrEqual(1);
});

test('Settings collapses navigation according to its content pane, including beside an app sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mountSettings(page, 'dark');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Settings section' })).toBeHidden();
  await page.locator('.app-main').evaluate((element) => { element.style.setProperty('max-width', '700px', 'important'); });
  await expect(page.locator('.gs-page')).toHaveCSS('container-name', 'settings-page');
  expect(await page.locator('.gs-page').evaluate((element) => element.clientWidth)).toBeLessThan(760);
  await expect(page.getByRole('combobox', { name: 'Settings section' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Settings section' })).toHaveCSS('font-size', '16px');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();
  await page.locator('.app-main').evaluate((element) => { element.style.removeProperty('max-width'); });
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
});

for (const width of [390, 320]) {
  test(`Settings dialogs cover the viewport and keep their content inside it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await mountSettings(page, 'light');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div class="gs-dialog" role="dialog" style="position:fixed;inset:0;display:grid;place-items:center;padding:20px"><div style="width:min(100%,920px);padding:20px"><h3>Cookie setup</h3><button>Close</button></div></div>');
    });
    const box = await page.getByRole('dialog').boundingBox();
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(width);
    expect(box.height).toBe(640);
    const panel = await page.getByRole('dialog').locator(':scope > div').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  });
}

for (const width of [320, 1440]) {
  test(`Travel brand dialog keeps its hover decoration from creating a scrollbar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mountSettings(page, 'light', 'travel');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div class="gs-dialog gs-brand-dialog" role="dialog" style="position:fixed;display:flex;align-items:center;justify-content:center"><form class="card" style="width:min(94vw,420px);padding:24px"><h3>Add another brand</h3><input class="input-field" aria-label="Brand name" style="width:100%"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button type="button" class="btn-secondary">Cancel</button><button type="button" class="btn-primary">Save Brand</button></div></form></div>');
    });
    await page.getByRole('button', { name: 'Save Brand' }).hover();
    expect(await page.getByRole('dialog').locator('form').evaluate((form) => form.scrollWidth <= form.clientWidth + 1)).toBe(true);
    await expect(page.getByRole('dialog').locator('form')).toHaveCSS('transform', 'none');
    await expect(page.getByRole('textbox', { name: 'Brand name' })).toHaveCSS('font-size', '16px');
  });
}
